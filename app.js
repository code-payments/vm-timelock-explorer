// Supported Solana wallets. Each entry describes how to locate the
// injected provider on `window` when the wallet's browser extension is
// installed. Providers share a minimal contract: `connect()` returns
// `{ publicKey }`, `disconnect()` tears down the session, and
// `publicKey.toString()` yields a base58 address.
const WALLETS = [
  {
    id: "phantom",
    name: "Phantom",
    getProvider: () => {
      const p = window.phantom?.solana;
      if (p?.isPhantom) return p;
      if (window.solana?.isPhantom) return window.solana;
      return null;
    },
  },
  {
    id: "solflare",
    name: "Solflare",
    getProvider: () => (window.solflare?.isSolflare ? window.solflare : null),
  },
  {
    id: "backpack",
    name: "Backpack",
    getProvider: () => window.backpack?.isBackpack ? window.backpack : null,
  },
];

const els = {
  status: document.getElementById("status"),
  walletList: document.getElementById("wallet-list"),
  walletButtons: document.getElementById("wallet-buttons"),
  connectedView: document.getElementById("connected-view"),
  connectedWallet: document.getElementById("connected-wallet"),
  publicKey: document.getElementById("public-key"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  noWallets: document.getElementById("no-wallets"),
};

let active = null; // { wallet, provider }

function setStatus(state, text) {
  els.status.className = `status status--${state}`;
  els.status.textContent = text;
}

function show(el, visible) {
  el.hidden = !visible;
}

function renderDisconnected(available) {
  active = null;
  setStatus("disconnected", "Not connected");
  show(els.connectedView, false);

  if (available.length === 0) {
    show(els.walletList, false);
    show(els.noWallets, true);
    return;
  }

  show(els.noWallets, false);
  show(els.walletList, true);
  els.walletButtons.replaceChildren();
  for (const wallet of available) {
    const btn = document.createElement("button");
    btn.className = "btn btn--primary";
    btn.textContent = `Connect ${wallet.name}`;
    btn.addEventListener("click", () => connect(wallet));
    els.walletButtons.appendChild(btn);
  }
}

function renderConnected(wallet, publicKey) {
  active = { wallet, provider: wallet.getProvider() };
  setStatus("connected", "Connected");
  show(els.walletList, false);
  show(els.noWallets, false);
  show(els.connectedView, true);
  els.connectedWallet.textContent = wallet.name;
  els.publicKey.textContent = publicKey.toString();
}

async function connect(wallet) {
  const provider = wallet.getProvider();
  if (!provider) {
    renderDisconnected(detectAvailable());
    return;
  }

  setStatus("connecting", `Connecting to ${wallet.name}…`);
  try {
    const resp = await provider.connect();
    const publicKey = resp?.publicKey ?? provider.publicKey;
    if (!publicKey) throw new Error("No public key returned by wallet");

    bindProviderEvents(provider);
    renderConnected(wallet, publicKey);
  } catch (err) {
    console.error("Wallet connection failed:", err);
    setStatus("disconnected", `Connection failed: ${err?.message ?? "unknown error"}`);
  }
}

async function disconnect() {
  if (!active) return;
  try {
    await active.provider.disconnect?.();
  } catch (err) {
    console.warn("Disconnect error:", err);
  }
  renderDisconnected(detectAvailable());
}

function bindProviderEvents(provider) {
  if (typeof provider.on !== "function") return;
  provider.on("disconnect", () => renderDisconnected(detectAvailable()));
  provider.on("accountChanged", (publicKey) => {
    if (publicKey && active) {
      renderConnected(active.wallet, publicKey);
    } else {
      renderDisconnected(detectAvailable());
    }
  });
}

function detectAvailable() {
  return WALLETS.filter((w) => w.getProvider() !== null);
}

els.disconnectBtn.addEventListener("click", disconnect);

// Some wallets (notably Solflare) inject their provider asynchronously
// after `DOMContentLoaded`. Re-scan once the page is fully loaded so
// late arrivals still appear in the connect list.
function init() {
  renderDisconnected(detectAvailable());
}

init();
window.addEventListener("load", init);
