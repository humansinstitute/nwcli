import { join } from "path";
import { hexToBytes } from "@noble/hashes/utils";
import { WalletConnect } from "applesauce-wallet-connect";
import {
  GetBalanceResult,
  MakeInvoiceResult,
  PayInvoiceResult,
  Transaction,
  WalletSupport,
  parseWalletConnectURI,
  supportsMethod,
} from "applesauce-wallet-connect/helpers";

import { onExit, prompt, promptNumber, promptSelect, println, readJsonFile, writeJsonFile } from "./utils/io";
import { getRelayPool, closeRelayPool } from "./utils/nostr";
import { withTimeout } from "./utils/async";
import { firstValueFrom, filter, timeout as rxTimeout, take } from "rxjs";

type NwcEntry = { uri: string; npub?: string };
type NwcStore = Record<string, NwcEntry>; // nickname -> { uri, npub? }

const NWC_PATH = join(process.cwd(), "nwc.json");

function loadNwcStore(): NwcStore {
  try {
    const raw = readJsonFile<any>(NWC_PATH);
    if (!raw || typeof raw !== "object") return {};
    // Backwards compatibility: previous format was Record<string, string>
    const fixed: NwcStore = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") fixed[k] = { uri: v };
      else if (v && typeof v === "object" && typeof (v as any).uri === "string") fixed[k] = { uri: (v as any).uri, npub: (v as any).npub };
    }
    return fixed;
  } catch {
    return {};
  }
}

function saveNwcStore(store: NwcStore) {
  writeJsonFile(NWC_PATH, store);
}

async function chooseOrCreateNwc(store: NwcStore): Promise<{ nickname: string; uri: string; npub?: string }> {
  const names = Object.keys(store);
  if (names.length === 0) {
    println("No NWC entries found. Let's add one.");
    return await createNwcEntry(store);
  }

  const choice = await promptSelect("Select a saved NWC or add new:", [
    ...names.map((n) => {
      const entry = store[n];
      const shortNpub = entry.npub ? entry.npub.slice(0, 8) : undefined;
      const npubStr = shortNpub ? ` | npub: ${shortNpub}` : "";
      return { label: `${n}${npubStr}`, value: n };
    }),
    { label: "+ Add new", value: "__new" },
  ]);

  if (choice === "__new") {
    return await createNwcEntry(store);
  }
  const entry = store[choice];
  return { nickname: choice, uri: entry.uri, npub: entry.npub };
}

async function createNwcEntry(store: NwcStore): Promise<{ nickname: string; uri: string; npub?: string }> {
  // Ask for nickname and connection string
  let nickname = "";
  while (!nickname) {
    nickname = (await prompt("Nickname for this wallet:"))?.trim() || "";
    if (!nickname) println("Nickname cannot be empty.");
    else if (store[nickname]) {
      println("Nickname already exists. Choose a different one.");
      nickname = "";
    }
  }

  let uri = "";
  while (true) {
    uri = (await prompt("Paste NWC connection string:"))?.trim() || "";
    if (!uri) {
      println("Connection string cannot be empty.");
      continue;
    }
    try {
      parseWalletConnectURI(uri);
      break;
    } catch (e) {
      println("Invalid NWC connection string. Please try again.");
    }
  }

  // Optional Nostr npub association
  const npub = (await prompt("Optional Nostr npub (press Enter to skip):"))?.trim();

  store[nickname] = { uri, npub: npub ? npub : undefined };
  saveNwcStore(store);
  println(`Saved NWC entry '${nickname}'.`);
  return { nickname, uri, npub: npub ? npub : undefined };
}

function createWallet(uri: string): WalletConnect {
  const parsed = parseWalletConnectURI(uri);
  const secret = hexToBytes(parsed.secret);
  const pool = getRelayPool();
  const wallet = new WalletConnect({
    ...parsed,
    secret,
    subscriptionMethod: pool.subscription.bind(pool),
    publishMethod: pool.publish.bind(pool),
  });
  return wallet;
}

async function awaitSupport(wallet: WalletConnect, timeoutMs = 8000): Promise<WalletSupport> {
  const obs = (wallet as any).support$;
  if (!obs) throw new Error("Wallet support$ stream not available");
  return firstValueFrom(obs.pipe(filter(Boolean), take(1), rxTimeout({ first: timeoutMs }))) as Promise<WalletSupport>;
}

