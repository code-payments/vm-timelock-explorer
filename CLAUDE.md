# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`vm-timelock-explorer` is a static web app for exploring VM timelock accounts on Solana. It is designed to be deployed as-is to GitHub Pages — no build step, no bundler, no package manifest.

Given a connected wallet, the app queries an indexer for that wallet's virtual timelock accounts across all VMs, then enriches the results with mint decimals, Metaplex token metadata, and off-chain metadata (token images) from a Solana RPC.

## Stack

- Plain HTML + CSS + vanilla JS (ES modules via `<script type="module">`)
- Solana libraries (`@solana/web3.js`, `bs58`) loaded from the `esm.sh` CDN via an import map in `index.html` — no bundler, no `package.json`, no `node_modules`
- Solana wallet integration uses injected browser-extension providers directly (no `@solana/wallet-adapter-*` packages)

Before adding a bundler or moving to npm-managed dependencies, confirm with the user — the no-build constraint is deliberate so the repo can be served directly by GitHub Pages. Adding new CDN imports to the import map is fine; pin a specific version (not `@latest` / bare major) so deploys are reproducible.

## Files

- `index.html` — page structure: wallet info bar (address + SOL balance), connect button, results list, disconnect button
- `styles.css` — dark theme, CSS custom properties on `:root`. Note the `[hidden] { display: none !important }` override — needed because flex containers (`.search-view`, `.results`) have equal specificity to the UA `[hidden]` rule and would otherwise win.
- `app.js` — Phantom wallet connection, indexer search, RPC mint + metadata lookup, off-chain metadata fetch, unlock transaction building + submission, result rendering
- `README.md` — local serve + GitHub Pages deploy instructions

## Wallet integration

The app uses Phantom exclusively via `getPhantomProvider()`. The UI starts with a "Connect Phantom" button; once connected it shows the wallet info bar (address + SOL balance) and automatically triggers a search. The wallet session is stored in the `active` variable (`{ provider, publicKey }`). If the wallet fires a `disconnect` or `accountChanged` event the session resets to the connect view. SOL balance is polled every 5 seconds while connected (`startSolBalancePolling` / `stopSolBalancePolling`).

## Indexer search

The search calls the indexer's Connect-RPC endpoint:

```
POST {INDEXER_URL}/code.vm.v1.Indexer/SearchVirtualTimelockAccounts
{ "owner": { "value": "<base64>" } }
```

The indexer URL (`INDEXER_URL`) and RPC URL (`RPC_URL`) are constants defined at the top of `app.js` — there are no user-facing input fields for these. Default indexer is `http://localhost:8086`; default RPC is `https://solana-rpc.flipcash.com`.

This searches across all VMs the indexer tracks — no VM address input is needed. Each result item includes a `vmAccount` field identifying which VM it belongs to.

Solana addresses are 32 raw bytes. On the wire they're proto3-JSON-encoded as base64 inside a `{ value: ... }` wrapper; the UI shows them as base58. `addressFromBase58` / `addressToBase58` bridge the two.

Response shape (partial): `{ result, items: [{ account: { balance, nonce }, storage: { memory: { account, index } }, slot, vmAccount: { value } }] }`. A `NOT_FOUND` result or empty `items` renders the empty state. Results are grouped by VM address (`vmGroups` Map) for batched RPC enrichment per VM (vm info, unlock state, withdraw receipts). Results are sorted alphabetically by token name before rendering. Items with zero balance and items with an existing withdraw receipt are filtered out. The results header includes a refresh button to re-run the search; while loading, a spinning refresh icon is shown with a 2-second minimum display time to prevent flash.

## Mint + metadata enrichment (RPC)

When search results exist, the app reads each VM account directly from Solana to display balances in token units instead of raw quarks:

1. `getAccountInfo(vmAddress)` → parse `CodeVmAccount`. The mint lives at bytes `[40, 72)` of the account data (matching `code-vm/idl/code_vm.accounts.hexpat` — 8-byte account header then the `CodeVmAccount` struct starting with `authority` then `mint`).
2. `getTokenSupply(mint)` → decimals.
3. Derive the Metaplex metadata PDA with `PublicKey.findProgramAddressSync(["metadata", programId, mint], programId)` under `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`, then `getAccountInfo` it. Parse name, symbol, and URI from the `DataV2` borsh layout (length-prefixed strings, null-padded, trimmed) — the borsh parse is inline in `parseMetadataAccount` rather than pulling in `@metaplex-foundation/mpl-token-metadata`.
4. If a metadata URI exists, fetch the off-chain JSON and extract the `image` field for display in result cards.

VM info is cached in-memory per VM address (`vmInfoCache`) so repeat searches on the same VM skip the RPC round trips. Metadata failure is non-fatal — the search still renders with just decimals.

## Result card rendering

Each result card displays a token image (from off-chain metadata), formatted balance with token name, and a status indicator. The status uses a colored dot: red for Locked, yellow for Unlocking, green for Unlocked, gray for Withdrawn. Unlock/unlocking dates are displayed in the user's locale (e.g. "April 21, 2026 at 3:30 pm") rather than ISO format.

Locked cards show an unlock icon button that triggers `startUnlock`. Unlocked cards show a withdraw row: a destination address text input (validated as a 32-byte base58 address) and a send button. The withdraw transaction is not yet implemented — only the UI and input validation are wired up.

## Unlock transaction flow

`startUnlock` builds and submits an `InitUnlock` instruction to the Code VM program. The flow:

1. Derive the virtual timelock PDA from `(mint, authority, owner, lockDuration)` via `findVirtualTimelockAddress` under `time2Z2SCnn3qYg3ULKVtdkh8YmZ5jFdKicnA1W2YnJ`.
2. Derive the unlock PDA from `(owner, timelockAddress, vm)` via `findUnlockAddress` under `vmZ1WUq8SxjBWcaeTCvgJRZbS84R61uniFsQy5YMRTJ`.
3. Build the instruction (`IX_INIT_UNLOCK = 7`, 1-byte discriminator, no trailing args). Account order mirrors `sdk.rs timelock_unlock_init`.
4. Sign via `provider.signTransaction`, send via `sendTransaction` RPC, then poll `waitForUnlockStateCreated` — checks both the unlock PDA account and `getSignatureStatuses` each second for up to 60 attempts.
5. On success, re-runs `searchTimelocks` to refresh the display. Progress stages ("Preparing…", "Awaiting wallet…", "Sending…", "Waiting for unlock…") are shown in the card's detail text.

The UnlockStateAccount layout: 8-byte header, then `vm` (32), `owner` (32), `address` (32), `unlock_at` (i64 LE at offset 104), `bump` (u8), `state` (u8 at offset 113). `TIMELOCK_STATE`: 0 = UNKNOWN, 1 = UNLOCKED, 2 = WAITING_FOR_TIMEOUT.

## Balance formatting

`formatTokenAmount` uses string math (not `Number`) because balances are u64 and can exceed `Number.MAX_SAFE_INTEGER`. It splits the digit string at `length - decimals` and displays exactly 2 decimal places (truncated, not rounded), or omits the decimal part if it would be `.00`.

## Local development

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Wallet extensions must be installed in the browser to test connection flows. An indexer (default `localhost:8086`) must be reachable to exercise search.

There is no test suite or linter configured yet.

## Deployment

GitHub Pages serves the repo root directly. Pushing to `main` and enabling Pages (source: `main` / root) is the full deploy process.
