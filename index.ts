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

import { onExit, prompt, promptNumber, promptSelect, println } from "./utils/io";
import { getRelayPool, closeRelayPool } from "./utils/nostr";
import { withTimeout } from "./utils/async";
import { firstValueFrom, filter, timeout as rxTimeout, take } from "rxjs";
import {
  NwcEntry,
  NwcStore,
  NwcSubAccount,
  SubAccountInvoice,
  applyIncomingTransaction,
  debitSubAccount,
  ensureSubAccountContainer,
  formatSubAccountIdentifier,
  generateSubAccountId,
  getSubAccount,
  hasSufficientBalance,
  loadNwcStore,
  registerPendingInvoice,
  saveNwcStore,
  touchSubAccount,
} from "./utils/nwc-store";
import { parseBolt11 } from "applesauce-core/helpers";

const MSATS_PER_SAT = 1000;
const PAY_TIMEOUT_MS = Number(process.env.PAY_TIMEOUT_MS || "60000");

function persistEntry(store: NwcStore, nickname: string, entry: NwcEntry): NwcStore {
  const next = loadNwcStore();
  next[nickname] = entry;
  saveNwcStore(next);
  return next;
}

function msatsToSats(msats: number | undefined | null): number {
  if (!msats || !Number.isFinite(msats)) return 0;
  return Math.floor(msats / MSATS_PER_SAT);
}

function formatMsats(msats: number | undefined | null): string {
  const sats = msatsToSats(msats);
  return `${sats} sats`;
}

function extractInvoiceAmountMsats(invoice: string): number | null {
  const parsed = parseBolt11(invoice);
  if (!parsed) throw new Error("Failed to decode bolt11 invoice");
  const amt = (parsed as any)?.amount;
  if (typeof amt === "number") return amt;
  return null;
}

function resolveInvoiceAmountMsats(invoice: string): number {
  const amount = extractInvoiceAmountMsats(invoice);
  if (typeof amount === "number" && amount > 0) return amount;
  throw new Error("Invoice does not contain a fixed amount");
}

async function payLnAddressViaClientFlow(
  wallet: WalletConnect,
  store: NwcStore,
  entry: NwcEntry,
  nickname: string,
  activeSubAccountId: string | null
): Promise<NwcStore> {
  const { resolveLightningAddress, executeLnurlPayment } = await import("./utils/lnurl");

  const lnaddr = await prompt("LN Address (name@domain):");
  if (!lnaddr) {
    println("No LN address provided.");
    return store;
  }

  let resolved;
  try {
    resolved = await withTimeout(resolveLightningAddress(lnaddr.trim()), 20000, "lnurlp_fetch");
  } catch (error: any) {
    println(`Failed to resolve LN address: ${error?.message || String(error)}`);
    return store;
  }

  const { domain, params } = resolved;

  println(`LNURL domain: ${domain}`);
  try {
    const metadata = JSON.parse(params.metadata);
    const textEntry = Array.isArray(metadata)
      ? metadata.find((e: any) => Array.isArray(e) && e[0] === "text/plain")
      : undefined;
    if (textEntry?.[1]) println(`Description: ${textEntry[1]}`);
  } catch {}

  const minSats = Math.ceil(params.minSendable / MSATS_PER_SAT);
  const maxSats = Math.floor(params.maxSendable / MSATS_PER_SAT);
  println(`Amount range: ${minSats} - ${maxSats} sats`);
  const sats = await promptNumber("Amount (sats):");
  if (sats < minSats || sats > maxSats) {
    println("Amount out of bounds.");
    return store;
  }

  let comment: string | undefined;
  if ((params.commentAllowed || 0) > 0) {
    const c = await prompt(`Comment (up to ${params.commentAllowed} chars, optional):`);
    comment = (c || "").slice(0, params.commentAllowed);
  }

  const msats = sats * MSATS_PER_SAT;
  if (activeSubAccountId) {
    const sub = requireSubAccount(entry, nickname, activeSubAccountId);
    if (!sub) return store;
    if (!hasSufficientBalance(entry, activeSubAccountId, msats)) {
      println(
        `Insufficient balance. ${sub.label} has ${formatMsats(sub.balanceMsats)}, requires ${formatMsats(msats)}.`
      );
      return store;
    }
  }

  let outcome;
  try {
    outcome = await withTimeout(
      executeLnurlPayment({ wallet, resolved, amountMsats: msats, comment }),
      PAY_TIMEOUT_MS,
      "pay_invoice"
    );
  } catch (error: any) {
    println(`Failed to pay LN address: ${error?.message || String(error)}`);
    return store;
  }

  println("Payment submitted:");
  println(JSON.stringify(outcome.payResult, null, 2));

  if (outcome.successAction) {
    const sa = outcome.successAction;
    if (sa.tag === "message" && sa.message) {
      println(`Success message: ${sa.message}`);
    } else if (sa.tag === "url" && sa.url) {
      println(`Success URL: ${sa.url}${sa.description ? ` - ${sa.description}` : ""}`);
    } else if (sa.tag === "aes") {
      println("Success AES payload received (decryption not implemented in CLI).");
    }
  }

  if (activeSubAccountId) {
    try {
      debitSubAccount(entry, activeSubAccountId, outcome.amountMsats);
      store = recordSubAccountUsage(store, nickname, activeSubAccountId, { immediateSave: false });
      store = persistEntry(store, nickname, entry);
      println(
        `[ledger] Debited ${formatMsats(outcome.amountMsats)} from ${describeContext(entry, nickname, activeSubAccountId)}.`
      );
    } catch (err: any) {
      println(`[ledger] Failed to debit sub-account: ${err?.message || String(err)}`);
    }
  } else {
    store = recordSubAccountUsage(store, nickname, activeSubAccountId);
  }

  return store;
}

