import { serve } from "bun";
import { hexToBytes } from "@noble/hashes/utils";
import { WalletConnect } from "applesauce-wallet-connect";
import { parseWalletConnectURI, supportsMethod } from "applesauce-wallet-connect/helpers";
import { withTimeout } from "./utils/async";
import { getRelayPool, closeRelayPool } from "./utils/nostr";
import { readJsonFile } from "./utils/io";
import { join } from "path";
import { firstValueFrom, filter, take, timeout as rxTimeout } from "rxjs";
import { parseLightningAddress, fetchLnurlpParams, requestInvoice, verifyInvoiceAmount, verifyInvoiceDescriptionHashIfAvailable } from "./utils/lnurl";

type NwcEntry = { uri: string; npub?: string };
type NwcStore = Record<string, NwcEntry>;

const NWC_PATH = join(process.cwd(), "nwc.json");

function loadNwcStore(): NwcStore {
  try {
    const raw = readJsonFile<any>(NWC_PATH);
    if (!raw || typeof raw !== "object") return {};
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

async function withWallet<T>(nickname: string, fn: (wallet: WalletConnect, support: any) => Promise<T>): Promise<T> {
  const store = loadNwcStore();
  const entry = store[nickname];
  if (!entry?.uri) throw new Error("Unknown wallet nickname");
  let wallet: WalletConnect | null = null;
  try {
    wallet = createWallet(entry.uri);
    const support = await awaitSupport(wallet);
    return await fn(wallet, support);
  } finally {
    try { (wallet as any)?.stop?.(); } catch {}
  }
}

function json(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
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
      const items = Object.entries(store).map(([nickname, e]) => ({ nickname, npub: e.npub || null }));
      return json(200, { wallets: items });
    }

    if (path === "/api/balance" && req.method === "GET") {
      const nickname = url.searchParams.get("nickname") || "";
      if (!nickname) return json(400, { error: "Missing nickname" });
      const res = await withWallet(nickname, async (wallet, support) => {
        if (!supportsMethod(support, "get_balance")) throw new Error("get_balance not supported");
        const r = await withTimeout(wallet.getBalance(), 15000, "get_balance");
        return r;
      });
      return json(200, res);
    }

    if (path === "/api/getInvoice" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, amount, description } = body as { nickname?: string; amount?: number; description?: string };
      if (!nickname || !amount) return json(400, { error: "Missing nickname or amount" });
      const res = await withWallet(nickname, async (wallet, support) => {
        if (!supportsMethod(support, "make_invoice")) throw new Error("make_invoice not supported");
        const out = await withTimeout(wallet.makeInvoice(amount * 1000, { description: description || undefined }), 20000, "make_invoice");
        return out;
      });
      return json(200, res);
    }

    if (path === "/api/payInvoice" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, invoice } = body as { nickname?: string; invoice?: string };
      if (!nickname || !invoice) return json(400, { error: "Missing nickname or invoice" });
      const res = await withWallet(nickname, async (wallet, support) => {
        if (!supportsMethod(support, "pay_invoice")) throw new Error("pay_invoice not supported");
        const out = await withTimeout(wallet.payInvoice(invoice.trim()), 30000, "pay_invoice");
        return out;
      });
      return json(200, res);
    }

    if (path === "/api/payLNAddress" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { nickname, lnaddress, amount, comment } = body as { nickname?: string; lnaddress?: string; amount?: number; comment?: string };
      if (!nickname || !lnaddress || !amount) return json(400, { error: "Missing nickname, lnaddress, or amount" });
      const res = await withWallet(nickname, async (wallet, support) => {
        if (!supportsMethod(support, "pay_invoice")) throw new Error("Wallet must support pay_invoice");
        const url = parseLightningAddress(lnaddress.trim());
        if (!url) throw new Error("Invalid LN address");
        const params = await withTimeout(fetchLnurlpParams(url), 20000, "lnurlp_fetch");
        if (params.tag !== "payRequest") throw new Error("Invalid LNURL-pay response");
        const msats = amount * 1000;
        if (msats < params.minSendable || msats > params.maxSendable) throw new Error("Amount out of bounds");
        const cbResp = await withTimeout(requestInvoice(params.callback, msats, { comment }), 20000, "lnurlp_callback");
        const pr = cbResp.pr;
        verifyInvoiceAmount(pr, msats);
        verifyInvoiceDescriptionHashIfAvailable(pr, params.metadata);
        const payRes = await withTimeout(wallet.payInvoice(pr), 30000, "pay_invoice");
        return { payRes, successAction: cbResp.successAction || null };
      });
      return json(200, res);
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
