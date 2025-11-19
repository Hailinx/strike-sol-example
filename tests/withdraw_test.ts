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
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  MultisigAdminClient,
  MultisigVaultClient,
  setupAdminClient,
  setupUserClient,
  computeVaultSeed,
  Asset,
  AssetAmount,
  WithdrawalTicket,
  EthereumKeypair,
} from "../src/client";

describe("Withdraw Tests", () => {
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

    const result = await adminClient.initialize(mThreshold, ethAddresses);
    vaultPda = result.vaultAddress;
    [treasuryPda] = adminClient.getTreasuryAddress(vaultPda);
    
    console.log(`Vault initialized: ${vaultPda.toBase58()}`);
    console.log(`Treasury: ${treasuryPda.toBase58()}`);
    console.log(`M-of-N: ${mThreshold} of ${ethAddresses.length}`);
    
    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Airdrop SOL for testing
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
      console.log("Airdropped SOL to accounts");
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

  describe("Basic SOL Withdrawals", () => {
    it("should successfully withdraw SOL with M-of-N signatures", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      const treasuryBalanceBefore = await connection.getBalance(treasuryPda);
      
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2], // 2-of-3 signatures
        3600
      );
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const treasuryBalanceAfter = await connection.getBalance(treasuryPda);
      
      const received = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      const withdrawn = (treasuryBalanceBefore - treasuryBalanceAfter) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount, 0.001);
      expect(withdrawn).to.be.closeTo(withdrawAmount, 0.001);
    });

    it("should succeed with more than M signatures", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.3;
      const requestId = getUniqueRequestId();
      
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      
      // Use all 3 signatures (more than threshold of 2)
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
        3600
      );
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount, 0.001);
    });

    it("should withdraw multiple SOL amounts in single transaction", async function() {
      this.timeout(30000);
      
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const expiryTimestamp = currentTimestamp + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(0.1 * LAMPORTS_PER_SOL) },
        { asset: { sol: {} }, amount: new BN(0.2 * LAMPORTS_PER_SOL) },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(getUniqueRequestId()),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102), // DEVNET
      };
      
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      
      await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(0.3, 0.001);
    });
  });

  describe("Signature Validation", () => {
    it("should fail with insufficient signatures (less than M)", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId,
          [ethKeypair1], // Only 1 signature, need 2
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, ['InsufficientSignatures', 'InsufficientValidSignatures']);
      }
    });

    it("should fail with invalid signer", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      
      // Create an unauthorized signer
      const unauthorizedSigner = MultisigAdminClient.generateEthereumKeypair();
      
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId,
          [ethKeypair1, unauthorizedSigner], // One valid, one invalid
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InsufficientValidSignatures');
      }
    });

    it("should fail with all invalid signers", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      
      const unauthorizedSigner1 = MultisigAdminClient.generateEthereumKeypair();
      const unauthorizedSigner2 = MultisigAdminClient.generateEthereumKeypair();
      
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId,
          [unauthorizedSigner1, unauthorizedSigner2],
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InsufficientValidSignatures');
      }
    });
  });

  describe("Ticket Validation", () => {
    it("should fail with expired ticket", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(withdrawAmount * LAMPORTS_PER_SOL) },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(pastTimestamp),
        networkId: new BN(102),
      };
      
      try {
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'TicketExpired');
      }
    });

    it("should fail when replaying the same nonce (request_id)", async function() {
      this.timeout(60000);
      
      const withdrawAmount = 0.1;
      const requestId = getUniqueRequestId();
      
      // First withdrawal should succeed
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Try to replay with same request_id
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId, // Same request_id
          [ethKeypair1, ethKeypair2],
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Could be NonceAlreadyUsed or account already exists
        expectErrorMessage(error, ['NonceAlreadyUsed', 'already in use']);
      }
    });

    it("should fail with wrong vault in ticket", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const fakeVault = Keypair.generate().publicKey;
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(withdrawAmount * LAMPORTS_PER_SOL) },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: fakeVault, // Wrong vault
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      try {
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, ['InvalidVault', 'AnchorError']);
      }
    });

    it("should fail with wrong recipient in ticket", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const fakeRecipient = Keypair.generate().publicKey;
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(withdrawAmount * LAMPORTS_PER_SOL) },
      ];
      
      // Create ticket with fake recipient
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: fakeRecipient,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      // The client helper uses ticket.recipient, so we need to call withdraw directly
      // or the signature won't match. Let's use the low-level withdraw method
      try {
        // Sign with fake recipient in ticket
        const signersWithSigs = [ethKeypair1, ethKeypair2].map(kp => 
          userClient.signWithdrawalTicket(ticket, kp)
        );
        
        // But try to pass real recipient in accounts (mismatch)
        const [treasuryPda] = userClient.getTreasuryAddress(vaultPda);
        const [noncePda] = userClient.getNonceAddress(vaultPda, ticket.requestId);
        
        const sigsArg = signersWithSigs.map(s => ({
          signature: Array.from(s.signature),
          recoveryId: s.recoveryId,
        }));
        
        // Try to use different recipient in accounts than in ticket
        await userClient['program'].methods
          .withdraw(ticket, sigsArg, null)
          .accounts({
            vault: vaultPda,
            treasury: treasuryPda,
            recipient: recipient.publicKey, // Different from ticket.recipient
            nonceAccount: noncePda,
            payer: user.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc();
        
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InvalidRecipient');
      }
    });

    it("should fail with wrong network ID", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(withdrawAmount * LAMPORTS_PER_SOL) },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(999), // Wrong network ID
      };
      
      try {
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InvalidNetwork');
      }
    });
  });

  describe("Amount Validation", () => {
    it("should fail with zero withdrawal amount", async function() {
      this.timeout(30000);
      
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(0) }, // Zero amount
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      try {
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InvalidAmount');
      }
    });

    it("should fail with empty withdrawals array", async function() {
      this.timeout(30000);
      
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals: [], // Empty array
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      try {
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'NoWithdrawalsProvided');
      }
    });

    it("should fail when withdrawing more than treasury balance", async function() {
      this.timeout(30000);
      
      const treasuryBalance = await adminClient.getTreasuryBalance();
      const excessiveAmount = treasuryBalance + 10; // More than available
      const requestId = getUniqueRequestId();
      
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          excessiveAmount,
          requestId,
          [ethKeypair1, ethKeypair2],
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InsufficientFunds');
      }
    });
  });

  describe("Admin Withdrawals", () => {
    it("should require all signatures when withdrawing to admin", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.2;
      const requestId = getUniqueRequestId();
      
      // Try with only M signatures (should fail for admin)
      try {
        await adminClient.createAndExecuteAdminWithdrawal(
          authority.publicKey, // Withdrawing to admin
          withdrawAmount,
          requestId,
          [ethKeypair1, ethKeypair2], // Only 2 of 3
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InsufficientValidSignatures');
      }
    });

    it("should succeed with all signatures when withdrawing to admin", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.2;
      const requestId = getUniqueRequestId();
      
      const adminBalanceBefore = await connection.getBalance(authority.publicKey);
      
      // All 3 signatures required for admin withdrawal
      await adminClient.createAndExecuteAdminWithdrawal(
        authority.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3], // All 3 signers
        3600
      );
      
      const adminBalanceAfter = await connection.getBalance(authority.publicKey);
      const received = (adminBalanceAfter - adminBalanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(withdrawAmount, 0.001);
    });
  });

  describe("SPL Token Withdrawals", () => {
    before(async function() {
      this.timeout(60000);
      
      // Create test token mint
      testMint = await createMint(
        connection,
        authority,
        authority.publicKey,
        null,
        9
      );
      console.log(`\nTest token created: ${testMint.toBase58()}`);
      
      // Create recipient token account
      recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        recipient,
        testMint,
        recipient.publicKey
      );
      console.log(`Recipient token account: ${recipientTokenAccount.address.toBase58()}`);
      
      // Create vault token account
      await adminClient.createVaultTokenAccount(testMint);
      
      vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        vaultPda,
        true
      );
      console.log(`Vault token account: ${vaultTokenAccount.address.toBase58()}`);
      
      // Mint tokens to vault
      await mintTo(
        connection,
        authority,
        testMint,
        vaultTokenAccount.address,
        authority.publicKey,
        1000000000000 // 1000 tokens
      );
      console.log(`Minted 1000 tokens to vault\n`);
    });

    it("should successfully withdraw SPL tokens", async function() {
      this.timeout(30000);
      
      const tokenAmount = new BN(100000000); // 0.1 tokens
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { splToken: { mint: testMint } }, amount: tokenAmount },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      const recipientTokenBefore = await getAccount(connection, recipientTokenAccount.address);
      
      const remainingAccounts = [
        {
          pubkey: recipientTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
      ];
      
      await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2], remainingAccounts);
      
      const recipientTokenAfter = await getAccount(connection, recipientTokenAccount.address);
      const received = recipientTokenAfter.amount - recipientTokenBefore.amount;
      
      expect(received.toString()).to.equal(tokenAmount.toString());
    });

    it("should withdraw both SOL and SPL tokens in same transaction", async function() {
      this.timeout(30000);
      
      const solAmount = new BN(0.1 * LAMPORTS_PER_SOL);
      const tokenAmount = new BN(50000000); // 0.05 tokens
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { sol: {} }, amount: solAmount },
        { asset: { splToken: { mint: testMint } }, amount: tokenAmount },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      const recipientTokenBefore = await getAccount(connection, recipientTokenAccount.address);
      
      const remainingAccounts = [
        {
          pubkey: recipientTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
      ];
      
      await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2], remainingAccounts);
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const recipientTokenAfter = await getAccount(connection, recipientTokenAccount.address);
      
      const solReceived = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      const tokensReceived = recipientTokenAfter.amount - recipientTokenBefore.amount;
      
      expect(solReceived).to.be.closeTo(0.1, 0.001);
      expect(tokensReceived.toString()).to.equal(tokenAmount.toString());
    });

    it("should fail when token accounts not provided", async function() {
      this.timeout(30000);
      
      const tokenAmount = new BN(100000000);
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { splToken: { mint: testMint } }, amount: tokenAmount },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      try {
        // Not providing remaining accounts
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2], []);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'TokenAccountNotFound');
      }
    });

    it("should fail when withdrawing more tokens than vault balance", async function() {
      this.timeout(30000);
      
      const vaultTokenBalance = await getAccount(connection, vaultTokenAccount.address);
      const excessiveAmount = new BN(vaultTokenBalance.amount.toString()).add(new BN(1000000000));
      
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const withdrawals: AssetAmount[] = [
        { asset: { splToken: { mint: testMint } }, amount: excessiveAmount },
      ];
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      const remainingAccounts = [
        {
          pubkey: recipientTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
      ];
      
      try {
        await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2], remainingAccounts);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InsufficientFunds');
      }
    });
  });

  describe("Edge Cases", () => {
    it("should not allow different recipients to withdraw with same request_id", async function() {
      this.timeout(60000);
      
      const recipient2 = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(
        recipient2.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig);
      
      const sameRequestId = getUniqueRequestId();
      
      // First withdrawal succeeds
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        0.1,
        sameRequestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      // Second withdrawal with same request_id but different recipient should fail
      // because nonce is already used
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient2.publicKey,
          0.1,
          sameRequestId,
          [ethKeypair1, ethKeypair2],
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, ['NonceAlreadyUsed', 'already in use']);
      }
    });

    it("should verify treasury balance decreases correctly", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.15;
      const requestId = getUniqueRequestId();
      
      const treasuryBefore = await adminClient.getTreasuryBalance();
      
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const treasuryAfter = await adminClient.getTreasuryBalance();
      const decrease = treasuryBefore - treasuryAfter;
      
      expect(decrease).to.be.closeTo(withdrawAmount, 0.001);
    });

    it("should verify nonce account is created and marked as used", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      const requestId = getUniqueRequestId();
      
      // Execute withdrawal
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      // Verify nonce is now marked as used
      const isUsedAfter = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(isUsedAfter).to.be.true;
    });

    it("should handle large withdrawal amounts", async function() {
      this.timeout(30000);
      
      const treasuryBalance = await adminClient.getTreasuryBalance();
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const availableToWithdraw = treasuryBalance - (rentExempt / LAMPORTS_PER_SOL) - 0.01;
      
      // Withdraw a large amount (5 SOL or max available)
      const largeAmount = Math.min(5, availableToWithdraw);
      const requestId = getUniqueRequestId();
      
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        largeAmount,
        requestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(largeAmount, 0.001);
    });
  });

  describe("Multiple Sequential Withdrawals", () => {
    it("should handle multiple sequential withdrawals with different request_ids", async function() {
      this.timeout(90000);
      
      const withdrawAmount = 0.1;
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      
      for (let i = 0; i < 3; i++) {
        const requestId = getUniqueRequestId();
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId,
          [ethKeypair1, ethKeypair2],
          3600
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const totalReceived = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      
      expect(totalReceived).to.be.closeTo(0.3, 0.003);
    });

    it("should allow concurrent withdrawals to different recipients", async function() {
      this.timeout(60000);
      
      const recipient2 = Keypair.generate();
      const recipient3 = Keypair.generate();
      
      const airdrop2 = await connection.requestAirdrop(
        recipient2.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      const airdrop3 = await connection.requestAirdrop(
        recipient3.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop2);
      await connection.confirmTransaction(airdrop3);
      
      // Execute withdrawals with different request IDs
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        0.1,
        getUniqueRequestId(),
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      await userClient.createAndExecuteWithdrawal(
        recipient2.publicKey,
        0.1,
        getUniqueRequestId(),
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      await userClient.createAndExecuteWithdrawal(
        recipient3.publicKey,
        0.1,
        getUniqueRequestId(),
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      // All should succeed
      const balance1 = await connection.getBalance(recipient.publicKey);
      const balance2 = await connection.getBalance(recipient2.publicKey);
      const balance3 = await connection.getBalance(recipient3.publicKey);
      
      expect(balance1).to.be.gt(2 * LAMPORTS_PER_SOL);
      expect(balance2).to.be.gt(2 * LAMPORTS_PER_SOL);
      expect(balance3).to.be.gt(2 * LAMPORTS_PER_SOL);
    });
  });

  describe("Treasury State", () => {
    it("should verify treasury PDA derivation", async function() {
      this.timeout(10000);
      
      const [derivedTreasury, bump] = userClient.getTreasuryAddress(vaultPda);
      expect(derivedTreasury.toBase58()).to.equal(treasuryPda.toBase58());
    });

    it("should maintain minimum balance for rent exemption", async function() {
      this.timeout(30000);
      
      const treasuryBalance = await connection.getBalance(treasuryPda);
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      
      // Treasury should always have at least rent-exempt balance
      expect(treasuryBalance).to.be.gte(rentExempt);
    });
  });

  describe("Security Features", () => {
    it("should prevent withdrawal without proper signatures", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.5;
      const requestId = getUniqueRequestId();
      
      try {
        await userClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId,
          [], // No signatures
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, ['InsufficientSignatures', 'InsufficientValidSignatures']);
      }
    });

    it("should validate signer addresses match vault signers", async function() {
      this.timeout(30000);
      
      const vaultData = await adminClient.getVaultData();
      
      // Verify our test signers are in the vault
      const signer1Valid = await userClient.isValidSigner(ethKeypair1.address);
      const signer2Valid = await userClient.isValidSigner(ethKeypair2.address);
      const signer3Valid = await userClient.isValidSigner(ethKeypair3.address);
      
      expect(signer1Valid).to.be.true;
      expect(signer2Valid).to.be.true;
      expect(signer3Valid).to.be.true;
      
      // Verify a random signer is not valid
      const randomSigner = MultisigAdminClient.generateEthereumKeypair();
      const randomValid = await userClient.isValidSigner(randomSigner.address);
      expect(randomValid).to.be.false;
    });

    it("should enforce nonce uniqueness per request_id", async function() {
      this.timeout(30000);
      
      const requestId = getUniqueRequestId();
      const [noncePda] = userClient.getNonceAddress(vaultPda, new BN(requestId));
      
      // First withdrawal creates and uses nonce
      await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        0.1,
        requestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      // Verify nonce account exists and is marked as used
      const nonceAccountInfo = await connection.getAccountInfo(noncePda);
      expect(nonceAccountInfo).to.not.be.null;
      
      const isUsed = await userClient.isNonceUsed(vaultPda, new BN(requestId));
      expect(isUsed).to.be.true;
    });
  });

  describe("Gas and Performance", () => {
    it("should measure transaction cost for SOL withdrawal", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 0.1;
      const requestId = getUniqueRequestId();
      
      const payerBalanceBefore = await connection.getBalance(user.publicKey);
      
      const tx = await userClient.createAndExecuteWithdrawal(
        recipient.publicKey,
        withdrawAmount,
        requestId,
        [ethKeypair1, ethKeypair2],
        3600
      );
      
      const payerBalanceAfter = await connection.getBalance(user.publicKey);
      const txCost = (payerBalanceBefore - payerBalanceAfter) / LAMPORTS_PER_SOL;
      
      console.log(`      Transaction cost: ${txCost.toFixed(6)} SOL`);
      expect(txCost).to.be.lessThan(0.01); // Should be under 0.01 SOL
    });

    it("should handle maximum withdrawal array size", async function() {
      this.timeout(30000);
      
      // Create multiple small withdrawals in one transaction
      const withdrawals: AssetAmount[] = [];
      for (let i = 0; i < 5; i++) {
        withdrawals.push({
          asset: { sol: {} },
          amount: new BN(0.01 * LAMPORTS_PER_SOL),
        });
      }
      
      const requestId = getUniqueRequestId();
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;
      
      const ticket: WithdrawalTicket = {
        requestId: new BN(requestId),
        vault: vaultPda,
        recipient: recipient.publicKey,
        withdrawals,
        expiry: new BN(expiryTimestamp),
        networkId: new BN(102),
      };
      
      const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);
      
      await userClient.withdraw(ticket, [ethKeypair1, ethKeypair2]);
      
      const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
      const received = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
      
      expect(received).to.be.closeTo(0.05, 0.001);
    });
  });

  describe("Insufficient Funds Scenario", () => {
    let emptyVaultClient: MultisigVaultClient;
    let emptyVaultPda: PublicKey;
    let emptyTreasuryPda: PublicKey;

    before(async function() {
      this.timeout(60000);
      
      // Create a separate vault for testing insufficient funds
      const emptyVaultSeed = computeVaultSeed(
        [ethKeypair1.address],
        mThreshold + 100
      );
      
      const emptyAdminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, emptyVaultSeed);
      emptyVaultClient = setupUserClient(user, ANCHOR_PROVIDER_URL, emptyVaultSeed);
      
      // Initialize the empty vault
      const result = await emptyAdminClient.initialize(
        mThreshold,
        [ethKeypair1.address, ethKeypair2.address, ethKeypair3.address]
      );
      
      emptyVaultPda = result.vaultAddress;
      [emptyTreasuryPda] = emptyAdminClient.getTreasuryAddress(emptyVaultPda);
      
      console.log(`\nEmpty vault created: ${emptyVaultPda.toBase58()}`);
      console.log(`Empty treasury: ${emptyTreasuryPda.toBase58()}\n`);
    });

    it("should fail when withdrawing from empty treasury", async function() {
      this.timeout(30000);
      
      const withdrawAmount = 1.0;
      const requestId = getUniqueRequestId();
      
      try {
        await emptyVaultClient.createAndExecuteWithdrawal(
          recipient.publicKey,
          withdrawAmount,
          requestId,
          [ethKeypair1, ethKeypair2],
          3600
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expectErrorMessage(error, 'InsufficientFunds');
      }
    });

    it("should show treasury balance is minimal (rent-exempt only)", async function() {
      this.timeout(10000);
      
      const balance = await connection.getBalance(emptyTreasuryPda);
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      
      // Empty treasury should only have rent-exempt amount
      expect(balance).to.be.lte(rentExempt + 0.001 * LAMPORTS_PER_SOL);
      console.log(`      Empty treasury balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    });
  });
});