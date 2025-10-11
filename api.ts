import { serve } from "bun";
import { hexToBytes } from "@noble/hashes/utils";
import { WalletConnect } from "applesauce-wallet-connect";
import { parseWalletConnectURI, supportsMethod } from "applesauce-wallet-connect/helpers";
import { withTimeout } from "./utils/async";
import { getRelayPool, closeRelayPool } from "./utils/nostr";
import { firstValueFrom, filter, take, timeout as rxTimeout } from "rxjs";
import { resolveLightningAddress, executeLnurlPayment } from "./utils/lnurl";
import {
  NwcStore,
  NwcEntry,
  WalletResolution,
  debitSubAccount,
  loadNwcStore,
  registerPendingInvoice,
  resolveWalletIdentifier,
  saveNwcStore,
  hasSufficientBalance,
  touchSubAccount,
  formatSubAccountIdentifier,
  createSubAccountRecord,
  applyIncomingTransaction,
} from "./utils/nwc-store";
import type { NwcSubAccount } from "./utils/nwc-store";
import type { SubAccountInvoice } from "./utils/nwc-store";
import type { Transaction } from "applesauce-wallet-connect/helpers";
import { parseBolt11 } from "applesauce-core/helpers";

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

async function awaitSupport(wallet: WalletConnect, timeoutMs = 8000) {
  const obs = (wallet as any).support$;
  if (!obs) throw new Error("Wallet support$ stream not available");
  return firstValueFrom(obs.pipe(filter(Boolean), take(1), rxTimeout({ first: timeoutMs })));
}

const PAY_TIMEOUT_MS = Number(Bun.env.PAY_TIMEOUT_MS || "60000");
const MSATS_PER_SAT = 1000;

function parseIsoToUnixSeconds(value?: string): number {
  if (!value) return Math.floor(Date.now() / 1000);
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return Math.floor(Date.now() / 1000);
  return Math.floor(ts / 1000);
}

async function reconcilePendingInvoices(
  resolved: WalletResolution,
  wallet: WalletConnect,
  store: NwcStore
): Promise<number> {
  const entry = resolved.entry;
  const subAccounts = entry.subAccounts || {};
  const targets: Array<[string, NwcSubAccount | undefined]> = resolved.subAccountId
    ? [[resolved.subAccountId, subAccounts[resolved.subAccountId]]]
    : Object.entries(subAccounts);

  let settledCount = 0;

  for (const [subId, sub] of targets) {
    if (!sub) continue;
    const invoices = (Object.values(sub.invoices || {}) as SubAccountInvoice[]).filter(
      (inv) => inv.state === "pending"
    );
    for (const invoice of invoices) {
      try {
        const lookup = await withTimeout(
          wallet.lookupInvoice(invoice.paymentHash, invoice.invoice),
          20000,
          "lookup_invoice"
        );
        if (!lookup || lookup.state !== "settled") continue;
        const normalized: Transaction = {
          type: lookup.type || "incoming",
          state: "settled",
          amount: lookup.amount ?? invoice.amountMsats,
          fees_paid: lookup.fees_paid ?? 0,
          created_at: lookup.created_at ?? parseIsoToUnixSeconds(invoice.createdAt),
          invoice: lookup.invoice ?? invoice.invoice,
          description: lookup.description ?? undefined,
          description_hash: lookup.description_hash ?? undefined,
          preimage: lookup.preimage ?? undefined,
          payment_hash: lookup.payment_hash ?? invoice.paymentHash,
          expires_at: lookup.expires_at ?? undefined,
          settled_at: lookup.settled_at ?? Math.floor(Date.now() / 1000),
          metadata: lookup.metadata ?? invoice.metadata,
        };
        const settlement = applyIncomingTransaction(entry, normalized);
        if (settlement.matched) settledCount += 1;
      } catch (error) {
        console.error(`Failed to reconcile invoice for ${formatSubAccountIdentifier(resolved.nickname, subId)}:`, error);
      }
    }
  }

  return settledCount;
}

