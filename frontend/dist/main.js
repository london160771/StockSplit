import * as anchor from "https://esm.sh/@coral-xyz/anchor@0.32.1?bundle&external=@solana/web3.js&target=es2022";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "https://esm.sh/@solana/spl-token@0.4.14?bundle&external=@solana/web3.js&target=es2022";
import { compareMessageSemantics, selectWalletSignedTransaction, snapshotTransaction } from "./transaction-message.mjs";
import { createWalletAtaInstruction } from "./token-account-instructions.mjs";
import { ApprovalExpiredError, assertBlockhashActive } from "./transaction-expiry.mjs";
import { allVaultsReady, canCancelPortfolio, canClaimRefund, cancelPortfolioDiagnostics, isCanonicalVault, memberClaimRaw, memberHasWithdrawn, memberRefunded, portfolioInviteUrl } from "./portfolio-ux.mjs";
import { TEST_USDC_MINT_ADDRESS, demoFundsAvailableForPortfolio, needsDemoFunds } from "./demo-funds.mjs";
import { assetDetails, basketAssets, contributionAsset, contributionAssetLabel, displayAsset, isApprovedContributionMint, validateBasketSelection } from "./asset-registry.mjs";
import { FUNDING_ENDED_MESSAGE, fundingCloseLabel, fundingCountdown, fundingEnded } from "./funding-deadline.mjs";
import { friendlyActionError, isRefundAlreadyCompletedError, isWithdrawalAlreadyCompletedError } from "./action-errors.mjs";
import { deploymentMode } from "./deployment-mode.mjs";
import { memberRole, publicKeyEquals, publicKeyText } from "./public-key-utils.mjs";
import { connectInjectedWallet, createWalletEventRegistry, injectedSolanaWallet } from "./wallet-session.mjs";
import {
  COMPLEX_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  priorityFeeForConnection,
  withComputeBudget,
} from "./priority-fee.mjs";

const PROGRAM_ID = new PublicKey("9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm");
const TEST_USDC_MINT = new PublicKey(TEST_USDC_MINT_ADDRESS);
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const NETWORKS = {
  localnet: { label: "Localnet", rpc: "http://127.0.0.1:8899" },
  devnet: { label: "Devnet", rpc: "https://api.devnet.solana.com" },
  "mainnet-beta": { label: "Mainnet", rpc: "https://api.mainnet-beta.solana.com" },
};
const STATUS = {
  DRAFT: 0,
  FUNDING: 1,
  FUNDING_CLOSED: 2,
  DEPLOYING: 3,
  ACTIVE: 4,
  CLOSED: 5,
  CANCELLED: 6,
};
const STATUS_NAMES = ["DRAFT", "FUNDING", "FUNDING_CLOSED", "DEPLOYING", "ACTIVE", "CLOSED", "CANCELLED"];
const STATUS_LABELS = ["Draft", "Funding open", "Funding ended", "Investing", "Active", "Closed", "Cancelled"];
const walletEventRegistry = createWalletEventRegistry();

function createDemoClaimState() {
  return { busy: false, status: "unknown", balance: null, amount: null, error: "", notice: "", signature: null };
}

function createDemoFundsState(open = false) {
  return { open, ...createDemoClaimState(), sol: createDemoClaimState() };
}

const state = {
  view: "landing",
  network: localStorage.getItem("stocksplit.network") || "devnet",
  connection: null,
  provider: null,
  program: null,
  idl: null,
  walletProvider: null,
  walletPublicKey: null,
  walletNetwork: null,
  walletNetworkSource: "",
  manualNetworkConfirmation: false,
  walletEventProvider: null,
  portfolios: [],
  selected: null,
  selectedMembers: [],
  selectedVaults: [],
  selectedMember: null,
  selectedMemberError: null,
  selectedWalletUsdcBalance: null,
  busy: "",
  error: "",
  errorDetails: "",
  notice: "",
  retryAction: null,
  demoFunds: createDemoFundsState(),
  createDraft: {
    portfolioId: String(Date.now() % 1000000),
    name: "",
    description: "",
    target: localStorage.getItem("stocksplit.network") === "mainnet-beta" ? "500" : "50",
    fundingStart: toDateInput(new Date()),
    fundingDeadline: toDateInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    basket: [{ mint: basketAssets("devnet")[0].mint, allocation: "100" }],
  },
};

