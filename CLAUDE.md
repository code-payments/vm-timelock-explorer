# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`vm-timelock-explorer` is a static web app for exploring VM timelock accounts on Solana. It is designed to be deployed as-is to GitHub Pages — no build step, no bundler, no package manifest.

Given a connected wallet, the app queries an indexer for that wallet's virtual timelock accounts across all VMs, then enriches the results with mint decimals, Metaplex token metadata, and off-chain metadata (token images) from a Solana RPC.

## Stack

- Plain HTML + CSS + vanilla JS (ES modules via `<script type="module">`)
- Solana and crypto libraries (`@solana/web3.js`, `bs58`, `@scure/bip39`, `@noble/hashes`) loaded from the `esm.sh` CDN via an import map in `index.html` — no bundler, no `package.json`, no `node_modules`
- Wallet is derived locally from a user-supplied BIP39 mnemonic — no browser extension / wallet-adapter dependency

Before adding a bundler or moving to npm-managed dependencies, confirm with the user — the no-build constraint is deliberate so the repo can be served directly by GitHub Pages. Adding new CDN imports to the import map is fine; pin a specific version (not `@latest` / bare major) so deploys are reproducible. Prefer browser-native CJS-free libraries (`@scure/*`, `@noble/*`) — older CJS libs that rely on Node's Buffer/crypto polyfills (e.g. `bip39`, `ed25519-hd-key`, `create-hmac`) fail at runtime on esm.sh with errors like "Class constructor X cannot be invoked without 'new'".

## Files

- `index.html` — page structure: `#connect-view` (warning banner, 12-cell Access Key grid, connect button) and `#connected-view` (wallet info bar, low-balance warning, results, disconnect button). The wallet info bar lives inside `#connected-view` so the address and SOL balance are hidden until a successful connect.
- `styles.css` — dark theme, CSS custom properties on `:root`. Note the `[hidden] { display: none !important }` override — needed because flex containers (`.search-view`, `.results`) have equal specificity to the UA `[hidden]` rule and would otherwise win.
- `app.js` — mnemonic-based wallet derivation + signing, indexer search, RPC mint + metadata lookup, off-chain metadata fetch, unlock + withdraw transaction building + submission, result rendering
- `README.md` — local serve + GitHub Pages deploy instructions

## Wallet integration

The app derives a Solana keypair from a user-supplied 12-word BIP39 mnemonic (branded in the UI as "Access Key") — there is no browser-extension / wallet-adapter integration. The connect view renders 12 numbered input cells via `renderMnemonicInputs()`; `onMnemonicPaste` splits whitespace-separated pasted text across all 12 cells starting at index 0 (regardless of which cell was focused), and `onMnemonicKeydown` advances focus on space/Enter and rewinds on backspace-from-empty. `readMnemonic()` joins the cells into a single space-separated phrase.

`connectWithMnemonic`:

1. Normalize the input (trim, lowercase, collapse whitespace) and enforce exactly `MNEMONIC_WORD_COUNT` (12) words.
2. Validate with `@scure/bip39` `validateMnemonic(mnemonic, bip39English)`.
3. `mnemonicToSeed(mnemonic)` → 64-byte seed.
4. `deriveSlip10Ed25519(seed, "m/44'/501'/0'/0'")` performs SLIP-0010 hardened-only Ed25519 derivation using `hmac(sha512, ...)` from `@noble/hashes`. This matches what Phantom/Solflare/`solana-keygen` produce for the first account — verified against `ed25519-hd-key`'s output for the three standard BIP39 test mnemonics.
5. `Keypair.fromSeed(derivedSeed)` yields the wallet keypair, stored in `active = { keypair, publicKey }`.

Transactions are signed locally with `tx.sign(active.keypair)` (no `provider.signTransaction` round trip). On disconnect the `active` reference is nulled and the mnemonic inputs are cleared; there is no persistence. SOL balance is polled every 5 seconds while connected (`startSolBalancePolling` / `stopSolBalancePolling`).

Security note: pasting a seed phrase into a static web page is inherently higher-risk than an isolated signer like Phantom — a supply-chain compromise of any CDN'd dependency (esm.sh, `@solana/web3.js`, `bs58`, `@scure/bip39`, `@noble/hashes`) would exfiltrate the phrase. The `#connect-view` includes a prominent warning and the user is instructed to only connect on trusted sites.

