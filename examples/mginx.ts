import { onlyEvents, RelayPool } from "applesauce-relay";
import { SimpleSigner } from "applesauce-signers";
import {
  createWalletConnectURI,
  WALLET_REQUEST_KIND,
  type Transaction,
} from "applesauce-wallet-connect/helpers";
import { WalletConnect } from "applesauce-wallet-connect/wallet-connect";
import { WalletService } from "applesauce-wallet-connect/wallet-service";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { share, tap } from "rxjs";

// Configuration interface
interface Config {
  relay?: string | string[];
  "connect-uri"?: string;
  data?: string;
}

// Load configuration from config.json if it exists
let config: Config = {};
const configPath = "config.json";
if (existsSync(configPath)) {
  try {
    const configData = readFileSync(configPath, "utf-8");
    config = JSON.parse(configData);
    console.log(`Loaded configuration from ${configPath}`);
  } catch (error) {
    console.error(`Error loading config file: ${error}`);
    process.exit(1);
  }
}

// Parse CLI arguments
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    relay: {
      type: "string",
      short: "r",
      multiple: true,
    },
    "connect-uri": {
      type: "string",
      short: "c",
    },
    data: {
      type: "string",
      short: "b",
    },
    config: {
      type: "string",
      short: "f",
    },
  },
  strict: true,
  allowPositionals: false,
});

// Load custom config file if specified
if (values.config) {
  try {
    const configData = readFileSync(values.config, "utf-8");
    config = JSON.parse(configData);
    console.log(`Loaded configuration from ${values.config}`);
  } catch (error) {
    console.error(`Error loading config file: ${error}`);
    process.exit(1);
  }
}

// Merge CLI arguments with config (CLI takes precedence)
const relayFromConfig = Array.isArray(config.relay)
  ? config.relay
  : config.relay
  ? [config.relay]
  : undefined;
const finalRelays = values.relay || relayFromConfig;
const finalConnectUri = values["connect-uri"] || config["connect-uri"];
const finalDataPath = values.data || config.data;

if (!finalRelays || !finalConnectUri || !finalDataPath) {
  console.error("Usage: bun run index.ts [options]");
  console.error("Options:");
  console.error(
    "  --relay, -r: Relay URL to listen on (can be specified multiple times)"
  );
  console.error("  --connect-uri, -c: Upstream wallet connect URI");
  console.error("  --data, -d: Path to folder containing client data");
  console.error("  --config, -f: Path to config file (default: config.json)");
  console.error("");
  console.error("Configuration can also be provided via config.json file:");
  console.error(`{
  "relay": ["wss://relay1.com", "wss://relay2.com"],
  "connect-uri": "nostr+walletconnect://...",
  "data": "./data"
}`);
  console.error("");
  console.error("CLI arguments take precedence over config file values.");
  process.exit(1);
}

const relays = Array.isArray(finalRelays) ? finalRelays : [finalRelays];
const connectUri = finalConnectUri;
const dataPath = finalDataPath;

// Make sure data path exists
if (!existsSync(dataPath)) {
  console.log(`Creating new data folder at ${dataPath}`);
  mkdirSync(dataPath, { recursive: true });
}

const balancesPath = join(dataPath, "balances.json");
const pendingPath = join(dataPath, "pending.json");

// Load or create balances file
let balances: Record<string, number> = {};
if (existsSync(balancesPath)) {
  try {
    const data = readFileSync(balancesPath, "utf-8");
    balances = JSON.parse(data);
    console.log(`Loaded balances for ${Object.keys(balances).length} clients`);
  } catch (error) {
    console.error(`Error loading balances file: ${error}`);
    process.exit(1);
  }
} else {
  console.log(`Creating new balances file at ${balancesPath}`);
  writeFileSync(balancesPath, JSON.stringify(balances, null, 2));
}

// Function to save balances
function saveBalances() {
  try {
    writeFileSync(balancesPath, JSON.stringify(balances, null, 2));
  } catch (error) {
    console.error(`Error saving balances: ${error}`);
  }
}

// Load or create balances file
let pending: (Transaction & { owner: string })[] = [];
if (existsSync(pendingPath)) {
  try {
    const data = readFileSync(pendingPath, "utf-8");
    pending = JSON.parse(data);
    console.log(`Loaded pending for ${pending.length} clients`);
  } catch (error) {
    console.error(`Error loading pending file: ${error}`);
    process.exit(1);
  }
} else {
  console.log(`Creating new pending file at ${pendingPath}`);
  writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
}

/** Save pending invoices */
function savePending() {
  try {
    writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  } catch (error) {
    console.error(`Error saving pending: ${error}`);
  }
}

/** Remove expired pending invoices */
function prunePending() {
  const now = Date.now();
  pending = pending.filter((p) => p.expires_at && p.expires_at > now);
  savePending();
}

// Set up relay pool
const pool = new RelayPool();

// Set default pool for wallet connect and service
WalletConnect.pool = pool;

// Connect to upstream wallet
console.log(`Connecting to upstream wallet: ${connectUri}`);
const upstream = await WalletConnect.fromConnectURI(connectUri);

// Wait for upstream service to connect
await upstream.waitForService();
console.log("Connected to upstream wallet service");

// Create a signer for all the downstream services
const signer = SimpleSigner.fromKey(upstream.secret);

// Map to track active wallet services per client
const clientServices = new Map<string, WalletService>();

