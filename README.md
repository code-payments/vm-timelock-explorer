# vm-timelock-explorer

A static web app for exploring VM timelock accounts, deployable to GitHub Pages.

## Local development

No build step — open `index.html` in a browser, or serve the directory:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying to GitHub Pages

1. Push to `main`.
2. In the repo settings, enable **Pages** → source: `main` branch, `/` (root).
3. The app will be served at `https://<user>.github.io/vm-timelock-explorer/`.

## Supported wallets

Detects wallets via their injected browser-extension providers:

- [Phantom](https://phantom.app/)
- [Solflare](https://solflare.com/)
- [Backpack](https://backpack.app/)
