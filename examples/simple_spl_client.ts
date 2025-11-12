import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
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

  // Load wallet
  let authority: Keypair;
  try {
    authority = loadKeypairFromJson(ANCHOR_WALLET);
  } catch (err) {
    console.error("Failed to load wallet:", (err as Error).message);
    process.exit(1);
  }
  console.log(`Authority public key: ${authority.publicKey.toBase58()}`);

  // Setup Ethereum signers
  let M = 3, N = 5;
  const ethSigners = await loadOrCreateEthKeypairs(ETH_KEYS_PATH, N);
  N = ethSigners.length;

  const ethAddresses = ethSigners.map((s) => s.address);

  console.log(`\nEthereum Signers:`);
  for (let i = 0; i < ethSigners.length; i++) {
    const addressHex = "0x" + Buffer.from(ethSigners[i].address).toString("hex");
    console.log(`  [${i}] ${addressHex}`);
  }

  const vaultSeed = computeVaultSeed(ethAddresses, M);
  const client = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);
  const connection = client.provider.connection;

  // Initialize or get vault
  const [vaultPda] = client.getVaultAddress(vaultSeed);
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

  console.log(`\n=== Step 1: Creating SPL Token ===`);
  const mintAuthority = authority;
  const decimals = 6; // USDC-like decimals

  console.log(`Creating mint with authority: ${mintAuthority.publicKey.toBase58()}`);
  const mint = await createMint(
    connection,
    authority, // payer
    mintAuthority.publicKey, // mint authority
    null, // freeze authority (optional)
    decimals,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  console.log(`✅ Token mint created: ${mint.toBase58()}`);

  console.log(`\n=== Step 2: Adding SPL Token to Whitelist ===`);
  const addAssetRequestId = Date.now();
  await client.addAsset(
    { splToken: { mint } },
    addAssetRequestId,
    [...ethSigners], // M signatures
    3600,
  );
  console.log(`✅ SPL token added to whitelist`);

  console.log(`\n=== Step 3: Minting Tokens to User ===`);
  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    authority, // payer
    mint,
    authority.publicKey // owner
  );

  const mintAmount = 1000 * Math.pow(10, decimals); // Mint 1000 tokens
  await mintTo(
    connection,
    authority, // payer
    mint,
    userTokenAccount.address,
    mintAuthority, // mint authority
    mintAmount
  );

  console.log(`✅ Minted ${mintAmount / Math.pow(10, decimals)} tokens to user`);
  console.log(`   User token account: ${userTokenAccount.address.toBase58()}`);

  console.log(`\n=== Step 4: Creating Vault Token Account ===`);
  await client.createVaultTokenAccount(mint);

  const vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    vaultPda,
    true
  );
  console.log(`   Vault token account: ${vaultTokenAccount.address.toBase58()}`);

  console.log(`\n=== Step 5: Depositing SPL Tokens ===`);
  const depositAmount = 500 * Math.pow(10, decimals); // Deposit 500 tokens
  const depositRequestId = Date.now() + 1;

  const deposits: AssetAmount[] = [
    {
      asset: { splToken: { mint } },
      amount: new BN(depositAmount),
    },
  ];
  const depositRemainingAccounts = [
    {
      pubkey: userTokenAccount.address,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: vaultTokenAccount.address,
      isSigner: false,
      isWritable: true,
    },
  ];
  await client.deposit(deposits, depositRequestId, depositRemainingAccounts);

  const vaultTokenAccountInfo = await getAccount(connection, vaultTokenAccount.address);
  console.log(
    `✅ Vault token balance: ${Number(vaultTokenAccountInfo.amount) / Math.pow(10, decimals)} tokens`
  );

  console.log(`\n=== Step 6: Withdrawing SPL Tokens ===`);

  // Create a recipient (new user)
  const recipient = Keypair.generate();
  console.log(`Recipient: ${recipient.publicKey.toBase58()}`);

  console.log(`Airdropping SOL to recipient for rent...`);
  const airdropSig = await connection.requestAirdrop(
    recipient.publicKey,
    0.1 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(airdropSig);

  const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    recipient, // payer (recipient pays for their own account)
    mint,
    recipient.publicKey
  );
  console.log(`Recipient token account created: ${recipientTokenAccount.address.toBase58()}`);

  const withdrawAmount = 200 * Math.pow(10, decimals); // Withdraw 200 tokens
  const withdrawRequestId = Date.now() + 2;
  const expiryDurationSeconds = 3600;

  const withdrawals: AssetAmount[] = [
    {
      asset: { splToken: { mint } },
      amount: new BN(withdrawAmount),
    },
  ];

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

  const withdrawalTicket = client.createWithdrawalTicket(
    recipient.publicKey,
    withdrawals,
    withdrawRequestId,
    expiryTimestamp,
  );

  const withdrawRemainingAccounts = [
    {
      pubkey: vaultTokenAccount.address,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: recipientTokenAccount.address,
      isSigner: false,
      isWritable: true,
    },
  ];
  console.log(`\nExecuting withdrawal with M=${M} signatures...`);
  console.log(`  Amount: ${withdrawAmount / Math.pow(10, decimals)} tokens`);
  console.log(`  Request ID: ${withdrawRequestId}`);
  console.log(`  Using signers [0], [1], and [2]`);

  await client.withdraw(
    withdrawalTicket,
    [ethSigners[0], ethSigners[1], ethSigners[2]], // Provide M signatures
    withdrawRemainingAccounts
  );

  console.log(`\n=== Step 7: Final Balances ===`);

  const finalVaultTokenAccountInfo = await getAccount(connection, vaultTokenAccount.address);
  console.log(
    `Vault token balance: ${Number(finalVaultTokenAccountInfo.amount) / Math.pow(10, decimals)} tokens`
  );

  const recipientTokenAccountInfo = await getAccount(connection, recipientTokenAccount.address);
  console.log(
    `Recipient token balance: ${Number(recipientTokenAccountInfo.amount) / Math.pow(10, decimals)} tokens`
  );

  const userTokenAccountInfo = await getAccount(connection, userTokenAccount.address);
  console.log(
    `User token balance: ${Number(userTokenAccountInfo.amount) / Math.pow(10, decimals)} tokens`
  );
}

main().catch(console.error);