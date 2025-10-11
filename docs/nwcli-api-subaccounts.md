# Nostr Wallet Connect Sub-Account API

This document describes the local HTTP endpoints exposed by `nwcli` for managing
parent wallets and sub-accounts. All routes are served by `api.ts`
(launch with `bun run api` or by running the CLI when `START_API` is not `0`).

NOTE THE BASE API URL IS 
"http://dev.otherstuff.studio:8787/"

> **Authentication** — if the environment variable `AUTH_API` is set, each
> request must supply the token via `Authorization: Bearer <token>` or
> `?auth=<token>` query string.

> **Automatic ledger updates** — the API maintains a background watcher for
> every configured wallet. Incoming `payment_received` notifications from the
> upstream NWC session automatically settle pending invoices in `nwc.json`. Use
> the manual refresh endpoint (see below) if you need to force reconciliation.

## Identifier Format

Most endpoints accept a `nickname` query parameter or field. Use one of:

- `walletNickname` – parent wallet context
- `walletNickname:subAccountId` – sub-account context (see `identifier` in
  responses)

The same format can be used with the CLI and JSON API interchangeably.

## List Wallets & Sub-Accounts

```
GET /api/wallets
```

Returns every wallet saved in `nwc.json`, including sub-account metadata and any
stored connect URIs.

Response snippet:

```json
{
  "wallets": [
    {
      "nickname": "BeaconMulti",
      "npub": null,
      "subAccounts": [
        {
          "id": "65fb690a",
          "label": "pete-beacon",
          "identifier": "BeaconMulti:65fb690a",
          "balanceMsats": 21000,
          "pendingMsats": 0,
          "connectUri": null
        }
      ]
    }
  ]
}
```

## Create a Sub-Account

```
POST /api/wallets/:nickname/subaccounts
Content-Type: application/json
```

Body:

```json
{
  "label": "pete-beacon",
  "description": "Internal relay account",
  "connectUri": "nostr+walletconnect://...",   // optional (validated)
  "metadata": { "team": "ops" }               // optional
}
```

Response:

```json
{
  "id": "65fb690a",
  "identifier": "BeaconMulti:65fb690a",
  "subAccount": {
    "id": "65fb690a",
    "label": "pete-beacon",
    "createdAt": "2025-10-10T12:34:56.789Z",
    "updatedAt": "2025-10-10T12:34:56.789Z",
    "balanceMsats": 0,
    "pendingMsats": 0,
    "connectUri": null
  }
}
```

## Retrieve a Connect URI

```
GET /api/wallet/nwc/:nickname/:subId?
```

- `/api/wallet/nwc/BeaconMulti` → parent URI
- `/api/wallet/nwc/BeaconMulti/65fb690a` → sub-account URI (if stored)

## Balance (Parent or Sub-Account)

```
GET /api/balance?nickname=BeaconMulti:65fb690a
```

Returns the local ledger balance for a sub-account, or the upstream wallet
balance when no `subId` is present.

## Create Invoice

```
POST /api/getInvoice
Content-Type: application/json
```

Body (amount in sats):

```json
{
  "nickname": "BeaconMulti:65fb690a",
  "amount": 25,
  "description": "Top up"
}
```

When a sub-account is supplied, the invoice is registered in the local ledger.

## Pay Invoice

```
POST /api/payInvoice
Content-Type: application/json
```

Body:

```json
{
  "nickname": "BeaconMulti:65fb690a",
  "invoice": "lnbc..."
}
```

The upstream wallet settles the invoice via NWC, then the sub-account balance is
debited locally.

## Pay Lightning Address (LNURL-pay)

```
POST /api/payLnAddress
Content-Type: application/json
```

Body:

```json
{
  "nickname": "BeaconMulti:65fb690a",
  "lnAddress": "tips@example.com",
  "amountSats": 10,
  "comment": "Thanks!"        // optional
}
```

The server resolves the LN address, requests the invoice, pays it with the
upstream wallet, and updates the sub-account ledger. Response includes the
payment result and any LNURL success action.

## List Transactions

```
GET /api/transactions?nickname=BeaconMulti&limit=50
```

Relays upstream history (`list_transactions`). Use a sub-account identifier to
keep the context consistent with other calls; the returned transactions are the
wallet’s, because the upstream wallet owns the data.

## Refresh Ledger State

```
POST /api/refreshLedger
Content-Type: application/json
```

Body:

```json
{ "nickname": "BeaconMulti:65fb690a" }
```

Forces a lookup of all pending invoices (across the whole wallet or a specific
sub-account). Any invoice that has settled upstream is credited locally. The
response reports how many invoices were updated.

```json
{
  "data": { "settled": 1 },
  "context": { "identifier": "BeaconMulti:65fb690a", ... }
}
```

## Notes & Limits

- Amount fields supplied in sats are converted to millisatoshis internally.
- Sub-account balances are tracked locally (JSON ledger) unless you run the
  one-to-many service backed by SQLite.
- Use `/api/wallets` after creating sub-accounts to read fresh IDs and connect
  URIs.
- All LNURL operations honour the remote min/max sendable bounds and optional
  comment length restrictions.