When the wallet's SOL balance drops below `LOW_BALANCE_LAMPORTS` (0.005 SOL), a warning banner (`#low-balance-warning`) appears and all SOL-gated buttons (unlock, send) are disabled. The `currentLamports` variable tracks the latest balance; `hasSufficientSol()` is the single predicate, and `updateSolGatedButtons()` re-evaluates all buttons with `[data-sol-gate=unlock]` plus withdraw send buttons whenever the balance changes.

## Indexer search

The search calls the indexer's Connect-RPC endpoint:

```
POST {INDEXER_URL}/code.vm.v1.Indexer/SearchVirtualTimelockAccounts
{ "owner": { "value": "<base64>" } }
```

The indexer URL (`INDEXER_URL`) and RPC URL (`RPC_URL`) are constants defined at the top of `app.js` — there are no user-facing input fields for these. Default indexer is `http://localhost:8086`; default RPC is `https://solana-rpc.flipcash.com`.

This searches across all VMs the indexer tracks — no VM address input is needed. Each result item includes a `vmAccount` field identifying which VM it belongs to.

Solana addresses are 32 raw bytes. On the wire they're proto3-JSON-encoded as base64 inside a `{ value: ... }` wrapper; the UI shows them as base58. `addressFromBase58` / `addressToBase58` bridge the two.

Response shape (partial): `{ result, items: [{ account: { balance, nonce }, storage: { memory: { account, index } }, slot, vmAccount: { value } }] }`. A `NOT_FOUND` result or empty `items` renders the empty state. Results are grouped by VM address (`vmGroups` Map) for batched RPC enrichment per VM (vm info, unlock state, withdraw receipts). Results are sorted alphabetically by token name before rendering. Items with zero balance and items with an existing withdraw receipt are filtered out. Withdraw receipts are checked by deriving a PDA from `(unlockPda, nonce, vm)` via `findWithdrawReceiptAddress` under `vmZ1WUq8SxjBWcaeTCvgJRZbS84R61uniFsQy5YMRTJ`; if the account exists on-chain, the item has already been withdrawn. Receipts are only fetched when the VM's on-chain unlock state is UNLOCKED (state=1). The results header includes a refresh button to re-run the search; while loading, a spinning refresh icon is shown with a 2-second minimum display time to prevent flash.

## Mint + metadata enrichment (RPC)

When search results exist, the app reads each VM account directly from Solana to display balances in token units instead of raw quarks:

1. `getAccountInfo(vmAddress)` → parse `CodeVmAccount` (8-byte account header, then `authority` at [8, 40), `mint` at [40, 72), `lock_duration` at byte 145). Authority and lock duration are also needed for timelock PDA derivation in the unlock flow.
2. `getTokenSupply(mint)` → decimals.
3. Derive the Metaplex metadata PDA with `PublicKey.findProgramAddressSync(["metadata", programId, mint], programId)` under `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`, then `getAccountInfo` it. Parse name, symbol, and URI from the `DataV2` borsh layout (length-prefixed strings, null-padded, trimmed) — the borsh parse is inline in `parseMetadataAccount` rather than pulling in `@metaplex-foundation/mpl-token-metadata`.
4. If a metadata URI exists, fetch the off-chain JSON and extract the `image` field for display in result cards.

VM info is cached in-memory per VM address (`vmInfoCache`) so repeat searches on the same VM skip the RPC round trips. Metadata failure is non-fatal — the search still renders with just decimals.

## Result card rendering

Each result card (`data-vm`, `data-nonce` attributes for targeted refresh) displays a token image (from off-chain metadata), formatted balance with token name, and a status indicator. Locked and Unlocking states show a colored status dot (red for Locked, yellow for Unlocking) with detail text. Locked cards display the lock duration in days (e.g. "Funds are locked for 21 days") and an unlock icon button (`data-sol-gate="unlock"`) that triggers `startUnlock`. Unlocking cards show the estimated unlock date in en-US locale format (e.g. "April 21, 2026 at 3:30 pm").

Unlocked cards — including WAITING_FOR_TIMEOUT accounts whose `unlock_at` time has passed — don't show a status dot. Instead they display a withdraw row: a destination address text input (validated as a 32-byte base58 address) and a send button that triggers `startWithdraw`. The input listener is guarded so validation stops while a withdraw is in flight (spinner visible). Items with existing withdraw receipts are filtered out entirely and never rendered.