function requireSubAccount(entry: NwcEntry, nickname: string, subId: string | null): NwcSubAccount | null {
  if (!subId) return null;
  const sub = getSubAccount(entry, subId);
  if (!sub) {
    println(`Sub-account '${subId}' not found for wallet '${nickname}'.`);
    return null;
  }
  return sub;
}

async function chooseOrCreateNwc(store: NwcStore): Promise<{ nickname: string; entry: NwcEntry }> {
  const names = Object.keys(store);
  if (names.length === 0) {
    println("No NWC entries found. Let's add one.");
    return await createNwcEntry(store);
  }

  const choice = await promptSelect("Select a saved NWC or add new:", [
    ...names.map((n) => {
      const entry = store[n];
      const subCount = Object.keys(entry?.subAccounts || {}).length;
      const shortNpub = entry.npub ? entry.npub.slice(0, 8) : undefined;
      const parts: string[] = [n];
      if (shortNpub) parts.push(`npub: ${shortNpub}`);
      if (subCount > 0) parts.push(`${subCount} sub` + (subCount === 1 ? "" : "s"));
      return { label: parts.join(" | "), value: n };
    }),
    { label: "+ Add new", value: "__new" },
  ]);

  if (choice === "__new") {
    return await createNwcEntry(store);
  }
  const entry = store[choice];
  return { nickname: choice, entry };
}

async function createNwcEntry(store: NwcStore): Promise<{ nickname: string; entry: NwcEntry }> {
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

  store[nickname] = { uri, npub: npub ? npub : undefined, subAccounts: {} };
  saveNwcStore(store);
  println(`Saved NWC entry '${nickname}'.`);
  return { nickname, entry: store[nickname] };
}

async function manageSubAccounts(store: NwcStore, nickname: string): Promise<string | null> {
  let currentStore = store;
  let entry = currentStore[nickname];
  if (!entry) {
    println(`Wallet '${nickname}' not found.`);
    return null;
  }

  ensureSubAccountContainer(entry);

  while (true) {
    currentStore = loadNwcStore();
    entry = currentStore[nickname];
    if (!entry) {
      println(`Wallet '${nickname}' not found.`);
      return null;
    }
    ensureSubAccountContainer(entry);

    const subAccounts = entry.subAccounts || {};
    const subKeys = Object.keys(subAccounts);
    println("");
    if (subKeys.length === 0) {
      println(`Wallet '${nickname}' has no sub-accounts yet.`);
    } else {
      println(`Wallet '${nickname}' sub-accounts:`);
      subKeys.forEach((key, idx) => {
        const sub = subAccounts[key];
        const identifier = formatSubAccountIdentifier(nickname, key);
        const usage = typeof sub.usageCount === "number" ? ` | uses: ${sub.usageCount}` : "";
        const lastUsed = sub.lastUsedAt ? ` | last used: ${sub.lastUsedAt}` : "";
        const ledger = ` | balance: ${formatMsats(sub.balanceMsats)} | pending: ${formatMsats(sub.pendingMsats)}`;
        println(`${idx + 1}. ${sub.label} (${identifier})${ledger}${usage}${lastUsed}`);
      });
    }

    const selection = await promptSelect("Choose a sub-account action:", [
      ...subKeys.map((key) => ({ label: `Manage '${subAccounts[key].label}'`, value: key })),
      { label: "+ Create sub-account", value: "__create" },
      { label: "Back", value: "__back" },
    ]);

    if (selection === "__back") return null;
    if (selection === "__create") {
      const nextStore = await createSubAccount(currentStore, nickname);
      if (nextStore) currentStore = nextStore;
      continue;
    }
    const result = await showSubAccountDetails(currentStore, nickname, selection);
    if (result === "use") {
      return selection;
    } else if (result) {
      currentStore = result;
    }
  }
}

