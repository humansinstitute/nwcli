import { RelayPool } from "applesauce-relay";
import { createWalletConnectURI } from "applesauce-wallet-connect/helpers";
import { WalletConnect } from "applesauce-wallet-connect/wallet-connect";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  getSubAccountSecrets,
  getSubAccounts,
  initStorage,
} from "../utils/storage";
import {
  WalletServiceManager,
  type CreateSubAccountResult,
} from "../src/wallet-service-manager";

interface Config {
  relay?: string | string[];
  "connect-uri"?: string;
  data?: string;
}

interface CliValues {
  relay?: string[];
  "connect-uri"?: string;
  data?: string;
  config?: string;
  create?: string;
  description?: string;
  "client-secret"?: string;
  "service-secret"?: string;
  list?: boolean;
}

function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as Config;
}

function coerceRelays(value?: string | string[]): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  return [value];
}

function printUsage(): void {
  console.error("Usage: bun run examples/mginx.ts [options]");
  console.error("Options:");
  console.error("  --relay, -r <url>       Relay URL (repeatable)");
  console.error("  --connect-uri, -c <uri> Upstream wallet connect URI");
  console.error("  --data, -d <path>       Working directory for storage");
  console.error("  --config, -f <path>     JSON config file");
  console.error("  --create <label>        Create a sub-account and print connect URI");
  console.error("  --description <text>    Optional description for new sub-account");
  console.error("  --client-secret <hex>   Optional client secret override (64 hex chars)");
  console.error("  --service-secret <hex>  Optional service secret override (64 hex chars)");
  console.error("  --list                  List configured sub-accounts and exit");
}

function ensureDataDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function printSubAccounts(dbRelays: string[]): void {
  const accounts = getSubAccounts();
  if (accounts.length === 0) {
    console.log("No sub-accounts stored yet.");
    return;
  }
  console.log(`Found ${accounts.length} sub-accounts:\n`);
  for (const account of accounts) {
    const secrets = getSubAccountSecrets(account.id);
    const relays = account.relays.length ? account.relays : dbRelays;
    const uri = createWalletConnectURI({
      service: account.servicePubkey,
      relays,
      secret: secrets.clientSecret,
    });
    console.log(`- ${account.label}`);
    console.log(`  id: ${account.id}`);
    console.log(`  client pubkey: ${account.clientPubkey}`);
    console.log(`  service pubkey: ${account.servicePubkey}`);
    console.log(`  balance: ${account.balanceMsats} msats`);
    console.log(`  pending: ${account.pendingMsats} msats`);
    if (account.lastUsedAt) console.log(`  last used: ${account.lastUsedAt}`);
    console.log(`  relays: ${relays.join(", ")}`);
    console.log(`  connect uri: ${uri}`);
    console.log("");
  }
}

function printCreateResult(result: CreateSubAccountResult): void {
  console.log("Created sub-account:\n");
  console.log(`Label:       ${result.record.label}`);
  console.log(`ID:          ${result.record.id}`);
  console.log(`Client npub: ${result.record.clientPubkey}`);
  console.log(`Service npub:${result.record.servicePubkey}`);
  console.log(`Client secret (keep safe): ${result.clientSecret}`);
  console.log(`Connect URI: ${result.connectURI}`);
  console.log("");
  console.log("Share the Connect URI (or client secret) securely with the client.");
}

const parsed = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    relay: { type: "string", short: "r", multiple: true },
    "connect-uri": { type: "string", short: "c" },
    data: { type: "string", short: "d" },
    config: { type: "string", short: "f" },
    create: { type: "string" },
    description: { type: "string" },
    "client-secret": { type: "string" },
    "service-secret": { type: "string" },
    list: { type: "boolean" },
  },
  strict: true,
  allowPositionals: false,
});

const values = parsed.values as CliValues;

let config: Config = {};
if (existsSync("config.json")) {
  try {
    config = loadConfig("config.json");
    console.log("Loaded configuration from config.json");
  } catch (error) {
    console.warn("Failed to parse config.json", error);
  }
}

if (values.config) {
  try {
    config = loadConfig(values.config);
    console.log(`Loaded configuration from ${values.config}`);
  } catch (error) {
    console.error(`Unable to parse ${values.config}:`, error);
    process.exit(1);
  }
}

const relays = values.relay || coerceRelays(config.relay);
const connectUri = values["connect-uri"] || config["connect-uri"];
const dataPath = values.data || config.data || join(process.cwd(), "data");

if (!relays || !relays.length || !connectUri) {
  printUsage();
  process.exit(1);
}

ensureDataDirectory(dataPath);
const dbPath = join(dataPath, "subwallets.db");
initStorage({ dbPath });

if (values.list) {
  printSubAccounts(relays);
  process.exit(0);
}

const pool = new RelayPool();
WalletConnect.pool = pool;

console.log(`Connecting to upstream wallet: ${connectUri}`);
const upstream = await WalletConnect.fromConnectURI(connectUri);
await upstream.waitForService();
console.log("Connected to upstream wallet service");

const manager = new WalletServiceManager({ relays, pool, upstream });

if (values.create) {
  const result = await manager.createSubAccount({
    label: values.create,
    description: values.description,
    relays,
    clientSecretHex: values["client-secret"],
    serviceSecretHex: values["service-secret"],
  });
  printCreateResult(result);
  await manager.stop();
  process.exit(0);
}

await manager.start();

console.log("NWC One-to-Many service is running...");
console.log(`Relays: ${relays.join(", ")}`);
console.log(`Database: ${dbPath}`);
console.log("");
console.log("Existing sub-accounts:");
printSubAccounts(relays);
console.log("");
console.log("Use --create <label> to create a new connect code.");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  manager
    .stop()
    .catch((error) => console.error("Error during shutdown", error))
    .finally(() => {
      try {
        (upstream as any)?.stop?.();
      } catch (error) {
        console.warn("Failed to stop upstream cleanly", error);
      }
      process.exit(0);
    });
});
