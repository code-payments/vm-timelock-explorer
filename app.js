import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { validateMnemonic, mnemonicToSeed } from "@scure/bip39";
import { wordlist as bip39English } from "@scure/bip39/wordlists/english";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";

// Solana's standard BIP44 derivation path — matches what Phantom, Solflare,
// and the `solana-keygen` CLI use for the first account from a seed phrase.
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
const SLIP10_ED25519_HMAC_KEY = new TextEncoder().encode("ed25519 seed");
const SLIP10_HARDENED_OFFSET = 0x80000000;

// SLIP-0010 Ed25519 derivation. Ed25519 supports hardened-only derivation,
// so every path segment must end with `'`. Returns the 32-byte seed for
// `Keypair.fromSeed`.
function deriveSlip10Ed25519(masterSeed, path) {
  let I = hmac(sha512, SLIP10_ED25519_HMAC_KEY, masterSeed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  for (const seg of path.split("/").slice(1)) {
    if (!seg.endsWith("'")) {
      throw new Error(`SLIP-0010 ed25519 requires hardened segments; got "${seg}"`);
    }
    const index = (parseInt(seg.slice(0, -1), 10) >>> 0) + SLIP10_HARDENED_OFFSET;
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0;
    data.set(key, 1);
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return key;
}

const INDEXER_URL = "https://vm-indexer.flipcash.com:443";
const RPC_URL = "https://solana-rpc.flipcash.com";

const MNEMONIC_WORD_COUNT = 12;

const els = {
  connectBtn: document.getElementById("connect-btn"),
  connectView: document.getElementById("connect-view"),
  mnemonicGrid: document.getElementById("mnemonic-grid"),
  connectedView: document.getElementById("connected-view"),
  publicKey: document.getElementById("public-key"),
  solBalance: document.getElementById("sol-balance"),
  results: document.getElementById("results"),
  lowBalanceWarning: document.getElementById("low-balance-warning"),
  disconnectBtn: document.getElementById("disconnect-btn"),
};

function getMnemonicInputs() {
  return els.mnemonicGrid.querySelectorAll(".mnemonic-word");
}

function readMnemonic() {
  return Array.from(getMnemonicInputs())
    .map((i) => i.value.trim().toLowerCase())
    .join(" ");
}

function clearMnemonicInputs() {
  getMnemonicInputs().forEach((i) => {
    i.value = "";
  });
}

function focusMnemonicInput(idx) {
  const inputs = getMnemonicInputs();
  const clamped = Math.max(0, Math.min(inputs.length - 1, idx));
  inputs[clamped]?.focus();
  inputs[clamped]?.select?.();
}

function onMnemonicPaste(e) {
  const text = (e.clipboardData || window.clipboardData)?.getData("text") ?? "";
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return; // single word paste: default behavior
  e.preventDefault();
  const inputs = getMnemonicInputs();
  for (let i = 0; i < inputs.length; i++) {
    inputs[i].value = words[i] ?? "";
  }
  focusMnemonicInput(Math.min(words.length, inputs.length) - 1);
}

function onMnemonicKeydown(e) {
  const input = e.target;
  const idx = Number(input.dataset.index);

  if ((e.key === " " || e.key === "Enter") && !e.shiftKey) {
    if (e.key === "Enter" && idx === MNEMONIC_WORD_COUNT - 1 && input.value.trim() !== "") {
      e.preventDefault();
      els.connectBtn.click();
      return;
    }
    if (input.value.trim() !== "") {
      e.preventDefault();
      focusMnemonicInput(idx + 1);
    } else if (e.key === " ") {
      e.preventDefault();
    }
  } else if (e.key === "Backspace" && input.value === "" && idx > 0) {
    e.preventDefault();
    focusMnemonicInput(idx - 1);
  }
}

function renderMnemonicInputs() {
  const grid = els.mnemonicGrid;
  grid.replaceChildren();
  for (let i = 0; i < MNEMONIC_WORD_COUNT; i++) {
    const cell = document.createElement("div");
    cell.className = "mnemonic-word-cell";

    const num = document.createElement("span");
    num.className = "mnemonic-word-num";
    num.textContent = `${i + 1}`;
    cell.appendChild(num);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "mnemonic-word";
    input.dataset.index = String(i);
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.addEventListener("paste", onMnemonicPaste);
    input.addEventListener("keydown", onMnemonicKeydown);
    cell.appendChild(input);

    grid.appendChild(cell);
  }
}

let active = null; // { keypair, publicKey }
let solBalanceTimer = null;
let currentLamports = null;

async function connectWithMnemonic(rawMnemonic) {
  const mnemonic = rawMnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!mnemonic) {
    throw new Error("Please enter your Access Key.");
  }
  if (mnemonic.split(" ").length !== MNEMONIC_WORD_COUNT) {
    throw new Error(`Access Key must be ${MNEMONIC_WORD_COUNT} words.`);
  }
  if (!validateMnemonic(mnemonic, bip39English)) {
    throw new Error("Invalid Access Key. Please check the words and try again.");
  }

  const seed = await mnemonicToSeed(mnemonic);
  const derivedSeed = deriveSlip10Ed25519(seed, SOLANA_DERIVATION_PATH);
  const keypair = Keypair.fromSeed(derivedSeed);

  active = { keypair, publicKey: keypair.publicKey.toBase58() };
  showConnectedView();
}

function showConnectedView() {
  els.connectView.hidden = true;
  els.connectedView.hidden = false;
  els.publicKey.textContent = active.publicKey;
  els.solBalance.textContent = "-";
  startSolBalancePolling();
}

const LOW_BALANCE_LAMPORTS = 5_000_000; // 0.005 SOL

function hasSufficientSol() {
  return typeof currentLamports === "number" && currentLamports >= LOW_BALANCE_LAMPORTS;
}

function updateSolGatedButtons() {
  document.querySelectorAll("[data-sol-gate=unlock]").forEach((btn) => {
    if (btn.querySelector(".spinner")) return;
    btn.disabled = !hasSufficientSol();
  });
  document.querySelectorAll(".result-card__dest-input").forEach((input) => {
    input.dispatchEvent(new Event("input"));
  });
}

function fetchSolBalance() {
  if (!active) return;
  rpcCall(RPC_URL, "getBalance", [active.publicKey])
    .then((result) => {
      const lamports = result?.value ?? result;
      if (typeof lamports === "number") {
        currentLamports = lamports;
        els.solBalance.textContent = `${(lamports / 1e9).toFixed(4)} SOL`;
        els.lowBalanceWarning.hidden = lamports >= LOW_BALANCE_LAMPORTS;
        updateSolGatedButtons();
      }
    })
    .catch(() => {});
}

function startSolBalancePolling() {
  stopSolBalancePolling();
  fetchSolBalance();
  solBalanceTimer = setInterval(fetchSolBalance, 5000);
}

function stopSolBalancePolling() {
  if (solBalanceTimer) {
    clearInterval(solBalanceTimer);
    solBalanceTimer = null;
  }
}

function showConnectView() {
  stopSolBalancePolling();
  currentLamports = null;
  els.lowBalanceWarning.hidden = true;
  els.connectedView.hidden = true;
  els.connectView.hidden = false;
  els.connectBtn.disabled = false;
  els.connectBtn.textContent = "Connect Wallet";
  clearMnemonicInputs();
  els.publicKey.textContent = "-";
  els.solBalance.textContent = "-";
  els.results.hidden = true;
  els.results.replaceChildren();
  showError(null);
  clearSuccess();
}

function disconnect() {
  if (!active) return;
  active = null;
  showConnectView();
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
  const uri = readString().trim();
  return { name, symbol, uri };
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
const IX_UNLOCK = 15;
const IX_WITHDRAW = 14;
const VM_OMNIBUS_SEED = new TextEncoder().encode("vm_omnibus");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

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

function findVmOmnibusAddress(vmB58) {
  const [pda] = PublicKey.findProgramAddressSync(
    [CODE_VM_SEED, VM_OMNIBUS_SEED, new PublicKey(vmB58).toBytes()],
    CODE_VM_PROGRAM_ID,
  );
  return pda.toBase58();
}

function findAssociatedTokenAddress(walletB58, mintB58) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(walletB58).toBytes(),
      TOKEN_PROGRAM_ID.toBytes(),
      new PublicKey(mintB58).toBytes(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return pda.toBase58();
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

function buildUnlockFinalizeInstruction({ accountOwner, payer, vm, unlockPda }) {
  return new TransactionInstruction({
    programId: CODE_VM_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(accountOwner), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(vm), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(unlockPda), isSigner: false, isWritable: true },
    ],
    data: new Uint8Array([IX_UNLOCK]),
  });
}

function buildCreateAtaIdempotentInstruction({ payer, wallet, mint }) {
  const ata = findAssociatedTokenAddress(wallet, mint);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(wallet), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  });
}