async function createSubAccount(store: NwcStore, nickname: string): Promise<NwcStore | null> {
  const entry = store[nickname];
  if (!entry) {
    println(`Wallet '${nickname}' not found.`);
    return null;
  }

  ensureSubAccountContainer(entry);

  let label = "";
  while (!label) {
    label = (await prompt("Label for new sub-account:"))?.trim() || "";
    if (!label) println("Label cannot be empty.");
  }

  const description = (await prompt("Description (optional):"))?.trim();
  let connectUri: string | undefined;
  const rawConnect = (await prompt("Connect URI for this sub-account (optional):"))?.trim();
  if (rawConnect) {
    try {
      parseWalletConnectURI(rawConnect);
      connectUri = rawConnect;
    } catch (error: any) {
      println(`Connect URI ignored (invalid): ${error?.message || String(error)}`);
    }
  }
  const id = generateSubAccountId(store, nickname);
  const now = new Date().toISOString();
  entry.subAccounts![id] = {
    id,
    label,
    description: description || undefined,
    createdAt: now,
    updatedAt: now,
    usageCount: 0,
    connectUri,
    balanceMsats: 0,
    pendingMsats: 0,
    invoices: {},
  } satisfies NwcSubAccount;

  const next = persistEntry(store, nickname, entry);
  const identifier = formatSubAccountIdentifier(nickname, id);
  println(`Created sub-account '${label}'. Identifier: ${identifier}`);
  println("Use this identifier with the CLI or API to act on behalf of the sub-account. Operations still route through the parent wallet.");
  return next;
}

