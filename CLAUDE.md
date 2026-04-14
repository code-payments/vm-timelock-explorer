# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`vm-timelock-explorer` is a static web app for exploring VM timelock accounts on Solana. It is designed to be deployed as-is to GitHub Pages — no build step, no bundler, no package manifest.

The current scaffold implements wallet connection only. Core timelock-explorer logic has not been written yet.

## Stack

- Plain HTML + CSS + vanilla JS (ES modules via `<script type="module">`)
- No dependencies, no build tooling, no package.json
- Solana wallet integration uses injected browser-extension providers directly (no `@solana/wallet-adapter-*` packages)

Keep the stack minimal. Before adding a build step, bundler, or npm dependencies, confirm with the user — the zero-build constraint is deliberate so the repo can be served directly by GitHub Pages.

## Files

- `index.html` — page structure: status pill, wallet picker, connected view, empty state
- `styles.css` — dark theme, CSS custom properties on `:root`
- `app.js` — wallet detection, connect/disconnect, event binding
- `README.md` — local serve + GitHub Pages deploy instructions

## Wallet integration

`app.js` defines a `WALLETS` array. Each entry has `{ id, name, getProvider }` where `getProvider()` returns the injected provider object (or `null` if the extension is not installed). Currently supported: Phantom, Solflare, Backpack.

Providers share a minimal contract:
- `connect()` → `{ publicKey }`
- `disconnect()`
- `publicKey.toString()` → base58 address
- `on('disconnect', ...)` and `on('accountChanged', ...)` events

To add a new wallet, append an entry to `WALLETS` with the correct `window.*` detection. Solflare injects asynchronously, so `init()` runs on both initial script load and `window.load`.

## Local development

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Wallet extensions must be installed in the browser to test connection flows.

There is no test suite or linter configured yet.

## Deployment

GitHub Pages serves the repo root directly. Pushing to `main` and enabling Pages (source: `main` / root) is the full deploy process.
