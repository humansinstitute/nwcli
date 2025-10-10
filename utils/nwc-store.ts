import { createHash, randomBytes } from "crypto";
import { join } from "path";

import { readJsonFile, writeJsonFile } from "./io";

export interface NwcSubAccount {
  id: string;
  label: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usageCount?: number;
  metadata?: Record<string, unknown>;
  balanceMsats?: number;
  pendingMsats?: number;
  invoices?: Record<string, SubAccountInvoice>;
}

export type SubAccountInvoiceState = "pending" | "settled" | "failed" | "expired";

export interface SubAccountInvoice {
  id: string;
  invoice?: string;
  paymentHash?: string;
  amountMsats: number;
  state: SubAccountInvoiceState;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  metadata?: Record<string, unknown>;
}

export interface NwcEntry {
  uri: string;
  npub?: string;
  subAccounts?: Record<string, NwcSubAccount>;
}

export type NwcStore = Record<string, NwcEntry>;

export const NWC_PATH = join(process.cwd(), "nwc.json");

function normalizeSubAccounts(value: unknown): Record<string, NwcSubAccount> {
  if (!value || typeof value !== "object") return {};
  const entries: Record<string, NwcSubAccount> = {};
  for (const [key, rawVal] of Object.entries(value as Record<string, unknown>)) {
    if (!rawVal || typeof rawVal !== "object") continue;
    const sub = rawVal as Partial<NwcSubAccount>;
    if (typeof sub.id !== "string" || !sub.id) continue;
    const now = new Date().toISOString();
    const normalized: NwcSubAccount = {
      id: sub.id,
      label: typeof sub.label === "string" && sub.label.trim() ? sub.label.trim() : sub.id,
      description: typeof sub.description === "string" && sub.description.trim() ? sub.description.trim() : undefined,
      createdAt: typeof sub.createdAt === "string" ? sub.createdAt : now,
      updatedAt: typeof sub.updatedAt === "string" ? sub.updatedAt : typeof sub.createdAt === "string" ? sub.createdAt : now,
      lastUsedAt: typeof sub.lastUsedAt === "string" ? sub.lastUsedAt : undefined,
      usageCount: typeof sub.usageCount === "number" && Number.isFinite(sub.usageCount) ? Math.max(0, Math.floor(sub.usageCount)) : 0,
      metadata: sub.metadata && typeof sub.metadata === "object" ? (sub.metadata as Record<string, unknown>) : undefined,
      balanceMsats: normalizeMsat(sub.balanceMsats),
      pendingMsats: normalizeMsat(sub.pendingMsats),
      invoices: normalizeInvoices(sub.invoices),
    };
    entries[key] = normalized;
  }
  return entries;
}

function normalizeInvoices(value: unknown): Record<string, SubAccountInvoice> {
  if (!value || typeof value !== "object") return {};
  const invoices: Record<string, SubAccountInvoice> = {};
  for (const [key, rawVal] of Object.entries(value as Record<string, unknown>)) {
    if (!rawVal || typeof rawVal !== "object") continue;
    const item = rawVal as Partial<SubAccountInvoice>;
    const id = typeof item.id === "string" && item.id ? item.id : key;
    const now = new Date().toISOString();
    invoices[id] = {
      id,
      invoice: typeof item.invoice === "string" ? item.invoice : undefined,
      paymentHash: typeof item.paymentHash === "string" ? item.paymentHash : undefined,
      amountMsats: normalizeMsat(item.amountMsats),
      state: isInvoiceState(item.state) ? item.state : "pending",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
      settledAt: typeof item.settledAt === "string" ? item.settledAt : undefined,
      metadata: item.metadata && typeof item.metadata === "object" ? (item.metadata as Record<string, unknown>) : undefined,
    };
  }
  return invoices;
}

function normalizeMsat(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isInvoiceState(state: unknown): state is SubAccountInvoiceState {
  return state === "pending" || state === "settled" || state === "failed" || state === "expired";
}

function normalizeEntry(value: unknown): NwcEntry | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    return { uri: value, subAccounts: {} };
  }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const uri = typeof raw.uri === "string" ? raw.uri : undefined;
    if (!uri) return undefined;
    const entry: NwcEntry = { uri };
    if (typeof raw.npub === "string") entry.npub = raw.npub;
    entry.subAccounts = normalizeSubAccounts(raw.subAccounts);
    return entry;
  }
  return undefined;
}

export function loadNwcStore(): NwcStore {
  try {
    const raw = readJsonFile<Record<string, unknown>>(NWC_PATH);
    if (!raw || typeof raw !== "object") return {};
    const store: NwcStore = {};
    for (const [nickname, value] of Object.entries(raw)) {
      const entry = normalizeEntry(value);
      if (entry) store[nickname] = entry;
    }
    return store;
  } catch {
    return {};
  }
}