async function showSubAccountDetails(store: NwcStore, nickname: string, subId: string): Promise<"use" | NwcStore> {
  let currentStore = store;
  let entry = currentStore[nickname];
  let sub = entry?.subAccounts?.[subId];
  if (!entry || !sub) {
    println("Sub-account not found.");
    return currentStore;
  }

  while (true) {
    currentStore = loadNwcStore();
    entry = currentStore[nickname];
    sub = entry?.subAccounts?.[subId];
    if (!entry || !sub) {
      println("Sub-account not found.");
      return currentStore;
    }
    ensureSubAccountContainer(entry);
    println("");
    println(`Sub-account: ${sub.label}`);
    println(`Identifier: ${formatSubAccountIdentifier(nickname, subId)}`);
    if (sub.description) println(`Description: ${sub.description}`);
    println(`Created: ${sub.createdAt}`);
    println(`Updated: ${sub.updatedAt}`);
    if (sub.lastUsedAt) println(`Last used: ${sub.lastUsedAt}`);
    if (typeof sub.usageCount === "number") println(`Usage count: ${sub.usageCount}`);
    println(`Balance: ${formatMsats(sub.balanceMsats)}`);
    println(`Pending: ${formatMsats(sub.pendingMsats)}`);
    const invoices = Object.values(sub.invoices || {});
    const pendingInvoices = invoices.filter((i) => i.state === "pending");
    println(`Tracked invoices: ${pendingInvoices.length} pending / ${invoices.length} total`);

    const choice = await promptSelect("Select action:", [
      { label: "Rename", value: "rename" },
      { label: "Update description", value: "description" },
      { label: "Show connect URI", value: "show_uri" },
      { label: "Set connect URI", value: "set_uri" },
      { label: "View invoices", value: "invoices" },
      { label: "Use for session", value: "use" },
      { label: "Remove sub-account", value: "delete" },
      { label: "Back", value: "__back" },
    ]);

    if (choice === "__back") return currentStore;

    if (choice === "use") {
      return "use";
    }

    if (choice === "invoices") {
      if (invoices.length === 0) {
        println("No invoices tracked for this sub-account yet.");
      } else {
        println("Invoices:");
        invoices
          .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
          .forEach((invoice, idx) => {
            const amountLabel = formatMsats(invoice.amountMsats);
            const stateSuffix = invoice.state === "settled" && invoice.settledAt ? ` @ ${invoice.settledAt}` : "";
            const id = invoice.paymentHash || invoice.id;
            println(`${idx + 1}. ${amountLabel} | ${invoice.state}${stateSuffix} | id: ${id.slice(0, 12)}`);
          });
      }
      continue;
    }

    if (choice === "rename") {
      const newLabel = (await prompt("New label:"))?.trim();
      if (!newLabel) {
        println("Label unchanged.");
      } else {
        sub.label = newLabel;
        sub.updatedAt = new Date().toISOString();
        currentStore = persistEntry(currentStore, nickname, entry);
        println("Label updated.");
      }
      continue;
    }

    if (choice === "description") {
      const newDesc = (await prompt("New description (leave blank to clear):"))?.trim();
      sub.description = newDesc ? newDesc : undefined;
      sub.updatedAt = new Date().toISOString();
      currentStore = persistEntry(currentStore, nickname, entry);
      println("Description updated.");
      continue;
    }

    if (choice === "show_uri") {
      if (sub.connectUri) {
        println(`Stored connect URI:\n${sub.connectUri}`);
      } else {
        println("No connect URI stored for this sub-account.");
      }
      continue;
    }

    if (choice === "set_uri") {
      const raw = (await prompt("Paste NWC connect URI (leave blank to clear):"))?.trim();
      try {
        if (!raw) {
          sub.connectUri = undefined;
          println("Connect URI cleared.");
        } else {
          parseWalletConnectURI(raw);
          sub.connectUri = raw;
          println("Connect URI updated.");
        }
        sub.updatedAt = new Date().toISOString();
        saveNwcStore(store);
      } catch (error: any) {
        println(`Invalid connect URI: ${error?.message || String(error)}`);
      }
      continue;
    }

    if (choice === "delete") {
      const confirm = (await prompt("Type DELETE to remove this sub-account:"))?.trim();
      if (confirm !== "DELETE") {
        println("Deletion aborted.");
        continue;
      }
      if (entry.subAccounts && subId in entry.subAccounts) {
        delete entry.subAccounts[subId];
      }
      currentStore = persistEntry(currentStore, nickname, entry);
      println("Sub-account removed.");
      return currentStore;
    }
  }
}

function describeContext(entry: NwcEntry | undefined, nickname: string, subId: string | null): string {
  if (!entry || !subId) return `${nickname} (parent)`;
  const sub = entry.subAccounts?.[subId];
  if (!sub) return nickname;
  const balance = formatMsats(sub.balanceMsats);
  const pending = sub.pendingMsats && sub.pendingMsats > 0 ? ` | pending: ${formatMsats(sub.pendingMsats)}` : "";
  return `${sub.label} (${formatSubAccountIdentifier(nickname, subId)}) | balance: ${balance}${pending}`;
}

function recordSubAccountUsage(
  store: NwcStore,
  nickname: string,
  subId: string | null,
  options: { immediateSave?: boolean } = {}
): NwcStore {
  if (!subId) return store;
  const entry = store[nickname];
  if (!entry) return store;
  const touched = touchSubAccount(entry, subId);
  if (touched && options.immediateSave !== false) {
    store = persistEntry(store, nickname, entry);
  }
  return store;
}

