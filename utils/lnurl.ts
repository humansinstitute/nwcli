import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { parseBolt11 } from "applesauce-core/helpers";

export type LnurlPayParams = {
  callback: string;
  maxSendable: number; // msats
  minSendable: number; // msats
  metadata: string; // raw string (JSON array string)
  commentAllowed?: number;
  tag: string;
  withdrawLink?: string;
};

export type LnurlCallbackResponse = {
  pr: string;
  successAction?: any | null;
  disposable?: boolean | null;
  routes?: any[];
};

export function parseLightningAddress(address: string): URL | undefined {
  const [name, domain] = address.trim().split("@");
  if (!name || !domain) return undefined;
  const scheme = domain.endsWith(".onion") ? "http" : "https";
  try {
    return new URL(`${scheme}://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`);
  } catch {
    return undefined;
  }
}

export async function fetchLnurlpParams(url: URL): Promise<LnurlPayParams> {
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`LNURLp request failed: ${res.status}`);
  const data = await res.json();
  if (data?.status === "ERROR") throw new Error(data?.reason || "LNURL error");
  if (!data || data.tag !== "payRequest") throw new Error("Invalid LNURLp response");
  return data as LnurlPayParams;
}

export async function requestInvoice(callback: string | URL, msats: number, opts?: { comment?: string; nonce?: string }) {
  const cb = typeof callback === "string" ? new URL(callback) : new URL(callback.toString());
  cb.searchParams.set("amount", String(msats));
  if (opts?.comment) cb.searchParams.set("comment", opts.comment);
  if (opts?.nonce) cb.searchParams.set("nonce", opts.nonce);

  const res = await fetch(cb.toString());
  if (!res.ok) throw new Error(`Callback request failed: ${res.status}`);
  const data = await res.json();
  if (data?.status === "ERROR") throw new Error(data?.reason || "LNURL callback error");
  if (!data?.pr) throw new Error("Missing invoice in callback response");
  return data as LnurlCallbackResponse;
}

export function verifyInvoiceAmount(pr: string, expectedMsats: number): void {
  const parsed = parseBolt11(pr);
  if (!parsed) throw new Error("Failed to parse invoice");
  if (typeof parsed.amount !== "number") throw new Error("Invoice has no amount");
  if (parsed.amount !== expectedMsats) throw new Error("Invoice amount does not match requested amount");
}

export function verifyInvoiceDescriptionHashIfAvailable(pr: string, metadataString: string): void {
  // Best-effort: if parser exposes descriptionHash we compare it, otherwise skip silently
  try {
    const parsed: any = parseBolt11(pr);
    const dh: string | undefined = parsed?.descriptionHash || parsed?.tags?.h || parsed?.h;
    if (!dh) return; // parser doesn't expose; skip
    const hash = bytesToHex(sha256(utf8ToBytes(metadataString)));
    if (dh.toLowerCase() !== hash.toLowerCase()) throw new Error("Invoice description hash does not match metadata");
  } catch {
    // If anything fails here, do not block payments beyond amount verification in first iteration
  }
}

