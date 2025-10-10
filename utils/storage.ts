import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { getPublicKey } from "nostr-tools";

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

type RawRow = Record<string, any>;

const DEFAULT_DB_PATH = join(process.cwd(), "data", "subwallets.db");

const SECRET_VERSION = 1;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

interface StorageInitOptions {
  dbPath?: string;
  masterKey?: string;
}

export interface SubAccountRecord {
  id: string;
  label: string;
  description?: string;
  relays: string[];
  servicePubkey: string;
  clientPubkey: string;
  balanceMsats: number;
  pendingMsats: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usageCount: number;
}

export interface SubAccountSecrets {
  serviceSecret: string;
  clientSecret: string;
}

export type PendingInvoiceState = "pending" | "settled" | "failed" | "expired";

export interface PendingInvoiceRecord {
  id: string;
  subAccountId: string;
  invoice?: string;
  paymentHash?: string;
  descriptionHash?: string;
  amountMsats: number;
  state: PendingInvoiceState;
  expiresAt?: number;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  rawPayload?: Record<string, unknown>;
}

export interface CreateSubAccountParams {
  label: string;
  description?: string;
  relays: string[];
  metadata?: Record<string, JSONValue>;
  clientSecret?: string;
  serviceSecret?: string;
}

export interface UpdateBalancesParams {
  subAccountId: string;
  balanceMsats?: number;
  pendingMsats?: number;
}

export interface RegisterPendingParams {
  subAccountId: string;
  id: string;
  invoice?: string;
  paymentHash?: string;
  descriptionHash?: string;
  amountMsats: number;
  expiresAt?: number | null;
  rawTransaction?: Record<string, unknown>;
}

export interface PendingLookupCriteria {
  paymentHash?: string | null;
  invoice?: string | null;
  descriptionHash?: string | null;
}

let dbPath = DEFAULT_DB_PATH;
let database: Database | null = null;
let masterKey: Buffer | null = null;
let initialized = false;

function getMasterKey(): Buffer {
  if (!masterKey) {
    throw new Error("Storage master key not configured. Set STORAGE_MASTER_KEY.");
  }
  return masterKey;
}

function normalizeKey(input: string): Buffer {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Storage master key cannot be empty");
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === 64) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch (error) {
    // Ignore and fallback to hash
  }
  return createHash("sha256").update(trimmed).digest();
}

function encryptBuffer(buffer: Uint8Array): Buffer {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const header = Buffer.alloc(2);
  header.writeUInt8(SECRET_VERSION, 0);
  header.writeUInt8(IV_LENGTH, 1);
  return Buffer.concat([header, iv, authTag, ciphertext]);
}

function decryptBuffer(payload: Uint8Array): Buffer {
  const buffer = Buffer.from(payload);
  if (buffer.length < 2 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted payload too short");
  }
  const version = buffer.readUInt8(0);
  if (version !== SECRET_VERSION) {
    throw new Error(`Unsupported secret version: ${version}`);
  }
  const ivLength = buffer.readUInt8(1);
  if (ivLength !== IV_LENGTH) {
    throw new Error("Unexpected IV length in encrypted payload");
  }
  const ivStart = 2;
  const ivEnd = ivStart + ivLength;
  const authTagStart = ivEnd;
  const authTagEnd = authTagStart + AUTH_TAG_LENGTH;
  const ciphertextStart = authTagEnd;
  const iv = buffer.subarray(ivStart, ivEnd);
  const authTag = buffer.subarray(authTagStart, authTagEnd);
  const ciphertext = buffer.subarray(ciphertextStart);
  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptHexSecret(secretHex: string): Buffer {
  const clean = secretHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length !== 64) {
    throw new Error("Secrets must be 32-byte hex strings");
  }
  return encryptBuffer(Buffer.from(clean, "hex"));
}

function decryptHexSecret(payload: Uint8Array): string {
  const buffer = decryptBuffer(payload);
  return buffer.toString("hex");
}

function requireDatabase(): Database {
  if (!database) {
    throw new Error("Storage not initialized");
  }
  return database;
}

function ensureInitialized(): void {
  if (initialized) return;
  const envKey = Bun.env.STORAGE_MASTER_KEY || Bun.env.NWC_STORAGE_KEY || "";
  if (!envKey) {
    throw new Error("STORAGE_MASTER_KEY environment variable must be set");
  }
  masterKey = normalizeKey(envKey);
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  database = new Database(dbPath, { create: true });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  runMigrations();
  initialized = true;
}

