import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import bs58 from "bs58";

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
  vmAddress: document.getElementById("vm-address"),
  indexerUrl: document.getElementById("indexer-url"),
  rpcUrl: document.getElementById("rpc-url"),
  searchBtn: document.getElementById("search-btn"),
  searchError: document.getElementById("search-error"),
  results: document.getElementById("results"),
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
  if (els.results) {
    els.results.hidden = true;
    els.results.replaceChildren();
  }
  if (els.searchError) {
    els.searchError.hidden = true;
    els.searchError.textContent = "";
  }
  if (els.searchBtn) els.searchBtn.disabled = true;

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
  updateSearchEnabled();
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

// --- Wire format helpers --------------------------------------------------
// The Indexer's Connect API takes/returns 32-byte addresses as base64 inside
// a `{ value: ... }` wrapper (proto3 JSON). The UI uses base58 throughout,
// so we need bytes<->base64 helpers to bridge the two.
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  // Accept both standard and URL-safe base64.
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- Indexer search -------------------------------------------------------
function addressFromBase58(str) {
  const bytes = bs58.decode(str.trim());
  if (bytes.length !== 32) {
    throw new Error(`expected 32-byte address, got ${bytes.length} bytes`);
  }
  return { value: bytesToBase64(bytes) };
}

function addressToBase58(addr) {
  if (!addr?.value) return "";
  return bs58.encode(base64ToBytes(addr.value));
}

// --- Metaplex token metadata PDA -----------------------------------------
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const METADATA_PREFIX = new TextEncoder().encode("metadata");

function getMetadataPda(mintBase58) {
  const [pda] = PublicKey.findProgramAddressSync(
    [METADATA_PREFIX, METADATA_PROGRAM_ID.toBytes(), new PublicKey(mintBase58).toBytes()],
    METADATA_PROGRAM_ID,
  );
  return pda.toBase58();
}

// Metaplex Metadata account layout (only the fields we need):
//   key: u8
//   update_authority: Pubkey (32)
//   mint: Pubkey (32)
//   DataV2 {
//     name:   borsh String (u32 LE length prefix + utf-8 bytes, null-padded)
//     symbol: borsh String (same)
//     uri:    borsh String (same)
//     ...
//   }
function parseMetadataAccount(dataBytes) {
  let offset = 1 + 32 + 32;
  const readString = () => {
    if (offset + 4 > dataBytes.length) throw new Error("metadata truncated");
    const len =
      dataBytes[offset] |
      (dataBytes[offset + 1] << 8) |
      (dataBytes[offset + 2] << 16) |
      (dataBytes[offset + 3] << 24);
    offset += 4;
    if (len < 0 || offset + len > dataBytes.length) {
      throw new Error("metadata string length out of range");
    }
    const raw = dataBytes.subarray(offset, offset + len);
    offset += len;
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) end--;
    return new TextDecoder().decode(raw.subarray(0, end));
  };
  const name = readString().trim();
  const symbol = readString().trim();
  return { name, symbol };
}

async function fetchTokenMetadata(rpcUrl, mintBase58) {
  const pda = getMetadataPda(mintBase58);
  const info = await rpcCall(rpcUrl, "getAccountInfo", [
    pda,
    { encoding: "base64" },
  ]);
  const value = info?.value;
  if (!value) return null;
  const [dataB64] = value.data ?? [];
  if (!dataB64) return null;
  return parseMetadataAccount(base64ToBytes(dataB64));
}

// CodeVmAccount layout (see code-vm/idl/code_vm.accounts.hexpat):
//   Account {
//     u8 _type;         // 1 = CodeVmAccount
//     u8 _padding[7];
//     CodeVmAccount {
//       Pubkey authority;       // offset  8 (32 bytes)
//       Pubkey mint;            // offset 40 (32 bytes)
//       u64    slot;            // offset 72
//       Hash   poh;             // offset 80 (32 bytes)
//       Pubkey omnibus.vault;   // offset 112 (32 bytes)
//       u8     omnibus.bump;    // offset 144
//       u8     lock_duration;   // offset 145 (days)
//       ...
//     }
//   }
const VM_ACCOUNT_AUTHORITY_OFFSET = 8;
const VM_ACCOUNT_MINT_OFFSET = 40;
const VM_ACCOUNT_MINT_END = 72;
const VM_ACCOUNT_LOCK_DURATION_OFFSET = 145;