async function selectSessionContext(store: NwcStore, nickname: string, currentSubId: string | null): Promise<string | null | undefined> {
  const entry = store[nickname];
  if (!entry) {
    println(`Wallet '${nickname}' not found.`);
    return undefined;
  }

  const subAccounts = entry.subAccounts || {};
  const subIds = Object.keys(subAccounts);
  if (subIds.length === 0) {
    println("No sub-accounts available. Create one first.");
    return undefined;
  }

  const options: { label: string; value: string }[] = [
    {
      label: `${currentSubId === null ? "* " : ""}Parent wallet (${nickname})`,
      value: "__parent",
    },
    ...subIds.map((id) => {
      const sub = subAccounts[id];
      const prefix = currentSubId === id ? "* " : "";
      const balance = formatMsats(sub.balanceMsats);
      const pending = sub.pendingMsats && sub.pendingMsats > 0 ? ` | pending: ${formatMsats(sub.pendingMsats)}` : "";
      return {
        label: `${prefix}${sub.label} (${formatSubAccountIdentifier(nickname, id)}) | balance: ${balance}${pending}`,
        value: id,
      };
    }),
    { label: "Back", value: "__back" },
  ];

  const choice = await promptSelect("Select context:", options);
  if (choice === "__back") return undefined;
  if (choice === "__parent") return null;
  return choice;
}

function handleIncomingPaymentNotification(store: NwcStore, nickname: string, tx: Transaction): string | null {
  const entry = store[nickname];
  if (!entry) return null;
  const settlement = applyIncomingTransaction(entry, tx);
  if (!settlement.matched || !settlement.subAccountId || !settlement.invoice) return null;
  const subId = settlement.subAccountId;
  const invoice = settlement.invoice;
  const previous = settlement.previousState ?? invoice.state;
  const credited = settlement.creditedMsats ?? 0;
  if (credited <= 0 && previous === invoice.state) return null;
  touchSubAccount(entry, subId, { incrementUsage: false, updateLastUsed: true });
  saveNwcStore(store);
  const contextLabel = describeContext(entry, nickname, subId);
  if (credited > 0) {
    return `[ledger] Credited ${formatMsats(credited)} to ${contextLabel} (invoice ${shortInvoiceId(invoice)})`;
  }
  if (previous !== invoice.state) {
    return `[ledger] Invoice ${shortInvoiceId(invoice)} for ${contextLabel} marked ${invoice.state}`;
  }
  return null;
}

