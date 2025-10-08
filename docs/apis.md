# API Endpoints

The HTTP API is served by `api.ts` and listens on `PORT` (default `8787`). If `AUTH_API` is set, all endpoints except `/api/health` require authorization via header or query param.

## Authorization
- Header: `Authorization: Bearer <AUTH_API>`
- Or query param: `?auth=<AUTH_API>`

## Endpoints

### GET /api/health
- Description: Health check.
- Auth: Not required.
- Response: `{ "ok": true }`
 - Example:
   - `curl http://localhost:8787/api/health`

### GET /api/wallets
- Description: List configured NWC wallets by nickname and npub.
- Auth: Required if `AUTH_API` is set.
- Response: `{ "wallets": [{ "nickname": string, "npub": string | null }] }`
 - Example:
   - Header: `Authorization: Bearer <AUTH_API>`
   - `curl -H "Authorization: Bearer $AUTH_API" http://localhost:8787/api/wallets`
   - Or: `curl "http://localhost:8787/api/wallets?auth=$AUTH_API"`

### GET /api/balance
- Description: Get balance from a specific wallet.
- Auth: Required if `AUTH_API` is set.
- Query: `nickname` (string; required)
- Response: Proxied response from `WalletConnect.getBalance()`.
 - Query example:
   - `GET /api/balance?nickname=mywallet`
   - With auth param: `/api/balance?nickname=mywallet&auth=$AUTH_API`
 - curl example:
   - `curl -H "Authorization: Bearer $AUTH_API" "http://localhost:8787/api/balance?nickname=mywallet"`

### POST /api/getInvoice
- Description: Create a new invoice from a wallet.
- Auth: Required if `AUTH_API` is set.
- Body (JSON):
  - `nickname` (string; required)
  - `amount` (number; sats; required)
  - `description` (string; optional)
- Response: Proxied response from `WalletConnect.makeInvoice()`.
 - Body example:
   ```json
   {
     "nickname": "mywallet",
     "amount": 2500,
     "description": "Coffee"
   }
   ```
 - curl example:
   - `curl -H "Authorization: Bearer $AUTH_API" -H "Content-Type: application/json" -d '{"nickname":"mywallet","amount":2500,"description":"Coffee"}' http://localhost:8787/api/getInvoice`

### POST /api/payInvoice
- Description: Pay a BOLT11 invoice using a wallet.
- Auth: Required if `AUTH_API` is set.
- Body (JSON):
  - `nickname` (string; required)
  - `invoice` (string; required)
- Response: Proxied response from `WalletConnect.payInvoice()`.
 - Body example:
   ```json
   {
     "nickname": "mywallet",
     "invoice": "lnbc1..."
   }
   ```
 - curl example:
   - `curl -H "Authorization: Bearer $AUTH_API" -H "Content-Type: application/json" -d '{"nickname":"mywallet","invoice":"lnbc1..."}' http://localhost:8787/api/payInvoice`

### POST /api/payLNAddress
- Description: Pay a Lightning Address (LNURL-pay flow).
- Auth: Required if `AUTH_API` is set.
- Body (JSON):
  - `nickname` (string; required)
  - `lnaddress` (string; required)
  - `amount` (number; sats; required)
  - `comment` (string; optional)
- Notes: Validates sendable range, description hash (if available), and pays the returned invoice.
- Response: `{ "payRes": <pay result>, "successAction": <object|null> }`
 - Body example:
   ```json
   {
     "nickname": "mywallet",
     "lnaddress": "alice@nostrplebs.com",
     "amount": 1000,
     "comment": "Thanks!"
   }
   ```
 - curl example:
   - `curl -H "Authorization: Bearer $AUTH_API" -H "Content-Type: application/json" -d '{"nickname":"mywallet","lnaddress":"alice@nostrplebs.com","amount":1000,"comment":"Thanks!"}' http://localhost:8787/api/payLNAddress`

## Notes
- Source: `api.ts`
- Server starts listening with: `bun run api` or equivalent (see `package.json`).
- Env:
  - `PORT`: server port (default `8787`).
  - `AUTH_API`: bearer token enabling auth.
