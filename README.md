**Nostr Wallet Connect CLI (Bun + TypeScript)**

- Menu-driven Applesauce NWC client to get balance, create invoice, pay invoice, and list transactions. Keeps multiple NWC URIs in `nwc.json`.

**Prerequisites**
- Install Bun: https://bun.sh

**Setup**
- Install deps: `bun install`

**Run**
- Start the CLI: `bun start`
- First run prompts for a nickname and an NWC connection string, then saves to `nwc.json`.
- Later runs let you select an existing saved connection or add a new one.

**Actions**
- Get balance
- Create invoice (amount + optional description)
- Pay invoice (BOLT11)
- List transactions (limit)
- Optional (shown only if supported by your wallet): Lookup invoice, Pay LN Address

**Implementation details**
- Uses a singleton `RelayPool` shared across the session to minimize connection churn.
- Streams handled with RxJS: waits for `support$` with a timeout; subscribes to `notifications$` and prints payment notifications.
- RPC calls have sensible timeouts and friendly messages.
- Clean teardown on Ctrl+C: unsubscribes and closes the relay pool.

**Files**
- `index.ts` — main CLI loop; connects to NWC, detects support, shows menu
- `utils/io.ts` — tiny prompt/print + JSON helpers
- `nwc.json` — saved connections (nickname -> URI)

**Notes**
- Uses `applesauce-relay` + `applesauce-wallet-connect` + `applesauce-core`.
- Ctrl+C to quit at any time.