function shortInvoiceId(invoice: SubAccountInvoice): string {
  const base = invoice.paymentHash || invoice.id || "invoice";
  return base.slice(0, 12);
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

interface ShowMenuContext {
  wallet: WalletConnect;
  support: WalletSupport;
  store: NwcStore;
  nickname: string;
}

async function showMenu({ wallet, support, store, nickname }: ShowMenuContext) {
  let currentStore = store;
  let activeSubAccountId: string | null = null;

  // Notifications listener (prints async events)
  let notifSub: any = null;
  if (support.notifications?.includes("payment_received") && (wallet as any).notifications$) {
    notifSub = (wallet as any).notifications$.subscribe((n: any) => {
      try {
        if (n?.notification_type === "payment_received") {
          const tx = n.notification as Transaction;
          println(`[notification] payment_received: ${tx.amount ? formatMsats(tx.amount) : ""}`);
          currentStore = loadNwcStore();
          const ledgerMsg = handleIncomingPaymentNotification(currentStore, nickname, tx);
          if (ledgerMsg) println(ledgerMsg);
        }
      } catch {}
    });
  }

  while (true) {
    currentStore = loadNwcStore();
    const entry = currentStore[nickname];
    if (!entry) {
      println("Wallet entry not found. Returning to wallet list.");
      notifSub?.unsubscribe?.();
      return;
    }

    ensureSubAccountContainer(entry);

    if (activeSubAccountId && !entry.subAccounts?.[activeSubAccountId]) {
      println("Previously selected sub-account is no longer available. Reverting to parent wallet context.");
      activeSubAccountId = null;
    }

    const contextLabel = describeContext(entry, nickname, activeSubAccountId);

    const menuItems: { label: string; value: string }[] = [];
    if (supportsMethod(support, "get_balance")) menuItems.push({ value: "get_balance", label: "Get balance" });
    if (supportsMethod(support, "make_invoice")) menuItems.push({ value: "make_invoice", label: "Create invoice" });
    if (supportsMethod(support, "pay_invoice")) menuItems.push({ value: "pay_invoice", label: "Pay invoice" });
    if (supportsMethod(support, "list_transactions")) menuItems.push({ value: "list_transactions", label: "List transactions" });
    if (supportsMethod(support, "lookup_invoice")) menuItems.push({ value: "lookup_invoice", label: "Lookup invoice" });
    if (supportsMethod(support, "pay_lnaddress" as any)) {
      menuItems.push({ value: "pay_lnaddress", label: "Pay LN Address" });
    }
    menuItems.push({ value: "pay_lnaddress_client", label: "Pay LN Address (client)" });
    menuItems.push({ value: "show_connect_uri", label: "Show connect URI" });

    const hasSubAccounts = Object.keys(entry.subAccounts || {}).length > 0;
    if (hasSubAccounts) {
      const switchLabel = activeSubAccountId ? "Switch context (sub-account)" : "Switch context (sub-account)";
      menuItems.push({ value: "switch_context", label: switchLabel });
    }

    menuItems.push({ value: "manage_subaccounts", label: "Manage sub-accounts" });
    menuItems.push({ value: "switch_wallet", label: "Switch wallet" });
    menuItems.push({ value: "quit", label: "Quit" });

    println("");
    println(`Active context: ${contextLabel}`);
    const selection = await promptSelect("Select an action:", menuItems);

    if (selection === "quit") {
      notifSub?.unsubscribe?.();
      process.exit(0);
    }
    if (selection === "switch_wallet") {
      notifSub?.unsubscribe?.();
      return;
    }

    try {
      switch (selection) {
        case "switch_context": {
          const next = await selectSessionContext(currentStore, nickname, activeSubAccountId);
          if (next !== undefined) {
            activeSubAccountId = next;
            const updatedLabel = describeContext(entry, nickname, activeSubAccountId);
            println(`Now operating as: ${updatedLabel}`);
          }
          break;
        }
        case "manage_subaccounts": {
          const chosen = await manageSubAccounts(currentStore, nickname);
          if (typeof chosen === "string") {
            activeSubAccountId = chosen;
            const updatedLabel = describeContext(entry, nickname, activeSubAccountId);
            println(`Now operating as: ${updatedLabel}`);
          }
          break;
        }
        case "get_balance": {
          if (activeSubAccountId) {
            const sub = entry.subAccounts?.[activeSubAccountId];
            if (!sub) {
              println("Sub-account not found.");
              activeSubAccountId = null;
              break;
            }
            println(`Balance for ${describeContext(entry, nickname, activeSubAccountId)}.`);
            println(`  Available: ${formatMsats(sub.balanceMsats)}`);
            println(`  Pending: ${formatMsats(sub.pendingMsats)}`);
            currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId);
          } else {
            const res: GetBalanceResult = await withTimeout(wallet.getBalance(), 15000, "get_balance");
            println(`Balance for ${describeContext(entry, nickname, activeSubAccountId)}: ${formatMsats(res.balance)}`);
          }
          break;
        }
        case "make_invoice": {
          const amount = await promptNumber("Amount (sats):");
          const description = await prompt("Description (optional):");
          const result: MakeInvoiceResult = await withTimeout(wallet.makeInvoice(amount * 1000, {
            description: description?.trim() || undefined,
          }), 20000, "make_invoice");
          println(`Invoice created for ${describeContext(entry, nickname, activeSubAccountId)}:`);
          if (result.invoice) println(result.invoice);
          const invoiceMsats = result.amount ?? amount * MSATS_PER_SAT;
          println(`Amount: ${formatMsats(invoiceMsats)}`);
          println(`State: ${result.state}`);
          if (activeSubAccountId) {
            try {
              const ledgerInvoice = registerPendingInvoice(entry, activeSubAccountId, {
                invoice: result.invoice,
                paymentHash: result.payment_hash,
                amountMsats: result.amount ?? amount * MSATS_PER_SAT,
              });
              currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId, { immediateSave: false });
              currentStore = persistEntry(currentStore, nickname, entry);
              println(`[ledger] Pending balance for ${describeContext(entry, nickname, activeSubAccountId)} increased by ${formatMsats(ledgerInvoice.amountMsats)}.`);
            } catch (err: any) {
              println(`[ledger] Failed to register invoice: ${err?.message || String(err)}`);
            }
          } else {
            currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId);
          }
          if (support.notifications?.includes("payment_received")) {
            println("Waiting for payment notification (Ctrl+C to stop)...");
          }
          break;
        }
        case "pay_invoice": {
          const invoice = await prompt("Paste BOLT11 invoice:");
          if (!invoice) {
            println("No invoice provided.");
            break;
          }
          const trimmedInvoice = invoice.trim();
          let amountMsats: number;
          try {
            amountMsats = resolveInvoiceAmountMsats(trimmedInvoice);
          } catch (err: any) {
            println(`Unable to determine invoice amount: ${err?.message || String(err)}`);
            break;
          }

          if (activeSubAccountId) {
            const sub = requireSubAccount(entry, nickname, activeSubAccountId);
            if (!sub) break;
            if (!hasSufficientBalance(entry, activeSubAccountId, amountMsats)) {
              println(`Insufficient balance. ${sub.label} has ${formatMsats(sub.balanceMsats)}, requires ${formatMsats(amountMsats)}.`);
              break;
            }
          }

          const result: PayInvoiceResult = await withTimeout(wallet.payInvoice(trimmedInvoice), PAY_TIMEOUT_MS, "pay_invoice");
          println(`Payment submitted by ${describeContext(entry, nickname, activeSubAccountId)}:`);
          println(JSON.stringify(result, null, 2));

          if (activeSubAccountId) {
            try {
              debitSubAccount(entry, activeSubAccountId, amountMsats);
              currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId, { immediateSave: false });
              currentStore = persistEntry(currentStore, nickname, entry);
              println(`[ledger] Debited ${formatMsats(amountMsats)} from ${describeContext(entry, nickname, activeSubAccountId)}.`);
            } catch (err: any) {
              println(`[ledger] Failed to debit sub-account: ${err?.message || String(err)}`);
            }
          } else {
            currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId);
          }
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
          currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId);
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
          currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId);
          break;
        }
        case "pay_lnaddress": {
          if (activeSubAccountId) {
            await payLnAddressViaClientFlow(wallet, currentStore, entry, nickname, activeSubAccountId);
            break;
          }

          const lnaddr = await prompt("LN Address (name@domain):");
          if (!lnaddr) {
            println("No LN address provided.");
            break;
          }

          if (!(supportsMethod(support, "pay_lnaddress" as any) && (wallet as any).payLnAddress)) {
            println("pay_lnaddress not supported by this wallet.");
            break;
          }

          const amount = await promptNumber("Amount (sats):");
          const amountMsats = amount * MSATS_PER_SAT;
          const result = await withTimeout(
            (wallet as any).payLnAddress(lnaddr.trim(), amountMsats),
            PAY_TIMEOUT_MS,
            "pay_lnaddress"
          );
          println(JSON.stringify(result, null, 2));
          currentStore = recordSubAccountUsage(currentStore, nickname, activeSubAccountId);
          break;
        }
        case "pay_lnaddress_client": {
          currentStore = await payLnAddressViaClientFlow(wallet, currentStore, entry, nickname, activeSubAccountId);
          break;
        }
        case "show_connect_uri": {
          if (activeSubAccountId) {
            const sub = requireSubAccount(entry, nickname, activeSubAccountId);
            if (!sub) break;
            if (sub.connectUri) {
              println(`Sub-account connect URI:\n${sub.connectUri}`);
            } else {
              println("No connect URI stored for this sub-account. Use sub-account management to set one.");
            }
          } else {
            println(`Wallet connect URI:\n${entry.uri}`);
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
  // Optionally auto-start the HTTP API when running the CLI.
  // Set START_API=0 to disable.
  try {
    if (process.env.START_API !== "0") {
      await import("./api");
    }
  } catch (e) {
    // Non-fatal: continue running CLI even if API fails to start
  }

  println("Nostr Wallet Connect CLI");
  const apiPort = process.env.PORT ? Number(process.env.PORT) : 8787;
  println(`API base (if running): http://localhost:${apiPort}`);
  let store = loadNwcStore();
  onExit(() => closeRelayPool());

  while (true) {
    store = loadNwcStore();
    const { nickname, entry } = await chooseOrCreateNwc(store);
    println(`Connecting to wallet '${nickname}'...`);
    let wallet: WalletConnect | null = null;
    try {
      wallet = createWallet(entry.uri);
      const support = await awaitSupport(wallet);
      println("Connected. Supported methods detected.");
      await showMenu({ wallet, support, store, nickname });
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
