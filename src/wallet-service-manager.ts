import { onlyEvents, RelayPool } from "applesauce-relay";
import { SimpleSigner } from "applesauce-signers";
import { createWalletConnectURI, WALLET_REQUEST_KIND } from "applesauce-wallet-connect/helpers";
import { WalletService } from "applesauce-wallet-connect/wallet-service";
import type { WalletConnect } from "applesauce-wallet-connect/wallet-connect";
import { hexToBytes } from "@noble/hashes/utils";
import { randomUUID } from "node:crypto";
import {
  BehaviorSubject,
  EMPTY,
  Subject,
  catchError,
  concatMap,
  filter,
  from,
  groupBy,
  map,
  mergeMap,
  of,
  share,
  switchMap,
  type Observable,
  type Subscription,
} from "rxjs";

import {
  adjustBalance,
  closeStorage,
  createSubAccount,
  findPendingInvoice,
  getSubAccountById,
  getSubAccountByServicePubkey,
  getSubAccountSecrets,
  getSubAccounts,
  listPendingForSubAccount,
  pruneExpiredPending,
  registerPendingInvoice,
  touchSubAccount,
  updatePendingInvoiceState,
  type JSONValue,
  type PendingInvoiceRecord,
  type PendingLookupCriteria,
  type SubAccountRecord,
  type SubAccountSecrets,
} from "../utils/storage";
import { parseBolt11 } from "applesauce-core/helpers";

interface ManagerOptions {
  relays: string[];
  pool: RelayPool;
  upstream: WalletConnect;
}

interface ServiceContext {
  record: SubAccountRecord;
  secrets: SubAccountSecrets;
  signer: SimpleSigner;
  events$: Subject<any>;
  service: WalletService;
}

interface CreateSubAccountInput {
  label: string;
  description?: string;
  relays?: string[];
  metadata?: Record<string, JSONValue>;
  clientSecretHex?: string;
  serviceSecretHex?: string;
}

export interface CreateSubAccountResult {
  record: SubAccountRecord;
  connectURI: string;
  clientSecret: string;
  serviceSecret: string;
}

function msatsFromInvoice(invoice: string): number | null {
  const parsed = parseBolt11(invoice);
  if (!parsed) return null;
  const amount: unknown = (parsed as any)?.amount;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    return Math.floor(amount);
  }
  return null;
}

function resolveInvoiceAmount(invoice: string, fallback?: number | null): number {
  const embedded = msatsFromInvoice(invoice);
  if (typeof embedded === "number" && embedded > 0) return embedded;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) {
    return Math.floor(fallback);
  }
  throw new Error("Invoice does not include an amount");
}

export class WalletServiceManager {
  private readonly relays: string[];
  private readonly pool: RelayPool;
  private readonly upstream: WalletConnect;

  private readonly serviceKeySet = new Set<string>();
  private readonly serviceKeys$ = new BehaviorSubject<string[]>([]);
  private readonly contextsById = new Map<string, ServiceContext>();
  private readonly contextsByServiceKey = new Map<string, ServiceContext>();

  private requests$!: Observable<any>;
  private requestsSubscription: Subscription | null = null;

  constructor(options: ManagerOptions) {
    if (!options.relays?.length) {
      throw new Error("WalletServiceManager requires at least one relay");
    }
    this.relays = options.relays;
    this.pool = options.pool;
    this.upstream = options.upstream;
  }

  async start(): Promise<void> {
    const accounts = getSubAccounts();
    this.rebuildServiceKeySet(accounts.map((item) => item.servicePubkey));

    for (const record of accounts) {
      await this.ensureContext(record.servicePubkey);
    }

    this.requests$ = this.serviceKeys$.pipe(
      switchMap((keys) => {
        if (!keys.length) return EMPTY;
        return this.pool
          .subscription(
            this.relays,
            { kinds: [WALLET_REQUEST_KIND], "#p": keys },
            { reconnect: true }
          )
          .pipe(onlyEvents());
      }),
      share()
    );

    this.requestsSubscription = this.requests$
      .pipe(
        map((event) => ({
          event,
          servicePubkey: this.resolveServicePubkey(event),
        })),
        filter((payload) => typeof payload.servicePubkey === "string"),
        groupBy((payload) => payload.servicePubkey as string),
        mergeMap((group$) =>
          group$.pipe(
            concatMap((payload) =>
              from(this.routeEvent(group$.key, payload.event)).pipe(
                catchError((error) => {
                  console.error(
                    "Failed to route wallet request",
                    group$.key,
                    error
                  );
                  return of(null);
                })
              )
            )
          )
        )
      )
      .subscribe();

    await this.bootstrapUpstreamNotifications();
    pruneExpiredPending(Date.now());
  }

