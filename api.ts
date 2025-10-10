import { serve } from "bun";
import { hexToBytes } from "@noble/hashes/utils";
import { WalletConnect } from "applesauce-wallet-connect";
import { parseWalletConnectURI, supportsMethod } from "applesauce-wallet-connect/helpers";
import { withTimeout } from "./utils/async";
import { getRelayPool, closeRelayPool } from "./utils/nostr";
import { firstValueFrom, filter, take, timeout as rxTimeout } from "rxjs";
import { parseLightningAddress, fetchLnurlpParams, requestInvoice, verifyInvoiceAmount, verifyInvoiceDescriptionHashIfAvailable } from "./utils/lnurl";
import {
  NwcStore,
  WalletResolution,
  debitSubAccount,
  loadNwcStore,
  registerPendingInvoice,
  resolveWalletIdentifier,
  saveNwcStore,
  hasSufficientBalance,
  touchSubAccount,
  formatSubAccountIdentifier,
} from "./utils/nwc-store";
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

async function withWallet<T>(identifier: string, fn: (wallet: WalletConnect, support: any, resolved: WalletResolution, store: NwcStore, markMutated: () => void) => Promise<T>): Promise<T> {
  const store = loadNwcStore();
  const resolved = resolveWalletIdentifier(store, identifier);
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
        })),
      }));
      return json(200, { wallets: items });
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
      return json(200, { ...res.data, context: res.context });
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
      return json(200, { ...res.data, context: res.context });
    }

    if (path === "/api/payLNAddress" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, lnaddress, amount, comment } = body as { nickname?: string; lnaddress?: string; amount?: number; comment?: string };
      if (!nickname || !lnaddress || !amount) return json(400, { error: "Missing nickname, lnaddress, or amount" });
      const res = await withWallet(nickname, async (wallet, support, resolved, store, markMutated) => {
        if (!supportsMethod(support, "pay_invoice")) throw new Error("Wallet must support pay_invoice");
        const url = parseLightningAddress(lnaddress.trim());
        if (!url) throw new Error("Invalid LN address");
        const params = await withTimeout(fetchLnurlpParams(url), 20000, "lnurlp_fetch");
        if (params.tag !== "payRequest") throw new Error("Invalid LNURL-pay response");
        const msats = amount * 1000;
        if (msats < params.minSendable || msats > params.maxSendable) throw new Error("Amount out of bounds");
        if (resolved.subAccountId && !hasSufficientBalance(resolved.entry, resolved.subAccountId, msats)) {
          throw new Error("Insufficient sub-account balance");
        }
        const cbResp = await withTimeout(requestInvoice(params.callback, msats, { comment }), 20000, "lnurlp_callback");
        const pr = cbResp.pr;
        verifyInvoiceAmount(pr, msats);
        verifyInvoiceDescriptionHashIfAvailable(pr, params.metadata);
        const payRes = await withTimeout(wallet.payInvoice(pr), PAY_TIMEOUT_MS, "pay_invoice");
        if (resolved.subAccountId) {
          debitSubAccount(resolved.entry, resolved.subAccountId, msats);
          markMutated();
        }
        return { data: { payRes, successAction: cbResp.successAction || null }, context: toResolutionContext(resolved) };
      });
      return json(200, { ...res.data, context: res.context });
    }

    return json(404, { error: "Not Found" });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
}

const server = serve({ port: Bun.env.PORT ? Number(Bun.env.PORT) : 8787, fetch: handle });
const authOn = Boolean(Bun.env.AUTH_API);
console.log(`API listening on http://localhost:${server.port} (auth ${authOn ? "enabled" : "disabled"})`);

process.on("SIGINT", () => {
  try { closeRelayPool(); } catch {}
  process.exit(0);
});