function runMigrations(): void {
  const db = requireDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sub_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      relays TEXT NOT NULL,
      service_pubkey TEXT NOT NULL UNIQUE,
      service_secret BLOB NOT NULL,
      client_pubkey TEXT NOT NULL UNIQUE,
      client_secret BLOB NOT NULL,
      balance_msats INTEGER NOT NULL DEFAULT 0,
      pending_msats INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_invoices (
      id TEXT PRIMARY KEY,
      sub_account_id TEXT NOT NULL,
      invoice TEXT,
      payment_hash TEXT,
      description_hash TEXT,
      amount_msats INTEGER NOT NULL,
      state TEXT NOT NULL,
      expires_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      raw TEXT,
      FOREIGN KEY(sub_account_id) REFERENCES sub_accounts(id) ON DELETE CASCADE
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_sub_account_state ON pending_invoices(sub_account_id, state);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_payment_hash ON pending_invoices(payment_hash);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_invoice ON pending_invoices(invoice);`);
}

function nowISO(): string {
  return new Date().toISOString();
}

function parseJSON<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    return undefined;
  }
}

function serializeJSON(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function parseRelays(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string");
    }
  } catch (error) {
    // ignore and fallback
  }
  return [];
}

function mapSubAccountRow(row: RawRow): SubAccountRecord {
  return {
    id: row.id as string,
    label: row.label as string,
    description: row.description ?? undefined,
    relays: parseRelays(row.relays as string),
    servicePubkey: row.service_pubkey as string,
    clientPubkey: row.client_pubkey as string,
    balanceMsats: Number(row.balance_msats) || 0,
    pendingMsats: Number(row.pending_msats) || 0,
    metadata: parseJSON<Record<string, unknown>>(row.metadata ?? null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: row.last_used_at ?? undefined,
    usageCount: Number(row.usage_count) || 0,
  };
}

function refreshPendingAggregate(subAccountId: string): number {
  const db = requireDatabase();
  const statement = db.prepare(
    `SELECT COALESCE(SUM(amount_msats), 0) AS total FROM pending_invoices WHERE sub_account_id = $id AND state = 'pending'`
  );
  const row = statement.get({ $id: subAccountId }) as RawRow | undefined;
  const total = Number(row?.total) || 0;
  db.prepare(
    `UPDATE sub_accounts SET pending_msats = $total, updated_at = $updated WHERE id = $id`
  ).run({ $total: total, $updated: nowISO(), $id: subAccountId });
  return total;
}

export function initStorage(options: StorageInitOptions = {}): void {
  if (options.dbPath) {
    dbPath = options.dbPath;
  }
  if (options.masterKey) {
    masterKey = normalizeKey(options.masterKey);
  }
  ensureInitialized();
}

export function getSubAccounts(): SubAccountRecord[] {
  ensureInitialized();
  const db = requireDatabase();
  const rows = db.prepare(`SELECT * FROM sub_accounts ORDER BY created_at`).all() as RawRow[];
  return rows.map(mapSubAccountRow);
}

export function getSubAccountById(id: string): SubAccountRecord | undefined {
  ensureInitialized();
  const db = requireDatabase();
  const row = db.prepare(`SELECT * FROM sub_accounts WHERE id = $id`).get({ $id: id }) as RawRow | undefined;
  return row ? mapSubAccountRow(row) : undefined;
}

export function getSubAccountByServicePubkey(servicePubkey: string): SubAccountRecord | undefined {
  ensureInitialized();
  const db = requireDatabase();
  const row = db
    .prepare(`SELECT * FROM sub_accounts WHERE service_pubkey = $service_pubkey`)
    .get({ $service_pubkey: servicePubkey }) as RawRow | undefined;
  return row ? mapSubAccountRow(row) : undefined;
}

export function getSubAccountSecrets(id: string): SubAccountSecrets {
  ensureInitialized();
  const db = requireDatabase();
  const row = db
    .prepare(`SELECT service_secret, client_secret FROM sub_accounts WHERE id = $id`)
    .get({ $id: id }) as RawRow | undefined;
  if (!row) {
    throw new Error(`Sub account ${id} not found`);
  }
  const serviceSecret = decryptHexSecret(row.service_secret as Uint8Array);
  const clientSecret = decryptHexSecret(row.client_secret as Uint8Array);
  return { serviceSecret, clientSecret };
}

export function createSubAccount(params: CreateSubAccountParams): {
  record: SubAccountRecord;
  secrets: SubAccountSecrets;
} {
  ensureInitialized();
  const db = requireDatabase();
  const id = randomBytes(16).toString("hex");
  const createdAt = nowISO();
  const serviceSecretHex = params.serviceSecret ? params.serviceSecret.trim() : bytesToHex(randomBytes(32));
  const clientSecretHex = params.clientSecret ? params.clientSecret.trim() : bytesToHex(randomBytes(32));
  const serviceSecretEncrypted = encryptHexSecret(serviceSecretHex);
  const clientSecretEncrypted = encryptHexSecret(clientSecretHex);
  const serviceSignerKey = serviceSecretHex;
  const servicePubkey = getPublicKey(hexToBytes(serviceSignerKey));
  const clientPubkey = getPublicKey(hexToBytes(clientSecretHex));
  const relaysJson = JSON.stringify(params.relays);
  const metadataJson = serializeJSON(params.metadata);
  try {
    db.prepare(
      `INSERT INTO sub_accounts (
        id,
        label,
        description,
        relays,
        service_pubkey,
        service_secret,
        client_pubkey,
        client_secret,
        balance_msats,
        pending_msats,
        metadata,
        created_at,
        updated_at,
        usage_count
      ) VALUES (
        $id,
        $label,
        $description,
        $relays,
        $service_pubkey,
        $service_secret,
        $client_pubkey,
        $client_secret,
        0,
        0,
        $metadata,
        $created_at,
        $created_at,
        0
      )`
    ).run({
      $id: id,
      $label: params.label,
      $description: params.description ?? null,
      $relays: relaysJson,
      $service_pubkey: servicePubkey,
      $service_secret: serviceSecretEncrypted,
      $client_pubkey: clientPubkey,
      $client_secret: clientSecretEncrypted,
      $metadata: metadataJson,
      $created_at: createdAt,
    });
  } catch (error) {
    throw new Error(`Failed to create sub account: ${(error as Error).message}`);
  }
  const record = getSubAccountById(id);
  if (!record) {
    throw new Error("Failed to load created sub account");
  }
  return {
    record,
    secrets: { serviceSecret: serviceSecretHex, clientSecret: clientSecretHex },
  };
}

export function touchSubAccount(id: string, updatedAt?: string): void {
  ensureInitialized();
  const db = requireDatabase();
  db.prepare(
    `UPDATE sub_accounts SET last_used_at = $time, usage_count = usage_count + 1, updated_at = $time WHERE id = $id`
  ).run({ $time: updatedAt ?? nowISO(), $id: id });
}

export function updateBalances(params: UpdateBalancesParams): SubAccountRecord {
  ensureInitialized();
  const db = requireDatabase();
  const record = getSubAccountById(params.subAccountId);
  if (!record) {
    throw new Error(`Sub account ${params.subAccountId} not found`);
  }
  const updatedBalance = params.balanceMsats ?? record.balanceMsats;
  const updatedPending = params.pendingMsats ?? record.pendingMsats;
  const updatedAt = nowISO();
  db.prepare(
    `UPDATE sub_accounts SET balance_msats = $balance, pending_msats = $pending, updated_at = $updated WHERE id = $id`
  ).run({
    $balance: updatedBalance,
    $pending: updatedPending,
    $updated: updatedAt,
    $id: params.subAccountId,
  });
  const updated = getSubAccountById(params.subAccountId);
  if (!updated) {
    throw new Error("Failed to refresh updated sub account");
  }
  return updated;
}

export function adjustBalance(subAccountId: string, deltaMsats: number): SubAccountRecord {
  ensureInitialized();
  const db = requireDatabase();
  const updatedAt = nowISO();
  db.prepare(
    `UPDATE sub_accounts SET balance_msats = balance_msats + $delta, updated_at = $updated WHERE id = $id`
  ).run({ $delta: deltaMsats, $updated: updatedAt, $id: subAccountId });
  const updated = getSubAccountById(subAccountId);
  if (!updated) {
    throw new Error("Failed to refresh balance after adjustment");
  }
  return updated;
}

export function registerPendingInvoice(params: RegisterPendingParams): PendingInvoiceRecord {
  ensureInitialized();
  const db = requireDatabase();
  const createdAt = nowISO();
  db.prepare(
    `INSERT INTO pending_invoices (
      id,
      sub_account_id,
      invoice,
      payment_hash,
      description_hash,
      amount_msats,
      state,
      expires_at,
      created_at,
      updated_at,
      raw
    ) VALUES (
      $id,
      $sub_account_id,
      $invoice,
      $payment_hash,
      $description_hash,
      $amount_msats,
      'pending',
      $expires_at,
      $created_at,
      $created_at,
      $raw
    )`
  ).run({
    $id: params.id,
    $sub_account_id: params.subAccountId,
    $invoice: params.invoice ?? null,
    $payment_hash: params.paymentHash ?? null,
    $description_hash: params.descriptionHash ?? null,
    $amount_msats: params.amountMsats,
    $expires_at: params.expiresAt ?? null,
    $created_at: createdAt,
    $raw: params.rawTransaction ? JSON.stringify(params.rawTransaction) : null,
  });
  refreshPendingAggregate(params.subAccountId);
  return getPendingInvoiceById(params.id)!;
}

export function getPendingInvoiceById(id: string): PendingInvoiceRecord | undefined {
  ensureInitialized();
  const db = requireDatabase();
  const row = db.prepare(`SELECT * FROM pending_invoices WHERE id = $id`).get({ $id: id }) as RawRow | undefined;
  if (!row) return undefined;
  return mapPendingRow(row);
}

function mapPendingRow(row: RawRow): PendingInvoiceRecord {
  return {
    id: row.id as string,
    subAccountId: row.sub_account_id as string,
    invoice: row.invoice ?? undefined,
    paymentHash: row.payment_hash ?? undefined,
    descriptionHash: row.description_hash ?? undefined,
    amountMsats: Number(row.amount_msats) || 0,
    state: row.state as PendingInvoiceState,
    expiresAt: typeof row.expires_at === "number" ? (row.expires_at as number) : row.expires_at ? Number(row.expires_at) : undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    settledAt: row.settled_at ?? undefined,
    rawPayload: parseJSON<Record<string, unknown>>(row.raw ?? null),
  };
}

export function updatePendingInvoiceState(
  id: string,
  state: PendingInvoiceState,
  updates: { settledAt?: string }
): PendingInvoiceRecord | undefined {
  ensureInitialized();
  const db = requireDatabase();
  const pending = getPendingInvoiceById(id);
  if (!pending) return undefined;
  const updatedAt = nowISO();
  db.prepare(
    `UPDATE pending_invoices SET state = $state, settled_at = $settled_at, updated_at = $updated WHERE id = $id`
  ).run({
    $state: state,
    $settled_at: updates.settledAt ?? null,
    $updated: updatedAt,
    $id: id,
  });
  refreshPendingAggregate(pending.subAccountId);
  return getPendingInvoiceById(id);
}

export function deletePendingInvoice(id: string): void {
  ensureInitialized();
  const db = requireDatabase();
  const pending = getPendingInvoiceById(id);
  if (!pending) return;
  db.prepare(`DELETE FROM pending_invoices WHERE id = $id`).run({ $id: id });
  refreshPendingAggregate(pending.subAccountId);
}

export function findPendingInvoice(criteria: PendingLookupCriteria): PendingInvoiceRecord | undefined {
  ensureInitialized();
  const db = requireDatabase();
  const statement = db.prepare(
    `SELECT * FROM pending_invoices WHERE ($payment_hash IS NOT NULL AND payment_hash = $payment_hash)
      OR ($invoice IS NOT NULL AND invoice = $invoice)
      OR ($description_hash IS NOT NULL AND description_hash = $description_hash)
      ORDER BY updated_at DESC LIMIT 1`
  );
  const row = statement.get({
    $payment_hash: criteria.paymentHash ?? null,
    $invoice: criteria.invoice ?? null,
    $description_hash: criteria.descriptionHash ?? null,
  }) as RawRow | undefined;
  return row ? mapPendingRow(row) : undefined;
}

export function pruneExpiredPending(now: number): PendingInvoiceRecord[] {
  ensureInitialized();
  const db = requireDatabase();
  const statement = db.prepare(
    `SELECT * FROM pending_invoices WHERE expires_at IS NOT NULL AND expires_at <= $cutoff`
  );
  const rows = statement.all({ $cutoff: now }) as RawRow[];
  const expired = rows.map(mapPendingRow);
  const deleteStmt = db.prepare(`DELETE FROM pending_invoices WHERE id = $id`);
  for (const row of expired) {
    deleteStmt.run({ $id: row.id });
    refreshPendingAggregate(row.subAccountId);
  }
  return expired;
}

export function listPendingForSubAccount(subAccountId: string): PendingInvoiceRecord[] {
  ensureInitialized();
  const db = requireDatabase();
  const rows = db
    .prepare(`SELECT * FROM pending_invoices WHERE sub_account_id = $id ORDER BY created_at DESC`)
    .all({ $id: subAccountId }) as RawRow[];
  return rows.map(mapPendingRow);
}

export function setBalance(subAccountId: string, balanceMsats: number): SubAccountRecord {
  return updateBalances({ subAccountId, balanceMsats });
}

export function setPending(subAccountId: string, pendingMsats: number): SubAccountRecord {
  return updateBalances({ subAccountId, pendingMsats });
}

export function closeStorage(): void {
  if (database) {
    database.close();
  }
  database = null;
  masterKey = null;
  initialized = false;
}
