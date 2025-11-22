import { describe, it, before, beforeEach } from "mocha";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  MultisigAdminClient,
  MultisigVaultClient,
  setupAdminClient,
  setupUserClient,
  computeVaultSeed,
  Asset,
  EthereumKeypair,
} from "../src/client";

describe("Bulk Withdraw Tests", () => {
  const ANCHOR_PROVIDER_URL = "http://127.0.0.1:8899";

  let adminClient: MultisigAdminClient;
  let userClient: MultisigVaultClient;
  let authority: Keypair;
  let user: Keypair;
  let recipient: Keypair;
  let connection: anchor.web3.Connection;
  
  // Test signers
  let ethKeypair1: EthereumKeypair;
  let ethKeypair2: EthereumKeypair;
  let ethKeypair3: EthereumKeypair;
  
  let vaultSeed: string;
  let vaultPda: PublicKey;
  let treasuryPda: PublicKey;
  let mThreshold: number;
  
  // Counter to ensure unique request IDs across all tests
  let requestIdCounter = Math.floor(Date.now() / 1000);

  // SPL Token test variables
  let testMint: PublicKey;
  let recipientTokenAccount: any;
  let vaultTokenAccount: any;
  
  // Helper to get unique request ID
  function getUniqueRequestId(): number {
    requestIdCounter += 1;
    return requestIdCounter;
  }
  
  // Helper to check if error contains expected message
  function expectErrorMessage(error: any, expectedMessages: string | string[]) {
    const messages = Array.isArray(expectedMessages) ? expectedMessages : [expectedMessages];
    const errorString = error.message || error.toString();
    const hasMatch = messages.some(msg => errorString.includes(msg));
    expect(hasMatch, `Expected error to contain one of: ${messages.join(', ')}\nActual error: ${errorString}`).to.be.true;
  }

  before(async function() {
    this.timeout(120000);

    connection = new anchor.web3.Connection(ANCHOR_PROVIDER_URL, "confirmed");
    
    // Check if validator is running
    try {
      await connection.getLatestBlockhash();
      console.log("Connected to Solana validator");
    } catch (error) {
      console.error("Cannot connect to Solana validator");
      console.error("Please start a local validator with: solana-test-validator");
      throw new Error("Solana validator not running");
    }

    // Generate keypairs
    authority = Keypair.generate();
    user = Keypair.generate();
    recipient = Keypair.generate();
    
    console.log(`Authority: ${authority.publicKey.toBase58()}`);
    console.log(`User: ${user.publicKey.toBase58()}`);
    console.log(`Recipient: ${recipient.publicKey.toBase58()}`);
    
    // Airdrop SOL for testing
    try {
      const authSig = await connection.requestAirdrop(
        authority.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      const userSig = await connection.requestAirdrop(
        user.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      const recipientSig = await connection.requestAirdrop(
        recipient.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(authSig);
      await connection.confirmTransaction(userSig);
      await connection.confirmTransaction(recipientSig);
      console.log("Airdropped SOL to accounts");
    } catch (error: any) {
      console.error("Airdrop failed:", error.message);
      throw error;
    }

    // Generate Ethereum keypairs
    ethKeypair1 = MultisigAdminClient.generateEthereumKeypair();
    ethKeypair2 = MultisigAdminClient.generateEthereumKeypair();
    ethKeypair3 = MultisigAdminClient.generateEthereumKeypair();
    
    // Initialize vault
    mThreshold = 2;
    const ethAddresses = [
      ethKeypair1.address,
      ethKeypair2.address,
      ethKeypair3.address,
    ];

    vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
    adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);
    userClient = setupUserClient(user, ANCHOR_PROVIDER_URL, vaultSeed);

    const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
    vaultPda = result.vaultAddress;
    [treasuryPda] = adminClient.getTreasuryAddress(vaultPda);
    
    console.log(`Vault initialized: ${vaultPda.toBase58()}`);
    console.log(`Treasury: ${treasuryPda.toBase58()}`);
    console.log(`M-of-N: ${mThreshold} of ${ethAddresses.length}`);
    
    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Airdrop more SOL for testing
    try {
      const authSig = await connection.requestAirdrop(
        authority.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      const userSig = await connection.requestAirdrop(
        user.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(authSig);
      await connection.confirmTransaction(userSig);
      console.log("Airdropped additional SOL to accounts");
    } catch (error: any) {
      console.error("Airdrop failed:", error.message);
      throw error;
    }
    
    // Add substantial funds to treasury for all withdrawal tests
    console.log("Adding funds to treasury for withdrawal tests...");

    const solAsset: Asset = { sol: {} };
    await adminClient.addAsset(
        solAsset,
        getUniqueRequestId(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
        3600
    );
    console.log("SOL whitelisted");
    
    // Deposit substantial SOL for withdrawal tests
    await userClient.depositSol(50, Date.now());
    const balance = await adminClient.getTreasuryBalance();
    console.log(`Deposited 50 SOL to treasury (balance: ${balance.toFixed(2)} SOL)`);

    console.log("\nTest setup complete\n");
  });

  describe("Basic Bulk SOL Withdrawals", () => {
    it("should successfully execute bulk withdrawal with multiple SOL transfers", async function() {
      this.timeout(30000);
      
      const withdrawAmount1 = 0.5;
      const withdrawAmount2 = 0.3;
      const withdrawAmount3 = 0.2;
      
      const requestId1 = getUniqueRequestId();
      const requestId2 = getUniqueRequestId();
      const requestId3 = getUniqueRequestId();
      
      const recipient2 = Keypair.generate();
      const recipient3 = Keypair.generate();
      
      // Airdrop to recipients
      const sig2 = await connection.requestAirdrop(
        recipient2.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      const sig3 = await connection.requestAirdrop(
        recipient3.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig2);
      await connection.confirmTransaction(sig3);
      
      // Check nonces don't exist before withdrawal
      const nonceUsed1Before = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2Before = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      const nonceUsed3Before = await userClient.isNonceUsed(vaultPda, new BN(requestId3));
      expect(nonceUsed1Before).to.be.false;
      expect(nonceUsed2Before).to.be.false;
      expect(nonceUsed3Before).to.be.false;
      
      const balanceBefore1 = await connection.getBalance(recipient.publicKey);
      const balanceBefore2 = await connection.getBalance(recipient2.publicKey);
      const balanceBefore3 = await connection.getBalance(recipient3.publicKey);
      const treasuryBalanceBefore = await connection.getBalance(treasuryPda);
      
      await userClient.createAndExecuteBulkWithdrawal(
        [
          {
            recipient: recipient.publicKey,
            amountSol: withdrawAmount1,
            requestId: requestId1,
          },
          {
            recipient: recipient2.publicKey,
            amountSol: withdrawAmount2,
            requestId: requestId2,
          },
          {
            recipient: recipient3.publicKey,
            amountSol: withdrawAmount3,
            requestId: requestId3,
          }
        ],
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const balanceAfter1 = await connection.getBalance(recipient.publicKey);
      const balanceAfter2 = await connection.getBalance(recipient2.publicKey);
      const balanceAfter3 = await connection.getBalance(recipient3.publicKey);
      const treasuryBalanceAfter = await connection.getBalance(treasuryPda);
      
      const received1 = (balanceAfter1 - balanceBefore1) / LAMPORTS_PER_SOL;
      const received2 = (balanceAfter2 - balanceBefore2) / LAMPORTS_PER_SOL;
      const received3 = (balanceAfter3 - balanceBefore3) / LAMPORTS_PER_SOL;
      const totalWithdrawn = (treasuryBalanceBefore - treasuryBalanceAfter) / LAMPORTS_PER_SOL;
      
      expect(received1).to.be.closeTo(withdrawAmount1, 0.001);
      expect(received2).to.be.closeTo(withdrawAmount2, 0.001);
      expect(received3).to.be.closeTo(withdrawAmount3, 0.001);
      expect(totalWithdrawn).to.be.closeTo(withdrawAmount1 + withdrawAmount2 + withdrawAmount3, 0.001);
      
      // Check nonces are marked as used after successful withdrawal
      const nonceUsed1After = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2After = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      const nonceUsed3After = await userClient.isNonceUsed(vaultPda, new BN(requestId3));
      expect(nonceUsed1After).to.be.true;
      expect(nonceUsed2After).to.be.true;
      expect(nonceUsed3After).to.be.true;
    });

    it("should successfully execute bulk withdrawal to same recipient multiple times", async function() {
      this.timeout(30000);
      
      const withdrawAmount1 = 0.2;
      const withdrawAmount2 = 0.3;
      
      const balanceBefore = await connection.getBalance(recipient.publicKey);
      const treasuryBalanceBefore = await connection.getBalance(treasuryPda);
      
      await userClient.createAndExecuteBulkWithdrawal(
        [
          {
            recipient: recipient.publicKey,
            amountSol: withdrawAmount1,
            requestId: getUniqueRequestId(),
          },
          {
            recipient: recipient.publicKey,
            amountSol: withdrawAmount2,
            requestId: getUniqueRequestId(),
          }
        ],
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const balanceAfter = await connection.getBalance(recipient.publicKey);
      const treasuryBalanceAfter = await connection.getBalance(treasuryPda);
      
      const received = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      const totalWithdrawn = (treasuryBalanceBefore - treasuryBalanceAfter) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount1 + withdrawAmount2, 0.001);
      expect(totalWithdrawn).to.be.closeTo(withdrawAmount1 + withdrawAmount2, 0.001);
    });

    it("should successfully execute bulk withdrawal with M-of-N signatures", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      
      const balanceBefore = await connection.getBalance(recipient.publicKey);
      
      await userClient.createAndExecuteBulkWithdrawal(
        [
          {
            recipient: recipient.publicKey,
            amountSol: withdrawAmount,
            requestId: getUniqueRequestId(),
          }
        ],
        [ethKeypair1, ethKeypair2], // 2-of-3 signatures
        3600
      );
      
      const balanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount, 0.001);
    });

    it("should successfully execute bulk withdrawal with all signatures", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.3;
      
      const balanceBefore = await connection.getBalance(recipient.publicKey);
      
      await userClient.createAndExecuteBulkWithdrawal(
        [
          {
            recipient: recipient.publicKey,
            amountSol: withdrawAmount,
            requestId: getUniqueRequestId(),
          }
        ],
        [ethKeypair1, ethKeypair2, ethKeypair3], // All 3 signatures
        3600
      );
      
      const balanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount, 0.001);
    });
  });

  describe("Bulk Withdrawal Validation", () => {
    it("should reject bulk withdrawal with empty tickets array", async function() {
      this.timeout(30000);
      
      const bulkTicket = { tickets: [] };
      
      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          []
        );
        expect.fail("Should have rejected empty tickets");
      } catch (error: any) {
        expectErrorMessage(error, ["NoWithdrawalsProvided", "No withdrawal tickets provided"]);
      }
    });

    it("should reject bulk withdrawal with duplicate request IDs", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      const requestId = getUniqueRequestId(); // Same request ID for both
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      // Check nonce doesn't exist before
      const nonceUsedBefore = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedBefore).to.be.false;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId,
          expiryTimestamp,
        },
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId, // Duplicate!
          expiryTimestamp,
        }
      ]);

      const recipientAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
      ];

      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          recipientAccounts
        );
        expect.fail("Should have rejected duplicate request IDs");
      } catch (error: any) {
        expectErrorMessage(error, "DuplicateRequestId");
      }
      
      // Check nonce is still not created/used after failure
      const nonceUsedAfter = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedAfter).to.be.false;
    });

    it("should reject bulk withdrawal with insufficient signatures", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      const requestId = getUniqueRequestId();
      
      // Check nonce doesn't exist before
      const nonceUsedBefore = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedBefore).to.be.false;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        }
      ]);

      const recipientAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
      ];

      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1], // Only 1 signature, need 2
          recipientAccounts
        );
        expect.fail("Should have rejected insufficient signatures");
      } catch (error: any) {
        expectErrorMessage(error, ["InsufficientSignatures", "InsufficientValidSignatures"]);
      }
      
      // Check nonce is still not created/used after failure
      const nonceUsedAfter = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedAfter).to.be.false;
    });

    it("should reject bulk withdrawal when one ticket has expired", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiredTimestamp = currentTimestamp - 100; // Already expired
      const validTimestamp = currentTimestamp + 3600;
      
      const requestId1 = getUniqueRequestId();
      const requestId2 = getUniqueRequestId();
      
      // Check nonces don't exist before
      const nonceUsed1Before = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2Before = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      expect(nonceUsed1Before).to.be.false;
      expect(nonceUsed2Before).to.be.false;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId1,
          expiryTimestamp: validTimestamp,
        },
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId2,
          expiryTimestamp: expiredTimestamp, // This one is expired
        }
      ]);

      const recipientAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
      ];

      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          recipientAccounts
        );
        expect.fail("Should have rejected expired ticket");
      } catch (error: any) {
        expectErrorMessage(error, "TicketExpired");
      }
      
      // Check nonces are still not created/used after failure
      const nonceUsed1After = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2After = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      expect(nonceUsed1After).to.be.false;
      expect(nonceUsed2After).to.be.false;
    });

    it("should reject bulk withdrawal with insufficient treasury funds", async function() {
      this.timeout(30000);
      
      const treasuryBalance = await adminClient.getTreasuryBalance();
      const excessiveAmount = treasuryBalance + 10; // More than available
      const requestId = getUniqueRequestId();
      
      // Check nonce doesn't exist before
      const nonceUsedBefore = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedBefore).to.be.false;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(excessiveAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        }
      ]);

      const recipientAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
      ];

      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          recipientAccounts
        );
        expect.fail("Should have rejected insufficient funds");
      } catch (error: any) {
        expectErrorMessage(error, "InsufficientFunds");
      }
      
      // Check nonce is still not created/used after failure
      const nonceUsedAfter = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedAfter).to.be.false;
    });

    it("should reject bulk withdrawal when total exceeds treasury balance", async function() {
      this.timeout(30000);
      
      const treasuryBalance = await adminClient.getTreasuryBalance();
      const amount = (treasuryBalance / 2) + 1; // Each withdrawal is more than half
      
      const recipient2 = Keypair.generate();
      const sig = await connection.requestAirdrop(recipient2.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      
      const requestId1 = getUniqueRequestId();
      const requestId2 = getUniqueRequestId();
      
      // Check nonces don't exist before
      const nonceUsed1Before = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2Before = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      expect(nonceUsed1Before).to.be.false;
      expect(nonceUsed2Before).to.be.false;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(amount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId1,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        },
        {
          recipient: recipient2.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(amount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId2,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        }
      ]);

      const recipientAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipient2.publicKey, isWritable: true, isSigner: false },
      ];

      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          recipientAccounts
        );
        expect.fail("Should have rejected when total exceeds balance");
      } catch (error: any) {
        expectErrorMessage(error, "InsufficientFunds");
      }
      
      // Check nonces are still not created/used after failure
      const nonceUsed1After = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2After = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      expect(nonceUsed1After).to.be.false;
      expect(nonceUsed2After).to.be.false;
    });

    it("should reject bulk withdrawal with missing recipient account", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        }
      ]);

      // Don't provide recipient account in remaining_accounts
      const recipientAccounts: any[] = [];

      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          recipientAccounts
        );
        expect.fail("Should have rejected missing recipient");
      } catch (error: any) {
        expectErrorMessage(error, "InvalidRecipient");
      }
    });

    it("should reject replay of used nonce in bulk withdrawal", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      const requestId = getUniqueRequestId();
      
      // Check nonce doesn't exist before first withdrawal
      const nonceUsedBefore = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedBefore).to.be.false;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: new BN(withdrawAmount * LAMPORTS_PER_SOL),
          }],
          requestId: requestId,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        }
      ]);

      const recipientAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
      ];

      // First withdrawal should succeed
      await userClient.bulkWithdraw(
        bulkTicket,
        [ethKeypair1, ethKeypair2],
        recipientAccounts
      );

      // Check nonce is now marked as used
      const nonceUsedAfterFirst = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedAfterFirst).to.be.true;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Try to replay the same transaction
      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          recipientAccounts
        );
        expect.fail("Should have rejected nonce replay");
      } catch (error: any) {
        expectErrorMessage(error, "NonceAlreadyUsed");
      }
      
      // Check nonce is still marked as used after replay attempt
      const nonceUsedAfterReplay = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedAfterReplay).to.be.true;
    });
  });

  describe("Bulk Withdrawal with Mixed Recipients", () => {
    it("should handle bulk withdrawal with different recipients", async function() {
      this.timeout(30000);

      const MAX_TICKETS = 4;
      
      const recipients = await Promise.all(
        Array(MAX_TICKETS).fill(0).map(async () => {
          const kp = Keypair.generate();
          const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig);
          return kp;
        })
      );
      
      const withdrawAmounts = [0.1, 0.2, 0.15, 0.25];
      
      const balancesBefore = await Promise.all(
        recipients.map(r => connection.getBalance(r.publicKey))
      );
      
      await userClient.createAndExecuteBulkWithdrawal(
        recipients.map((r, idx) => ({
          recipient: r.publicKey,
          amountSol: withdrawAmounts[idx],
          requestId: getUniqueRequestId(),
        })),
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const balancesAfter = await Promise.all(
        recipients.map(r => connection.getBalance(r.publicKey))
      );
      
      recipients.forEach((_, idx) => {
        const received = (balancesAfter[idx] - balancesBefore[idx]) / LAMPORTS_PER_SOL;
        expect(received).to.be.closeTo(withdrawAmounts[idx], 0.001);
      });
    });
  });

  describe("Bulk Withdrawal with SPL Tokens", () => {
    beforeEach(async function() {
      this.timeout(30000);
      
      // Create mint and token accounts if not already created
      if (!testMint) {
        testMint = await createMint(
          connection,
          authority,
          authority.publicKey,
          null,
          9
        );
        console.log(`Test mint created: ${testMint.toBase58()}`);
        
        // Whitelist the SPL token
        const splAsset: Asset = { splToken: { mint: testMint } };
        await adminClient.addAsset(
          splAsset,
          getUniqueRequestId(),
          [ethKeypair1, ethKeypair2, ethKeypair3],
          3600
        );
        console.log("SPL Token whitelisted");
        
        // Create vault token account
        await adminClient.createVaultTokenAccount(testMint);
        
        // Get vault token account
        vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
          connection,
          authority,
          testMint,
          vaultPda,
          true
        );
        
        // Mint tokens to vault
        await mintTo(
          connection,
          authority,
          testMint,
          vaultTokenAccount.address,
          authority,
          1000000 * 10 ** 9 // 1 million tokens
        );
        console.log(`Minted 1,000,000 tokens to vault`);
      }
    });

    it("should successfully execute bulk withdrawal with multiple SPL token transfers", async function() {
      this.timeout(30000);
      
      const recipient2 = Keypair.generate();
      const recipient3 = Keypair.generate();
      
      const requestId1 = getUniqueRequestId();
      const requestId2 = getUniqueRequestId();
      const requestId3 = getUniqueRequestId();
      
      // Check nonces don't exist before
      const nonceUsed1Before = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2Before = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      const nonceUsed3Before = await userClient.isNonceUsed(vaultPda, new BN(requestId3));
      expect(nonceUsed1Before).to.be.false;
      expect(nonceUsed2Before).to.be.false;
      expect(nonceUsed3Before).to.be.false;
      
      // Create recipient token accounts
      const recipientTokenAccount1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient.publicKey
      );
      
      const recipientTokenAccount2 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient2.publicKey
      );
      
      const recipientTokenAccount3 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient3.publicKey
      );
      
      const amount1 = new BN(1000 * 10 ** 9); // 1000 tokens
      const amount2 = new BN(2000 * 10 ** 9); // 2000 tokens
      const amount3 = new BN(1500 * 10 ** 9); // 1500 tokens
      
      const balanceBefore1 = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      const balanceBefore2 = (await getAccount(connection, recipientTokenAccount2.address)).amount;
      const balanceBefore3 = (await getAccount(connection, recipientTokenAccount3.address)).amount;
      const vaultBalanceBefore = (await getAccount(connection, vaultTokenAccount.address)).amount;
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: amount1,
          }],
          requestId: requestId1,
          expiryTimestamp,
        },
        {
          recipient: recipient2.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: amount2,
          }],
          requestId: requestId2,
          expiryTimestamp,
        },
        {
          recipient: recipient3.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: amount3,
          }],
          requestId: requestId3,
          expiryTimestamp,
        }
      ]);
      
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipient2.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipient3.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultTokenAccount.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount1.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount2.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount3.address, isWritable: true, isSigner: false },
      ];
      
      await userClient.bulkWithdraw(
        bulkTicket,
        [ethKeypair1, ethKeypair2],
        remainingAccounts
      );
      
      const balanceAfter1 = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      const balanceAfter2 = (await getAccount(connection, recipientTokenAccount2.address)).amount;
      const balanceAfter3 = (await getAccount(connection, recipientTokenAccount3.address)).amount;
      const vaultBalanceAfter = (await getAccount(connection, vaultTokenAccount.address)).amount;
      
      expect(balanceAfter1 - balanceBefore1).to.equal(BigInt(amount1.toString()));
      expect(balanceAfter2 - balanceBefore2).to.equal(BigInt(amount2.toString()));
      expect(balanceAfter3 - balanceBefore3).to.equal(BigInt(amount3.toString()));
      expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(
        BigInt(amount1.add(amount2).add(amount3).toString())
      );
      
      // Check nonces are marked as used after successful withdrawal
      const nonceUsed1After = await userClient.isNonceUsed(vaultPda, new BN(requestId1));
      const nonceUsed2After = await userClient.isNonceUsed(vaultPda, new BN(requestId2));
      const nonceUsed3After = await userClient.isNonceUsed(vaultPda, new BN(requestId3));
      expect(nonceUsed1After).to.be.true;
      expect(nonceUsed2After).to.be.true;
      expect(nonceUsed3After).to.be.true;
    });

    it("should successfully execute bulk withdrawal with mixed SOL and SPL tokens", async function() {
      this.timeout(30000);
      
      const recipient2 = Keypair.generate();
      const sig = await connection.requestAirdrop(recipient2.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      
      const recipientTokenAccount1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient.publicKey
      );
      
      const solAmount = new BN(0.5 * LAMPORTS_PER_SOL);
      const splAmount = new BN(5000 * 10 ** 9); // 5000 tokens
      
      const solBalanceBefore = await connection.getBalance(recipient2.publicKey);
      const splBalanceBefore = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: splAmount,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        },
        {
          recipient: recipient2.publicKey,
          withdrawals: [{
            asset: { sol: {} },
            amount: solAmount,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        }
      ]);
      
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipient2.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultTokenAccount.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount1.address, isWritable: true, isSigner: false },
      ];
      
      await userClient.bulkWithdraw(
        bulkTicket,
        [ethKeypair1, ethKeypair2],
        remainingAccounts
      );
      
      const solBalanceAfter = await connection.getBalance(recipient2.publicKey);
      const splBalanceAfter = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      
      expect((solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL).to.be.closeTo(0.5, 0.001);
      expect(splBalanceAfter - splBalanceBefore).to.equal(BigInt(splAmount.toString()));
    });

    it("should successfully execute bulk withdrawal with multiple SPL tokens to same recipient", async function() {
      this.timeout(30000);
      
      const recipientTokenAccount1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient.publicKey
      );
      
      const amount1 = new BN(1000 * 10 ** 9);
      const amount2 = new BN(2000 * 10 ** 9);
      
      const balanceBefore = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: amount1,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        },
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: amount2,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        }
      ]);
      
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultTokenAccount.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount1.address, isWritable: true, isSigner: false },
      ];
      
      await userClient.bulkWithdraw(
        bulkTicket,
        [ethKeypair1, ethKeypair2],
        remainingAccounts
      );
      
      const balanceAfter = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      
      expect(balanceAfter - balanceBefore).to.equal(
        BigInt(amount1.add(amount2).toString())
      );
    });

    it("should reject bulk withdrawal with insufficient SPL token balance", async function() {
      this.timeout(30000);
      
      const requestId = getUniqueRequestId();
      
      // Check nonce doesn't exist before
      const nonceUsedBefore = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedBefore).to.be.false;
      
      const recipientTokenAccount1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient.publicKey
      );
      
      const vaultBalance = (await getAccount(connection, vaultTokenAccount.address)).amount;
      const excessiveAmount = new BN(vaultBalance.toString()).add(new BN(1000 * 10 ** 9));
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: excessiveAmount,
          }],
          requestId: requestId,
          expiryTimestamp,
        }
      ]);
      
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultTokenAccount.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount1.address, isWritable: true, isSigner: false },
      ];
      
      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          remainingAccounts
        );
        expect.fail("Should have rejected insufficient SPL token balance");
      } catch (error: any) {
        expectErrorMessage(error, "InsufficientFunds");
      }
      
      // Check nonce is still not created/used after failure
      const nonceUsedAfter = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(nonceUsedAfter).to.be.false;
    });

    it("should reject bulk withdrawal when total SPL tokens exceed vault balance", async function() {
      this.timeout(30000);
      
      const recipient2 = Keypair.generate();
      
      const recipientTokenAccount1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient.publicKey
      );
      
      const recipientTokenAccount2 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient2.publicKey
      );
      
      const vaultBalance = (await getAccount(connection, vaultTokenAccount.address)).amount;
      const halfPlusOne = new BN(vaultBalance.toString()).divn(2).add(new BN(1000 * 10 ** 9));
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: halfPlusOne,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        },
        {
          recipient: recipient2.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: halfPlusOne,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        }
      ]);
      
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipient2.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultTokenAccount.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount1.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount2.address, isWritable: true, isSigner: false },
      ];
      
      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          remainingAccounts
        );
        expect.fail("Should have rejected when total exceeds balance");
      } catch (error: any) {
        expectErrorMessage(error, "InsufficientFunds");
      }
    });

    it("should reject bulk withdrawal with missing SPL token account", async function() {
      this.timeout(30000);
      
      const amount = new BN(1000 * 10 ** 9);
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [{
            asset: { splToken: { mint: testMint } },
            amount: amount,
          }],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        }
      ]);
      
      // Missing token accounts in remaining_accounts
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
      ];
      
      try {
        await userClient.bulkWithdraw(
          bulkTicket,
          [ethKeypair1, ethKeypair2],
          remainingAccounts
        );
        expect.fail("Should have rejected missing token account");
      } catch (error: any) {
        expectErrorMessage(error, "TokenAccountNotFound");
      }
    });

    it("should successfully execute bulk withdrawal with single ticket containing both SOL and SPL", async function() {
      this.timeout(30000);
      
      const recipientTokenAccount1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        recipient.publicKey
      );
      
      const solAmount = new BN(0.3 * LAMPORTS_PER_SOL);
      const splAmount = new BN(1000 * 10 ** 9);
      
      const solBalanceBefore = await connection.getBalance(recipient.publicKey);
      const splBalanceBefore = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const bulkTicket = userClient.createBulkWithdrawalTicket([
        {
          recipient: recipient.publicKey,
          withdrawals: [
            {
              asset: { sol: {} },
              amount: solAmount,
            },
            {
              asset: { splToken: { mint: testMint } },
              amount: splAmount,
            }
          ],
          requestId: getUniqueRequestId(),
          expiryTimestamp,
        }
      ]);
      
      const remainingAccounts = [
        { pubkey: recipient.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultTokenAccount.address, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount1.address, isWritable: true, isSigner: false },
      ];
      
      await userClient.bulkWithdraw(
        bulkTicket,
        [ethKeypair1, ethKeypair2],
        remainingAccounts
      );
      
      const solBalanceAfter = await connection.getBalance(recipient.publicKey);
      const splBalanceAfter = (await getAccount(connection, recipientTokenAccount1.address)).amount;
      
      expect((solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL).to.be.closeTo(0.3, 0.001);
      expect(splBalanceAfter - splBalanceBefore).to.equal(BigInt(splAmount.toString()));
    });
  });

  describe("Bulk Withdrawal Edge Cases", () => {
    it("should handle single ticket in bulk withdrawal", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const balanceBefore = await connection.getBalance(recipient.publicKey);
      
      await userClient.createAndExecuteBulkWithdrawal(
        [
          {
            recipient: recipient.publicKey,
            amountSol: withdrawAmount,
            requestId: getUniqueRequestId(),
          }
        ],
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const balanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount, 0.001);
    });

    it("should handle maximum number of tickets in bulk withdrawal", async function() {
      this.timeout(60000);
      
      const MAX_TICKETS = 4;
      const withdrawAmount = 0.05;
      
      const recipients = await Promise.all(
        Array(MAX_TICKETS).fill(0).map(async () => {
          const kp = Keypair.generate();
          const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig);
          return kp;
        })
      );
      
      const treasuryBalanceBefore = await connection.getBalance(treasuryPda);
      
      await userClient.createAndExecuteBulkWithdrawal(
        recipients.map(r => ({
          recipient: r.publicKey,
          amountSol: withdrawAmount,
          requestId: getUniqueRequestId(),
        })),
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const treasuryBalanceAfter = await connection.getBalance(treasuryPda);
      const totalWithdrawn = (treasuryBalanceBefore - treasuryBalanceAfter) / LAMPORTS_PER_SOL;
      
      expect(totalWithdrawn).to.be.closeTo(MAX_TICKETS * withdrawAmount, 0.01);
    });
  });
});