function toDateInput(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortKey(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 5)}…${text.slice(-4)}` : text;
}

function statusName(status) {
  return STATUS_NAMES[Number(status)] || "UNKNOWN";
}

function statusLabel(status) {
  return STATUS_LABELS[Number(status)] || "Unknown";
}

function statusClass(status) {
  const value = statusName(status).toLowerCase().replace("_", "-");
  return value === "funding-closed" ? "closed" : value;
}

function deploymentLegsOf(portfolio) {
  return Array.isArray(portfolio?.deploymentLegs) ? portfolio.deploymentLegs : [];
}

function bn(value) {
  return new anchor.BN(String(value));
}

function rawString(value) {
  return value?.toString?.() ?? String(value ?? "0");
}

function formatRaw(value, decimals = 6) {
  const raw = BigInt(rawString(value));
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

function formatOwnershipUnits(value) {
  const raw = BigInt(rawString(value));
  if (raw > 0n && raw < 10_000n) return "<0.01";
  const scale = 1_000_000n;
  const whole = raw / scale;
  const hundredths = (raw % scale) / 10_000n;
  return `${whole.toString()}.${hundredths.toString().padStart(2, "0")}`;
}

function portfolioContributionLabel(portfolio) {
  return contributionAssetLabel(state.network, portfolio?.usdcMint);
}

function approvedDevnetContribution(portfolio) {
  return state.network !== "devnet" || isApprovedContributionMint(state.network, portfolio?.usdcMint);
}

function networkShortLabel() {
  return state.network === "mainnet-beta" ? "Mainnet" : networkConfig().label;
}

function parseRaw(value, decimals = 6) {
  const clean = String(value || "").trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Enter a valid positive amount.");
  const [whole, fraction = ""] = clean.split(".");
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function percentOf(units, total) {
  const member = BigInt(rawString(units));
  const denominator = BigInt(rawString(total));
  if (denominator === 0n) return "0.0";
  return (Number((member * 10000n) / denominator) / 100).toFixed(2);
}

function u64Bytes(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function seedText(value) {
  return new TextEncoder().encode(value);
}

function canonicalPublicKey(value) {
  if (!value) throw new Error("Wallet did not provide a public key");
  return new PublicKey(typeof value === "string" ? value : value.toBase58?.() || value.toString());
}

function portfolioPda(creator, portfolioId) {
  return PublicKey.findProgramAddressSync(
    [seedText("portfolio"), new PublicKey(creator).toBytes(), u64Bytes(portfolioId)],
    PROGRAM_ID,
  )[0];
}

function memberPda(portfolio, wallet) {
  return PublicKey.findProgramAddressSync(
    [seedText("member"), new PublicKey(portfolio).toBytes(), new PublicKey(wallet).toBytes()],
    PROGRAM_ID,
  )[0];
}

function vaultPda(portfolio, mint) {
  return PublicKey.findProgramAddressSync(
    [seedText("vault"), new PublicKey(portfolio).toBytes(), new PublicKey(mint).toBytes()],
    PROGRAM_ID,
  )[0];
}

function networkConfig() {
  return NETWORKS[state.network];
}

function normalizeNetwork(value) {
  if (value && typeof value === "object") {
    for (const key of ["network", "cluster", "chain", "chainId", "name", "rpcEndpoint", "endpoint"]) {
      const nested = normalizeNetwork(value[key]);
      if (nested) return nested;
    }
    return null;
  }
  const normalized = String(value || "").toLowerCase().trim();
  if (!normalized) return null;
  if (normalized.includes("devnet")) return "devnet";
  if (normalized.includes("mainnet")) return "mainnet-beta";
  if (normalized.includes("localnet") || normalized.includes("localhost") || normalized.includes("127.0.0.1")) return "localnet";
  return null;
}

function inspectWalletNetwork(wallet = state.walletProvider) {
  if (!wallet) return { network: null, source: "" };
  const candidates = [
    ["network", wallet.network],
    ["cluster", wallet.cluster],
    ["chain", wallet.chain],
    ["chainId", wallet.chainId],
    ["rpcEndpoint", wallet.rpcEndpoint],
    ["connection.rpcEndpoint", wallet.connection?.rpcEndpoint],
    ["provider.network", wallet.provider?.network],
    ["adapter.network", wallet.adapter?.network],
  ];
  for (const [source, value] of candidates) {
    const network = normalizeNetwork(value);
    if (network) return { network, source };
  }
  return { network: null, source: "" };
}

async function refreshWalletNetwork(value) {
  const normalizedValue = normalizeNetwork(value);
  const detected = normalizedValue ? { network: normalizedValue, source: "wallet event" } : inspectWalletNetwork();
  if (!detected.network && state.manualNetworkConfirmation && state.walletNetwork === state.network) return { network: state.walletNetwork, source: "manual confirmation" };
  state.walletNetwork = detected.network;
  state.walletNetworkSource = detected.source;
  state.manualNetworkConfirmation = false;
  return detected;
}

function walletNetworkMatches() {
  return Boolean(state.walletPublicKey && state.walletNetwork && state.walletNetwork === state.network);
}

function transactionActionsEnabled() {
  return walletNetworkMatches() && !state.busy && !demoFundsBusy();
}

function demoFundsBusy() {
  return Boolean(state.demoFunds.busy || state.demoFunds.sol?.busy);
}

function networkWarningText() {
  const expected = networkConfig().label;
  if (state.network === "devnet") return "Switch Phantom to Solana Devnet";
  return `Switch Phantom to Solana ${expected}`;
}

function networkWarningHtml() {
  const detected = state.walletNetwork ? `Detected: ${esc(networkConfigFor(state.walletNetwork).label)}.` : "Phantom did not expose its current Solana network.";
  const buttonLabel = state.walletNetwork ? "Switch / re-check" : `I switched Phantom to ${networkConfig().label}`;
  const instruction = state.walletNetwork ? "Transactions stay disabled until the wallet and app network match." : "Confirm Phantom is set to Solana Devnet, then use the button to re-check.";
  return `<div class="network-warning"><div><strong>${esc(networkWarningText())}</strong><span>${detected} ${instruction}</span></div><button class="button secondary" data-action="switch-wallet-network">${buttonLabel}</button></div>`;
}

function networkConfigFor(network) {
  return NETWORKS[network] || { label: network };
}

function walletObject() {
  if (state.walletProvider && state.walletPublicKey) {
    const walletProvider = state.walletProvider;
    const publicKey = canonicalPublicKey(state.walletPublicKey);
    return {
      publicKey,
      signTransaction: (transaction) => walletProvider.signTransaction(transaction),
      signAllTransactions: (transactions) => {
        if (typeof walletProvider.signAllTransactions !== "function") {
          throw new Error("The connected wallet does not support signing multiple transactions.");
        }
        return walletProvider.signAllTransactions(transactions);
      },
    };
  }
  const readOnly = new PublicKey("11111111111111111111111111111111");
  return {
    publicKey: readOnly,
    signTransaction: async () => { throw new Error("Connect a wallet before signing."); },
    signAllTransactions: async () => { throw new Error("Connect a wallet before signing."); },
  };
}

function injectedWallet() {
  return injectedSolanaWallet(window);
}

async function initializeProgram() {
  state.connection = new Connection(networkConfig().rpc, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  if (!state.idl) {
    const response = await fetch("./stock_split_phase0.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Generated StockSplit IDL could not be loaded.");
    state.idl = await response.json();
    if (!state.idl.address || !publicKeyEquals(new PublicKey(state.idl.address), PROGRAM_ID)) {
      throw new Error("Generated StockSplit IDL does not match the configured program ID.");
    }
  }
  state.provider = new anchor.AnchorProvider(
    state.connection,
    walletObject(),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  state.program = new anchor.Program(state.idl, state.provider);
}

function attachWalletEvents(wallet) {
  if (!wallet?.on || state.walletEventProvider === wallet) return;
  walletEventRegistry.attach(wallet, {
    accountChanged: async (publicKey) => {
      if (!publicKey) {
        await disconnectWallet();
        return;
      }
      state.walletPublicKey = canonicalPublicKey(publicKey);
      state.demoFunds = createDemoFundsState(state.demoFunds.open);
      state.manualNetworkConfirmation = false;
      await refreshWalletNetwork();
      await initializeProgram();
      await refreshPortfolios();
      if (state.network === "devnet") refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
      render();
    },
    networkChanged: async (value) => {
      await refreshWalletNetwork(value);
      if (state.network === "devnet") refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
      render();
    },
    chainChanged: async (value) => {
      await refreshWalletNetwork(value);
      if (state.network === "devnet") refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
      render();
    },
  });
  state.walletEventProvider = wallet;
}

async function connectWallet({ onlyIfTrusted = false, silent = false } = {}) {
  const wallet = injectedWallet();
  if (!wallet) {
    if (onlyIfTrusted) return false;
    throw new Error("Phantom was not found. Install or enable the Phantom browser extension.");
  }
  let publicKey;
  try {
    publicKey = await connectInjectedWallet(wallet, { onlyIfTrusted });
    if (!publicKey) throw new Error("Phantom did not provide a public key.");
  } catch (error) {
    if (onlyIfTrusted) return false;
    throw error;
  }
  state.walletProvider = wallet;
  state.walletPublicKey = canonicalPublicKey(publicKey);
  state.demoFunds = createDemoFundsState(state.demoFunds.open);
  await refreshWalletNetwork();
  attachWalletEvents(wallet);
  await initializeProgram();
  state.view = "dashboard";
  await refreshPortfolios();
  if (state.network === "devnet") refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
  if (!silent) toast(`Connected ${shortKey(state.walletPublicKey.toBase58())}`);
  return true;
}

async function disconnectWallet() {
  await state.walletProvider?.disconnect?.();
  state.walletProvider = null;
  state.walletPublicKey = null;
  state.walletNetwork = null;
  state.walletNetworkSource = "";
  state.manualNetworkConfirmation = false;
  state.portfolios = [];
  state.selected = null;
  state.selectedMember = null;
  state.selectedWalletUsdcBalance = null;
  state.retryAction = null;
  state.demoFunds = createDemoFundsState();
  state.view = "landing";
  render();
}

async function switchWalletNetwork() {
  if (!state.walletProvider) throw new Error("Connect Phantom before switching networks.");
  const wallet = state.walletProvider;
  const target = state.network;
  try {
    if (typeof wallet.switchNetwork === "function") {
      await wallet.switchNetwork(target);
    } else if (wallet.solana && typeof wallet.solana.switchNetwork === "function") {
      await wallet.solana.switchNetwork(target);
    } else if (typeof wallet.request === "function") {
      await wallet.request({ method: "switchNetwork", params: { network: target } });
    }
  } catch {
    // Unsupported provider methods and user-declined switches both fall back
    // to the explicit manual instruction rendered by the guard.
  }
  await refreshWalletNetwork();
  if (walletNetworkMatches()) {
    await initializeProgram();
    await refreshPortfolios();
    return;
  }

  // The raw injected Phantom provider may not expose a Solana network field.
  // The user action above is the explicit manual confirmation fallback; the
  // app still pins all RPC work to the selected cluster and fresh blockhash.
  if (!state.walletNetwork) {
    if (networkConfig().rpc !== "https://api.devnet.solana.com" && state.network === "devnet") {
      throw new Error("The Devnet RPC configuration is invalid. Transaction aborted.");
    }
    await state.connection.getLatestBlockhash("confirmed");
    state.walletNetwork = state.network;
    state.walletNetworkSource = "manual confirmation";
    state.manualNetworkConfirmation = true;
    state.error = "";
    state.notice = `${networkConfig().label} wallet network manually confirmed.`;
    render();
    return;
  }

  render();
  throw new Error(networkWarningText());
}

async function requireTransactionReady() {
  await requireWallet();
  await refreshWalletNetwork();
  if (!walletNetworkMatches()) {
    throw new Error(`${networkWarningText()}. Transactions are disabled until the wallet and app network match.`);
  }
  if (!state.connection || networkConfig().rpc !== state.connection.rpcEndpoint) {
    await initializeProgram();
  }
  if (!state.connection || state.connection.rpcEndpoint !== networkConfig().rpc) {
    throw new Error(`The frontend RPC is not ${networkConfig().rpc}. Transaction aborted.`);
  }
  const programAccount = await state.connection.getAccountInfo(PROGRAM_ID, "confirmed");
  if (!programAccount?.executable) {
    throw new Error(`StockSplit is not deployed at ${PROGRAM_ID.toBase58()} on ${networkConfig().label}.`);
  }
}

function assertWalletPublicKey() {
  if (!state.walletProvider || !state.walletPublicKey) {
    throw new Error("Wallet is not connected");
  }
  state.walletPublicKey = canonicalPublicKey(state.walletPublicKey);
}

async function sendInstructions(instructions, { computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT } = {}) {
  await requireTransactionReady();
  assertWalletPublicKey();
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error("Transaction has no instructions");
  }

  // Capture every mutable dependency before the wallet prompt. A network or
  // account change during approval must abort instead of crossing RPCs.
  const connection = state.connection;
  const walletProvider = state.walletProvider;
  const payer = canonicalPublicKey(state.walletPublicKey);
  const selectedNetwork = state.network;
  const rpcEndpoint = connection.rpcEndpoint;
  if (typeof walletProvider?.signTransaction !== "function") {
    throw new Error("The connected Solana wallet does not support signing v0 transactions. Nothing was sent.");
  }
  if (!walletProvider.publicKey || !publicKeyEquals(canonicalPublicKey(walletProvider.publicKey), payer)) {
    throw new Error("The connected wallet account changed before signing. Transaction was not sent.");
  }
  const microLamports = await priorityFeeForConnection(connection);
  const finalInstructions = withComputeBudget(
    instructions,
    ComputeBudgetProgram,
    computeUnitLimit,
    microLamports,
  );
  // All validation, account derivation, instruction construction, and fee
  // sampling are complete. This is the final RPC call before opening Phantom.
  const latest = await connection.getLatestBlockhash("processed");
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latest.blockhash,
      instructions: finalInstructions,
    }).compileToV0Message(),
  );
  const requiredSigners = transaction.message.staticAccountKeys
    .slice(0, transaction.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  if (requiredSigners.length !== 1 || requiredSigners[0] !== payer.toBase58()) {
    throw new Error(`Transaction construction requires unexpected external signers: ${requiredSigners.join(", ")}. Nothing was sent.`);
  }
  // Snapshot primitives before Phantom runs: some providers mutate the input
  // transaction, while others return a new instance.
  const unsigned = snapshotTransaction(transaction);

  const walletResult = await walletProvider.signTransaction(transaction);
  if (typeof walletResult?.serialize !== "function") {
    throw new Error("The connected Solana wallet did not return a v0 transaction. Nothing was sent.");
  }

  if (
    state.connection !== connection
    || state.network !== selectedNetwork
    || state.connection.rpcEndpoint !== rpcEndpoint
    || state.walletProvider !== walletProvider
    || state.walletNetwork !== selectedNetwork
    || !walletProvider.publicKey
    || !publicKeyEquals(canonicalPublicKey(walletProvider.publicKey), payer)
    || !state.walletPublicKey
    || !publicKeyEquals(canonicalPublicKey(state.walletPublicKey), payer)
  ) {
    throw new Error("Network or wallet account changed during approval. Transaction was not sent.");
  }

  let returnedTransaction;
  try {
    returnedTransaction = VersionedTransaction.deserialize(walletResult.serialize());
  } catch {
    throw new Error("Wallet returned an invalid versioned transaction");
  }
  const { transaction: signedTransaction } = selectWalletSignedTransaction(
    unsigned, returnedTransaction, transaction,
  );
  const signed = snapshotTransaction(signedTransaction);
  const messageDifferences = compareMessageSemantics(unsigned, signed);
  if (messageDifferences.length) {
    throw new Error(`Wallet changed transaction message fields: ${messageDifferences.join(", ")}`);
  }
  if (signed.message.recentBlockhash !== latest.blockhash) {
    throw new Error("Wallet returned a transaction with a different blockhash");
  }
  if (signed.message.staticAccountKeys[0] !== payer.toBase58()) {
    throw new Error("Transaction fee payer does not match the connected wallet");
  }
  await assertBlockhashActive(connection, latest.lastValidBlockHeight);
  const simulation = await connection.simulateTransaction(signedTransaction, {
    commitment: "processed",
    sigVerify: true,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.length ? ` Logs: ${simulation.value.logs.join(" | ")}` : "";
    if (String(simulation.value.err).includes("BlockhashNotFound")) {
      throw new ApprovalExpiredError();
    }
    throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}.${logs}`);
  }

  // Simulation itself consumes time. Never hand an expired signed message to
  // the broadcaster; retry requires a fresh blockhash and a new wallet prompt.
  await assertBlockhashActive(connection, latest.lastValidBlockHeight);
  const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "processed",
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`Transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

async function tokenProgramForMint(mint) {
  const info = await state.connection.getAccountInfo(new PublicKey(mint), "confirmed");
  if (!info) throw new Error(`Mint ${shortKey(mint)} was not found on ${networkConfig().label}.`);
  if (publicKeyEquals(info.owner, TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (publicKeyEquals(info.owner, TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Mint ${shortKey(mint)} is not owned by a supported token program.`);
}

async function readTokenAsset(portfolioKey, mint, label, allocationBps, isUsdc = false) {
  const tokenProgram = await tokenProgramForMint(mint);
  const mintKey = new PublicKey(mint);
  const mintState = await getMint(state.connection, mintKey, "confirmed", tokenProgram);
  const vault = vaultPda(portfolioKey, mintKey);
  let tokenAccount = null;
  try {
    tokenAccount = await getAccount(state.connection, vault, "confirmed", tokenProgram);
  } catch (error) {
    if (!String(error?.name || error).toLowerCase().includes("notfound")) throw error;
  }
  return {
    mint: mintKey,
    label: assetDetails(state.network, mint, isUsdc)?.name || label,
    ticker: assetDetails(state.network, mint, isUsdc)?.ticker || label,
    icon: assetDetails(state.network, mint, isUsdc)?.icon || (isUsdc ? "$" : "x"),
    allocationBps,
    isUsdc,
    tokenProgram,
    decimals: mintState.decimals,
    vault,
    rawBalance: tokenAccount?.amount || 0n,
    initialized: isCanonicalVault(tokenAccount, mintKey, new PublicKey(portfolioKey)),
  };
}

async function readWalletUsdcBalance(usdcAsset, wallet) {
  if (!wallet) return null;
  const source = getAssociatedTokenAddressSync(usdcAsset.mint, wallet, false, usdcAsset.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  try {
    const account = await getAccount(state.connection, source, "confirmed", usdcAsset.tokenProgram);
    if (!publicKeyEquals(account.mint, usdcAsset.mint) || !publicKeyEquals(account.owner, wallet)) {
      throw new Error("The connected wallet's USDC account did not match its expected mint and owner.");
    }
    return account.amount;
  } catch (error) {
    if (String(error?.name || error).toLowerCase().includes("notfound")) return 0n;
    throw error;
  }
}

async function demoFundsRequest(endpoint, options) {
  const response = await fetch(`/api/demo-funds/${endpoint}`, options);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Demo Funds service is unavailable. Use the StockSplit demo server.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Demo Funds service is unavailable.");
  return body;
}

function demoClaimState(asset) {
  return asset === "SOL" ? state.demoFunds.sol : state.demoFunds;
}

function demoClaimLabel(asset) {
  return asset === "SOL" ? `${state.demoFunds.sol.amount || "0.2"} Devnet SOL` : "25 TEST-USDC";
}

function demoClaimError(asset) {
  return asset === "SOL"
    ? "Connect Phantom on Devnet to claim fee SOL."
    : "Connect Phantom on Devnet to claim demo funds.";
}

async function refreshDemoFunds() {
  if (state.network !== "devnet" || !state.walletPublicKey || !state.connection) return;
  const wallet = canonicalPublicKey(state.walletPublicKey);
  const connection = state.connection;
  const [claim, balance, solBalance] = await Promise.all([
    demoFundsRequest(`status?wallet=${encodeURIComponent(wallet.toBase58())}`),
    readWalletUsdcBalance({ mint: TEST_USDC_MINT, tokenProgram: TOKEN_2022_PROGRAM_ID }, wallet),
    connection.getBalance(wallet, "confirmed").then((lamports) => BigInt(lamports)),
  ]);
  if (state.network !== "devnet" || state.connection !== connection || !publicKeyEquals(state.walletPublicKey, wallet)) return;
  const usdcClaim = claim.usdc || claim;
  const solClaim = claim.sol || { status: "unavailable", signature: null };
  state.demoFunds.status = usdcClaim.status;
  state.demoFunds.signature = usdcClaim.signature || null;
  state.demoFunds.balance = balance;
  state.demoFunds.error = "";
  state.demoFunds.sol.status = solClaim.status;
  state.demoFunds.sol.signature = solClaim.signature || null;
  state.demoFunds.sol.amount = solClaim.amountSol || state.demoFunds.sol.amount || "0.2";
  state.demoFunds.sol.balance = solBalance;
  state.demoFunds.sol.error = solClaim.reason || "";
  render();
}

async function claimDemoFunds(asset = "USDC") {
  const demoState = demoClaimState(asset);
  if (demoState.busy) return;
  if (state.network !== "devnet" || !walletNetworkMatches() || !state.walletProvider?.signMessage) {
    demoState.error = demoClaimError(asset);
    render();
    return;
  }
  const wallet = canonicalPublicKey(state.walletPublicKey);
  const walletProvider = state.walletProvider;
  const rootDemoState = state.demoFunds;
  demoState.busy = true;
  demoState.error = "";
  demoState.notice = "";
  render();
  try {
    const challenge = await demoFundsRequest("challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: wallet.toBase58(), asset }),
    });
    if (state.network !== "devnet" || state.walletProvider !== walletProvider || !publicKeyEquals(state.walletPublicKey, wallet)) {
      throw new Error("Wallet or network changed before approval. Claim cancelled.");
    }
    const approval = await walletProvider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
    if (!approval?.signature || approval.signature.length !== 64) throw new Error("Phantom did not return a valid message signature.");
    if (state.network !== "devnet" || !walletNetworkMatches() || state.walletProvider !== walletProvider
        || !walletProvider.publicKey || !publicKeyEquals(canonicalPublicKey(walletProvider.publicKey), wallet)
        || !publicKeyEquals(state.walletPublicKey, wallet)) {
      throw new Error("Wallet or network changed during approval. Claim cancelled.");
    }
    const signature = btoa(Array.from(approval.signature, (byte) => String.fromCharCode(byte)).join(""));
    const result = await demoFundsRequest("claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: wallet.toBase58(), nonce: challenge.nonce, signature, asset }),
    });
    if (state.demoFunds !== rootDemoState || demoClaimState(asset) !== demoState || state.network !== "devnet" || !publicKeyEquals(state.walletPublicKey, wallet)) return;
    demoState.status = result.status;
    demoState.signature = result.signature || null;
    demoState.notice = result.status === "claimed"
      ? asset === "SOL" ? `${demoClaimLabel(asset)} received for transaction fees.` : "25 TEST-USDC received. Demo tokens have no monetary value."
      : "Claim submitted. Check its status before trying again.";
    await refreshDemoFunds().catch(() => {});
    if (state.selected?.publicKey && state.network === "devnet" && publicKeyEquals(state.walletPublicKey, wallet)) {
      await loadPortfolio(state.selected.publicKey).catch(() => {
        demoState.notice = "Claim recorded. Refresh the portfolio to update your displayed balance.";
      });
    }
  } catch (error) {
    if (state.demoFunds === rootDemoState && demoClaimState(asset) === demoState) {
      demoState.error = error.message || String(error);
      if (/exhausted|below its reserve/i.test(demoState.error)) demoState.status = "exhausted";
    }
  } finally {
    if (state.demoFunds === rootDemoState && demoClaimState(asset) === demoState) {
      demoState.busy = false;
      render();
    }
  }
}