export function saveNwcStore(store: NwcStore): void {
  const sorted: NwcStore = Object.keys(store)
    .sort((a, b) => a.localeCompare(b))
    .reduce((acc, key) => {
      const entry = store[key];
      if (!entry) return acc;
      const subAccounts = entry.subAccounts ? Object.keys(entry.subAccounts)
        .sort((a, b) => a.localeCompare(b))
        .reduce<Record<string, NwcSubAccount>>((subs, subKey) => {
          const sub = entry.subAccounts?.[subKey];
          if (sub) {
            prepareSubAccount(sub);
            const serialized: NwcSubAccount = { ...sub };
            if (sub.invoices) {
              serialized.invoices = Object.keys(sub.invoices)
                .sort((a, b) => a.localeCompare(b))
                .reduce<Record<string, SubAccountInvoice>>((accInvoices, invoiceKey) => {
                  const inv = sub.invoices?.[invoiceKey];
                  if (inv) accInvoices[invoiceKey] = inv;
                  return accInvoices;
                }, {});
            }
            subs[subKey] = serialized;
          }
          return subs;
        }, {}) : undefined;
      acc[key] = { ...entry, subAccounts };
      return acc;
    }, {} as NwcStore);
  writeJsonFile(NWC_PATH, sorted);
}

export function ensureSubAccountContainer(entry: NwcEntry): Record<string, NwcSubAccount> {
  if (!entry.subAccounts) entry.subAccounts = {};
  for (const sub of Object.values(entry.subAccounts)) {
    prepareSubAccount(sub);
  }
  return entry.subAccounts;
}

export function getSubAccount(entry: NwcEntry, subAccountId: string): NwcSubAccount | undefined {
  const sub = entry.subAccounts?.[subAccountId];
  if (sub) prepareSubAccount(sub);
  return sub;
}

export function generateSubAccountId(store: NwcStore, nickname: string): string {
  const existing = new Set(Object.keys(store[nickname]?.subAccounts || {}));
  for (let i = 0; i < 10; i += 1) {
    const id = randomBytes(4).toString("hex");
    if (!existing.has(id)) return id;
  }
  return `${Date.now().toString(16)}${randomBytes(2).toString("hex")}`;
}

export interface WalletResolution {
  identifier: string;
  nickname: string;
  entry: NwcEntry;
  subAccountId?: string;
  subAccount?: NwcSubAccount;
}

function splitIdentifier(identifier: string): { nickname: string; subAccountId?: string } {
  const trimmed = identifier.trim();
  if (!trimmed) return { nickname: "" };
  const separators = [":", "/", "#"];
  for (const sep of separators) {
    if (trimmed.includes(sep)) {
      const [nick, sub] = trimmed.split(sep, 2);
      return { nickname: nick.trim(), subAccountId: sub.trim() || undefined };
    }
  }
  return { nickname: trimmed };
}

export function resolveWalletIdentifier(store: NwcStore, identifier: string): WalletResolution {
  const { nickname, subAccountId } = splitIdentifier(identifier);
  if (!nickname) {
    throw new Error("Missing wallet identifier");
  }
  const entry = store[nickname];
  if (!entry?.uri) {
    throw new Error(`Unknown wallet nickname '${nickname}'`);
  }
  if (!subAccountId) {
    return { identifier: nickname, nickname, entry };
  }
  const subAccounts = entry.subAccounts || {};
  const subAccount = subAccounts[subAccountId];
  if (!subAccount) {
    throw new Error(`Unknown sub-account '${subAccountId}' for wallet '${nickname}'`);
  }
  return {
    identifier: formatSubAccountIdentifier(nickname, subAccountId),
    nickname,
    entry,
    subAccountId,
    subAccount,
  };
}

export function formatSubAccountIdentifier(nickname: string, subAccountId: string): string {
  return `${nickname}:${subAccountId}`;
}

export interface TouchOptions {
  incrementUsage?: boolean;
  updateLastUsed?: boolean;
}

export function touchSubAccount(entry: NwcEntry, subAccountId: string, options: TouchOptions = {}): boolean {
  const sub = entry.subAccounts?.[subAccountId];
  if (!sub) return false;
  prepareSubAccount(sub);
  const now = new Date().toISOString();
  const incrementUsage = options.incrementUsage ?? true;
  const updateLastUsed = options.updateLastUsed ?? incrementUsage;
  if (updateLastUsed) sub.lastUsedAt = now;
  sub.updatedAt = now;
  if (incrementUsage) sub.usageCount = ((sub.usageCount || 0) + 1);
  return true;
}

function prepareSubAccount(sub: NwcSubAccount): void {
  if (!sub.label) sub.label = sub.id;
  if (!sub.createdAt) sub.createdAt = new Date().toISOString();
  if (!sub.updatedAt) sub.updatedAt = sub.createdAt;
  if (typeof sub.usageCount !== "number" || !Number.isFinite(sub.usageCount)) sub.usageCount = 0;
  if (typeof sub.balanceMsats !== "number" || !Number.isFinite(sub.balanceMsats)) sub.balanceMsats = 0;
  if (typeof sub.pendingMsats !== "number" || !Number.isFinite(sub.pendingMsats)) sub.pendingMsats = 0;
  if (!sub.invoices) sub.invoices = {};
}

