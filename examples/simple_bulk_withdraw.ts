import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import {
  setupAdminClient, 
  computeVaultSeed,
  loadKeypairFromJson, 
  ANCHOR_WALLET, 
  ANCHOR_PROVIDER_URL, 
  printEnv,
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
    const { vaultAddress } = await client.initialize(M, ethAddresses);
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

  // Deposit enough SOL for multiple withdrawals
  const totalDepositSol = 5.0;
  console.log(`\nDepositing ${totalDepositSol} SOL...`);
  await client.createAndExecuteAdminDeposit(
    totalDepositSol, 
    Date.now(), 
    [ethSigners[1]]
  );

  // Check balance
  const balance = await client.getTreasuryBalance();
  console.log(`Treasury balance: ${balance} SOL`);

  // Create multiple recipients for bulk withdrawal
  const numWithdrawals = 3;
  const recipients: Keypair[] = [];
  
  console.log(`\nCreating ${numWithdrawals} recipients:`);
  for (let i = 0; i < numWithdrawals; i++) {
    const recipient = Keypair.generate();
    recipients.push(recipient);
    console.log(`  [${i}] ${recipient.publicKey.toBase58()}`);
  }

  // Example 1: Simple bulk withdrawal with convenience method
  console.log(`\n=== Example 1: Simple Bulk Withdrawal (SOL only) ===`);
  
  const withdrawalRequests = [
    { 
      recipient: recipients[0].publicKey, 
      amountSol: 0.5, 
      requestId: Date.now() 
    },
    { 
      recipient: recipients[1].publicKey, 
      amountSol: 0.3, 
      requestId: Date.now() + 1 
    },
    { 
      recipient: recipients[2].publicKey, 
      amountSol: 0.2, 
      requestId: Date.now() + 2 
    },
  ];

  console.log(`\nExecuting bulk withdrawal with M=${M} signatures...`);
  console.log(`  Number of withdrawals: ${withdrawalRequests.length}`);
  console.log(`  Total amount: ${withdrawalRequests.reduce((sum, r) => sum + r.amountSol, 0)} SOL`);
  console.log(`  Using signers [0], [1], and [2]`);

  await client.createAndExecuteBulkWithdrawal(
    withdrawalRequests,
    [ethSigners[0], ethSigners[1], ethSigners[2]], // Provide M signatures
    3600 // 1 hour expiry
  );

  // Check balance after first bulk withdrawal
  let currentBalance = await client.getTreasuryBalance();
  console.log(`\nTreasury balance after bulk withdrawal: ${currentBalance} SOL`);

  // Example 2: Advanced bulk withdrawal with manual ticket creation
  console.log(`\n=== Example 2: Advanced Bulk Withdrawal (Manual) ===`);
  
  const expiryDurationSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

  // Create individual withdrawal tickets
  const withdrawals = [
    {
      recipient: recipients[0].publicKey,
      withdrawals: [{
        asset: { sol: {} } as const,
        amount: new BN(0.1 * 1_000_000_000), // 0.1 SOL
      }],
      requestId: Date.now() + 10,
      expiryTimestamp,
    },
    {
      recipient: recipients[1].publicKey,
      withdrawals: [{
        asset: { sol: {} } as const,
        amount: new BN(0.15 * 1_000_000_000), // 0.15 SOL
      }],
      requestId: Date.now() + 11,
      expiryTimestamp,
    },
    {
      recipient: recipients[2].publicKey,
      withdrawals: [{
        asset: { sol: {} } as const,
        amount: new BN(0.25 * 1_000_000_000), // 0.25 SOL
      }],
      requestId: Date.now() + 12,
      expiryTimestamp,
    },
  ];

  console.log(`\nCreating bulk withdrawal ticket...`);
  const bulkTicket = client.createBulkWithdrawalTicket(withdrawals);
  
  console.log(`  Number of tickets: ${bulkTicket.tickets.length}`);
  console.log(`  Total amount: ${withdrawals.reduce((sum, w) => 
    sum + w.withdrawals[0].amount.toNumber() / 1_000_000_000, 0
  )} SOL`);

  // Prepare remaining accounts (recipients)
  const recipientAccounts = withdrawals.map(w => ({
    pubkey: w.recipient,
    isWritable: true,
    isSigner: false,
  }));

  console.log(`\nExecuting bulk withdrawal...`);
  await client.bulkWithdraw(
    bulkTicket,
    [ethSigners[0], ethSigners[1], ethSigners[2]], // M signatures
    recipientAccounts,
    "Bulk withdrawal example" // Optional metadata
  );

  // Check final balance
  const finalBalance = await client.getTreasuryBalance();
  console.log(`\nFinal treasury balance: ${finalBalance} SOL`);

  // Verify nonce usage
  console.log(`\nVerifying nonce accounts are marked as used:`);
  for (let i = 0; i < bulkTicket.tickets.length; i++) {
    const ticket = bulkTicket.tickets[i];
    const isUsed = await client.isNonceUsed(ticket.vault, ticket.requestId);
    console.log(`  Ticket ${i} (Request ID: ${ticket.requestId}): ${isUsed ? "✓ Used" : "✗ Not used"}`);
  }
}

main().catch(console.error);