interface LedgerWatcher {
  nickname: string;
  wallet: WalletConnect;
  stop: () => void;
  ready: Promise<void>;
}

const ledgerWatchers = new Map<string, LedgerWatcher>();

function processIncomingTransaction(nickname: string, tx: Transaction): string | null {
  if (tx.type !== "incoming") return null;
  const store = loadNwcStore();
  const entry = store[nickname];
  if (!entry) return null;
  const settlement = applyIncomingTransaction(entry, tx);
  if (!settlement.matched || !settlement.subAccountId || !settlement.invoice) return null;
  saveNwcStore(store);
  const credited = settlement.creditedMsats ?? 0;
  if (credited > 0) {
    return `Credited ${credited} msats to ${formatSubAccountIdentifier(nickname, settlement.subAccountId)}`;
  }
  return null;
}

async function startLedgerWatcher(nickname: string, entry: NwcEntry) {
  if (ledgerWatchers.has(nickname)) return ledgerWatchers.get(nickname)!.ready;

  const wallet = createWallet(entry.uri);
  let subscription: any = null;
  const watcher: LedgerWatcher = {
    nickname,
    wallet,
    stop: () => {
      try { subscription?.unsubscribe?.(); } catch {}
      try { (wallet as any).stop?.(); } catch {}
    },
    ready: Promise.resolve(),
  };
  ledgerWatchers.set(nickname, watcher);

  watcher.ready = (async () => {
    try {
      await wallet.waitForService();
      const support = (await awaitSupport(wallet)) as any;
      if (!(support?.notifications?.includes?.("payment_received") && (wallet as any).notifications$)) {
        return;
      }
      subscription = (wallet as any).notifications$.subscribe((event: any) => {
        try {
          if (event?.notification_type !== "payment_received") return;
          const tx = event.notification as Transaction;
          const msg = processIncomingTransaction(nickname, tx);
          if (msg) {
            console.log(`[ledger] ${msg}`);
          }
        } catch (error) {
          console.error("Failed to process payment notification", error);
        }
      });
    } catch (error) {
      console.error(`Failed to start ledger watcher for ${nickname}:`, error);
    }
  })();

  return watcher.ready;
}

async function ensureLedgerWatcher(nickname: string, entry: NwcEntry) {
  await startLedgerWatcher(nickname, entry);
}

async function initializeLedgerWatchers() {
  const store = loadNwcStore();
  await Promise.all(
    Object.entries(store).map(([nickname, entry]) => ensureLedgerWatcher(nickname, entry))
  );
}

function stopLedgerWatchers() {
  for (const watcher of ledgerWatchers.values()) {
    watcher.stop();
  }
  ledgerWatchers.clear();
}

async function withWallet<T>(identifier: string, fn: (wallet: WalletConnect, support: any, resolved: WalletResolution, store: NwcStore, markMutated: () => void) => Promise<T>): Promise<T> {
  const store = loadNwcStore();
  const resolved = resolveWalletIdentifier(store, identifier);
  await ensureLedgerWatcher(resolved.nickname, resolved.entry);
  let wallet: WalletConnect | null = null;
  let mutated = false;
  try {
    wallet = createWallet(resolved.entry.uri);
    const support = await awaitSupport(wallet);
    const result = await fn(wallet, support, resolved, store, () => { mutated = true; });
    if (resolved.subAccountId) {
      mutated = touchSubAccount(resolved.entry, resolved.subAccountId) || mutated;
    }
    if (mutated) saveNwcStore(store);
    return result;
  } finally {
    try { (wallet as any)?.stop?.(); } catch {}
  }
}