// Code VM program and timelock program IDs, plus seeds used for PDA
// derivation. These mirror api/src/consts.rs + api/src/pdas.rs in the
// code-payments/code-vm repo.
const CODE_VM_PROGRAM_ID = new PublicKey("vmZ1WUq8SxjBWcaeTCvgJRZbS84R61uniFsQy5YMRTJ");
const TIMELOCK_PROGRAM_ID = new PublicKey("time2Z2SCnn3qYg3ULKVtdkh8YmZ5jFdKicnA1W2YnJ");
const CODE_VM_SEED = new TextEncoder().encode("code_vm");
const VM_UNLOCK_ACCOUNT_SEED = new TextEncoder().encode("vm_unlock_pda_account");
const VM_WITHDRAW_RECEIPT_SEED = new TextEncoder().encode("vm_withdraw_receipt_account");
const VM_TIMELOCK_STATE_SEED = new TextEncoder().encode("timelock_state");

// TimelockState enum values from code-vm/api/src/cvm/state/unlock.rs.
const TIMELOCK_STATE = {
  UNKNOWN: 0,
  UNLOCKED: 1,
  WAITING_FOR_TIMEOUT: 2,
};

// CodeInstruction discriminators (see code-vm/api/src/instruction.rs).
// The enum is repr(u8) and starts at Unknown = 0.
const IX_INIT_UNLOCK = 7;

function findVirtualTimelockAddress(mintB58, authorityB58, ownerB58, lockDuration) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      VM_TIMELOCK_STATE_SEED,
      new PublicKey(mintB58).toBytes(),
      new PublicKey(authorityB58).toBytes(),
      new PublicKey(ownerB58).toBytes(),
      new Uint8Array([lockDuration]),
    ],
    TIMELOCK_PROGRAM_ID,
  );
  return pda.toBase58();
}

function findUnlockAddress(ownerB58, timelockAddressB58, vmB58) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      CODE_VM_SEED,
      VM_UNLOCK_ACCOUNT_SEED,
      new PublicKey(ownerB58).toBytes(),
      new PublicKey(timelockAddressB58).toBytes(),
      new PublicKey(vmB58).toBytes(),
    ],
    CODE_VM_PROGRAM_ID,
  );
  return pda.toBase58();
}

// UnlockStateAccount layout inside account data (after 8-byte account header):
//   Pubkey vm;          // offset   8
//   Pubkey owner;       // offset  40
//   Pubkey address;     // offset  72
//   i64    unlock_at;   // offset 104 (little-endian signed, seconds since epoch)
//   u8     bump;        // offset 112
//   u8     state;       // offset 113
const UNLOCK_STATE_UNLOCK_AT_OFFSET = 104;
const UNLOCK_STATE_STATE_OFFSET = 113;

function parseUnlockStateAccount(dataBytes) {
  if (dataBytes.length < UNLOCK_STATE_STATE_OFFSET + 1) {
    throw new Error(`unlock state account truncated: ${dataBytes.length} bytes`);
  }
  const view = new DataView(
    dataBytes.buffer,
    dataBytes.byteOffset,
    dataBytes.byteLength,
  );
  const unlockAt = view.getBigInt64(UNLOCK_STATE_UNLOCK_AT_OFFSET, true);
  const state = dataBytes[UNLOCK_STATE_STATE_OFFSET];
  return { unlockAt: Number(unlockAt), state };
}

function findWithdrawReceiptAddress(unlockPdaB58, nonceB58, vmB58) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      CODE_VM_SEED,
      VM_WITHDRAW_RECEIPT_SEED,
      new PublicKey(unlockPdaB58).toBytes(),
      new PublicKey(nonceB58).toBytes(),
      new PublicKey(vmB58).toBytes(),
    ],
    CODE_VM_PROGRAM_ID,
  );
  return pda.toBase58();
}

async function fetchWithdrawReceipt(rpcUrl, unlockPdaB58, nonceB58, vmB58) {
  const pda = findWithdrawReceiptAddress(unlockPdaB58, nonceB58, vmB58);
  const info = await rpcCall(rpcUrl, "getAccountInfo", [
    pda,
    { encoding: "base64" },
  ]);
  return { pda, exists: Boolean(info?.value) };
}