// Check for paid invoices
if (await upstream.supportsNotifications()) {
  upstream.notification("payment_received", (notification) => {
    if (notification.type !== "incoming") return;

    console.log("Payment received:", notification);

    // Find existing pending transaction by invoice or payment hash
    const existing = pending.find(
      (p) =>
        (p.payment_hash &&
          notification.payment_hash &&
          p.payment_hash === notification.payment_hash) ||
        (p.invoice &&
          notification.invoice &&
          p.invoice === notification.invoice) ||
        (p.description_hash &&
          notification.description_hash &&
          p.description_hash === notification.description_hash)
    );

    if (existing) {
      console.log("Updating balance for client:", existing.owner);

      // Update user balance
      balances[existing.owner] =
        (balances[existing.owner] || 0) + existing.amount;
      saveBalances();

      // Forward notification to client
      const client = clientServices.get(existing.owner);
      if (client) client.notify("payment_received", notification);

      // Removing pending transaction
      pending = pending.filter((p) => p !== existing);
      savePending();
    }
  });
} else {
  // Let downstream wallets check for their own invoices
}

// Create single relay subscription for all clients
const subscription = pool
  .subscription(
    relays,
    { kinds: [WALLET_REQUEST_KIND], "#p": [await signer.getPublicKey()] },
    { reconnect: true }
  )
  .pipe(
    onlyEvents(),
    tap((e) => {
      if (clientServices.has(e.pubkey)) return;

      // Create a new wallet service for the client
      createWalletService(e.pubkey);
    }),
    // Only create a single subscription
    share()
  );

// Listen for new connections
subscription.subscribe();

// Function to create a wallet service for a client
async function createWalletService(
  clientPubkey: string
): Promise<WalletService> {
  // Initialize balance if it doesn't exist
  if (!(clientPubkey in balances)) {
    balances[clientPubkey] = 0;
    saveBalances();
    console.log(`Initialized balance for new client: ${clientPubkey}`);
  }

  const service = new WalletService({
    relays: relays,
    signer: signer,
    client: clientPubkey,
    // Pass the single subscription to the service
    subscriptionMethod: () => subscription,
    // Pass the single pool to the service
    publishMethod: (relays, event) => pool.publish(relays, event),
    // Set up handlers for wallet methods
    handlers: {
      get_balance: async () => {
        const clientBalance = balances[clientPubkey] || 0;
        return { balance: clientBalance };
      },
      get_info: async () => {
        return await upstream.getInfo();
      },
      pay_invoice: async (params) => {
        const clientBalance = balances[clientPubkey] || 0;
        const amount = params.amount || 0;

        if (amount > clientBalance) throw new Error("Insufficient balance");

        // Forward to upstream wallet
        const result = await upstream.payInvoice(params.invoice, params.amount);

        // Deduct from client balance
        balances[clientPubkey] = clientBalance - amount;
        saveBalances();

        return result;
      },
      make_invoice: async (params) => {
        // Forward to upstream wallet
        const transaction = await upstream.makeInvoice(params.amount, params);
        console.log(
          "Created invoice for client:",
          clientPubkey,
          transaction.payment_hash || transaction.invoice
        );

        // Add to pending
        pending.push({ ...transaction, owner: clientPubkey });
        savePending();

        return transaction;
      },
      lookup_invoice: async (params) => {
        console.log(
          "Looking up invoice:",
          params.payment_hash || params.invoice
        );

        // Forward to upstream wallet
        const check = await upstream.lookupInvoice(
          params.payment_hash,
          params.invoice
        );

        if (check.state === "settled") {
          // Find existing pending transaction by invoice or payment hash
          const existing = pending.find(
            (p) =>
              (p.payment_hash &&
                check.payment_hash &&
                p.payment_hash === check.payment_hash) ||
              (p.invoice && check.invoice && p.invoice === check.invoice) ||
              (p.description_hash &&
                check.description_hash &&
                p.description_hash === check.description_hash)
          );

          if (existing?.state === "pending") {
            console.log(
              "Invoice was paid, updating balance for client:",
              existing.owner
            );

            // Invoice was paid, update balance
            balances[existing.owner] =
              (balances[existing.owner] || 0) + existing.amount;
            saveBalances();

            // Removing pending transaction
            pending = pending.filter((p) => p !== existing);
            savePending();
          }
        }

        return check;
      },
    },
    notifications: ["payment_received"],
  });

  // Save to cache
  clientServices.set(clientPubkey, service);

  await service.start();
  console.log(`Wallet service started for client: ${clientPubkey}`);

  return service;
}

// Recreate services for all existing balances on startup
console.log("Recreating services for existing balances...");
for (const clientPubkey of Object.keys(balances)) {
  try {
    await createWalletService(clientPubkey);
  } catch (error) {
    console.error(
      `Failed to recreate service for client ${clientPubkey}:`,
      error
    );
  }
}

// Prune expired pending invoices
prunePending();

console.log("NWC One-to-Many service is running...");
console.log(`Listening on relays: ${relays.join(", ")}`);
console.log(`Balances file: ${balancesPath}`);
console.log("");
console.log("Use the following scripts to create a new account:");
console.log("\n1. Generate a secret key");
console.log("SECRET=$(nak key generate)");
console.log("\n2. Create the account");
console.log(
  `nak event -k 23194 --sec $SECRET -p=${await signer.getPublicKey()} ${relays.join(
    " "
  )}`
);
console.log("\n3. Create the connect URI");
console.log(
  `echo "${createWalletConnectURI({
    service: await signer.getPublicKey(),
    relays: relays,
    secret: "SECRET",
  }).replace("SECRET", "$SECRET")}"`
);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");

  // Stop all client services
  for (const [clientPubkey, service] of clientServices) {
    console.log(`Stopping service for client: ${clientPubkey}`);
    service.stop();
  }

  process.exit(0);
});
