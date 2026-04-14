# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`vm-timelock-explorer` is a static web app for exploring VM timelock accounts on Solana. It is designed to be deployed as-is to GitHub Pages — no build step, no bundler, no package manifest.

Given a VM address and a connected wallet, the app queries an indexer for that wallet's virtual timelock accounts on that VM, then enriches the results with mint decimals and Metaplex token metadata from a Solana RPC.

## Stack

- Plain HTML + CSS + vanilla JS (ES modules via `<script type="module">`)
- Solana libraries (`@solana/web3.js`, `bs58`) loaded from the `esm.sh` CDN via an import map in `index.html` — no bundler, no `package.json`, no `node_modules`
- Solana wallet integration uses injected browser-extension providers directly (no `@solana/wallet-adapter-*` packages)

Before adding a bundler or moving to npm-managed dependencies, confirm with the user — the no-build constraint is deliberate so the repo can be served directly by GitHub Pages. Adding new CDN imports to the import map is fine; pin a specific version (not `@latest` / bare major) so deploys are reproducible.

## Files

- `index.html` — page structure: status pill, wallet picker, connected view with VM/indexer/RPC inputs, search button, results, empty state
- `styles.css` — dark theme, CSS custom properties on `:root`. Note the `[hidden] { display: none !important }` override — needed because `.connected-view { display: flex }` has equal specificity to the UA `[hidden]` rule and would otherwise win.
- `app.js` — wallet detection, connect/disconnect, indexer search, RPC mint + metadata lookup, result rendering
- `README.md` — local serve + GitHub Pages deploy instructions

## Wallet integration

`app.js` defines a `WALLETS` array. Each entry has `{ id, name, getProvider }` where `getProvider()` returns the injected provider object (or `null` if the extension is not installed). Currently supported: Phantom, Solflare, Backpack.

Providers share a minimal contract:
- `connect()` → `{ publicKey }`
- `disconnect()`
- `publicKey.toString()` → base58 address
- `on('disconnect', ...)` and `on('accountChanged', ...)` events

To add a new wallet, append an entry to `WALLETS` with the correct `window.*` detection. Solflare injects asynchronously, so `init()` runs on both initial script load and `window.load` (guarded so it won't clobber an active session).

## Indexer search

The search calls the indexer's Connect-RPC endpoint:

```
POST {indexerUrl}/code.vm.v1.Indexer/GetVirtualTimelockAccounts
{ "vmAccount": { "value": "<base64>" }, "owner": { "value": "<base64>" } }
```

Solana addresses are 32 raw bytes. On the wire they're proto3-JSON-encoded as base64 inside a `{ value: ... }` wrapper; the UI shows them as base58. `addressFromBase58` / `addressToBase58` bridge the two.

Response shape (partial): `{ result, items: [{ account: { balance, nonce }, storage: { memory: { account, index } }, slot }] }`. A `NOT_FOUND` result or empty `items` renders the empty state.

Default indexer URL in `index.html` is `http://localhost:8086` — developers are expected to be running the indexer locally.

## Mint + metadata enrichment (RPC)

When search results exist and an RPC URL is set, the app reads the VM account directly from Solana to display balances in token units instead of raw quarks:

1. `getAccountInfo(vmAddress)` → parse `CodeVmAccount`. The mint lives at bytes `[40, 72)` of the account data (matching `code-vm/idl/code_vm.accounts.hexpat` — 8-byte account header then the `CodeVmAccount` struct starting with `authority` then `mint`).
2. `getTokenSupply(mint)` → decimals.
3. Derive the Metaplex metadata PDA with `PublicKey.findProgramAddressSync(["metadata", programId, mint], programId)` under `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`, then `getAccountInfo` it. Parse name + symbol from the `DataV2` borsh layout (length-prefixed strings, null-padded, trimmed) — the borsh parse is inline in `parseMetadataAccount` rather than pulling in `@metaplex-foundation/mpl-token-metadata`.

Mint info is cached in-memory per VM address (`mintInfoCache`) so repeat searches on the same VM skip the RPC round trips. Metadata failure is non-fatal — the search still renders with just decimals.

Default RPC URL is `https://explorer-rpc.getcode.com`.

## Balance formatting

`formatTokenAmount` uses string math (not `Number`) because balances are u64 and can exceed `Number.MAX_SAFE_INTEGER`. It splits the digit string at `length - decimals` and trims trailing fractional zeros.

## Local development

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Wallet extensions must be installed in the browser to test connection flows. An indexer (default `localhost:8086`) must be reachable to exercise search.

There is no test suite or linter configured yet.

## Deployment

GitHub Pages serves the repo root directly. Pushing to `main` and enabling Pages (source: `main` / root) is the full deploy process.