  private resolveServicePubkey(event: any): string | null {
    if (!event?.tags || !Array.isArray(event.tags)) {
      return null;
    }
    for (const tag of event.tags) {
      if (Array.isArray(tag) && tag[0] === "p") {
        const candidate = tag[1];
        if (typeof candidate === "string" && this.serviceKeySet.has(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    if (this.requestsSubscription) {
      this.requestsSubscription.unsubscribe();
      this.requestsSubscription = null;
    }
    for (const context of this.contextsById.values()) {
      context.service.stop();
    }
    this.contextsById.clear();
    this.contextsByServiceKey.clear();
    closeStorage();
  }

  async createSubAccount(input: CreateSubAccountInput): Promise<CreateSubAccountResult> {
    const { record, secrets } = createSubAccount({
      label: input.label,
      description: input.description,
      relays: input.relays && input.relays.length > 0 ? input.relays : this.relays,
      metadata: input.metadata,
      clientSecret: input.clientSecretHex,
      serviceSecret: input.serviceSecretHex,
    });

    this.addServiceKey(record.servicePubkey);
    const context = await this.ensureContext(record.servicePubkey);

    const connectURI = createWalletConnectURI({
      service: record.servicePubkey,
      relays: record.relays.length > 0 ? record.relays : this.relays,
      secret: secrets.clientSecret,
    });

    return {
      record,
      serviceSecret: secrets.serviceSecret,
      clientSecret: secrets.clientSecret,
      connectURI,
    };
  }

  getSubAccounts(): SubAccountRecord[] {
    return getSubAccounts();
  }

  getPendingInvoices(subAccountId: string): PendingInvoiceRecord[] {
    return listPendingForSubAccount(subAccountId);
  }

  getConnectURI(subAccountId: string): string | null {
    const record = getSubAccountById(subAccountId);
    if (!record) return null;
    const secrets = getSubAccountSecrets(subAccountId);
    const relays = record.relays.length ? record.relays : this.relays;
    return createWalletConnectURI({
      service: record.servicePubkey,
      secret: secrets.clientSecret,
      relays,
    });
  }

  private async ensureContext(servicePubkey: string): Promise<ServiceContext | null> {
    const existing = this.contextsByServiceKey.get(servicePubkey);
    if (existing) return existing;

    const record = getSubAccountByServicePubkey(servicePubkey);
    if (!record) {
      console.warn("Received request for unknown service pubkey", servicePubkey);
      return null;
    }

    const secrets = getSubAccountSecrets(record.id);
    const signer = SimpleSigner.fromKey(secrets.serviceSecret);
    WalletService.pool = this.pool;

    const events$ = new Subject<any>();
    const relays = record.relays.length ? record.relays : this.relays;

    const service = new WalletService({
      relays,
      signer,
      secret: hexToBytes(secrets.clientSecret),
      subscriptionMethod: () => events$.asObservable(),
      publishMethod: (targetRelays, event) => this.pool.publish(targetRelays, event),
      handlers: this.buildHandlers(record.id),
      notifications: ["payment_received"],
    });

    await service.start();

    const context: ServiceContext = { record, secrets, signer, events$, service };
    this.contextsById.set(record.id, context);
    this.contextsByServiceKey.set(servicePubkey, context);

    return context;
  }

  private buildHandlers(subAccountId: string) {
    return {
      get_balance: async () => {
        const refreshed = getSubAccountById(subAccountId);
        const balance = refreshed?.balanceMsats ?? 0;
        touchSubAccount(subAccountId);
        return { balance };
      },
      get_info: async () => {
        touchSubAccount(subAccountId);
        return await this.upstream.getInfo();
      },
      pay_invoice: async (params: { invoice: string; amount?: number }) => {
        const record = getSubAccountById(subAccountId);
        if (!record) throw new Error("Sub account not found");
        const amountMsats = resolveInvoiceAmount(params.invoice, params.amount ?? null);
        if (record.balanceMsats < amountMsats) {
          throw new Error("Insufficient balance");
        }
        const result = await this.upstream.payInvoice(params.invoice, params.amount);
        const updated = adjustBalance(subAccountId, -amountMsats);
        this.updateContextRecord(updated);
        touchSubAccount(subAccountId);
        return result;
      },
      make_invoice: async (params: { amount: number; description?: string; expiry?: number; description_hash?: string }) => {
        const transaction = await this.upstream.makeInvoice(
          params.amount,
          params
        );
        const id =
          transaction.payment_hash || transaction.invoice || randomUUID();
        registerPendingInvoice({
          subAccountId,
          id,
          invoice: transaction.invoice,
          paymentHash: transaction.payment_hash,
          descriptionHash: transaction.description_hash,
          amountMsats: transaction.amount ?? params.amount,
          expiresAt: transaction.expires_at ?? null,
          rawTransaction: transaction as unknown as Record<string, unknown>,
        });
        touchSubAccount(subAccountId);
        const refreshed = getSubAccountById(subAccountId);
        if (refreshed) this.updateContextRecord(refreshed);
        return transaction;
      },
      lookup_invoice: async (params: { payment_hash?: string; invoice?: string }) => {
        const check = await this.upstream.lookupInvoice(
          params.payment_hash,
          params.invoice
        );
        if (check.state === "settled") {
          const pending = this.findMatchingPending({
            paymentHash: check.payment_hash,
            invoice: check.invoice,
            descriptionHash: check.description_hash,
          });
          if (pending) {
            this.settlePending(pending, check.amount ?? pending.amountMsats);
          }
        }
        return check;
      },
    };
  }

  private findMatchingPending(criteria: PendingLookupCriteria): PendingInvoiceRecord | undefined {
    return findPendingInvoice(criteria);
  }

  private settlePending(pending: PendingInvoiceRecord, amountMsats: number): void {
    updatePendingInvoiceState(pending.id, "settled", { settledAt: new Date().toISOString() });
    adjustBalance(pending.subAccountId, amountMsats);
    const refreshed = getSubAccountById(pending.subAccountId);
    if (refreshed) this.updateContextRecord(refreshed);
  }

  private updateContextRecord(record: SubAccountRecord): void {
    const context = this.contextsById.get(record.id);
    if (!context) return;
    context.record = record;
    this.contextsByServiceKey.set(record.servicePubkey, context);
  }

  private addServiceKey(servicePubkey: string): void {
    this.serviceKeySet.add(servicePubkey);
    this.serviceKeys$.next(Array.from(this.serviceKeySet));
  }

  private rebuildServiceKeySet(keys: string[]): void {
    this.serviceKeySet.clear();
    keys.forEach((key) => this.serviceKeySet.add(key));
    this.serviceKeys$.next(Array.from(this.serviceKeySet));
  }

  private async routeEvent(servicePubkey: string, event: any): Promise<void> {
    const context = await this.ensureContext(servicePubkey);
    if (!context) return;
    if (event.pubkey !== context.service.client) {
      // WalletService will perform its own filtering but log for visibility
      console.warn(
        "Wallet request pubkey mismatch",
        servicePubkey,
        event.pubkey,
        context.service.client
      );
    }
    context.events$.next(event);
    touchSubAccount(context.record.id);
    const refreshed = getSubAccountById(context.record.id);
    if (refreshed) this.updateContextRecord(refreshed);
  }

  private async bootstrapUpstreamNotifications(): Promise<void> {
    try {
      if (await this.upstream.supportsNotifications()) {
        this.upstream.notification("payment_received", async (notification: any) => {
          if (notification.type !== "incoming") return;
          const pending = this.findMatchingPending({
            paymentHash: notification.payment_hash,
            invoice: notification.invoice,
            descriptionHash: notification.description_hash,
          });
          if (!pending) return;
          this.settlePending(
            pending,
            notification.amount ?? pending.amountMsats
          );
          const context = this.contextsById.get(pending.subAccountId);
          if (context) {
            try {
              await context.service.notify("payment_received", notification);
            } catch (error) {
              console.error("Failed to forward payment notification", error);
            }
          }
        });
      }
    } catch (error) {
      console.error("Failed to configure upstream notifications", error);
    }
  }
}