## Unlock transaction flow

`startUnlock` builds and submits an `InitUnlock` instruction to the Code VM program. The flow:

1. Derive the virtual timelock PDA from `(mint, authority, owner, lockDuration)` via `findVirtualTimelockAddress` under `time2Z2SCnn3qYg3ULKVtdkh8YmZ5jFdKicnA1W2YnJ`.
2. Derive the unlock PDA from `(owner, timelockAddress, vm)` via `findUnlockAddress` under `vmZ1WUq8SxjBWcaeTCvgJRZbS84R61uniFsQy5YMRTJ`.
3. Build the instruction (`IX_INIT_UNLOCK = 7`, 1-byte discriminator, no trailing args). Account order mirrors `sdk.rs timelock_unlock_init`.
4. Sign locally with `tx.sign(active.keypair)`, send via `sendTransaction` RPC, then poll `waitForUnlockStateCreated` — checks both the unlock PDA account and `getSignatureStatuses` each second for up to 60 attempts.
5. On success, calls `refreshCardsForVm` to re-fetch the unlock state and re-render only the cards for that VM (avoids a full `searchTimelocks` round trip). The last search body and per-VM context are retained in `lastSearchBody` / `lastVmContext` so individual cards can be re-rendered without a full refresh. During the unlock the button shows a spinner icon; no progress text is written to the card. A success banner is shown after completion.

The UnlockStateAccount layout: 8-byte header, then `vm` (32), `owner` (32), `address` (32), `unlock_at` (i64 LE at offset 104), `bump` (u8), `state` (u8 at offset 113). `TIMELOCK_STATE`: 0 = UNKNOWN, 1 = UNLOCKED, 2 = WAITING_FOR_TIMEOUT.

## Withdraw transaction flow

`startWithdraw` builds and submits a withdraw transaction for an unlocked item. The flow:

1. Derive the same timelock and unlock PDAs used in the unlock flow, plus `findVmOmnibusAddress` (seeds: `[CODE_VM_SEED, VM_OMNIBUS_SEED, vm]`) and the withdraw receipt PDA.
2. Derive the destination's associated token account via `findAssociatedTokenAddress` (standard ATA derivation under `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`).
3. Build the transaction with up to three instructions in order:
   - `buildCreateAtaIdempotentInstruction` — creates the destination ATA if it doesn't exist (discriminator byte `1` = CreateIdempotent).
   - `buildUnlockFinalizeInstruction` (`IX_UNLOCK = 15`) — only included when the unlock state is WAITING_FOR_TIMEOUT, to finalize the unlock before withdrawing.
   - `buildWithdrawFromMemoryInstruction` (`IX_WITHDRAW = 14`, `WithdrawIxData::FromMemory = 0`, followed by a 2-byte little-endian account index). Account order mirrors `sdk.rs timelock_withdraw`.
4. Sign locally with `tx.sign(active.keypair)`, send via `sendTransaction` RPC, then poll `waitForWithdrawReceiptCreated` — checks both the withdraw receipt PDA and `getSignatureStatuses` each second for up to 60 attempts.
5. On success, updates `lastVmContext` with the new receipt, removes the card from the DOM, and shows a success banner. On failure, the spinner reverts and an error banner is shown.

## Error and success banners

Error and success feedback uses dynamically created DOM elements (no static HTML). `showError(msg)` creates a `.result-card--error` banner (red-tinted card). When the results header exists (connected state) the banner is inserted before it; otherwise it's prepended into `#connect-view` so connect-time errors appear above the warning. Passing `null` removes any existing error banner. `showSuccess(msg)` / `clearSuccess()` work the same way with `.result-card--success` (green-tinted card). Both are cleared on connect-view reset, new searches, and before unlock/withdraw attempts.

## Balance formatting

`formatTokenAmount` uses string math (not `Number`) because balances are u64 and can exceed `Number.MAX_SAFE_INTEGER`. It splits the digit string at `length - decimals` and displays exactly 2 decimal places (truncated, not rounded), or omits the decimal part if it would be `.00`.

## Local development

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 and paste a 12-word BIP39 mnemonic into the Access Key grid to connect. An indexer (default `localhost:8086`) must be reachable to exercise search.

There is no test suite or linter configured yet.

## Deployment

GitHub Pages serves the repo root directly. Pushing to `main` and enabling Pages (source: `main` / root) is the full deploy process.
