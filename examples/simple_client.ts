import { Keypair } from "@solana/web3.js";
import BN from "bn.js";

import {
  setupAdminClient, 
  computeVaultSeed,
  loadKeypairFromJson, 
  ANCHOR_WALLET, 
  ANCHOR_PROVIDER_URL, 
  printEnv,
  NetworkId,
  AssetAmount,
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

  let M = 3, N = 5;
  const ethSigners = await loadOrCreateEthKeypairs(ETH_KEYS_PATH, N);
  N = ethSigners.length;

  const ethAddresses = ethSigners.map(s => s.address);
  
  console.log(`\nEthereum Signers:`);
  for (let i = 0; i < ethSigners.length; i++) {
    const addressHex = "0x" + Buffer.from(ethSigners[i].address).toString("hex");
    console.log(`  [${i}] ${addressHex}`);
  }

  const vaultSeed = computeVaultSeed(ethAddresses, M);
  const client = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

  try {
    const vaultData = await client.getVaultData();
    console.log(`\nVault exists: ${vaultData.address.toBase58()}`);
    console.log(`  M-of-N: ${vaultData.mThreshold} of ${vaultData.signers.length}`);
    console.log(`  Treasury Balance: ${vaultData.balanceSol} SOL`);
    console.log(`  Whitelisted Assets: ${vaultData.whitelistedAssets.length}`);
  } catch {
    console.log(`\nInitializing new vault with M=${M}, N=${N}...`);
    const { vaultAddress } = await client.initialize(M, N, ethAddresses);
    console.log(`Vault created: ${vaultAddress.toBase58()}`);
  }

  // Add SOL to whitelist
  console.log(`\nAdding SOL to whitelist...`);
  await client.addAsset(
    { sol: {} },
    Date.now(),
    [...ethSigners], // all signatures
    3600,
  );

  // Deposit SOL from admin
  console.log(`\nDepositing 1.0 SOL...`);
  await client.createAndExecuteAdminDeposit(1.0, Date.now(), [ethSigners[1]]);

  // Check balance
  const balance = await client.getTreasuryBalance();
  console.log(`Treasury balance: ${balance} SOL`);

  // Create a withdrawal
  const amountSol = 0.5;
  const requestId = Date.now(); // Use timestamp as unique request ID
  const expiryDurationSeconds = 3600; // 1 hour

  // Create a new Solana recipient keypair for the withdrawal
  const recipient = Keypair.generate();
  console.log(`\nRecipient: ${recipient.publicKey.toBase58()}`);

  console.log(`\nExecuting withdrawal with M=${M} signatures...`);
  console.log(`  Amount: ${amountSol} SOL`);
  console.log(`  Request ID: ${requestId}`);
  console.log(`  Using signers [0], [1], and [2]`);

  // Withdraw using the multi-asset interface
  const withdrawals: AssetAmount[] = [{
    asset: { sol: {} },
    amount: new BN(amountSol * 1_000_000_000), // Convert to lamports
  }];

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

  const withdrawalTicket = client.createWithdrawalTicket(
    recipient.publicKey,
    withdrawals,
    requestId,
    expiryTimestamp,
  );

  await client.withdraw(
    withdrawalTicket,
    [ethSigners[0], ethSigners[1], ethSigners[2]] // Provide M signatures
  );

  // Check final balance
  const finalBalance = await client.getTreasuryBalance();
  console.log(`\nFinal treasury balance: ${finalBalance} SOL`);
}

main().catch(console.error);