async function loadPortfolio(portfolioKey) {
  if (!state.program) await initializeProgram();
  const key = new PublicKey(portfolioKey);
  const wallet = state.walletPublicKey ? canonicalPublicKey(state.walletPublicKey) : null;
  const program = state.program;
  const connection = state.connection;
  const network = state.network;
  const portfolio = await program.account.portfolio.fetch(key, "confirmed");
  const memberKey = wallet ? memberPda(key, wallet) : null;
  const [allMembers, walletMember] = await Promise.all([
    program.account.member.all(),
    memberKey ? program.account.member.fetchNullable(memberKey, "confirmed") : Promise.resolve(null),
  ]);
  const members = (Array.isArray(allMembers) ? allMembers : [])
    .filter((item) => publicKeyEquals(item?.account?.portfolio, key));
  const walletMemberMatches = Boolean(walletMember && memberKey
    && publicKeyEquals(walletMember.portfolio, key)
    && publicKeyEquals(walletMember.wallet, wallet));
  const visibleToWallet = Boolean(wallet && (publicKeyEquals(portfolio.creator, wallet) || walletMemberMatches));
  if (walletMemberMatches) {
    const index = members.findIndex((item) => publicKeyEquals(item?.publicKey, memberKey));
    const directMember = { account: walletMember, publicKey: memberKey };
    if (index < 0) members.push(directMember);
    else members[index] = directMember;
  }
  const vaults = [];
  vaults.push(await readTokenAsset(key, portfolio.usdcMint, displayAsset(state.network, portfolio.usdcMint, true), null, true));
  for (const asset of portfolio.basket) {
    vaults.push(await readTokenAsset(key, asset.mint, displayAsset(state.network, asset.mint), asset.allocationBps, false));
  }
  let selectedMember = null;
  let selectedMemberError = null;
  if (wallet) {
    if (walletMemberMatches) {
      selectedMember = { ...walletMember, publicKey: memberKey, pda: memberKey };
    }
    else selectedMemberError = "This wallet has not been invited to this portfolio.";
  }
  const walletUsdcBalance = await readWalletUsdcBalance(vaults[0], wallet);
  if (state.program !== program || state.connection !== connection || state.network !== network
      || (wallet?.toBase58() ?? null) !== (state.walletPublicKey?.toBase58() ?? null)) {
    throw new Error("Wallet or network changed while refreshing portfolio state.");
  }
  state.selected = { ...portfolio, publicKey: key };
  state.portfolios = state.portfolios.some((item) => publicKeyEquals(item?.publicKey, key))
    ? state.portfolios.map((item) => publicKeyEquals(item?.publicKey, key) ? state.selected : item)
    : visibleToWallet ? [...state.portfolios, state.selected] : state.portfolios;
  state.selectedMembers = members.map((item) => ({ ...item.account, publicKey: item.publicKey }));
  state.selectedVaults = vaults;
  state.selectedMember = selectedMember;
  state.selectedMemberError = selectedMemberError;
  state.selectedWalletUsdcBalance = walletUsdcBalance;
  state.view = "detail";
  render();
}

async function refreshPortfolios() {
  if (!state.program) await initializeProgram();
  const wallet = state.walletPublicKey ? canonicalPublicKey(state.walletPublicKey) : null;
  if (!wallet) {
    state.portfolios = [];
    state.selected = null;
    render();
    return;
  }
  const [accounts, members] = await Promise.all([
    state.program.account.portfolio.all(),
    state.program.account.member.all(),
  ]);
  state.portfolios = accounts
    .filter((item) => publicKeyEquals(item?.account?.creator, wallet)
      || members.some((member) => publicKeyEquals(member?.account?.portfolio, item?.publicKey)
        && publicKeyEquals(member?.account?.wallet, wallet)))
    .map((item) => ({ ...item.account, publicKey: item.publicKey }));
  if (state.selected?.publicKey) {
    try { await loadPortfolio(state.selected.publicKey); } catch { state.selected = null; }
  }
  render();
}

async function requireWallet() {
  if (!state.walletPublicKey) {
    await connectWallet();
  }
  if (!state.program) await initializeProgram();
  return state.walletPublicKey;
}

async function runAction(label, action) {
  if (state.busy) return;
  const retryContext = {
    network: state.network,
    wallet: state.walletPublicKey?.toBase58(),
    walletProvider: state.walletProvider,
    view: state.view,
    portfolio: state.selected?.publicKey?.toBase58(),
  };
  state.busy = label;
  state.error = "";
  state.errorDetails = "";
  state.notice = "";
  state.retryAction = null;
  render();
  try {
    const result = await action();
    state.notice = label === "Investing funds" ? "Completed" : `${label} complete.`;
    toast(state.notice);
    return result;
  } catch (error) {
    const message = friendlyActionError(error, label);
    state.error = message;
    state.errorDetails = [error?.message || String(error), error?.logs?.join("\n")].filter(Boolean).join("\n");
    if (((label === "Withdrawing" && isWithdrawalAlreadyCompletedError(error))
        || (label === "Claiming refund" && isRefundAlreadyCompletedError(error)))
        && state.network === retryContext.network
        && state.walletPublicKey?.toBase58() === retryContext.wallet
        && state.selected?.publicKey?.toBase58() === retryContext.portfolio) {
      await loadPortfolio(state.selected.publicKey).catch(() => {});
    }
    if (
      error instanceof ApprovalExpiredError
      && state.network === retryContext.network
      && state.walletProvider === retryContext.walletProvider
      && state.walletPublicKey?.toBase58() === retryContext.wallet
      && state.view === retryContext.view
      && state.selected?.publicKey?.toBase58() === retryContext.portfolio
    ) {
      state.retryAction = {
        label,
        action,
        ...retryContext,
      };
    }
    toast(message, true);
    throw error;
  } finally {
    state.busy = "";
    render();
  }
}

async function retryExpiredAction() {
  const pending = state.retryAction;
  if (!pending || state.busy) return;
  state.retryAction = null;
  if (
    state.network !== pending.network
    || state.walletProvider !== pending.walletProvider
    || state.walletPublicKey?.toBase58() !== pending.wallet
    || state.view !== pending.view
    || state.selected?.publicKey?.toBase58() !== pending.portfolio
  ) {
    state.error = "Wallet, network, or portfolio changed. Review the action and submit it again.";
    render();
    return;
  }
  await runAction(pending.label, pending.action);
}

