# LN Address (LNURLp) Payments — Integration Guide

This guide shows how this app implements paying Lightning Addresses (LUD‑16) using the LNURL‑pay flow on the client, even when the connected wallet does not natively support `pay_lnaddress`.

Outcome:
- Parse LN Address → fetch LNURL‑pay params → prompt sats/comment → request invoice → verify → pay via existing `pay_invoice`.

Key Files
- `index.ts`: CLI entry and menu
  - New menu item: “Pay LN Address (client)”
  - Flow implementation inside the switch handler
- `utils/lnurl.ts`: LNURL helpers
  - Parse LN Address to LNURLp URL
  - Fetch LNURLp params
  - Request invoice (callback)
  - Verify amount and (best‑effort) description hash
- Reference material
  - Spec: `examples/ln-url-and-pay-specs.md`
  - Prior example helpers: `examples/ln-url-helpers.ts`

End‑to‑End Flow
1) Parse LN Address → LNURLp URL
   - `utils/lnurl.ts` → `parseLightningAddress(name@domain)`
     - Clearnet: `https://<domain>/.well-known/lnurlp/<name>`
     - Onion: `http://<domain>/.well-known/lnurlp/<name>`
   - Used in CLI handler to derive the LNURLp endpoint.

2) Fetch LNURL‑pay parameters
   - `utils/lnurl.ts` → `fetchLnurlpParams(url)`
   - Validates response has `tag === "payRequest"` and returns: `callback`, `minSendable`, `maxSendable`, `metadata`, `commentAllowed`.
   - CLI prints domain and, if present, the `text/plain` description from metadata.

3) Prompt for amount and optional comment
   - Convert bounds from msats to sats: `min = ceil(minSendable/1000)`, `max = floor(maxSendable/1000)`.
   - Prompt user for sats within bounds.
   - If `commentAllowed > 0`, prompt for comment and truncate to allowed length.

4) Request a BOLT11 invoice
   - `utils/lnurl.ts` → `requestInvoice(callback, msats, { comment })`
   - Issues a GET to the callback URL with `amount=<msats>&comment=<optional>`.
   - Expects `{ pr, successAction?, ... }`.

5) Verify invoice
   - `utils/lnurl.ts` → `verifyInvoiceAmount(pr, expectedMsats)`
     - Uses `parseBolt11` to ensure the invoice amount matches the requested msats.
   - `utils/lnurl.ts` → `verifyInvoiceDescriptionHashIfAvailable(pr, metadataString)`
     - Best‑effort: computes `sha256(utf8(metadata))` and compares to the invoice `description_hash` if the parser exposes it. If not available, the check is skipped.

6) Pay via NWC `pay_invoice`
   - The CLI calls `wallet.payInvoice(pr)` and prints the result (`preimage`, `fees_paid`, etc.).

7) Handle optional `successAction`
   - If present, prints `message` or `url` info. `aes` payload is acknowledged; decryption not implemented in the CLI.

Where to Look in the Code
- LNURL helpers: `utils/lnurl.ts`
  - `parseLightningAddress` — lines 22–31
  - `fetchLnurlpParams` — lines 33–40
  - `requestInvoice` — lines 42–54
  - `verifyInvoiceAmount` — lines 56–61
  - `verifyInvoiceDescriptionHashIfAvailable` — lines 63–74
- CLI integration: `index.ts`
  - Menu item: add “Pay LN Address (client)” — around lines 118–120
  - Flow implementation (switch case): lines 224–287
- References
  - Spec: `examples/ln-url-and-pay-specs.md`
  - Example helpers (decoding, invoice fetch ideas): `examples/ln-url-helpers.ts`

Adapting to Your Wallet
- Reuse or port the helpers from `utils/lnurl.ts`.
- In your UI/CLI, add a “Pay LN Address (client)” action that:
  - Prompts LN Address → fetches params → shows description/range → prompts sats/comment → requests invoice → verifies → calls your wallet’s pay‑invoice function.
- Ensure your invoice parser exposes amount in msats and, if possible, the `description_hash` for stricter verification.