function buildWithdrawFromMemoryInstruction({
  depositor, payer, vm, vmOmnibus, vmMemory, unlockPda,
  withdrawReceipt, externalAddress, accountIndex,
}) {
  const data = new Uint8Array(4);
  data[0] = IX_WITHDRAW;
  data[1] = 0; // WithdrawIxData::FromMemory
  data[2] = accountIndex & 0xff;
  data[3] = (accountIndex >> 8) & 0xff;

  return new TransactionInstruction({
    programId: CODE_VM_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(depositor), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(vm), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(vmOmnibus), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(vmMemory), isSigner: false, isWritable: true },
      { pubkey: CODE_VM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: CODE_VM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: CODE_VM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(unlockPda), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(withdrawReceipt), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(externalAddress), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
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

async function waitForWithdrawReceiptCreated({
  rpcUrl, unlockPda, nonceB58, vmAddress, signature,
  maxPolls = 60, intervalMs = 1000,
}) {
  for (let i = 0; i < maxPolls; i++) {
    const receipt = await fetchWithdrawReceipt(rpcUrl, unlockPda, nonceB58, vmAddress);
    if (receipt.exists) return receipt;

    const resp = await rpcCall(rpcUrl, "getSignatureStatuses", [[signature]]);
    const status = resp?.value?.[0];
    if (status?.err) {
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for withdraw receipt");
}

async function refreshCardsForVm(vmB58) {
  if (!lastSearchBody || !lastVmContext || !active) return;

  const ctx = lastVmContext.get(vmB58);
  if (!ctx?.vmInfo) return;

  const timelockAddress = findVirtualTimelockAddress(
    ctx.vmInfo.mint,
    ctx.vmInfo.authority,
    active.publicKey,
    ctx.vmInfo.lockDuration,
  );
  const newUnlock = await fetchUnlockState(
    RPC_URL,
    active.publicKey,
    timelockAddress,
    vmB58,
  );
  newUnlock.timelockAddress = timelockAddress;
  ctx.unlockState = newUnlock;

  const oldCards = els.results.querySelectorAll(`.result-card[data-vm="${vmB58}"]`);
  for (const oldCard of oldCards) {
    const nonce = oldCard.dataset.nonce;
    const item = (lastSearchBody.items ?? []).find((it) => {
      const n = it?.account?.nonce ? addressToBase58(it.account.nonce) : "";
      return n === nonce;
    });
    if (!item) continue;
    const newCard = renderItem(item, vmB58, ctx.vmInfo, ctx.unlockState, ctx.withdrawReceipts);
    oldCard.replaceWith(newCard);
  }
}

async function startUnlock(btn, vmAddress) {
  if (!active) return;

  const rpcUrl = RPC_URL;
  if (!rpcUrl) {
    showError("A Solana RPC URL is required to unlock.");
    return;
  }

  const ownerB58 = active.publicKey;

  showError(null);
  clearSuccess();

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

  try {
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

    tx.sign(active.keypair);

    const serialized = tx.serialize();
    const b64 = bytesToBase64(new Uint8Array(serialized));
    const signature = await rpcCall(rpcUrl, "sendTransaction", [
      b64,
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);

    await waitForUnlockStateCreated({
      rpcUrl,
      ownerB58,
      timelockAddress,
      vmAddress,
      signature,
    });

    await refreshCardsForVm(vmAddress);
    showSuccess("Unlock started. Your funds are now unlocking.");
  } catch (err) {
    console.error("Unlock failed:", err);
    showError(`Unlock failed: ${err?.message ?? err}`);
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

async function startWithdraw(btn, input, vmAddress, item, vmInfo, unlockState) {
  if (!active) return;

  const destination = input.value.trim();
  const ownerB58 = active.publicKey;
  const rpcUrl = RPC_URL;

  showError(null);
  clearSuccess();

  const originalBtnHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
  input.disabled = true;

  try {
    const nonceB58 = item?.account?.nonce
      ? addressToBase58(item.account.nonce)
      : "";
    const memoryAccountB58 = item?.storage?.memory?.account
      ? addressToBase58(item.storage.memory.account)
      : null;
    const accountIndex = Number(item?.storage?.memory?.index ?? 0);

    if (!memoryAccountB58) throw new Error("Missing memory account in item data");
    if (!nonceB58) throw new Error("Missing nonce in item data");

    const timelockAddress = findVirtualTimelockAddress(
      vmInfo.mint, vmInfo.authority, ownerB58, vmInfo.lockDuration,
    );
    const unlockPda = findUnlockAddress(ownerB58, timelockAddress, vmAddress);
    const withdrawReceiptPda = findWithdrawReceiptAddress(unlockPda, nonceB58, vmAddress);
    const vmOmnibus = findVmOmnibusAddress(vmAddress);
    const destinationAta = findAssociatedTokenAddress(destination, vmInfo.mint);

    const tx = new Transaction();

    tx.add(buildCreateAtaIdempotentInstruction({
      payer: ownerB58,
      wallet: destination,
      mint: vmInfo.mint,
    }));

    if (unlockState?.exists && unlockState.state === TIMELOCK_STATE.WAITING_FOR_TIMEOUT) {
      tx.add(buildUnlockFinalizeInstruction({
        accountOwner: ownerB58,
        payer: ownerB58,
        vm: vmAddress,
        unlockPda,
      }));
    }

    tx.add(buildWithdrawFromMemoryInstruction({
      depositor: ownerB58,
      payer: ownerB58,
      vm: vmAddress,
      vmOmnibus,
      vmMemory: memoryAccountB58,
      unlockPda,
      withdrawReceipt: withdrawReceiptPda,
      externalAddress: destinationAta,
      accountIndex,
    }));

    const latest = await rpcCall(rpcUrl, "getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const blockhash = latest?.value?.blockhash;
    if (!blockhash) throw new Error("RPC did not return a blockhash");

    tx.feePayer = new PublicKey(ownerB58);
    tx.recentBlockhash = blockhash;

    tx.sign(active.keypair);

    const serialized = tx.serialize();
    const b64 = bytesToBase64(new Uint8Array(serialized));
    const signature = await rpcCall(rpcUrl, "sendTransaction", [
      b64,
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);

    await waitForWithdrawReceiptCreated({
      rpcUrl,
      unlockPda,
      nonceB58,
      vmAddress,
      signature,
    });

    const ctx = lastVmContext?.get(vmAddress);
    if (ctx) {
      if (!ctx.withdrawReceipts) ctx.withdrawReceipts = new Map();
      ctx.withdrawReceipts.set(nonceB58, { pda: withdrawReceiptPda, exists: true });
    }
    const card = btn.closest(".result-card");
    if (card) card.remove();
    showSuccess(`Withdrawal complete. Funds have been sent to ${destination.slice(0, 4)}...${destination.slice(-4)}.`);
  } catch (err) {
    console.error("Withdraw failed:", err);
    showError(`Withdraw failed: ${err?.message ?? err}`);
    btn.innerHTML = originalBtnHTML;
    btn.disabled = false;
    input.disabled = false;
  }
}

// Retained after each search so individual cards can be re-rendered without a
// full refresh (e.g. after an unlock completes).
let lastSearchBody = null;
let lastVmContext = null; // Map<vmB58, { vmInfo, unlockState, withdrawReceipts }>

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
  let image = null;
  try {
    const meta = await fetchTokenMetadata(rpcUrl, mint);
    if (meta) {
      name = meta.name || null;
      symbol = meta.symbol || null;
      if (meta.uri) {
        try {
          const offchain = await fetch(meta.uri).then((r) => r.json());
          image = offchain?.image || null;
        } catch (err) {
          console.warn("Off-chain metadata fetch failed:", err);
        }
      }
    }
  } catch (err) {
    console.warn("Token metadata lookup failed:", err);
  }

  const info = { mint, decimals, name, symbol, image, authority, lockDuration };
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
  let intPart, fracPart;
  if (trimmed.length <= decimals) {
    intPart = "0";
    fracPart = trimmed.padStart(decimals, "0");
  } else {
    intPart = trimmed.slice(0, trimmed.length - decimals);
    fracPart = trimmed.slice(trimmed.length - decimals);
  }
  const rounded = fracPart.slice(0, 2).padEnd(2, "0");
  return rounded === "00" ? intPart : `${intPart}.${rounded}`;
}

async function searchTimelocks() {
  if (!active) return;

  showError(null);
  clearSuccess();
  els.results.replaceChildren();
  els.results.hidden = false;

  const loadingHeader = document.createElement("div");
  loadingHeader.className = "results__header";
  loadingHeader.innerHTML = '<div class="results__label">Tokens</div><span class="btn btn--refresh btn--refresh--spinning"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span>';
  els.results.appendChild(loadingHeader);

  const minWait = new Promise((r) => setTimeout(r, 2000));

  let owner;
  try {
    owner = addressFromBase58(active.publicKey);
  } catch (err) {
    showError(`Invalid wallet public key: ${err.message}`);
    return;
  }

  try {
    const resp = await fetch(
      `${INDEXER_URL}/code.vm.v1.Indexer/SearchVirtualTimelockAccounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner }),
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

    // Group items by VM address so we can batch RPC lookups per VM.
    const items = body?.items ?? [];
    const vmGroups = new Map();
    for (const item of items) {
      const vmB58 = item?.vmAccount ? addressToBase58(item.vmAccount) : null;
      if (!vmB58) continue;
      if (!vmGroups.has(vmB58)) vmGroups.set(vmB58, []);
      vmGroups.get(vmB58).push(item);
    }

    // For each unique VM, fetch on-chain info + unlock state in parallel.
    const vmContext = new Map(); // vmB58 -> { vmInfo, unlockState, withdrawReceipts }
    if (RPC_URL && vmGroups.size > 0) {
      await Promise.all(
        Array.from(vmGroups.entries()).map(async ([vmB58, vmItems]) => {
          const ctx = { vmInfo: null, unlockState: null, withdrawReceipts: null };
          vmContext.set(vmB58, ctx);

          try {
            ctx.vmInfo = await fetchVmInfo(RPC_URL, vmB58);
          } catch (err) {
            console.warn(`VM info lookup failed for ${vmB58}:`, err);
            return;
          }

          try {
            const timelockAddress = findVirtualTimelockAddress(
              ctx.vmInfo.mint,
              ctx.vmInfo.authority,
              active.publicKey,
              ctx.vmInfo.lockDuration,
            );
            ctx.unlockState = await fetchUnlockState(
              RPC_URL,
              active.publicKey,
              timelockAddress,
              vmB58,
            );
            ctx.unlockState.timelockAddress = timelockAddress;
          } catch (err) {
            console.warn(`Unlock state lookup failed for ${vmB58}:`, err);
          }

          if (ctx.unlockState?.exists && ctx.unlockState.state === TIMELOCK_STATE.UNLOCKED) {
            ctx.withdrawReceipts = new Map();
            await Promise.all(
              vmItems.map(async (item) => {
                const nonceB58 = item?.account?.nonce
                  ? addressToBase58(item.account.nonce)
                  : null;
                if (!nonceB58) return;
                try {
                  const receipt = await fetchWithdrawReceipt(
                    RPC_URL,
                    ctx.unlockState.pda,
                    nonceB58,
                    vmB58,
                  );
                  ctx.withdrawReceipts.set(nonceB58, receipt);
                } catch (err) {
                  console.warn("Withdraw receipt lookup failed:", err);
                }
              }),
            );
          }
        }),
      );
    }

    await minWait;
    lastSearchBody = body ?? {};
    lastVmContext = vmContext;
    renderResults(lastSearchBody, lastVmContext);
  } catch (err) {
    await minWait;
    console.error("Indexer request failed:", err);
    showError(`Search failed: ${err.message}`);
  }
}

function renderTokensHeader(container) {
  const header = document.createElement("div");
  header.className = "results__header";

  const label = document.createElement("div");
  label.className = "results__label";
  label.textContent = "Tokens";
  header.appendChild(label);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn btn--refresh";
  refreshBtn.title = "Refresh";
  refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  refreshBtn.addEventListener("click", searchTimelocks);
  header.appendChild(refreshBtn);

  container.appendChild(header);
}

function renderResults(body, vmContext) {
  const container = els.results;
  container.replaceChildren();
  container.hidden = false;

  const hasResults = body.result !== "NOT_FOUND" && body.items?.length > 0;

  if (!hasResults) {
    const empty = document.createElement("p");
    empty.className = "results__empty";
    empty.textContent = "No Timelock accounts found for this wallet.";
    container.appendChild(empty);
    return;
  }

  renderTokensHeader(container);

  const sorted = [...body.items].sort((a, b) => {
    const vmA = a?.vmAccount ? addressToBase58(a.vmAccount) : null;
    const vmB = b?.vmAccount ? addressToBase58(b.vmAccount) : null;
    const nameA = (vmA && vmContext.get(vmA)?.vmInfo?.name) || "";
    const nameB = (vmB && vmContext.get(vmB)?.vmInfo?.name) || "";
    return nameA.localeCompare(nameB);
  });

  for (const item of sorted) {
    const bal = item?.account?.balance ?? "0";
    if (bal === "0" || bal === 0) continue;
    const vmB58 = item?.vmAccount ? addressToBase58(item.vmAccount) : null;
    const ctx = vmB58 ? vmContext.get(vmB58) : null;
    const nonceB58 = item?.account?.nonce ? addressToBase58(item.account.nonce) : "";
    if (nonceB58 && ctx?.withdrawReceipts?.get(nonceB58)?.exists) continue;
    container.appendChild(
      renderItem(item, vmB58, ctx?.vmInfo, ctx?.unlockState, ctx?.withdrawReceipts),
    );
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
  const localDate = Number.isFinite(unlockAtMs)
    ? unlockDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "—";
  const localTime = Number.isFinite(unlockAtMs)
    ? unlockDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase()
    : "—";
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
      detail: `Funds are unlocked and can now be withdrawn`,
    };
  }

  if (unlockState.state === TIMELOCK_STATE.WAITING_FOR_TIMEOUT) {
    if (unlockAtMs > now) {
      return {
        status: "Unlocking",
        detail: `Funds are unlocking and can be withdrawn on ${localDate} at ${localTime}`,
      };
    }
    return {
      status: "Unlocked",
      detail: `Funds are unlocked and can now be withdrawn`,
    };
  }

  return {
    status: `State ${unlockState.state}`,
    detail: `Unlock-at: ${localDate} at ${localTime}`,
  };
}

function renderItem(item, vmB58, vmInfo, unlockState, withdrawReceipts) {
  const card = document.createElement("div");
  card.className = "result-card";
  if (vmB58) card.dataset.vm = vmB58;

  const nonceB58 = item?.account?.nonce ? addressToBase58(item.account.nonce) : "";
  if (nonceB58) card.dataset.nonce = nonceB58;
  const withdrawReceipt = nonceB58 ? withdrawReceipts?.get(nonceB58) : null;
  const unlockInfo = describeUnlockState(unlockState, vmInfo, withdrawReceipt);

  const header = document.createElement("div");
  header.className = "result-card__header";

  const nameGroup = document.createElement("div");
  nameGroup.className = "result-card__name-group";

  const nameRow = document.createElement("div");
  nameRow.className = "result-card__name-row";

  if (vmInfo?.image) {
    const img = document.createElement("img");
    img.className = "result-card__token-img";
    img.src = vmInfo.image;
    img.alt = vmInfo.name || vmInfo.symbol || "";
    nameRow.appendChild(img);
  }

  const balanceRaw = item?.account?.balance ?? "0";
  const balanceText = vmInfo
    ? formatTokenAmount(balanceRaw, vmInfo.decimals)
    : `${balanceRaw} quarks`;
  const tokenLabel = vmInfo?.name || vmInfo?.symbol || "Unknown Token";

  const currencyText = document.createElement("div");
  currencyText.className = "result-card__currency";
  currencyText.textContent = `${balanceText} ${tokenLabel}`;
  nameRow.appendChild(currencyText);

  nameGroup.appendChild(nameRow);

  if (unlockInfo && unlockInfo.status !== "Unlocked") {
    const detailRow = document.createElement("div");
    detailRow.className = "result-card__detail-row";

    const dot = document.createElement("span");
    dot.className = `result-card__status-dot result-card__status-dot--${unlockInfo.status.toLowerCase().replace(/\s+/g, "-")}`;
    detailRow.appendChild(dot);

    const detail = document.createElement("div");
    detail.className = "result-card__unlock-detail";
    detail.textContent = unlockInfo.detail;
    detailRow.appendChild(detail);

    nameGroup.appendChild(detailRow);
  }

  header.appendChild(nameGroup);

  if (unlockState && !unlockState.exists && vmB58) {
    const unlockBtn = document.createElement("button");
    unlockBtn.className = "btn btn--primary btn--icon";
    unlockBtn.dataset.solGate = "unlock";
    unlockBtn.disabled = !hasSufficientSol();
    unlockBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
    unlockBtn.title = "Start Unlock";
    unlockBtn.addEventListener("click", () => startUnlock(unlockBtn, vmB58));
    header.appendChild(unlockBtn);
  }

  card.appendChild(header);

  if (unlockInfo?.status === "Unlocked" && vmB58) {
    const withdrawRow = document.createElement("div");
    withdrawRow.className = "result-card__withdraw-row";

    const input = document.createElement("input");
    input.className = "result-card__dest-input";
    input.type = "text";
    input.placeholder = "Where do you want to withdraw your funds to?";
    input.autocomplete = "off";
    input.spellcheck = false;
    withdrawRow.appendChild(input);

    const sendBtn = document.createElement("button");
    sendBtn.className = "btn btn--primary btn--icon";
    sendBtn.title = "Withdraw";
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    withdrawRow.appendChild(sendBtn);

    input.addEventListener("input", () => {
      if (sendBtn.querySelector(".spinner")) return;
      const val = input.value.trim();
      let valid = false;
      if (val) {
        try {
          const bytes = bs58.decode(val);
          valid = bytes.length === 32;
        } catch {}
      }
      sendBtn.disabled = !valid || !hasSufficientSol();
    });

    sendBtn.addEventListener("click", () => {
      startWithdraw(sendBtn, input, vmB58, item, vmInfo, unlockState);
    });

    card.appendChild(withdrawRow);
  }

  return card;
}

function showError(msg) {
  document.querySelectorAll(".result-card--error").forEach((el) => el.remove());
  if (!msg) return;

  const banner = document.createElement("div");
  banner.className = "result-card result-card--error";
  banner.innerHTML = `<div class="result-card__info-row"><svg class="result-card__info-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><span></span></div>`;
  banner.querySelector("span").textContent = msg;
  const header = els.results.querySelector(".results__header");
  if (header) {
    header.before(banner);
  } else {
    els.connectView.prepend(banner);
  }
}

function clearSuccess() {
  els.results.querySelectorAll(".result-card--success").forEach((el) => el.remove());
}

function showSuccess(msg) {
  clearSuccess();
  els.results.querySelectorAll(".result-card--success").forEach((el) => el.remove());
  const banner = document.createElement("div");
  banner.className = "result-card result-card--success";
  banner.innerHTML = `<div class="result-card__info-row"><svg class="result-card__info-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span></span></div>`;
  banner.querySelector("span").textContent = msg;
  const header = els.results.querySelector(".results__header");
  if (header) {
    header.before(banner);
  } else {
    els.results.prepend(banner);
  }
}

els.connectBtn.addEventListener("click", async () => {
  const mnemonic = readMnemonic();
  showError(null);
  els.connectBtn.disabled = true;
  els.connectBtn.textContent = "Connecting…";
  try {
    await connectWithMnemonic(mnemonic);
    clearMnemonicInputs();
    searchTimelocks();
  } catch (err) {
    showError(`Connect failed: ${err.message}`);
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = "Connect Wallet";
  }
});
els.disconnectBtn.addEventListener("click", disconnect);
renderMnemonicInputs();