async function showMenu(wallet: WalletConnect, support: WalletSupport) {
  // Build dynamic options based on supported methods
  const items: { key: string; label: string }[] = [];
  if (supportsMethod(support, "get_balance")) items.push({ key: "get_balance", label: "Get balance" });
  if (supportsMethod(support, "make_invoice")) items.push({ key: "make_invoice", label: "Create invoice" });
  if (supportsMethod(support, "pay_invoice")) items.push({ key: "pay_invoice", label: "Pay invoice" });
  if (supportsMethod(support, "list_transactions")) items.push({ key: "list_transactions", label: "List transactions" });

  // Potential extras if supported by wallet (only show if available)
  if (supportsMethod(support, "lookup_invoice")) items.push({ key: "lookup_invoice", label: "Lookup invoice" });
  if (supportsMethod(support, "pay_lnaddress")) items.push({ key: "pay_lnaddress", label: "Pay LN Address" });

  // Always offer client-side LN Address payment via LNURLp
  items.push({ key: "pay_lnaddress_client", label: "Pay LN Address (client)" });

  items.push({ key: "switch_wallet", label: "Switch wallet" });
  items.push({ key: "quit", label: "Quit" });

  // Notifications listener (prints async events)
  let notifSub: any = null;
  if (support.notifications?.includes("payment_received") && (wallet as any).notifications$) {
    notifSub = (wallet as any).notifications$.subscribe((n: any) => {
      try {
        if (n?.notification_type === "payment_received") {
          println(`[notification] payment_received: ${n.notification?.amount ? Math.floor(n.notification.amount/1000) + ' sats' : ''}`);
        }
      } catch {}
    });
  }

  while (true) {
    println("");
    const selection = await promptSelect("Select an action:", items.map((i) => ({ label: i.label, value: i.key })));

    if (selection === "quit") {
      notifSub?.unsubscribe?.();
      process.exit(0);
    }
    if (selection === "switch_wallet") {
      notifSub?.unsubscribe?.();
      return; // return to main loop
    }

    try {
      switch (selection) {
        case "get_balance": {
          const res: GetBalanceResult = await withTimeout(wallet.getBalance(), 15000, "get_balance");
          println(`Balance: ${Math.floor(res.balance / 1000)} sats`);
          break;
        }
        case "make_invoice": {
          const amount = await promptNumber("Amount (sats):");
          const description = await prompt("Description (optional):");
          const result: MakeInvoiceResult = await withTimeout(wallet.makeInvoice(amount * 1000, {
            description: description?.trim() || undefined,
          }), 20000, "make_invoice");
          println("Invoice created:");
          if (result.invoice) println(result.invoice);
          println(`Amount: ${Math.floor(result.amount / 1000)} sats`);
          println(`State: ${result.state}`);
          if (support.notifications?.includes("payment_received")) {
            println("Waiting for payment notification (Ctrl+C to stop)...");
            // We already have a global notification subscription; the user will see it if it arrives
          }
          break;
        }
        case "pay_invoice": {
          const invoice = await prompt("Paste BOLT11 invoice:");
          if (!invoice) {
            println("No invoice provided.");
            break;
          }
          const result: PayInvoiceResult = await withTimeout(wallet.payInvoice(invoice.trim()), 30000, "pay_invoice");
          println("Payment submitted:");
          println(JSON.stringify(result, null, 2));
          break;
        }
        case "list_transactions": {
          const limit = await promptNumber("How many recent transactions? (default 20)", 20);
          const tx = await withTimeout(wallet.listTransactions({ limit }), 20000, "list_transactions");
          const arr: Transaction[] = tx.transactions || [];
          if (arr.length === 0) println("No transactions.");
          else {
            arr.forEach((t, i) => {
              println(`${i + 1}) ${t.type} ${Math.floor(t.amount / 1000)} sats | ${t.state} | ${t.description || ""}`);
            });
          }
          break;
        }
        case "lookup_invoice": {
          const invoice = await prompt("Paste BOLT11 invoice:");
          if (!invoice) {
            println("No invoice provided.");
            break;
          }
          if (!(supportsMethod(support, "lookup_invoice") && (wallet as any).lookupInvoice)) {
            println("lookup_invoice not supported by this wallet.");
            break;
          }
          const result = await withTimeout((wallet as any).lookupInvoice(invoice.trim()), 15000, "lookup_invoice");
          println(JSON.stringify(result, null, 2));
          break;
        }
        case "pay_lnaddress": {
          const lnaddr = await prompt("LN Address (name@domain):");
          if (!lnaddr) {
            println("No LN address provided.");
            break;
          }
          if (!(supportsMethod(support, "pay_lnaddress") && (wallet as any).payLnAddress)) {
            println("pay_lnaddress not supported by this wallet.");
            break;
          }
          const amount = await promptNumber("Amount (sats):");
          const result = await withTimeout((wallet as any).payLnAddress(lnaddr.trim(), amount * 1000), 30000, "pay_lnaddress");
          println(JSON.stringify(result, null, 2));
          break;
        }
        case "pay_lnaddress_client": {
          const { parseLightningAddress, fetchLnurlpParams, requestInvoice, verifyInvoiceAmount, verifyInvoiceDescriptionHashIfAvailable } = await import("./utils/lnurl.ts");
          const lnaddr = await prompt("LN Address (name@domain):");
          if (!lnaddr) { println("No LN address provided."); break; }

          const url = parseLightningAddress(lnaddr.trim());
          if (!url) { println("Invalid LN address."); break; }
          const domain = url.hostname;

          // 1) Fetch LNURLp params
          const params = await withTimeout(fetchLnurlpParams(url), 20000, "lnurlp_fetch");
          if (params.tag !== "payRequest") { println("Not a payRequest LNURL."); break; }

          // Show basic info
          println(`LNURL domain: ${domain}`);
          try {
            const metadata = JSON.parse(params.metadata);
            const textEntry = Array.isArray(metadata) ? metadata.find((e: any) => Array.isArray(e) && e[0] === "text/plain") : undefined;
            if (textEntry?.[1]) println(`Description: ${textEntry[1]}`);
          } catch {}

          // 2) Prompt amount within bounds
          const minSats = Math.ceil(params.minSendable / 1000);
          const maxSats = Math.floor(params.maxSendable / 1000);
          println(`Amount range: ${minSats} - ${maxSats} sats`);
          let sats = await promptNumber("Amount (sats):");
          if (sats < minSats || sats > maxSats) {
            println("Amount out of bounds.");
            break;
          }

          // 3) Optional comment
          let comment: string | undefined = undefined;
          if ((params.commentAllowed || 0) > 0) {
            const c = await prompt(`Comment (up to ${params.commentAllowed} chars, optional):`);
            comment = (c || "").slice(0, params.commentAllowed);
          }

          // 4) Request invoice from callback
          const msats = sats * 1000;
          const cbResp = await withTimeout(requestInvoice(params.callback, msats, { comment }), 20000, "lnurlp_callback");
          const pr = cbResp.pr;

          // 5) Verify invoice amount and description hash (best-effort)
          verifyInvoiceAmount(pr, msats);
          verifyInvoiceDescriptionHashIfAvailable(pr, params.metadata);

          // 6) Pay invoice
          const payRes: PayInvoiceResult = await withTimeout(wallet.payInvoice(pr), 30000, "pay_invoice");
          println("Payment submitted:");
          println(JSON.stringify(payRes, null, 2));

          // 7) Handle successAction
          if (cbResp.successAction) {
            const sa = cbResp.successAction;
            if (sa.tag === "message" && sa.message) {
              println(`Success message: ${sa.message}`);
            } else if (sa.tag === "url" && sa.url) {
              println(`Success URL: ${sa.url}${sa.description ? ` - ${sa.description}` : ""}`);
            } else if (sa.tag === "aes") {
              println("Success AES payload received (decryption not implemented in CLI).");
            }
          }
          break;
        }
        default:
          println("Unknown selection.");
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/timeout/i.test(msg)) println(`Timeout: ${msg}`);
      else println(`Error: ${msg}`);
    }
  }
}

async function main() {
  println("Nostr Wallet Connect CLI");
  const apiPort = process.env.PORT ? Number(process.env.PORT) : 8787;
  println(`API base (if running): http://localhost:${apiPort}`);
  const store = loadNwcStore();
  onExit(() => closeRelayPool());

  while (true) {
    const { uri } = await chooseOrCreateNwc(store);
    println("Connecting to wallet...");
    let wallet: WalletConnect | null = null;
    try {
      wallet = createWallet(uri);
      const support = await awaitSupport(wallet);
      println("Connected. Supported methods detected.");
      await showMenu(wallet, support);
    } catch (e: any) {
      println(`Failed to connect: ${e?.message || String(e)}`);
    } finally {
      try {
        (wallet as any)?.stop?.();
      } catch {}
    }
  }
}

main().catch((e) => {
  println(`Fatal error: ${e?.message || String(e)}`);
  process.exit(1);
});