export function hasSufficientBalance(entry: NwcEntry, subAccountId: string, amountMsats: number): boolean {
  if (amountMsats <= 0) return true;
  const sub = getSubAccount(entry, subAccountId);
  if (!sub) return false;
  return (sub.balanceMsats || 0) >= amountMsats;
}

export function debitSubAccount(entry: NwcEntry, subAccountId: string, amountMsats: number): number {
  if (amountMsats < 0) throw new Error("Amount must be positive");
  const sub = getSubAccount(entry, subAccountId);
  if (!sub) throw new Error(`Unknown sub-account '${subAccountId}'`);
  const current = sub.balanceMsats || 0;
  if (current < amountMsats) throw new Error("Insufficient balance");
  const next = current - amountMsats;
  sub.balanceMsats = normalizeMsat(next);
  sub.updatedAt = new Date().toISOString();
  return sub.balanceMsats;
}

export interface PendingInvoiceParams {
  invoice?: string;
  paymentHash?: string;
  amountMsats: number;
  metadata?: Record<string, unknown>;
}

export function registerPendingInvoice(entry: NwcEntry, subAccountId: string, params: PendingInvoiceParams): SubAccountInvoice {
  const { amountMsats } = params;
  const sub = entry.subAccounts?.[subAccountId];
  if (!sub) {
    throw new Error(`Unknown sub-account '${subAccountId}'`);
  }
  prepareSubAccount(sub);
  const now = new Date().toISOString();
  const id = computeInvoiceId(params.invoice, params.paymentHash);
  const invoice: SubAccountInvoice = {
    id,
    invoice: params.invoice,
    paymentHash: params.paymentHash,
    amountMsats: normalizeMsat(amountMsats),
    state: "pending",
    createdAt: now,
    updatedAt: now,
    metadata: params.metadata,
  };
  sub.invoices = sub.invoices || {};
  sub.invoices[id] = invoice;
  sub.pendingMsats = normalizeMsat((sub.pendingMsats || 0) + invoice.amountMsats);
  return invoice;
}

export interface SettlementResult {
  matched: boolean;
  subAccountId?: string;
  invoice?: SubAccountInvoice;
  creditedMsats?: number;
  previousState?: SubAccountInvoiceState;
}

export function applyIncomingTransaction(entry: NwcEntry, tx: { invoice?: string; payment_hash?: string; amount?: number; state?: string; settled_at?: number }): SettlementResult {
  if (!entry.subAccounts) return { matched: false };
  for (const [subId, sub] of Object.entries(entry.subAccounts)) {
    prepareSubAccount(sub);
    const invoice = findInvoice(sub, tx);
    if (!invoice) continue;
    const result = settleInvoice(sub, invoice, tx);
    if (!result.changed) {
      return { matched: true, subAccountId: subId, invoice, previousState: result.previousState };
    }
    return {
      matched: true,
      subAccountId: subId,
      invoice,
      creditedMsats: result.creditedMsats,
      previousState: result.previousState,
    };
  }
  return { matched: false };
}

function findInvoice(sub: NwcSubAccount, tx: { invoice?: string; payment_hash?: string }): SubAccountInvoice | undefined {
  const invoices = Object.values(sub.invoices || {});
  if (tx.invoice) {
    const exact = invoices.find((i) => i.invoice === tx.invoice);
    if (exact) return exact;
  }
  if (tx.payment_hash) {
    const byHash = invoices.find((i) => i.paymentHash && i.paymentHash === tx.payment_hash);
    if (byHash) return byHash;
  }
  return undefined;
}

function settleInvoice(sub: NwcSubAccount, invoice: SubAccountInvoice, tx: { amount?: number; state?: string; settled_at?: number }): { changed: boolean; creditedMsats?: number; previousState: SubAccountInvoiceState } {
  const previousState = invoice.state;
  const now = new Date().toISOString();
  invoice.updatedAt = now;
  const state = tx.state === "settled" || tx.state === "failed" || tx.state === "expired" ? (tx.state as SubAccountInvoiceState) : previousState;

  if (state === "settled" && previousState !== "settled") {
    const credit = invoice.amountMsats;
    sub.pendingMsats = Math.max(0, normalizeMsat((sub.pendingMsats || 0) - credit));
    sub.balanceMsats = normalizeMsat((sub.balanceMsats || 0) + credit);
    invoice.state = "settled";
    invoice.settledAt = tx.settled_at ? new Date(tx.settled_at * 1000).toISOString() : now;
    return { changed: true, creditedMsats: credit, previousState };
  }

  if ((state === "failed" || state === "expired") && previousState === "pending") {
    const delta = invoice.amountMsats;
    sub.pendingMsats = Math.max(0, normalizeMsat((sub.pendingMsats || 0) - delta));
    invoice.state = state;
    return { changed: true, creditedMsats: 0, previousState };
  }

  return { changed: false, previousState };
}

function computeInvoiceId(invoice?: string, paymentHash?: string): string {
  if (paymentHash) return paymentHash;
  if (invoice) return createHash("sha256").update(invoice).digest("hex");
  return randomBytes(6).toString("hex");
}