async function createPortfolio(form) {
  await requireTransactionReady();
  const formData = new FormData(form);
  const portfolioIdText = formData.get("portfolioId").toString().trim();
  const name = formData.get("name").toString().trim();
  const description = formData.get("description").toString().trim();
  const configuredUsdc = contributionAsset(state.network);
  if (!configuredUsdc) throw new Error("Portfolio creation is available when an approved asset list is configured for this network.");
  const usdcMint = new PublicKey(configuredUsdc.mint);
  const start = Math.floor(new Date(formData.get("fundingStart").toString()).getTime() / 1000);
  const deadline = Math.floor(new Date(formData.get("fundingDeadline").toString()).getTime() / 1000);
  const target = parseRaw(formData.get("target").toString(), 6);
  const basket = validateBasketSelection(state.network, [...form.querySelectorAll("[data-basket-row]")].map((row) => ({
    mint: row.querySelector("[name=basketAsset]").value,
    allocation: row.querySelector("[name=allocation]").value,
  }))).map((asset) => ({ mint: new PublicKey(asset.mint), allocationBps: asset.allocationBps }));
  if (!name) throw new Error("Add a portfolio name.");
  if (!/^\d+$/.test(portfolioIdText)) throw new Error("Portfolio ID must be a non-negative integer.");
  const portfolioId = BigInt(portfolioIdText);
  if (portfolioId > 0xffff_ffff_ffff_ffffn) throw new Error("Portfolio ID must fit in an unsigned 64-bit integer.");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deadline)) throw new Error("Enter valid funding dates.");
  if (deadline <= start) throw new Error("Funding deadline must be after funding start.");
  if (target <= 0n) throw new Error("Funding target must be positive.");
  const tokenProgram = await tokenProgramForMint(usdcMint);
  const portfolio = portfolioPda(state.walletPublicKey, portfolioId);
  const instruction = await state.program.methods
    .createPortfolio(bn(portfolioId), name, description, bn(start), bn(deadline), bn(target), basket)
    .accounts({
      creator: state.walletPublicKey,
      portfolio,
      usdcMint,
      tokenProgram,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .remainingAccounts(basket.map((asset) => ({ pubkey: asset.mint, isSigner: false, isWritable: false })))
    .instruction();
  await sendInstructions([instruction]);
  await loadPortfolio(portfolio);
}

async function initializeVaults() {
  await requireTransactionReady();
  const portfolio = state.selected;
  if (!portfolio) throw new Error("Open a portfolio first.");
  if (!publicKeyEquals(state.walletPublicKey, portfolio.creator)) throw new Error("Only the creator can prepare vaults.");
  const assets = [{ mint: portfolio.usdcMint }, ...portfolio.basket];
  try {
    for (const asset of assets) {
      const mint = new PublicKey(asset.mint);
      const vault = vaultPda(portfolio.publicKey, mint);
      if (await state.connection.getAccountInfo(vault, "confirmed")) continue;
      const tokenProgram = await tokenProgramForMint(mint);
      const instruction = await state.program.methods
        .initializeVault()
        .accounts({ payer: state.walletPublicKey, portfolio: portfolio.publicKey, mint, vault, tokenProgram, systemProgram: SYSTEM_PROGRAM_ID })
        .instruction();
      await sendInstructions([instruction]);
    }
  } catch (error) {
    await loadPortfolio(portfolio.publicKey).catch(() => {});
    throw error;
  }
  await loadPortfolio(portfolio.publicKey);
  if (!allVaultsReady(state.selectedVaults, portfolio.basket.length)) {
    throw new Error("One or more canonical vaults are not ready onchain. Refresh and review the portfolio before opening funding.");
  }
}

async function inviteMember(form) {
  await requireTransactionReady();
  const portfolio = state.selected;
  const wallet = new PublicKey(new FormData(form).get("wallet").toString().trim());
  const member = memberPda(portfolio.publicKey, wallet);
  const instruction = await state.program.methods
    .inviteMember()
    .accounts({ creator: state.walletPublicKey, portfolio: portfolio.publicKey, wallet, member, systemProgram: SYSTEM_PROGRAM_ID })
    .instruction();
  await sendInstructions([instruction]);
  await loadPortfolio(portfolio.publicKey);
}

async function copyInviteLink() {
  if (!state.selected || !state.selectedMembers.length) throw new Error("Invite a member before sharing this portfolio.");
  const link = portfolioInviteUrl(window.location.href, state.selected.publicKey.toBase58());
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Open this page on localhost or HTTPS.");
  await navigator.clipboard.writeText(link);
  state.notice = "Invite link copied. Only invited wallets can contribute.";
  toast("Invite link copied.");
  render();
}

async function openFunding() {
  await requireTransactionReady();
  const portfolio = state.selected;
  const instruction = await state.program.methods.openFunding().accounts({ creator: state.walletPublicKey, portfolio: portfolio.publicKey }).instruction();
  await sendInstructions([instruction]);
  await loadPortfolio(portfolio.publicKey);
}

async function closeFunding() {
  await requireTransactionReady();
  const portfolio = state.selected;
  const instruction = await state.program.methods.closeFunding().accounts({ creator: state.walletPublicKey, portfolio: portfolio.publicKey }).instruction();
  await sendInstructions([instruction]);
  await loadPortfolio(portfolio.publicKey);
}

async function cancelPortfolio() {
  await requireTransactionReady();
  const portfolio = state.selected;
  if (!canCancelPortfolio(portfolio, state.walletPublicKey)) {
    throw new Error("Only the creator can cancel before any investment begins.");
  }
  const instruction = await state.program.methods.cancelPortfolio()
    .accounts({ creator: state.walletPublicKey, portfolio: portfolio.publicKey })
    .instruction();
  await sendInstructions([instruction]);
  await loadPortfolio(portfolio.publicKey);
}

async function contribute(form) {
  await requireTransactionReady();
  const portfolio = state.selected;
  if (state.network === "devnet" && !isApprovedContributionMint(state.network, portfolio?.usdcMint)) {
    throw new Error("This portfolio uses an unapproved contribution asset. Devnet demo funding is disabled.");
  }
  if (fundingEnded(portfolio.fundingDeadline)) throw new Error(FUNDING_ENDED_MESSAGE);
  if (!portfolio || !state.selectedMember || !publicKeyEquals(state.selectedMember.wallet, state.walletPublicKey)
      || !publicKeyEquals(state.selectedMember.pda, memberPda(portfolio.publicKey, state.walletPublicKey))) {
    throw new Error("Only an invited member wallet can contribute to this portfolio.");
  }
  const amount = parseRaw(new FormData(form).get("amount").toString(), 6);
  if (amount <= 0n) throw new Error("Contribution must be positive.");
  const tokenProgram = state.selectedVaults[0].tokenProgram;
  const member = memberPda(portfolio.publicKey, state.walletPublicKey);
  const sourceToken = getAssociatedTokenAddressSync(portfolio.usdcMint, state.walletPublicKey, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vault = vaultPda(portfolio.publicKey, portfolio.usdcMint);
  const instruction = await state.program.methods
    .contribute(bn(amount))
    .accounts({ contributor: state.walletPublicKey, portfolio: portfolio.publicKey, member, mint: portfolio.usdcMint, sourceToken, vault, tokenProgram })
    .instruction();
  const instructions = [];
  if (!(await state.connection.getAccountInfo(sourceToken, "confirmed"))) {
    instructions.push(createWalletAtaInstruction(createAssociatedTokenAccountInstruction,
      state.walletPublicKey, sourceToken, portfolio.usdcMint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  instructions.push(instruction);
  await sendInstructions(instructions);
  await loadPortfolio(portfolio.publicKey);
}

function deploymentInputAmount(portfolio, index) {
  const total = BigInt(rawString(portfolio.totalContributed));
  if (index === portfolio.basket.length - 1) {
    let before = 0n;
    for (let i = 0; i < index; i++) before += (total * BigInt(portfolio.basket[i].allocationBps)) / 10_000n;
    return total - before;
  }
  return (total * BigInt(portfolio.basket[index].allocationBps)) / 10_000n;
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deployNextLeg() {
  await requireTransactionReady();
  const portfolio = state.selected;
  if (!portfolio || !publicKeyEquals(state.walletPublicKey, portfolio.creator)) throw new Error("Only the portfolio creator can invest the recorded funds.");
  if (state.network === "devnet" && !isApprovedContributionMint(state.network, portfolio.usdcMint)) {
    throw new Error("This portfolio uses an unapproved contribution asset. Devnet demo investment is disabled.");
  }
  const deploymentLegs = deploymentLegsOf(portfolio);
  if (!deploymentLegs.length) throw new Error("Deployment has not been initialized for this portfolio.");
  const index = deploymentLegs.findIndex((leg) => Number(leg.status) === 0);
  if (index < 0) throw new Error("All deployment legs are already complete.");
  const inputAmount = deploymentInputAmount(portfolio, index);
  const outputMint = new PublicKey(portfolio.basket[index].mint);
  const outputVault = vaultPda(portfolio.publicKey, outputMint);
  const inputMint = new PublicKey(portfolio.usdcMint);
  const usdcVault = vaultPda(portfolio.publicKey, inputMint);
  const mode = deploymentMode(state.network, inputMint.toBase58(), outputMint.toBase58());
  state.busy = "Preparing investment...";
  render();
  if (mode === "devnet-demo") {
    const approvedUsdc = contributionAsset("devnet");
    const approvedOutput = basketAssets("devnet").find((asset) => asset.mint === outputMint.toBase58());
    if (inputMint.toBase58() !== approvedUsdc.mint || !approvedOutput) {
      throw new Error("This Devnet portfolio does not use an approved demo asset.");
    }
    if (approvedOutput.demoPriceNumerator !== 1n || approvedOutput.demoPriceDenominator !== 1n || approvedOutput.decimals !== 6) {
      throw new Error("This demo asset does not match the approved fixed settlement price.");
    }
    if (typeof state.program.methods.deployDemoLeg !== "function") {
      throw new Error("The Devnet Demo Router program upgrade and IDL are required before investing.");
    }
    const demoAuthority = PublicKey.findProgramAddressSync([seedText("demo-authority")], PROGRAM_ID)[0];
    const demoUsdcSink = PublicKey.findProgramAddressSync([seedText("demo-sink"), inputMint.toBytes()], PROGRAM_ID)[0];
    const demoOutputLiquidity = PublicKey.findProgramAddressSync([seedText("demo-liquidity"), outputMint.toBytes()], PROGRAM_ID)[0];
    if (inputAmount > 0n) {
      const liquidity = await getAccount(state.connection, demoOutputLiquidity, "confirmed", TOKEN_2022_PROGRAM_ID)
        .catch(() => { throw new Error("Devnet Demo Router liquidity is not ready. Ask the demo organizer to prepare it."); });
      if (liquidity.amount < inputAmount) throw new Error(`Devnet Demo Router has insufficient ${approvedOutput.ticker} liquidity for this leg.`);
    }
    const instruction = await state.program.methods
      .deployDemoLeg(index, bn(inputAmount), bn(inputAmount))
      .accounts({
        caller: state.walletPublicKey,
        portfolio: portfolio.publicKey,
        inputMint,
        usdcVault,
        outputMint,
        outputVault,
        demoAuthority,
        demoUsdcSink,
        demoOutputLiquidity,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
    state.busy = `Investing in ${approvedOutput.ticker}...`;
    render();
    await sendInstructions([instruction], { computeUnitLimit: COMPLEX_COMPUTE_UNIT_LIMIT });
    await loadPortfolio(portfolio.publicKey);
    return;
  }
  if (inputAmount === 0n) {
    const tokenProgram = await tokenProgramForMint(inputMint);
    const instruction = await state.program.methods.deployLeg(index, bn(0), bn(0), bn(0), 0, [])
      .accounts({ caller: state.walletPublicKey, portfolio: portfolio.publicKey, inputMint, usdcVault, outputMint, outputVault,
        tokenProgram, outputTokenProgram: TOKEN_2022_PROGRAM_ID,
        jupiterProgram: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") })
      .instruction();
    await sendInstructions([instruction], { computeUnitLimit: COMPLEX_COMPUTE_UNIT_LIMIT });
    await loadPortfolio(portfolio.publicKey);
    return;
  }
  const query = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: inputAmount.toString(),
    taker: portfolio.publicKey.toBase58(),
    destinationTokenAccount: outputVault.toBase58(),
    slippageBps: "50",
  });
  const response = await fetch(`https://api.jup.ag/swap/v2/build?${query.toString()}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Jupiter /build failed (${response.status}).`);
  const build = await response.json();
  const swap = build.swapInstruction;
  if (!swap || swap.programId !== "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") throw new Error("Jupiter returned an unsupported swap program.");
  if (String(build.inAmount) !== inputAmount.toString()) throw new Error("Jupiter input amount did not match the approved leg.");
  if (!Array.isArray(swap.accounts) || swap.accounts.length < 3) throw new Error("Jupiter returned an incomplete account list.");
  if (build.taker && build.taker !== portfolio.publicKey.toBase58()) throw new Error("Jupiter route taker was not the portfolio PDA.");
  if (build.destinationTokenAccount && build.destinationTokenAccount !== outputVault.toBase58()) throw new Error("Jupiter route destination was not the portfolio output vault.");
  if (swap.accounts[0].pubkey !== portfolio.publicKey.toBase58()) throw new Error("Jupiter authority account was not the portfolio PDA.");
  const outputTokenProgram = await tokenProgramForMint(outputMint);
  if (!publicKeyEquals(outputTokenProgram, TOKEN_2022_PROGRAM_ID)) throw new Error("The basket output mint must use Token-2022.");
  const generatedSource = swap.accounts[1].pubkey;
  const generatedOutput = swap.accounts[2].pubkey;
  const accounts = swap.accounts.map((account) => ({
    pubkey: new PublicKey(account.pubkey === generatedSource ? usdcVault : account.pubkey === generatedOutput ? outputVault : account.pubkey),
    isSigner: false,
    isWritable: Boolean(account.isWritable),
  }));
  const tokenProgram = state.selectedVaults[0].tokenProgram;
  const slippageBps = Number(build.slippageBps ?? query.get("slippageBps"));
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error("Jupiter returned an invalid slippage value.");
  if (build.outAmount == null || build.otherAmountThreshold == null || !swap.data) throw new Error("Jupiter route omitted required quote or instruction data.");
  const instruction = await state.program.methods
    .deployLeg(index, bn(inputAmount), bn(build.outAmount), bn(build.otherAmountThreshold), slippageBps, Array.from(decodeBase64(swap.data)))
    .accounts({
      caller: state.walletPublicKey,
      portfolio: portfolio.publicKey,
      inputMint,
      usdcVault,
      outputMint,
      outputVault,
      tokenProgram,
      outputTokenProgram: TOKEN_2022_PROGRAM_ID,
      jupiterProgram: new PublicKey(swap.programId),
    })
    .remainingAccounts(accounts)
    .instruction();
  state.busy = `Investing in ${displayAsset(state.network, outputMint)}...`;
  render();
  await sendInstructions([instruction], { computeUnitLimit: COMPLEX_COMPUTE_UNIT_LIMIT });
  await loadPortfolio(portfolio.publicKey);
}

async function withdrawalRows() {
  const portfolio = state.selected;
  const member = state.selectedMember;
  if (!portfolio || !member) return [];
  const total = BigInt(rawString(portfolio.totalUnits));
  if (total === 0n) return [];
  return state.selectedVaults.map((asset) => ({
    ...asset,
    entitlement: (asset.rawBalance * BigInt(rawString(member.ownershipUnits))) / total,
  }));
}

async function withdrawMember() {
  await requireTransactionReady();
  const portfolioKey = state.selected?.publicKey;
  if (!portfolioKey) throw new Error("Open a portfolio before withdrawing.");
  await loadPortfolio(portfolioKey);
  const portfolio = state.selected;
  const member = state.selectedMember;
  if (!member) throw new Error("This wallet is not an invited member.");
  if (memberHasWithdrawn(member) || BigInt(rawString(portfolio.totalUnits)) === 0n) {
    throw new Error("WithdrawalAlreadyCompleted");
  }
  if (Number(portfolio.status) !== STATUS.ACTIVE) throw new Error("This portfolio is not active for withdrawals.");
  const rows = state.selectedVaults;
  const instructions = [];
  const remainingAccounts = [];
  for (const asset of rows) {
    const destination = getAssociatedTokenAddressSync(asset.mint, state.walletPublicKey, false, asset.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    if (!(await state.connection.getAccountInfo(destination, "confirmed"))) {
      instructions.push(createWalletAtaInstruction(createAssociatedTokenAccountInstruction,
        state.walletPublicKey, destination, asset.mint, asset.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
    }
    remainingAccounts.push(
      { pubkey: asset.vault, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: asset.mint, isSigner: false, isWritable: false },
      { pubkey: asset.tokenProgram, isSigner: false, isWritable: false },
    );
  }
  const instruction = await state.program.methods
    .withdrawMember()
    .accounts({ memberWallet: state.walletPublicKey, portfolio: portfolio.publicKey, member: member.pda })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(instruction);
  await sendInstructions(instructions, { computeUnitLimit: COMPLEX_COMPUTE_UNIT_LIMIT });
  await loadPortfolio(portfolio.publicKey);
}

async function claimRefund() {
  await requireTransactionReady();
  const portfolioKey = state.selected?.publicKey;
  if (!portfolioKey) throw new Error("Open a cancelled portfolio first.");
  await loadPortfolio(portfolioKey);
  const portfolio = state.selected;
  const member = state.selectedMember;
  if (!member || !publicKeyEquals(member.wallet, state.walletPublicKey)) {
    throw new Error("Only the invited member can claim this refund.");
  }
  if (memberRefunded(member)) throw new Error("RefundAlreadyCompleted");
  if (!canClaimRefund(portfolio, member)) throw new Error("No recorded contribution is available to refund.");

  const usdc = state.selectedVaults[0];
  const destination = getAssociatedTokenAddressSync(usdc.mint, state.walletPublicKey, false,
    usdc.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  const instructions = [];
  if (!(await state.connection.getAccountInfo(destination, "confirmed"))) {
    instructions.push(createWalletAtaInstruction(createAssociatedTokenAccountInstruction,
      state.walletPublicKey, destination, usdc.mint, usdc.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  const instruction = await state.program.methods.refundMember().accounts({
    memberWallet: state.walletPublicKey,
    portfolio: portfolio.publicKey,
    member: memberPda(portfolio.publicKey, state.walletPublicKey),
    usdcMint: usdc.mint,
    usdcVault: vaultPda(portfolio.publicKey, usdc.mint),
    destinationToken: destination,
    tokenProgram: usdc.tokenProgram,
  }).instruction();
  instructions.push(instruction);
  await sendInstructions(instructions, { computeUnitLimit: COMPLEX_COMPUTE_UNIT_LIMIT });
  await loadPortfolio(portfolio.publicKey);
}

function createDraftFromDom() {
  const form = document.querySelector("#create-form");
  if (!form) return;
  const formData = new FormData(form);
  state.createDraft.portfolioId = formData.get("portfolioId")?.toString() || state.createDraft.portfolioId;
  state.createDraft.name = formData.get("name")?.toString() || "";
  state.createDraft.description = formData.get("description")?.toString() || "";
  state.createDraft.target = formData.get("target")?.toString() || "";
  state.createDraft.fundingStart = formData.get("fundingStart")?.toString() || state.createDraft.fundingStart;
  state.createDraft.fundingDeadline = formData.get("fundingDeadline")?.toString() || state.createDraft.fundingDeadline;
  state.createDraft.basket = [...form.querySelectorAll("[data-basket-row]")].map((row) => ({
    mint: row.querySelector("[name=basketAsset]").value,
    allocation: row.querySelector("[name=allocation]").value,
  }));
}

function addBasketRow() {
  createDraftFromDom();
  const availableAssets = basketAssets(state.network).filter((asset) => asset.available);
  if (state.createDraft.basket.length >= Math.min(8, availableAssets.length)) return;
  const used = new Set(state.createDraft.basket.map((row) => row.mint));
  const next = availableAssets.find((asset) => !used.has(asset.mint));
  if (!next) return;
  state.createDraft.basket.push({ mint: next.mint, allocation: "0" });
  render();
}

function removeBasketRow(index) {
  createDraftFromDom();
  if (state.createDraft.basket.length <= 1) return;
  state.createDraft.basket.splice(index, 1);
  render();
}

function previewFor(row) {
  return formatRaw(row.entitlement, row.decimals);
}

function toast(message, error = false) {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  region.appendChild(element);
  setTimeout(() => element.remove(), 5000);
}

function pageHeader(title, description, action = "") {
  return `<div class="page-head"><div><div class="eyebrow">${esc(networkConfig().label)} workspace</div><h2>${esc(title)}</h2></div><p>${esc(description)}</p>${action}</div>`;
}

function landingView() {
  return `<section class="view">
    <div class="hero">
      <div class="hero-copy">
        <div class="eyebrow">A shared circle for serious ideas</div>
        <h1>Invest together.<br /><em>Own independently.</em></h1>
        <p>StockSplit turns a trusted group of friends, family, or collaborators into one transparent xStock portfolio—with each person’s ownership recorded clearly.</p>
        <div class="hero-actions">
          <button class="button primary" data-action="connect">${state.walletPublicKey ? "Open dashboard" : "Connect wallet"} <span>↗</span></button>
          <button class="button secondary" data-action="explore">See how it works</button>
        </div>
        <div class="hero-note">Invite-only · verifiable shared custody · in-kind exits · ${esc(networkConfig().label)}${state.network === "devnet" ? " · demo assets have no monetary value" : ""}</div>
      </div>
      <div class="hero-art">
        <div class="circle-map">
          <div class="circle-core"><strong>1 circle</strong><span>many owners</span></div>
          <div class="orbit-card"><small>CREATOR</small><strong>sets the basket</strong></div>
          <div class="orbit-card"><small>MEMBERS</small><strong>contribute ${state.network === "devnet" ? "TEST-USDC" : "USDC"}</strong></div>
          <div class="orbit-card"><small>VAULTS</small><strong>hold the raw assets</strong></div>
          <div class="orbit-card"><small>EXIT</small><strong>in kind, anytime active</strong></div>
          <div class="orbit-dot one"></div><div class="orbit-dot two"></div>
        </div>
      </div>
    </div>
    <div class="feature-strip">
      <div><strong>Fixed from day one</strong><span>Basket and ownership rules are clear before the circle opens.</span></div>
      <div><strong>Custody you can verify</strong><span>Shared portfolio custody keeps every member’s share protected.</span></div>
      <div><strong>Exit without a meeting</strong><span>Active members withdraw their proportional raw assets independently.</span></div>
    </div>
  </section>`;
}

function docsView() {
  const demoAssets = basketAssets("devnet").map((asset) => `<span class="docs-asset-pill"><span class="asset-icon">${esc(asset.icon)}</span><span><strong>${esc(asset.name)}</strong><small>${esc(asset.ticker)}</small></span></span>`).join("");
  const steps = [
    ["01", "Create portfolio", "Name your portfolio, set a funding window, and choose the fixed basket."],
    ["02", "Choose the basket", "Select one to eight xStocks and set allocations that add up to 100%."],
    ["03", "Invite members", "The creator invites the wallets that can participate in this circle."],
    ["04", "Fund together", "Members contribute TEST-USDC on Devnet and receive matching ownership units."],
    ["05", "End funding", "The creator closes funding. Contributions and ownership percentages are now fixed."],
    ["06", "Invest the funds", "The recorded funds are deployed into the chosen xStocks, one basket leg per transaction."],
    ["07", "Hold together", "The portfolio becomes Active when every basket leg is complete."],
    ["08", "Withdraw independently", "Each member receives their proportional in-kind assets. The final withdrawal closes the portfolio."],
  ];
  return `<section class="view docs-view">
    <div class="docs-hero card"><div class="docs-hero-grid"><div><div class="eyebrow">StockSplit docs</div><h1>Invest together.<br /><em>Own independently.</em></h1><p>Invite-only collaborative xStock portfolios on Solana. Members fund one circle together while keeping independent ownership and withdrawal rights.</p><div class="docs-hero-actions"><button class="button primary" data-action="create-view">Create portfolio <span>↗</span></button><span class="docs-hero-note">For users and technical judges</span></div></div><div class="docs-hero-card"><span class="section-label">The simple idea</span><strong>One shared portfolio.<br />Independent exits.</strong><p>Your ownership follows your contribution units—not a tradable share token or a price estimate.</p></div></div></div>
    <div class="docs-layout">
      <aside class="card docs-toc"><div class="section-label">On this page</div><a href="#docs-overview">Overview</a><a href="#docs-how-it-works">How it works</a><a href="#docs-ownership">Ownership</a><a href="#docs-cancel">Cancel + refund</a><a href="#docs-devnet">Devnet demo mode</a><a href="#docs-funds">Demo funds</a><a href="#docs-architecture">Architecture</a><a href="#docs-safety">Safety</a><a href="#docs-technical">Technical details</a><a href="#docs-faq">FAQ</a></aside>
      <div class="docs-content">
        <section id="docs-overview" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Overview</div><h2>A shared circle, made clear.</h2></div><span class="docs-audience">For users</span></div><p>StockSplit lets a trusted group create an invite-only portfolio of xStocks. Members contribute together, but each person’s ownership is recorded separately. That means you can leave on your own terms and receive your proportional assets in kind.</p><div class="docs-callout"><strong>Invest together. Own independently.</strong><span>Shared custody for the group. Independent rights for every member.</span></div></section>

        <section id="docs-how-it-works" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">How it works</div><h2>From invitation to ownership.</h2></div><span class="docs-audience">For users</span></div><div class="docs-steps">${steps.map(([number, title, copy]) => `<article class="docs-step"><span class="docs-step-number">${number}</span><div><h3>${title}</h3><p>${copy}</p></div></article>`).join("")}</div></section>

        <section id="docs-ownership" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Ownership</div><h2>Units keep the circle fair.</h2></div><span class="docs-audience">For users</span></div><div class="docs-two-col"><div><p>Every contribution creates ownership units using the same raw six-decimal amount. In the human-readable UI, 25 TEST-USDC is shown as 25.00 ownership units; onchain that is exactly 25,000,000 raw units.</p><p>When funding closes, the total units and each member’s percentage are locked. Asset prices do not change those percentages.</p></div><div class="docs-equation"><span>Your ownership</span><strong>your outstanding units<br /><em>÷</em> all outstanding units</strong><small>Withdrawals reduce outstanding units exactly once.</small></div></div><div class="docs-note-row"><strong>No tradable share token</strong><span>Ownership lives in the portfolio and member accounts. It is not a separate marketable token.</span></div></section>

        <section id="docs-cancel" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Cancel + refund</div><h2>A clear exit before investment.</h2></div><span class="docs-audience">For users</span></div><div class="docs-two-col"><div><p>The creator can cancel a portfolio while it is Draft, Funding, or Funding ended—as long as no deployment leg has started.</p><p>Cancellation is terminal. Each contributing member can claim their exact recorded USDC independently. The creator cannot sweep or redirect member funds.</p></div><div class="docs-callout docs-callout-coral"><strong>Before investment starts</strong><span>Cancel → members claim refunds → the portfolio remains verifiable as Cancelled.</span></div></div></section>

        <section id="docs-devnet" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Devnet demo mode</div><h2>Everything here is a safe demo.</h2></div><span class="docs-audience docs-audience-demo">Devnet only</span></div><p>Devnet uses operator-created mock assets so the full StockSplit flow can be demonstrated without claiming real market value. These assets are not investments. TEST-USDC is the configured Token-2022 demo contribution mint with 6 decimals; production/mainnet USDC is a separate legacy SPL Token assumption.</p><div class="docs-asset-list"><span class="docs-asset-pill"><span class="asset-icon">$</span><span><strong>Demo USDC</strong><small>TEST-USDC · Token-2022 contribution asset</small></span></span>${demoAssets}</div><div class="docs-two-col docs-demo-facts"><div><strong>Deterministic settlement</strong><span>Demo deployment settles selected assets 1:1 for predictable testing.</span></div><div><strong>Devnet SOL is gas only</strong><span>The 0.2 SOL demo claim pays transaction fees. It has no portfolio value.</span></div></div></section>

        <section id="docs-funds" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Demo funds</div><h2>Get ready to try the flow.</h2></div><span class="docs-audience">For users</span></div><p>Open Demo Funds from the navigation after connecting a Devnet wallet.</p><div class="docs-funds-grid"><div class="docs-fund-card"><span class="docs-fund-icon">$</span><div><strong>Claim 25 TEST-USDC</strong><p>Demo contribution tokens for funding a portfolio. One successful claim per wallet.</p></div></div><div class="docs-fund-card"><span class="docs-fund-icon">◎</span><div><strong>Claim 0.2 Devnet SOL</strong><p>Transaction fees only. One successful claim per wallet, subject to the faucet reserve.</p></div></div></div><p class="docs-muted">The official <a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer">Solana Devnet faucet ↗</a> is also available for SOL.</p></section>

        <section id="docs-architecture" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Production architecture</div><h2>Simple on the surface. Verifiable underneath.</h2></div><span class="docs-audience">For developers</span></div><div class="docs-architecture-grid"><div><h3>Custody and assets</h3><p>The Solana program controls portfolio vaults with PDAs. Canonical legacy SPL Token USDC is supported alongside Token-2022 xStocks.</p></div><div><h3>Deployment</h3><p>Production deployment uses Jupiter routing, while Devnet uses deterministic demo settlement because mock assets do not have Jupiter liquidity.</p></div><div><h3>Lifecycle</h3><p>Each basket leg is one transaction. The portfolio becomes Active only after all legs complete.</p></div><div><h3>Withdrawal</h3><p>Members withdraw proportional in-kind assets from current vault balances. No NAV, oracle, or redemption into USDC is used.</p></div></div></section>

        <section id="docs-safety" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">Safety / guarantees</div><h2>Rules that protect the circle.</h2></div><span class="docs-audience">For everyone</span></div><div class="docs-safety-grid"><div class="docs-safety-item"><strong>Invite-only</strong><span>Only invited wallets can contribute.</span></div><div class="docs-safety-item"><strong>Clear controls</strong><span>Creator controls lifecycle steps where appropriate.</span></div><div class="docs-safety-item"><strong>Independent exits</strong><span>Members do not need creator approval to withdraw.</span></div><div class="docs-safety-item"><strong>Canonical vaults</strong><span>Transfers are bound to the portfolio’s configured assets and vaults.</span></div><div class="docs-safety-item"><strong>No duplicates</strong><span>Completed withdrawals and refunds cannot be repeated.</span></div><div class="docs-safety-item"><strong>No sweep</strong><span>The creator cannot take custody of member funds.</span></div><div class="docs-safety-item"><strong>Cancel boundary</strong><span>Cancellation is forbidden after deployment begins.</span></div><div class="docs-safety-item"><strong>Final close</strong><span>The last member withdrawal moves the portfolio to Closed.</span></div></div></section>

        <section id="docs-technical" class="card docs-section"><details class="docs-technical" open><summary><div><div class="section-label">Technical details</div><h2>For technical judges</h2></div><span class="docs-summary-hint">Expand / collapse</span></summary><div class="docs-technical-body"><div class="docs-technical-grid"><div><span>Network</span><strong>Solana Devnet</strong></div><div><span>Program ID</span><code>9nLrXyjgLTwMxnyBJ2GnKqnHZiu5koYNHrpKXezVGDmm</code></div><div><span>Devnet contribution asset</span><strong>TEST-USDC · Token-2022 · 6 decimals</strong></div><div><span>Basket assets</span><strong>TEST-NVDAx · TEST-AAPLx · TEST-TSLAx · TEST-SPYx · Token-2022</strong></div></div><div class="docs-technical-summary"><strong>Architecture summary</strong><p>Anchor program, PDA-controlled portfolio and token vaults, invite/member accounts, fixed allocation basket, one deployment leg per transaction, deterministic Devnet demo settlement, and proportional in-kind member withdrawals. Ownership units use raw six-decimal accounting: 25 TEST-USDC = 25,000,000 raw units.</p></div><div class="docs-placeholder"><strong>Source code</strong><a class="docs-external-link" href="https://github.com/london160771/StockSplit" target="_blank" rel="noopener noreferrer">View source on GitHub ↗</a></div></div></details></section>

        <section id="docs-faq" class="card docs-section"><div class="docs-section-heading"><div><div class="section-label">FAQ</div><h2>Good questions are part of the product.</h2></div><span class="docs-audience">For users</span></div><div class="docs-faq"><details open><summary>Is this real money?</summary><p>Not in Devnet Demo Mode. TEST-USDC and the TEST-xStock assets are mock assets with no monetary value.</p></details><details><summary>Can the creator take my funds?</summary><p>No. Member ownership is recorded separately, vaults are controlled by the program, and there is no creator sweep path.</p></details><details><summary>Can I leave before others?</summary><p>Yes. Once the portfolio is Active, each eligible member can withdraw their proportional in-kind assets independently.</p></details><details><summary>What happens if the portfolio is cancelled?</summary><p>Before deployment starts, the creator can cancel. The portfolio becomes terminal and each contributing member can claim their exact recorded USDC refund.</p></details><details><summary>Why does Devnet use mock assets?</summary><p>The demo assets are operator-created Token-2022 mints without Jupiter liquidity. Deterministic settlement lets judges exercise the full flow safely.</p></details><details><summary>What is Devnet SOL used for?</summary><p>Devnet SOL pays transaction fees only. It is not deposited into a portfolio and has no investment value.</p></details><details><summary>What happens after the last member withdraws?</summary><p>Outstanding units reach zero and the portfolio becomes Closed.</p></details></div></section>
      </div>
    </div>
  </section>`;
}

function dashboardView() {
  const portfolios = state.walletPublicKey ? state.portfolios : [];
  const cards = portfolios.map((portfolio) => {
    const total = formatRaw(portfolio.totalContributed, 6);
    const status = Number(portfolio.status);
    return `<button class="card portfolio-card" data-open-portfolio="${portfolio.publicKey.toBase58()}">
      <div><h3>${esc(portfolio.name)}</h3><p>${esc(portfolio.description || "Invite-only collaborative portfolio")}</p><div class="portfolio-meta"><span class="status ${statusClass(status)}">${statusLabel(status)}</span><span class="mono">${portfolio.basket.length} asset${portfolio.basket.length === 1 ? "" : "s"}</span></div></div>
      <div class="stat"><label>Recorded contributions</label><strong>${esc(total)} ${esc(portfolioContributionLabel(portfolio))}</strong></div>
    </button>`;
  }).join("");
  const emptyState = !state.walletPublicKey
    ? `<div class="card empty-state"><strong>Connect to see your circles.</strong><span>My portfolios only shows circles you created or joined.</span></div>`
    : `<div class="card empty-state"><strong>Your first circle starts here.</strong><span>Create a fixed basket or open an invite link from someone you trust.</span></div>`;
  return `<section class="view">
    ${pageHeader("Your investment circles", "Browse live portfolios, follow each step, and keep the next action obvious.", `<button class="button primary" data-action="create-view">Create portfolio</button>`)}
    <div class="dashboard-grid"><div><div class="section-label">Your portfolios on ${esc(networkConfig().label)}</div><div class="portfolio-list">${cards || emptyState}</div></div>
      <aside class="card side-card"><div class="section-label">A simpler ownership model</div><h3>Many vaults. Clear shares.</h3><p>Each contribution becomes ownership units. Your share is your units divided by the circle’s outstanding units—not a price estimate.</p><div class="circle-stat"><div class="mini-ring"><span>live</span></div><div><strong>Transparent by design</strong><p style="margin:4px 0 0">Current balances, fixed units, in-kind withdrawals.</p></div></div></aside>
    </div>
  </section>`;
}

function createView() {
  const draft = state.createDraft;
  const transactionEnabled = transactionActionsEnabled();
  const registry = basketAssets(state.network);
  const usdc = contributionAsset(state.network);
  const total = draft.basket.reduce((sum, row) => sum + Number(row.allocation || 0), 0);
  const rows = draft.basket.map((row, index) => {
    const selected = registry.find((asset) => asset.mint === row.mint) || registry[0];
    return `<div class="basket-row" data-basket-row>
    <div class="asset-picker"><div class="asset-picker-heading"><span class="asset-icon">${esc(selected?.icon || "•")}</span><div><strong>${esc(selected?.name || "Choose an asset")}</strong><small>${esc(selected?.ticker || "Approved demo asset")}</small></div></div><select class="input" name="basketAsset" required aria-label="Basket asset">${registry.map((asset) => `<option value="${esc(asset.mint || "")}" ${row.mint === asset.mint ? "selected" : ""} ${asset.available ? "" : "disabled"}>${esc(asset.name)} · ${esc(asset.ticker)}${asset.available ? "" : " · operator setup pending"}</option>`).join("")}</select></div>
    <div class="field"><label>Allocation %</label><input class="input" name="allocation" value="${esc(row.allocation)}" min="0.01" max="100" step="0.01" type="number" required /></div>
    <button class="remove-asset" type="button" data-remove-basket="${index}" aria-label="Remove asset">×</button>
  </div>`;
  }).join("");
  const availableCount = registry.filter((asset) => asset.available).length;
  return `<section class="view">
    ${pageHeader("Create portfolio", "Choose a fixed basket, set the funding window, and make ownership clear before anyone contributes.")}
    <form id="create-form" class="card form-card">
      <div class="form-grid">
        <div class="field"><label>Portfolio name</label><input class="input" name="name" value="${esc(draft.name)}" placeholder="AI Leaders" required /></div>
        <div class="field"><label>Portfolio ID</label><input class="input" name="portfolioId" value="${esc(draft.portfolioId)}" inputmode="numeric" required /><small>Unique for your wallet on this network.</small></div>
        <div class="field full"><label>Short description</label><textarea class="input" name="description" placeholder="A focused basket for our circle">${esc(draft.description)}</textarea></div>
        <div class="field full"><label>Funding asset</label><div class="configured-asset">${esc(usdc?.ticker || "No approved contribution asset on this network")}</div><small>${state.network === "devnet" ? "TEST-USDC is demo funding on Devnet and has no monetary value. It is selected automatically." : "Creation is paused until a curated production asset list is approved."}</small></div>
        <div class="field"><label>Funding target · ${state.network === "devnet" ? "TEST-USDC" : "USDC"}</label><input class="input" name="target" value="${esc(draft.target)}" type="number" min="0.000001" step="0.000001" required />${state.network === "devnet" ? `<small>Demo tip: choose about 40–50 TEST-USDC so two invited wallets can fund it with one 25-token claim each. Demo assets have no monetary value.</small>` : ""}</div>
        <div class="field"><label>Funding opens</label><input class="input" name="fundingStart" value="${esc(draft.fundingStart)}" type="datetime-local" required /></div>
        <div class="field"><label>Funding closes</label><input class="input" name="fundingDeadline" value="${esc(draft.fundingDeadline)}" type="datetime-local" required /></div>
      </div>
       <div class="basket-editor"><div class="card-head"><div><h3>Fixed basket</h3><small>Choose the xStocks your circle will hold. Each allocation must total 100%.</small></div><button class="button ghost" type="button" data-action="add-basket" ${draft.basket.length >= Math.min(8, availableCount) ? "disabled" : ""}>+ Add asset</button></div>${rows}<small class="field"><span>${state.network === "devnet" ? "These are mock xStocks for Devnet only and have no monetary value. Assets awaiting operator mint creation remain visible but cannot be submitted yet." : "Choose from the approved asset list. Allocations are stored as exact basis points."}</span></small></div>
      <div class="form-footer"><span class="allocation-total ${Math.abs(total - 100) < .0001 ? "valid" : ""}">Allocation total · ${total.toFixed(2)}% ${Math.abs(total - 100) < .0001 ? "✓" : "· needs 100%"}</span><button class="button primary" type="submit" ${Math.abs(total - 100) < .0001 && transactionEnabled && usdc && registry.length ? "" : "disabled"}>Create portfolio</button></div>
    </form>
  </section>`;
}

function lifecycleRail(status) {
  const cancelled = Number(status) === STATUS.CANCELLED;
  const steps = cancelled ? STATUS_LABELS.slice(0, 3) : STATUS_LABELS.slice(0, -1);
  return `<div class="progress-rail">${steps.map((label, index) => `<div class="progress-step ${!cancelled && index < Number(status) ? "complete" : ""} ${index === Number(status) ? "current" : ""}">${label}</div>`).join("")}${cancelled ? `<div class="progress-step current">Cancelled</div>` : ""}</div>`;
}

function holdingsHtml() {
  return state.selectedVaults.map((asset) => {
    const allocation = asset.isUsdc ? null : Number(asset.allocationBps || 0) / 100;
    const leg = asset.isUsdc ? null : deploymentLegsOf(state.selected).find((item) => publicKeyEquals(item?.mint, asset.mint));
    const displayLabel = asset.label;
    return `<div class="holding-row"><div class="asset-title"><div class="asset-icon">${esc(asset.icon || (asset.isUsdc ? "$" : "x"))}</div><div><strong>${esc(displayLabel)}</strong><small>${esc(asset.ticker || displayAsset(state.network, asset.mint, asset.isUsdc))} · ${state.network === "devnet" ? "Demo asset · no monetary value" : publicKeyEquals(asset.tokenProgram, TOKEN_2022_PROGRAM_ID) ? "Token-2022 asset" : "USDC asset"}</small></div></div><div class="holding-number"><strong>${esc(formatRaw(asset.rawBalance, asset.decimals))}</strong><small>${asset.isUsdc ? "remaining contribution" : `${allocation.toFixed(2)}% allocation`}</small></div><div>${asset.isUsdc ? `<span class="status active">held</span>` : `<span class="status ${leg && Number(leg.status) === 1 ? "active" : "deploying"}">${leg && Number(leg.status) === 1 ? "ready" : "pending"}</span>`}</div><div class="allocation-bar"><span style="width:${asset.isUsdc ? 100 : Math.max(2, allocation)}%"></span></div></div>`;
  }).join("");
}

function teamHtml() {
  const total = state.selected.totalUnits;
  if (!state.selectedMembers.length) return `<div class="empty-state"><strong>No invites yet.</strong><span>Invite the people you want in the circle.</span></div>`;
  return `<div class="team-list">${state.selectedMembers.map((member) => `<div class="member-row"><div><strong>${memberRole(member, state.selected?.creator, state.walletPublicKey)}</strong><small>${formatOwnershipUnits(member?.ownershipUnits)} ownership units · ${memberRefunded(member) ? "refunded" : memberHasWithdrawn(member) ? "withdrawn" : "outstanding"}</small><div class="share-bar"><span style="width:${percentOf(member?.ownershipUnits, total)}%"></span></div></div><div class="member-share">${percentOf(member?.ownershipUnits, total)}%</div></div>`).join("")}</div>`;
}

function previewHtml(rows) {
  if (!rows.length) return `<div class="preview-row"><span>No outstanding units</span><strong>—</strong></div>`;
  return rows.map((row) => `<div class="preview-row"><span>${esc(row.isUsdc ? `Residual ${row.label}` : row.label)}</span><strong>${esc(previewFor(row))} ${esc(row.ticker)}</strong></div>`).join("");
}

function demoFundsCard(compact = false) {
  if (state.network !== "devnet") return "";
  const usdc = state.demoFunds;
  const sol = state.demoFunds.sol;
  const usdcBalance = compact ? state.selectedWalletUsdcBalance : usdc.balance;
  const usdcBalanceText = usdcBalance == null ? "Loading balance…" : `${formatRaw(usdcBalance, 6)} TEST-USDC`;
  const solBalanceText = sol.balance == null ? "Loading balance…" : `${formatRaw(sol.balance, 9)} SOL`;

  function claimStatus(claim, asset) {
    if (claim.status === "claimed") return `<div class="demo-status success">✓ ${asset === "SOL" ? "Fee SOL claimed" : "Demo funds claimed"}</div>`;
    if (claim.status === "pending") return `<div class="demo-status">Claim pending on Devnet. Check its status before trying again.</div>`;
    if (claim.status === "exhausted") return `<div class="demo-status">${asset === "SOL" ? "The fee SOL faucet is below its reserve." : "The TEST-USDC faucet is exhausted."}</div>`;
    if (claim.status === "unavailable") return `<div class="demo-status">The fee SOL faucet is not configured yet.</div>`;
    return "";
  }

  function claimAction(claim, asset) {
    if (!state.walletPublicKey) return `<button class="button secondary" data-action="wallet" type="button">Connect wallet</button>`;
    if (claim.status === "claimed" || claim.status === "exhausted" || claim.status === "unavailable") return "";
    if (claim.status === "pending") return `<button class="button secondary" data-action="demo-funds-status" type="button" ${demoFundsBusy() ? "disabled" : ""}>Check claim status</button>`;
    const action = asset === "SOL" ? "claim-demo-sol" : "claim-demo-funds";
    const label = `Claim ${demoClaimLabel(asset)}`;
    return `<button class="button secondary" data-action="${action}" type="button" ${claim.busy || !walletNetworkMatches() ? "disabled" : ""}>${claim.busy ? `Claiming ${esc(demoClaimLabel(asset))}…` : label}</button>`;
  }

  const usdcRow = `<section class="demo-claim-row"><div class="demo-claim-heading"><strong>TEST-USDC</strong><span>Demo contribution tokens · no monetary value</span></div><div class="demo-balance">Current balance: <strong>${esc(usdcBalanceText)}</strong></div>${compact && needsDemoFunds(usdcBalance) && usdc.status !== "claimed" ? `<div class="demo-prompt">Need demo funds?</div>` : ""}${claimStatus(usdc, "USDC")}${usdc.error ? `<div class="demo-error">${esc(usdc.error)}</div>` : ""}${usdc.notice ? `<div class="demo-status success">${esc(usdc.notice)}</div>` : ""}${claimAction(usdc, "USDC")}</section>`;
  const solRow = `<section class="demo-claim-row"><div class="demo-claim-heading"><strong>Devnet SOL</strong><span>Transaction fees only · no monetary value</span></div><div class="demo-balance">Current fee balance: <strong>${esc(solBalanceText)}</strong></div>${claimStatus(sol, "SOL")}${sol.error ? `<div class="demo-error">${esc(sol.error)}</div>` : ""}${sol.notice ? `<div class="demo-status success">${esc(sol.notice)}</div>` : ""}${claimAction(sol, "SOL")}</section>`;
  return `<div class="demo-funds-card ${compact ? "compact" : ""}"><div class="demo-funds-heading"><strong>Devnet Demo Funds</strong><span>Test assets only · no monetary value</span></div><div class="demo-claim-grid">${usdcRow}${solRow}</div><div class="demo-sol">Devnet SOL is only for transaction fees. Need another source? <a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer">Official Solana Devnet faucet ↗</a></div></div>`;
}

function actionCard() {
  const portfolio = state.selected;
  const creator = publicKeyEquals(state.walletPublicKey, portfolio?.creator);
  const status = Number(portfolio.status);
  const transactionEnabled = transactionActionsEnabled();
  const actionDisabled = transactionEnabled ? "" : "disabled";
  const contributionLabel = portfolioContributionLabel(portfolio);
  const demoContributionReady = approvedDevnetContribution(portfolio);
  const contributionWarning = state.network === "devnet" && !demoContributionReady
    ? `<div class="info-banner">This portfolio uses an unapproved contribution asset. Devnet demo funding and investment are disabled.</div>`
    : "";
  const cancelDiagnostics = cancelPortfolioDiagnostics(portfolio, state.walletPublicKey);
  const inviteButton = creator && state.selectedMembers.length
    ? `<button class="button secondary" data-action="copy-invite" type="button">Copy invite link</button>`
    : "";
  const cancelButton = cancelDiagnostics.allowed
    ? `<button class="button ghost cancel-button" data-action="cancel-portfolio" ${actionDisabled}>Cancel portfolio</button>`
    : "";
  const cancelAction = status === STATUS.FUNDING_CLOSED ? cancelButton : "";

  if (status === STATUS.DRAFT) {
    const readyCount = state.selectedVaults.filter((vault) => vault.initialized).length;
    const vaultStatus = allVaultsReady(state.selectedVaults, portfolio.basket.length)
      ? `<div class="vault-ready"><span class="vault-ready-mark">✓</span><div><strong>Portfolio ready</strong><small>${esc(contributionLabel)} and all ${portfolio.basket.length} selected assets are ready.</small></div></div>`
      : creator
        ? `<button class="button primary" data-action="prepare-vaults" ${actionDisabled}>${state.busy === "Preparing portfolio" ? "Preparing…" : readyCount ? `Prepare portfolio (${readyCount}/${state.selectedVaults.length} ready)` : "Prepare portfolio"}</button>`
        : `<div class="member-contribution">${readyCount}/${state.selectedVaults.length} asset accounts are ready.</div>`;
    return `<div class="card action-card"><div class="card-head"><h3>Prepare portfolio</h3><span>${statusLabel(status)}</span></div><p>Set up the selected assets, invite your circle, and open the funding window. The basket stays fixed once funding begins.</p><div class="action-stack">${contributionWarning}${vaultStatus}${creator ? `${!state.selectedMember ? `<div class="member-hint">Add your wallet as a member if you want to contribute too.</div>` : `<div class="member-status">✓ You are invited to this portfolio</div>`}<form id="invite-form"><input class="input" name="wallet" placeholder="Wallet address to invite" required /><button class="button secondary" type="submit" ${actionDisabled}>Invite member</button></form>${inviteButton}<button class="button secondary" data-action="open-funding" ${actionDisabled}>Open funding</button>${cancelButton}` : `<div class="info-banner">The creator is preparing this portfolio.</div>`}</div></div>`;
  }

  if (status === STATUS.FUNDING) {
    const usdcLabel = contributionLabel;
    const ended = fundingEnded(portfolio.fundingDeadline);
    const memberContent = state.selectedMember
      ? `<div class="member-status">✓ You are invited to contribute</div><div class="wallet-balance"><span>${esc(usdcLabel)} balance</span><strong>${formatRaw(state.selectedWalletUsdcBalance ?? 0n, state.selectedVaults[0].decimals)} ${esc(usdcLabel)}</strong></div><div class="member-contribution">Your recorded contribution: ${formatRaw(state.selectedMember.totalContributed, 6)} ${esc(usdcLabel)} · ${formatOwnershipUnits(state.selectedMember.ownershipUnits)} ownership units</div><form id="contribute-form"><div class="field"><label>Contribution · ${esc(usdcLabel)}</label><input class="input" name="amount" type="number" min="0.000001" step="0.000001" placeholder="25" required ${ended || !demoContributionReady ? "disabled" : ""} /></div><button class="button primary" type="submit" ${ended || !transactionEnabled || !demoContributionReady ? "disabled" : ""}>Contribute ${esc(usdcLabel)}</button></form>`
      : `<div class="info-banner">${creator ? "You're the creator, but you're not a contributing member of this portfolio." : state.walletPublicKey ? "This wallet is not invited to this portfolio." : "Connect an invited wallet to contribute."}</div>`;
    const showDemoFunds = state.selectedMember
      && demoFundsAvailableForPortfolio(state.network, portfolio.usdcMint.toBase58())
      && (needsDemoFunds(state.selectedWalletUsdcBalance) || ["claimed", "pending", "exhausted"].includes(state.demoFunds.status));
    return `<div class="card action-card"><div class="card-head"><h3>Funding open</h3><span>${statusLabel(status)}</span></div><p>${state.network === "devnet" ? "Each demo USDC token becomes one ownership unit." : "Each USDC contribution becomes one ownership unit."} Invite-only funding ends at the deadline, and no new member can join afterward.</p><div class="funding-clock"><strong>${esc(fundingCloseLabel(portfolio.fundingDeadline))}</strong><span data-funding-countdown aria-live="off">${esc(fundingCountdown(portfolio.fundingDeadline))}</span></div><div class="funding-ended" data-funding-ended ${ended ? "" : "hidden"}>${FUNDING_ENDED_MESSAGE}</div><div class="action-stack">${contributionWarning}${memberContent}${!ended && showDemoFunds ? demoFundsCard(true) : ""}${creator ? `<button class="button secondary" data-action="close-funding" ${actionDisabled}>End funding</button><form id="invite-form"><input class="input" name="wallet" placeholder="Invite another wallet" required /><button class="button secondary" type="submit" ${actionDisabled}>Invite member</button></form>${inviteButton}${cancelButton}` : ""}</div></div>`;
  }

  if (status === STATUS.FUNDING_CLOSED || status === STATUS.DEPLOYING) {
    const deploymentLegs = deploymentLegsOf(portfolio);
    const index = deploymentLegs.findIndex((leg) => Number(leg.status) === 0);
    const next = index >= 0 ? portfolio.basket[index] : null;
    const investmentDisabled = transactionEnabled && demoContributionReady ? "" : "disabled";
    return `<div class="card action-card"><div class="card-head"><h3>${!deploymentLegs.length ? "Ready to invest" : index >= 0 ? "Invest funds" : "Investment complete"}</h3><span>${statusLabel(status)}</span></div><p>${!deploymentLegs.length ? "No investment leg has executed yet. The creator can invest the recorded funding or cancel before investment begins." : index >= 0 ? `The next asset is ${esc(displayAsset(state.network, next.mint))}, using ${Number(next.allocationBps) / 100}% of recorded contributions.` : "Every selected asset is funded and the portfolio is active."}</p><div class="action-stack">${creator && index >= 0 ? `<button class="button primary" data-action="deploy-next" ${investmentDisabled}>${state.busy.startsWith("Investing") || state.busy.startsWith("Preparing investment") ? esc(state.busy) : "Invest funds"}</button>` : ""}${cancelAction}${contributionWarning}<div class="info-banner">${state.network === "devnet" ? "Devnet demo mode · selected xStocks are mock assets with no monetary value." : "Investment uses an approved route. Amounts come only from recorded contributions."}</div></div></div>`;
  }

  if (status === STATUS.CANCELLED) {
    const member = state.selectedMember;
    const refundable = canClaimRefund(portfolio, member);
    const amount = member ? formatRaw(member.totalContributed, 6) : "0";
    const memberContent = memberRefunded(member)
      ? `<div class="member-status">✓ Refund claimed</div><p>Your remaining recorded contribution is 0 ${esc(contributionLabel)}.</p>`
      : refundable
        ? `<div class="member-contribution">Your refundable contribution: ${amount} ${esc(contributionLabel)}</div><button class="button primary" data-action="claim-refund" ${actionDisabled}>${state.busy === "Claiming refund" ? "Claiming…" : "Claim refund"}</button>`
        : `<div class="info-banner">${member ? "This wallet has no recorded contribution to refund." : "Connect an invited member wallet to check for a refund."}</div>`;
    return `<div class="card action-card"><div class="card-head"><h3>Portfolio cancelled</h3><span>CANCELLED</span></div><p>Investment will not proceed. Each contributing member can claim a refund of their exact recorded ${esc(contributionLabel)} contribution independently.</p><div class="action-stack">${memberContent}</div></div>`;
  }

  if (status === STATUS.ACTIVE) {
    const withdrawn = Boolean(state.selectedMember
      && (memberHasWithdrawn(state.selectedMember) || BigInt(rawString(portfolio.totalUnits)) === 0n));
    const memberContent = !state.selectedMember
      ? `<div class="info-banner">${esc(state.selectedMemberError || "Connect the member wallet to preview an exit.")}</div>`
      : withdrawn
        ? `<div class="member-status">✓ Withdrawn</div><p>Your remaining claim is zero. The portfolio vault balances above still show assets held for other members.</p>`
        : `<div class="preview-list">${previewHtml(state.selectedVaults.map((row) => ({ ...row, entitlement: memberClaimRaw(row.rawBalance, state.selectedMember.ownershipUnits, portfolio.totalUnits) })))}</div><div class="action-stack"><button class="button primary" data-action="withdraw" ${actionDisabled}>${state.busy === "Withdrawing" ? "Signing withdrawal…" : "Withdraw my share"}</button></div>`;
    return `<div class="card action-card"><div class="card-head"><h3>Your share, in kind</h3><span>${withdrawn ? "Withdrawn" : statusLabel(status)}</span></div><p>Preview the current assets and any residual ${state.network === "devnet" ? "demo USDC" : "USDC"} you will receive before signing. You can leave independently; no creator approval or price estimate is required.</p>${memberContent}<div class="info-banner">After the final member withdraws, the portfolio closes automatically.</div></div>`;
  }

  return `<div class="card action-card"><div class="card-head"><h3>Circle closed</h3><span>${statusLabel(status)}</span></div><p>All members have withdrawn their in-kind shares. This portfolio remains verifiable as a completed circle.</p></div>`;
}

function detailView() {
  const portfolio = state.selected;
  if (!portfolio) return `<section class="view"><div class="card empty-state"><strong>Portfolio not found.</strong><span>Check the address and active network.</span></div></section>`;
  const status = Number(portfolio.status);
  const deploymentLegs = deploymentLegsOf(portfolio);
  const complete = deploymentLegs.filter((leg) => Number(leg.status) === 1).length;
  return `<section class="view">
    <div class="detail-head"><div class="detail-title"><span class="status ${statusClass(status)}">${statusLabel(status)}</span><h1>${esc(portfolio.name)}</h1><p>${esc(portfolio.description || "Invite-only collaborative xStock portfolio")}</p></div><div class="detail-actions"><button class="button secondary" data-action="refresh">Refresh state</button><button class="button ghost" data-action="dashboard">← All portfolios</button></div></div>
    ${lifecycleRail(status)}
    <div class="detail-summary"><div class="summary-item"><span>Funded</span><strong>${formatRaw(portfolio.totalContributed, 6)} ${esc(portfolioContributionLabel(portfolio))}</strong></div><div class="summary-item"><span>Target</span><strong>${formatRaw(portfolio.targetUsdc, 6)} ${esc(portfolioContributionLabel(portfolio))}</strong></div><div class="summary-item"><span>Members</span><strong>${state.selectedMembers.length}</strong></div><div class="summary-item"><span>Funding deadline</span><strong>${esc(fundingCloseLabel(portfolio.fundingDeadline))}</strong>${status === STATUS.FUNDING ? `<small data-funding-countdown>${esc(fundingCountdown(portfolio.fundingDeadline))}</small>` : ""}</div></div>
    <div class="detail-grid"><div><div class="card holdings-card"><div class="card-head"><h3>Current holdings</h3><span>${complete}/${deploymentLegs.length || portfolio.basket.length} assets ready</span></div>${holdingsHtml()}<details class="technical-details"><summary>Technical details</summary><div>Portfolio account: ${esc(publicKeyText(portfolio.publicKey) || "Unavailable")}</div><div>Total ownership units (raw): ${esc(rawString(portfolio.totalUnits))}</div>${state.selectedMembers.map((member) => `<div>Member account: ${esc(publicKeyText(member?.wallet) || "Unavailable")} · ownership units (raw): ${esc(rawString(member?.ownershipUnits))}</div>`).join("")}${state.selectedVaults.map((asset) => `<div>${esc(asset.ticker || asset.label)} mint: ${esc(publicKeyText(asset?.mint) || "Unavailable")}</div>`).join("")}</details></div><div class="card team-card" style="margin-top:22px"><div class="card-head"><h3>Ownership circle</h3><span>${formatOwnershipUnits(portfolio.totalUnits)} ownership units</span></div>${teamHtml()}</div></div><div><div class="card raw-card"><div class="card-head"><h3>Funding & ownership</h3><span>live portfolio data</span></div><div class="metric-grid"><div class="metric"><label>Amount funded</label><strong>${formatRaw(portfolio.totalContributed, 6)} ${esc(portfolioContributionLabel(portfolio))}</strong></div><div class="metric"><label>Outstanding ownership</label><strong>${formatOwnershipUnits(portfolio.totalUnits)} units</strong></div><div class="metric"><label>Funding target</label><strong>${formatRaw(portfolio.targetUsdc, 6)} ${esc(portfolioContributionLabel(portfolio))}</strong></div><div class="metric"><label>Funding closes</label><strong>${esc(fundingCloseLabel(portfolio.fundingDeadline))}</strong></div></div><div class="info-banner">Amounts are shown in a friendly format. Your share comes from recorded ownership units; exact raw units are available under Technical details.</div></div><div style="margin-top:22px">${actionCard()}</div></div></div>
  </section>`;
}

function render() {
  const connectedLabel = state.walletPublicKey ? shortKey(state.walletPublicKey.toBase58()) : "Connect wallet";
  const view = state.view === "landing" ? landingView() : state.view === "dashboard" ? dashboardView() : state.view === "create" ? createView() : state.view === "docs" ? docsView() : detailView();
  const networkWarning = state.walletPublicKey && !walletNetworkMatches() ? networkWarningHtml() : "";
  const demoButton = state.network === "devnet" ? `<button class="demo-header-button" data-action="demo-funds-toggle" type="button">Demo Funds</button>` : "";
  const networkIndicator = `<span class="network-indicator" aria-label="Selected network: ${esc(networkShortLabel())}">${esc(networkShortLabel())}</span>`;
  const demoPanel = state.network === "devnet" && state.demoFunds.open ? `<div class="demo-panel">${demoFundsCard()}</div>` : "";
  document.querySelector("#app").innerHTML = `<div class="shell"><header class="topbar"><a class="brand" href="#" data-action="home"><span class="brand-mark">ss</span><span class="brand-name">StockSplit</span><span class="brand-sub">shared ownership, made clear</span></a><nav class="nav"><button class="${state.view === "dashboard" ? "active" : ""}" data-action="dashboard">My portfolios</button><button class="${state.view === "create" ? "active" : ""}" data-action="create-view">Create</button><button class="${state.view === "docs" ? "active" : ""}" data-action="docs">Docs</button></nav><div class="top-actions"><select class="network-select" id="network-select" aria-label="Network" ${state.busy || demoFundsBusy() ? "disabled" : ""}>${Object.entries(NETWORKS).map(([key, value]) => `<option value="${key}" ${key === state.network ? "selected" : ""}>${value.label}</option>`).join("")}</select>${networkIndicator}${demoButton}<button class="wallet-button" data-action="wallet" ${demoFundsBusy() ? "disabled" : ""}>${esc(connectedLabel)}</button></div></header><main class="main">${demoPanel}${networkWarning}${state.error ? `<div class="error-banner">${esc(state.error)}${state.retryAction ? `<button class="button secondary" type="button" data-action="retry-expired">Try again with fresh blockhash</button>` : ""}${state.errorDetails ? `<details class="technical-details"><summary>Technical details</summary><pre>${esc(state.errorDetails)}</pre></details>` : ""}</div>` : ""}${state.notice ? `<div class="success-banner">${esc(state.notice)}</div>` : ""}${view}</main><footer class="footer">StockSplit · invite-only collaborative xStock portfolios · ${esc(networkConfig().label)} · <a href="https://github.com/london160771/StockSplit" target="_blank" rel="noopener noreferrer">Source on GitHub ↗</a></footer></div>`;
  bindEvents();
  updateFundingClock();
}

function updateFundingClock() {
  if (state.view !== "detail" || Number(state.selected?.status) !== STATUS.FUNDING) return;
  document.querySelectorAll("[data-funding-countdown]").forEach((countdown) => {
    countdown.textContent = fundingCountdown(state.selected.fundingDeadline);
  });
  if (!fundingEnded(state.selected.fundingDeadline)) return;
  const ended = document.querySelector("[data-funding-ended]");
  if (ended) ended.hidden = false;
  document.querySelectorAll("#contribute-form input, #contribute-form button").forEach((element) => { element.disabled = true; });
}

setInterval(updateFundingClock, 1000);

function bindEvents() {
  document.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", async (event) => {
    event.preventDefault();
    const action = element.dataset.action;
    try {
      if (action === "wallet") return state.walletPublicKey ? disconnectWallet() : connectWallet();
      if (action === "retry-expired") return retryExpiredAction().catch(() => {});
      if (action === "copy-invite") return copyInviteLink().catch((error) => { state.error = error.message; render(); });
      if (action === "demo-funds-toggle") {
        state.demoFunds.open = !state.demoFunds.open;
        render();
        if (state.demoFunds.open && state.walletPublicKey) refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
        return;
      }
      if (action === "claim-demo-funds") return claimDemoFunds("USDC");
      if (action === "claim-demo-sol") return claimDemoFunds("SOL");
      if (action === "demo-funds-status") return refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
      if (action === "switch-wallet-network") return runAction("Checking wallet network", switchWalletNetwork).catch(() => {});
      if (action === "connect") return state.walletPublicKey ? (state.view = "dashboard", render()) : connectWallet();
      if (action === "home") { state.view = "landing"; return render(); }
      if (action === "dashboard") { state.view = "dashboard"; return render(); }
      if (action === "create-view") { state.view = "create"; return render(); }
      if (action === "docs") { state.view = "docs"; return render(); }
      if (action === "explore") { state.view = "dashboard"; return render(); }
      if (action === "refresh") return runAction("Refresh", () => loadPortfolio(state.selected.publicKey));
      if (action === "add-basket") return addBasketRow();
       if (action === "prepare-vaults") return runAction("Preparing portfolio", initializeVaults);
      if (action === "open-funding") return runAction("Open funding", openFunding);
      if (action === "close-funding") return runAction("Close funding", closeFunding);
      if (action === "cancel-portfolio") {
        if (!window.confirm("Cancel this portfolio? Members will be able to claim only their recorded USDC contributions. This cannot be undone.")) return;
        return runAction("Cancel portfolio", cancelPortfolio);
      }
      if (action === "claim-refund") return runAction("Claiming refund", claimRefund);
      if (action === "deploy-next") return runAction("Investing funds", deployNextLeg);
      if (action === "withdraw") return runAction("Withdrawing", withdrawMember);
      if (action === "remove-basket") return removeBasketRow(Number(element.dataset.removeBasket));
    } catch { /* runAction already surfaced the error */ }
  }));
  document.querySelectorAll("[data-open-portfolio]").forEach((element) => element.addEventListener("click", () => loadPortfolio(element.dataset.openPortfolio).catch((error) => { state.error = error.message; render(); })));
  document.querySelector("#network-select")?.addEventListener("change", async (event) => {
    state.network = event.target.value;
    state.retryAction = null;
    state.demoFunds = createDemoFundsState();
    localStorage.setItem("stocksplit.network", state.network);
    state.manualNetworkConfirmation = false;
    try {
      await refreshWalletNetwork();
      await initializeProgram();
      await refreshPortfolios();
      if (state.network === "devnet" && state.walletPublicKey) refreshDemoFunds().catch((error) => { state.demoFunds.error = error.message; render(); });
      toast(`Switched to ${networkConfig().label}`);
    } catch (error) { state.error = error.message; render(); }
  });
  document.querySelector("#create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    createDraftFromDom();
    await runAction("Create portfolio", () => createPortfolio(form)).catch(() => {});
  });
  document.querySelector("#invite-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await runAction("Invite member", () => inviteMember(form)).catch(() => {});
  });
  document.querySelector("#contribute-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await runAction("Contribute USDC", () => contribute(form)).catch(() => {});
  });
}

async function boot() {
  render();
  try {
    await initializeProgram();
    const restored = await connectWallet({ onlyIfTrusted: true, silent: true });
    if (!restored) await refreshPortfolios();
    const queryPortfolio = new URLSearchParams(window.location.search).get("portfolio");
    if (queryPortfolio) await loadPortfolio(queryPortfolio);
  } catch (error) {
    state.error = `Could not load the ${networkConfig().label} program: ${error.message}`;
    render();
  }
}

window.addEventListener("load", boot);