function json(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function toResolutionContext(resolved: WalletResolution) {
  return {
    nickname: resolved.nickname,
    identifier: resolved.identifier,
    subAccountId: resolved.subAccountId || null,
    subAccountLabel: resolved.subAccount?.label || null,
    subAccountDescription: resolved.subAccount?.description || null,
    subAccountBalanceMsats: resolved.subAccount?.balanceMsats ?? null,
    subAccountPendingMsats: resolved.subAccount?.pendingMsats ?? null,
  };
}

function extractInvoiceAmountMsats(invoice: string): number | null {
  const parsed = parseBolt11(invoice);
  if (!parsed) throw new Error("Failed to decode bolt11 invoice");
  const amount = (parsed as any)?.amount;
  if (typeof amount === "number") return amount;
  return null;
}

function resolveInvoiceAmountMsats(invoice: string, fallbackMsats?: number): number {
  const parsed = extractInvoiceAmountMsats(invoice);
  if (typeof parsed === "number" && parsed > 0) return parsed;
  if (typeof fallbackMsats === "number" && Number.isFinite(fallbackMsats) && fallbackMsats > 0) {
    return Math.floor(fallbackMsats);
  }
  throw new Error("Invoice does not contain an amount. Provide amountMsats in request body.");
}

function authorized(req: Request, url: URL): boolean {
  const token = Bun.env.AUTH_API;
  if (!token) return true; // no auth configured
  const authH = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  if (authH.toLowerCase().startsWith("bearer ")) {
    const provided = authH.slice(7).trim();
    if (provided && provided === token) return true;
  }
  const q = url.searchParams.get("auth");
  if (q && q === token) return true;
  return false;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path === "/api/health") {
      return json(200, { ok: true });
    }

    if (!authorized(req, url)) {
      return json(401, { error: "Unauthorized" });
    }

    if (path === "/api/wallets" && req.method === "GET") {
      const store = loadNwcStore();
      const items = Object.entries(store).map(([nickname, entry]) => ({
        nickname,
        npub: entry.npub || null,
        subAccounts: Object.entries(entry.subAccounts || {}).map(([subId, sub]) => ({
          id: subId,
          label: sub.label,
          description: sub.description || null,
          createdAt: sub.createdAt,
          updatedAt: sub.updatedAt,
          lastUsedAt: sub.lastUsedAt || null,
          usageCount: sub.usageCount ?? 0,
          identifier: formatSubAccountIdentifier(nickname, subId),
          balanceMsats: sub.balanceMsats ?? 0,
          pendingMsats: sub.pendingMsats ?? 0,
          connectUri: sub.connectUri || null,
        })),
      }));
      return json(200, { wallets: items });
    }

    const pathParts = path.split("/").filter(Boolean);
    if (pathParts[0] === "api" && pathParts[1] === "wallet" && pathParts[2] === "nwc" && req.method === "GET") {
      const store = loadNwcStore();
      const nickname = pathParts[3];
      const subId = pathParts[4];
      if (!nickname) {
        return json(400, { error: "Missing wallet nickname" });
      }
      const entry = store[nickname];
      if (!entry) {
        return json(404, { error: "Wallet not found" });
      }
      if (!subId || subId === "parent" || subId === "main") {
        return json(200, { connectUri: entry.uri });
      }
      const sub = entry.subAccounts?.[subId];
      if (!sub) {
        return json(404, { error: "Sub-account not found" });
      }
      if (!sub.connectUri) {
        return json(404, { error: "Sub-account connect URI not set" });
      }
      return json(200, { connectUri: sub.connectUri });
    }

    if (
      pathParts[0] === "api" &&
      pathParts[1] === "wallets" &&
      pathParts.length === 4 &&
      pathParts[3] === "subaccounts" &&
      req.method === "POST"
    ) {
      const nickname = pathParts[2];
      const body = await req.json().catch(() => ({}));
      const { label, description, connectUri, metadata } = body as {
        label?: string;
        description?: string;
        connectUri?: string;
        metadata?: Record<string, unknown>;
      };
      if (!label || !label.trim()) {
        return json(400, { error: "Missing label" });
      }
      if (connectUri) {
        try {
          parseWalletConnectURI(connectUri.trim());
        } catch (error: any) {
          return json(400, { error: `Invalid connect URI: ${error?.message || String(error)}` });
        }
      }
      const store = loadNwcStore();
      const { id, sub } = createSubAccountRecord(store, nickname, {
        label,
        description,
        connectUri,
        metadata,
      });
      saveNwcStore(store);
      await ensureLedgerWatcher(nickname, store[nickname]);
      return json(201, {
        id,
        identifier: formatSubAccountIdentifier(nickname, id),
        subAccount: sub,
      });
    }

    if (path === "/api/balance" && req.method === "GET") {
      const identifier = url.searchParams.get("nickname") || "";
      if (!identifier) return json(400, { error: "Missing nickname" });
      const { data, context } = await withWallet(identifier, async (wallet, support, resolved) => {
        if (resolved.subAccountId) {
          const sub = resolved.entry.subAccounts?.[resolved.subAccountId];
          if (!sub) throw new Error("Sub-account not found");
          return {
            data: {
              balance: sub.balanceMsats ?? 0,
              pending: sub.pendingMsats ?? 0,
              source: "ledger",
            },
            context: toResolutionContext(resolved),
          };
        }
        if (!supportsMethod(support, "get_balance")) throw new Error("get_balance not supported");
        const r = await withTimeout(wallet.getBalance(), 15000, "get_balance");
        return { data: { ...r, pending: 0, source: "wallet" }, context: toResolutionContext(resolved) };
      });
      return json(200, { ...data, context });
    }

    if (path === "/api/getInvoice" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, amount, description } = body as { nickname?: string; amount?: number; description?: string };
      if (!nickname || !amount) return json(400, { error: "Missing nickname or amount" });
      const res = await withWallet(nickname, async (wallet, support, resolved, store, markMutated) => {
        if (!supportsMethod(support, "make_invoice")) throw new Error("make_invoice not supported");
        const out = await withTimeout(wallet.makeInvoice(amount * 1000, { description: description || undefined }), 20000, "make_invoice");
        if (resolved.subAccountId) {
          registerPendingInvoice(resolved.entry, resolved.subAccountId, {
            invoice: out.invoice,
            paymentHash: out.payment_hash,
            amountMsats: out.amount ?? amount * 1000,
          });
          markMutated();
        }
        return { data: out, context: toResolutionContext(resolved) };
      });
      return json(200, { data: res.data, context: res.context });
    }

    if (path === "/api/payInvoice" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, invoice, amountMsats } = body as { nickname?: string; invoice?: string; amountMsats?: number };
      if (!nickname || !invoice) return json(400, { error: "Missing nickname or invoice" });
      const res = await withWallet(nickname, async (wallet, support, resolved, store, markMutated) => {
        if (!supportsMethod(support, "pay_invoice")) throw new Error("pay_invoice not supported");
        const trimmed = invoice.trim();
        const amtMsats = resolveInvoiceAmountMsats(trimmed, amountMsats);
        if (resolved.subAccountId) {
          if (!hasSufficientBalance(resolved.entry, resolved.subAccountId, amtMsats)) {
            throw new Error("Insufficient sub-account balance");
          }
        }
        const out = await withTimeout(wallet.payInvoice(trimmed), PAY_TIMEOUT_MS, "pay_invoice");
        if (resolved.subAccountId) {
          debitSubAccount(resolved.entry, resolved.subAccountId, amtMsats);
          markMutated();
        }
        return { data: out, context: toResolutionContext(resolved) };
      });
      return json(200, { data: res.data, context: res.context });
    }

    if (path === "/api/payLnAddress" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, lnAddress, amountSats, comment } = body as {
        nickname?: string;
        lnAddress?: string;
        amountSats?: number;
        comment?: string;
      };
      if (!nickname || !lnAddress || typeof amountSats !== "number") {
        return json(400, { error: "Missing nickname, lnAddress, or amountSats" });
      }
      const res = await withWallet(nickname, async (wallet, support, resolved, store, markMutated) => {
        if (!supportsMethod(support, "pay_invoice")) throw new Error("Wallet must support pay_invoice");
        const resolvedAddress = await withTimeout(resolveLightningAddress(lnAddress.trim()), 20000, "lnurlp_fetch");
        const msats = Math.floor(amountSats * MSATS_PER_SAT);
        if (msats <= 0) throw new Error("amountSats must be positive");
        if (msats < resolvedAddress.params.minSendable || msats > resolvedAddress.params.maxSendable) {
          throw new Error("Amount out of bounds for LN address");
        }
        if (comment && (resolvedAddress.params.commentAllowed || 0) === 0) {
          throw new Error("Comments not supported for this LN address");
        }
        if (
          resolved.subAccountId &&
          !hasSufficientBalance(resolved.entry, resolved.subAccountId, msats)
        ) {
          throw new Error("Insufficient sub-account balance");
        }
        const outcome = await withTimeout(
          executeLnurlPayment({ wallet, resolved: resolvedAddress, amountMsats: msats, comment }),
          PAY_TIMEOUT_MS,
          "pay_invoice"
        );
        if (resolved.subAccountId) {
          debitSubAccount(resolved.entry, resolved.subAccountId, outcome.amountMsats);
          markMutated();
        }
        return {
          data: {
            payResult: outcome.payResult,
            successAction: outcome.successAction || null,
            invoice: outcome.invoice,
            amountMsats: outcome.amountMsats,
            domain: outcome.domain,
          },
          context: toResolutionContext(resolved),
        };
      });
      return json(200, { data: res.data, context: res.context });
    }

    if (path === "/api/transactions" && req.method === "GET") {
      const identifier = url.searchParams.get("nickname") || "";
      if (!identifier) return json(400, { error: "Missing nickname" });
      const limitParam = url.searchParams.get("limit");
      let limit = 20;
      if (limitParam) {
        const parsed = Number.parseInt(limitParam, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return json(400, { error: "Invalid limit" });
        limit = Math.min(parsed, 100);
      }
      const res = await withWallet(identifier, async (wallet, support, resolved) => {
        if (!supportsMethod(support, "list_transactions")) {
          throw new Error("list_transactions not supported");
        }
        const tx = await withTimeout((wallet as any).listTransactions({ limit }), 20000, "list_transactions");
        return { data: tx, context: toResolutionContext(resolved) };
      });
      return json(200, { data: res.data, context: res.context });
    }

    if (path === "/api/refreshLedger" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname } = body as { nickname?: string };
      if (!nickname) return json(400, { error: "Missing nickname" });
      const res = await withWallet(nickname, async (wallet, support, resolved, store, markMutated) => {
        if (!supportsMethod(support, "lookup_invoice")) {
          throw new Error("lookup_invoice not supported");
        }
        const settled = await reconcilePendingInvoices(resolved, wallet, store);
        if (settled > 0) markMutated();
        return { data: { settled }, context: toResolutionContext(resolved) };
      });
      return json(200, { data: res.data, context: res.context });
    }

    return json(404, { error: "Not Found" });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
}

const server = serve({ port: Bun.env.PORT ? Number(Bun.env.PORT) : 8787, fetch: handle });
const authOn = Boolean(Bun.env.AUTH_API);
console.log(`API listening on http://localhost:${server.port} (auth ${authOn ? "enabled" : "disabled"})`);
initializeLedgerWatchers().catch((error) => {
  console.error("Failed to initialize ledger watchers", error);
});

process.on("SIGINT", () => {
  stopLedgerWatchers();
  try { closeRelayPool(); } catch {}
  process.exit(0);
});
