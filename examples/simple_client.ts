import { Keypair } from "@solana/web3.js";

import {
  setupClient, 
  loadKeypairFromJson, 
  ANCHOR_WALLET, 
  ANCHOR_PROVIDER_URL, 
  printEnv,
  NetworkId,
} from "../src/client";
import { loadOrCreateEthKeypairs } from "./key_loader";

const ETH_KEYS_PATH = "./examples/n_test_keys.json";

async function main() {
  printEnv();

  let authority: Keypair;
  try {
    authority = loadKeypairFromJson(ANCHOR_WALLET);
  } catch (err) {
    console.error("Failed to load wallet:", (err as Error).message);
    process.exit(1);
  }
  console.log(`Authority public key: ${authority.publicKey.toBase58()}`);

  const client = setupClient(authority, ANCHOR_PROVIDER_URL);

  let M = 3, N = 5;
  const ethSigners = await loadOrCreateEthKeypairs(ETH_KEYS_PATH, N);
  N = ethSigners.length;

  const ethAddresses = ethSigners.map(s => s.address);
  
  console.log(`\nEthereum Signers:`);
  for (let i = 0; i < ethSigners.length; i++) {
    const addressHex = "0x" + Buffer.from(ethSigners[i].address).toString("hex");
    console.log(`  [${i}] ${addressHex}`);
  }

  try {
    const vaultData = await client.getVaultData(authority.publicKey);
    console.log(`\nVault exists: ${vaultData.address.toBase58()}`);
    console.log(`  M-of-N: ${vaultData.mThreshold} of ${vaultData.signers.length}`);
    console.log(`  Treasury Balance: ${vaultData.balanceSol} SOL`);
  } catch {
    console.log(`\nInitializing new vault with M=${M}, N=${N}...`);
    const { vaultAddress } = await client.initializeForSelf(M, ethAddresses);
    console.log(`Vault created: ${vaultAddress.toBase58()}`);
  }

  console.log(`\nDepositing 1.0 SOL...`);
  await client.depositSolFromSelf(1.0);

  const amountSol = 0.5;
  const requestId = Date.now(); // Use timestamp as unique request ID
  const expiryDurationSeconds = 3600; // 1 hour

  // Determine network ID based on provider URL
  let networkId = NetworkId.DEVNET;
  if (ANCHOR_PROVIDER_URL.includes("mainnet")) {
    networkId = NetworkId.MAINNET;
  } else if (ANCHOR_PROVIDER_URL.includes("testnet")) {
    networkId = NetworkId.TESTNET;
  }

  // Create a new Solana recipient keypair for the withdrawal
  const recipient = Keypair.generate();
  console.log(`\nRecipient: ${recipient.publicKey.toBase58()}`);

  console.log(`\nExecuting withdrawal with M=${M} signatures...`);
  console.log(`  Amount: ${amountSol} SOL`);
  console.log(`  Request ID: ${requestId}`);
  console.log(`  Using signers [1] and [2]`);

  await client.createAndExecuteWithdrawal(
    recipient.publicKey,
    amountSol,
    requestId,
    [ethSigners[1], ethSigners[2], ethSigners[3]], // Provide M signatures
    expiryDurationSeconds,
    networkId
  );
}

main().catch(console.error);