async function fetchUnlockState(rpcUrl, ownerB58, timelockAddressB58, vmB58) {
  const pda = findUnlockAddress(ownerB58, timelockAddressB58, vmB58);
  const info = await rpcCall(rpcUrl, "getAccountInfo", [
    pda,
    { encoding: "base64" },
  ]);
  const value = info?.value;
  if (!value) return { pda, exists: false };
  const [dataB64] = value.data ?? [];
  if (!dataB64) return { pda, exists: false };
  const parsed = parseUnlockStateAccount(base64ToBytes(dataB64));
  return { pda, exists: true, ...parsed };
}

// Build the InitUnlockIx instruction. Account order and signer/writable
// flags mirror code-vm/api/src/sdk.rs `timelock_unlock_init`. The instruction
// body is just the 1-byte discriminator — `InitUnlockIx` is an empty Pod
// struct, so no trailing args.
function buildInitUnlockInstruction({ accountOwner, payer, vm, unlockPda }) {
  return new TransactionInstruction({
    programId: CODE_VM_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(accountOwner), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(vm), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(unlockPda), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([IX_INIT_UNLOCK]),
  });
}

// Poll the unlock PDA until it materializes on-chain — that's the actual
// state change the user is waiting on. We also check the signature status
// each round so a failed transaction surfaces its error instead of just
// spinning to timeout.
async function waitForUnlockStateCreated({
  rpcUrl,
  ownerB58,
  timelockAddress,
  vmAddress,
  signature,
  maxPolls = 60,
  intervalMs = 1000,
}) {
  for (let i = 0; i < maxPolls; i++) {
    const state = await fetchUnlockState(
      rpcUrl,
      ownerB58,
      timelockAddress,
      vmAddress,
    );
    if (state.exists) return state;

    const resp = await rpcCall(rpcUrl, "getSignatureStatuses", [[signature]]);
    const status = resp?.value?.[0];
    if (status?.err) {
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for unlock state to appear");
}

async function startUnlock(button) {
  if (!active) return;

  const rpcUrl = els.rpcUrl.value.trim().replace(/\/+$/, "");
  if (!rpcUrl) {
    showError("A Solana RPC URL is required to start unlock.");
    return;
  }

  const vmAddress = els.vmAddress.value.trim();
  if (!vmAddress) {
    showError("VM address is required.");
    return;
  }

  const ownerB58 = els.publicKey.textContent;

  showError(null);

  // Disable every "Start Unlock" button on the page — the unlock PDA is
  // shared across every item in the current search, so one click covers
  // all cards.
  const actionButtons = Array.from(
    document.querySelectorAll(".result-card__action"),
  );
  for (const b of actionButtons) b.disabled = true;
  const originalLabel = button.textContent;

  try {
    button.textContent = "Preparing…";
    const vmInfo = await fetchVmInfo(rpcUrl, vmAddress);
    const timelockAddress = findVirtualTimelockAddress(
      vmInfo.mint,
      vmInfo.authority,
      ownerB58,
      vmInfo.lockDuration,
    );
    const unlockPda = findUnlockAddress(ownerB58, timelockAddress, vmAddress);

    const ix = buildInitUnlockInstruction({
      accountOwner: ownerB58,
      payer: ownerB58,
      vm: vmAddress,
      unlockPda,
    });

    const latest = await rpcCall(rpcUrl, "getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const blockhash = latest?.value?.blockhash;
    if (!blockhash) throw new Error("RPC did not return a blockhash");

    const tx = new Transaction();
    tx.add(ix);
    tx.feePayer = new PublicKey(ownerB58);
    tx.recentBlockhash = blockhash;

    button.textContent = "Awaiting wallet…";
    if (typeof active.provider.signTransaction !== "function") {
      throw new Error("wallet does not support signTransaction");
    }
    const signed = await active.provider.signTransaction(tx);

    button.textContent = "Sending…";
    const serialized = signed.serialize();
    const b64 = bytesToBase64(new Uint8Array(serialized));
    const signature = await rpcCall(rpcUrl, "sendTransaction", [
      b64,
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);

    button.textContent = "Waiting for unlock…";
    await waitForUnlockStateCreated({
      rpcUrl,
      ownerB58,
      timelockAddress,
      vmAddress,
      signature,
    });

    await searchTimelocks();
  } catch (err) {
    console.error("Start unlock failed:", err);
    showError(`Start unlock failed: ${err?.message ?? err}`);
    button.textContent = originalLabel;
    for (const b of actionButtons) b.disabled = false;
  }
}

// Cache VM-account-derived info within a session so repeated searches on the
// same VM don't re-query the RPC.
const vmInfoCache = new Map(); // vmAddressBase58 -> { mint, decimals, authority, lockDuration, name, symbol }

async function rpcCall(baseUrl, method, params) {
  const resp = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await resp.json();
  if (body.error) {
    throw new Error(body.error.message || `RPC error: ${method}`);
  }
  return body.result;
}

async function fetchVmInfo(rpcUrl, vmAddressBase58) {
  if (vmInfoCache.has(vmAddressBase58)) {
    return vmInfoCache.get(vmAddressBase58);
  }

  const accountInfo = await rpcCall(rpcUrl, "getAccountInfo", [
    vmAddressBase58,
    { encoding: "base64" },
  ]);
  const value = accountInfo?.value;
  if (!value) throw new Error("VM account not found on this RPC");

  const [dataB64] = value.data ?? [];
  if (!dataB64) throw new Error("VM account returned no data");

  const dataBytes = base64ToBytes(dataB64);
  if (dataBytes.length < VM_ACCOUNT_LOCK_DURATION_OFFSET + 1) {
    throw new Error(`VM account data too short: ${dataBytes.length} bytes`);
  }

  const authorityBytes = dataBytes.slice(
    VM_ACCOUNT_AUTHORITY_OFFSET,
    VM_ACCOUNT_MINT_OFFSET,
  );
  const authority = bs58.encode(authorityBytes);
  const mintBytes = dataBytes.slice(VM_ACCOUNT_MINT_OFFSET, VM_ACCOUNT_MINT_END);
  const mint = bs58.encode(mintBytes);
  const lockDuration = dataBytes[VM_ACCOUNT_LOCK_DURATION_OFFSET];

  const supply = await rpcCall(rpcUrl, "getTokenSupply", [mint]);
  const decimals = supply?.value?.decimals;
  if (typeof decimals !== "number") {
    throw new Error("mint did not return decimals");
  }

  let name = null;
  let symbol = null;
  try {
    const meta = await fetchTokenMetadata(rpcUrl, mint);
    if (meta) {
      name = meta.name || null;
      symbol = meta.symbol || null;
    }
  } catch (err) {
    // Metadata is optional — many tokens have none, and older RPCs may
    // reject the PDA lookup. Surface in console but don't fail the search.
    console.warn("Token metadata lookup failed:", err);
  }

  const info = { mint, decimals, name, symbol, authority, lockDuration };
  vmInfoCache.set(vmAddressBase58, info);
  return info;
}

// Format a uint64 balance string scaled by `decimals`. Uses string math so
// we preserve full precision (JS numbers can't safely represent all u64s).
function formatTokenAmount(balanceStr, decimals) {
  const s = String(balanceStr ?? "0");
  if (!/^\d+$/.test(s)) return s;
  if (decimals === 0) return s;
  const trimmed = s.replace(/^0+/, "") || "0";
  if (trimmed.length <= decimals) {
    const frac = trimmed.padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `0.${frac}` : "0";
  }
  const intPart = trimmed.slice(0, trimmed.length - decimals);
  const fracPart = trimmed.slice(trimmed.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

async function searchTimelocks() {
  if (!active) return;

  const vmInput = els.vmAddress.value.trim();
  const baseUrl = els.indexerUrl.value.trim().replace(/\/+$/, "");
  const rpcUrl = els.rpcUrl.value.trim().replace(/\/+$/, "");

  showError(null);
  els.results.hidden = true;
  els.results.replaceChildren();

  if (!vmInput) {
    showError("Enter a VM address first.");
    return;
  }
  if (!baseUrl) {
    showError("Enter an indexer URL.");
    return;
  }

  let vmAccount;
  try {
    vmAccount = addressFromBase58(vmInput);
  } catch (err) {
    showError(`Invalid VM address: ${err.message}`);
    return;
  }

  const ownerBase58 = active && els.publicKey.textContent;
  let owner;
  try {
    owner = addressFromBase58(ownerBase58);
  } catch (err) {
    showError(`Invalid wallet public key: ${err.message}`);
    return;
  }

  els.searchBtn.disabled = true;
  const originalLabel = els.searchBtn.textContent;
  els.searchBtn.textContent = "Searching…";

  try {
    const resp = await fetch(
      `${baseUrl}/code.vm.v1.Indexer/GetVirtualTimelockAccounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vmAccount, owner }),
      },
    );

    const text = await resp.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // leave body as null; raw text surfaced in error branch below
      }
    }

    if (!resp.ok) {
      const msg = body?.message || text || `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    let vmInfo = null;
    let unlockState = null;
    let withdrawReceipts = null;
    if (rpcUrl && body?.items?.length) {
      try {
        vmInfo = await fetchVmInfo(rpcUrl, vmInput);
      } catch (err) {
        console.warn("VM info lookup failed, falling back to base units:", err);
      }

      // The virtual timelock address is a PDA of (mint, authority, owner,
      // lock_duration), so every item returned by the indexer for a single
      // (VM, owner) query shares the same unlock state account. One lookup
      // per search suffices.
      if (vmInfo) {
        try {
          const timelockAddress = findVirtualTimelockAddress(
            vmInfo.mint,
            vmInfo.authority,
            ownerBase58,
            vmInfo.lockDuration,
          );
          unlockState = await fetchUnlockState(
            rpcUrl,
            ownerBase58,
            timelockAddress,
            vmInput,
          );
          unlockState.timelockAddress = timelockAddress;
        } catch (err) {
          console.warn("Unlock state lookup failed:", err);
        }
      }

      // Once an account is fully unlocked, funds may already have been
      // withdrawn. Each record (one per nonce) gets its own withdraw
      // receipt, so a separate lookup is needed per item.
      if (unlockState?.exists && unlockState.state === TIMELOCK_STATE.UNLOCKED) {
        withdrawReceipts = new Map();
        await Promise.all(
          body.items.map(async (item) => {
            const nonceB58 = item?.account?.nonce
              ? addressToBase58(item.account.nonce)
              : null;
            if (!nonceB58) return;
            try {
              const receipt = await fetchWithdrawReceipt(
                rpcUrl,
                unlockState.pda,
                nonceB58,
                vmInput,
              );
              withdrawReceipts.set(nonceB58, receipt);
            } catch (err) {
              console.warn("Withdraw receipt lookup failed:", err);
            }
          }),
        );
      }
    }

    renderResults(body ?? {}, vmInfo, unlockState, withdrawReceipts);
  } catch (err) {
    console.error("Indexer request failed:", err);
    showError(`Search failed: ${err.message}`);
  } finally {
    els.searchBtn.disabled = false;
    els.searchBtn.textContent = originalLabel;
    updateSearchEnabled();
  }
}

function renderResults(body, vmInfo, unlockState, withdrawReceipts) {
  const container = els.results;
  container.replaceChildren();
  container.hidden = false;

  if (body.result === "NOT_FOUND" || !body.items || body.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "results__empty";
    empty.textContent = "No timelock accounts found for this owner on this VM.";
    container.appendChild(empty);
    return;
  }

  for (const item of body.items) {
    container.appendChild(renderItem(item, vmInfo, unlockState, withdrawReceipts));
  }
}

function describeUnlockState(unlockState, vmInfo, withdrawReceipt) {
  // No RPC lookup was performed (e.g. no RPC URL configured, or the VM
  // account couldn't be read). Say nothing rather than claim "locked".
  if (!unlockState) return null;

  if (!unlockState.exists) {
    const days = vmInfo?.lockDuration;
    const detail = typeof days === "number"
      ? `Funds are locked for ${days} day${days === 1 ? "" : "s"}`
      : "Funds are locked";
    return {
      status: "Locked",
      detail,
    };
  }

  const unlockAtMs = unlockState.unlockAt * 1000;
  const unlockDate = new Date(unlockAtMs);
  const iso = Number.isFinite(unlockAtMs) ? unlockDate.toISOString() : "—";
  const now = Date.now();

  if (unlockState.state === TIMELOCK_STATE.UNLOCKED) {
    if (withdrawReceipt?.exists) {
      return {
        status: "Withdrawn",
        detail: "Funds have been withdrawn from this account",
      };
    }
    return {
      status: "Unlocked",
      detail: `Account is unlocked. Funds can now be withdrawn`,
    };
  }

  if (unlockState.state === TIMELOCK_STATE.WAITING_FOR_TIMEOUT) {
    if (unlockAtMs > now) {
      return {
        status: "Unlocking",
        detail: `Account can be unlocked at ${iso}.`,
      };
    }
    return {
      status: "Ready to complete unlock",
      detail: `Unlock waiting period has passed`,
    };
  }

  return {
    status: `State ${unlockState.state}`,
    detail: `Unlock-at: ${iso}.`,
  };
}

function renderItem(item, vmInfo, unlockState, withdrawReceipts) {
  const card = document.createElement("div");
  card.className = "result-card";

  const nonceB58 = item?.account?.nonce ? addressToBase58(item.account.nonce) : "";
  const withdrawReceipt = nonceB58 ? withdrawReceipts?.get(nonceB58) : null;

  const balanceRaw = item?.account?.balance ?? "0";
  const balance = document.createElement("div");
  balance.className = "result-card__balance";
  if (vmInfo) {
    const formatted = formatTokenAmount(balanceRaw, vmInfo.decimals);
    const suffix = vmInfo.symbol
      ? ` ${vmInfo.symbol}`
      : "";
    balance.textContent = `Balance: ${formatted}${suffix}`;
  } else {
    balance.textContent = `Balance: ${balanceRaw} (quarks)`;
  }
  card.appendChild(balance);

  const unlockInfo = describeUnlockState(unlockState, vmInfo, withdrawReceipt);
  if (unlockInfo) {
    const unlockEl = document.createElement("div");
    unlockEl.className = `result-card__unlock result-card__unlock--${unlockInfo.status
      .toLowerCase()
      .replace(/\s+/g, "-")}`;
    const status = document.createElement("span");
    status.className = "result-card__unlock-status";
    status.textContent = unlockInfo.status;
    const detail = document.createElement("span");
    detail.className = "result-card__unlock-detail";
    detail.textContent = unlockInfo.detail;
    unlockEl.append(status, detail);

    // Offer the "Start Unlock" action when the timelock is still locked —
    // i.e. we queried the unlock PDA and it doesn't exist yet. Once the
    // tx lands, the PDA exists and the next search will show "Unlocking".
    if (unlockState && !unlockState.exists) {
      const actionBtn = document.createElement("button");
      actionBtn.className = "btn btn--primary result-card__action";
      actionBtn.type = "button";
      actionBtn.textContent = "Start Unlock";
      actionBtn.addEventListener("click", () => startUnlock(actionBtn));
      unlockEl.appendChild(actionBtn);
    }

    card.appendChild(unlockEl);
  }

  if (vmInfo) {
    const tokenLabel = vmInfo.name
      ? `${vmInfo.name} mint (${vmInfo.decimals} decimals)`
      : `Mint (${vmInfo.decimals} decimals)`;
    card.appendChild(row(tokenLabel, vmInfo.mint));
  }

  if (unlockState?.exists && unlockState?.pda) {
    card.appendChild(row("Unlock PDA", unlockState.pda));
  }

  if (withdrawReceipt?.exists) {
    card.appendChild(row("Withdraw receipt", withdrawReceipt.pda));
  }

  card.appendChild(row("Timelock nonce", nonceB58));

  const memAccount = item?.storage?.memory?.account
    ? addressToBase58(item.storage.memory.account)
    : "";
  if (memAccount) {
    card.appendChild(row("Memory account", memAccount));
    card.appendChild(row("Memory index", String(item.storage.memory.index ?? 0)));
  }

  if (item?.slot) card.appendChild(row("Slot", String(item.slot)));

  return card;
}

function row(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "result-card__row";

  const l = document.createElement("span");
  l.className = "result-card__label";
  l.textContent = label;

  const v = document.createElement("code");
  v.className = "result-card__value";
  v.textContent = value;

  wrap.append(l, v);
  return wrap;
}

function showError(msg) {
  if (!msg) {
    els.searchError.hidden = true;
    els.searchError.textContent = "";
    return;
  }
  els.searchError.textContent = msg;
  els.searchError.hidden = false;
}

function updateSearchEnabled() {
  const hasVm = els.vmAddress.value.trim().length > 0;
  const hasUrl = els.indexerUrl.value.trim().length > 0;
  els.searchBtn.disabled = !(active && hasVm && hasUrl);
}

els.vmAddress.addEventListener("input", updateSearchEnabled);
els.indexerUrl.addEventListener("input", updateSearchEnabled);
els.searchBtn.addEventListener("click", searchTimelocks);

els.disconnectBtn.addEventListener("click", disconnect);

// Some wallets (notably Solflare) inject their provider asynchronously
// after `DOMContentLoaded`. Re-scan once the page is fully loaded so
// late arrivals still appear in the connect list — but only if the user
// hasn't already connected, otherwise we'd clobber the active session.
function init() {
  renderDisconnected(detectAvailable());
}

init();
window.addEventListener("load", () => {
  if (!active) init();
});
