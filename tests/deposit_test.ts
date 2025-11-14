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
  AssetAmount,
} from "../src/client";

describe("Deposit Tests", () => {
  const ANCHOR_PROVIDER_URL = "http://127.0.0.1:8899";

  let adminClient: MultisigAdminClient;
  let userClient: MultisigVaultClient;
  let authority: Keypair;
  let user: Keypair;
  let connection: anchor.web3.Connection;
  
  // Test signers
  let ethKeypair1: any;
  let ethKeypair2: any;
  let ethKeypair3: any;
  
  let vaultSeed: string;
  let vaultPda: PublicKey;
  let treasuryPda: PublicKey;

  // SPL Token test variables
  let testMint: PublicKey;
  let userTokenAccount: any;
  let vaultTokenAccount: any;

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
    
    console.log(`Authority: ${authority.publicKey.toBase58()}`);
    console.log(`User: ${user.publicKey.toBase58()}`);
    
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
      await connection.confirmTransaction(authSig);
      await connection.confirmTransaction(userSig);
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
    const mThreshold = 2;
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
    
    // Whitelist SOL
    const solAsset: Asset = { sol: {} };
    await adminClient.addAsset(
      solAsset,
      Date.now(),
      [ethKeypair1, ethKeypair2, ethKeypair3],
    );
    console.log("SOL whitelisted");
    
    console.log("\nTest setup complete\n");
  });

  describe("SOL Deposits", () => {
    it("should successfully deposit SOL", async function() {
      this.timeout(30000);
      
      const depositAmount = 1.5;
      const requestId = Date.now();
      
      const balanceBefore = await connection.getBalance(treasuryPda);
      
      await userClient.depositSol(depositAmount, requestId);
      
      const balanceAfter = await connection.getBalance(treasuryPda);
      const deposited = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      
      expect(deposited).to.be.closeTo(depositAmount, 0.0001);
    });

    it("should deposit multiple SOL amounts in single transaction", async function() {
      this.timeout(30000);
      
      const deposits: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(0.5 * LAMPORTS_PER_SOL) },
        { asset: { sol: {} }, amount: new BN(0.3 * LAMPORTS_PER_SOL) },
      ];
      
      const balanceBefore = await connection.getBalance(treasuryPda);
      
      await userClient.deposit(deposits, Date.now());
      
      const balanceAfter = await connection.getBalance(treasuryPda);
      const deposited = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      
      expect(deposited).to.be.closeTo(0.8, 0.0001);
    });

    it("should fail when depositing zero SOL", async function() {
      this.timeout(30000);
      
      const deposits: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(0) },
      ];
      
      try {
        await userClient.deposit(deposits, Date.now());
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAmount");
      }
    });

    it("should fail when depositing non-whitelisted asset", async function() {
      this.timeout(30000);
      
      // Create a fake mint that's not whitelisted
      const fakeMint = Keypair.generate().publicKey;
      
      const deposits: AssetAmount[] = [
        { 
          asset: { splToken: { mint: fakeMint } }, 
          amount: new BN(1000000) 
        },
      ];
      
      try {
        await userClient.deposit(deposits, Date.now());
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("AssetNotWhitelisted");
      }
    });

    it("should fail when no deposits provided", async function() {
      this.timeout(30000);
      
      const deposits: AssetAmount[] = [];
      
      try {
        await userClient.deposit(deposits, Date.now());
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("NoDepositsProvided");
      }
    });

    it("should fail when admin tries to use regular deposit", async function() {
      this.timeout(30000);
      
      const adminAsUser = setupUserClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);
      
      const deposits: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(1 * LAMPORTS_PER_SOL) },
      ];
      
      try {
        await adminAsUser.deposit(deposits, Date.now());
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("AdminDepositShouldBeSigned");
      }
    });

    it("should allow deposits with metadata", async function() {
      this.timeout(30000);
      
      const depositAmount = 0.5;
      const requestId = Date.now();
      const metadata = JSON.stringify({ 
        purpose: "test deposit",
        userId: "user123" 
      });
      
      const deposits: AssetAmount[] = [
        { asset: { sol: {} }, amount: new BN(depositAmount * LAMPORTS_PER_SOL) },
      ];
      
      const tx = await userClient.deposit(deposits, requestId, [], metadata);
      expect(tx).to.be.a("string");
    });

    it("should handle multiple sequential deposits", async function() {
      this.timeout(60000);
      
      const balanceBefore = await connection.getBalance(treasuryPda);
      
      for (let i = 0; i < 3; i++) {
        await userClient.depositSol(0.1, Date.now() + i);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay
      }
      
      const balanceAfter = await connection.getBalance(treasuryPda);
      const deposited = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;
      
      expect(deposited).to.be.closeTo(0.3, 0.001);
    });
  });

  describe("SPL Token Deposits", () => {
    before(async function() {
      this.timeout(60000);
      
      // Create test token mint
      testMint = await createMint(
        connection,
        authority,
        authority.publicKey,
        null,
        9 // 9 decimals
      );
      console.log(`Test token created: ${testMint.toBase58()}`);
      
      // Create user token account and mint tokens
      userTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        user,
        testMint,
        user.publicKey
      );
      
      await mintTo(
        connection,
        authority,
        testMint,
        userTokenAccount.address,
        authority.publicKey,
        1000000000000 // 1000 tokens with 9 decimals
      );
      console.log(`Minted tokens to user`);
      
      // Whitelist the token
      const tokenAsset: Asset = { splToken: { mint: testMint } };
      await adminClient.addAsset(
        tokenAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
        3600
      );
      console.log(`Token whitelisted`);
      
      // Create vault token account
      await adminClient.createVaultTokenAccount(testMint);
      console.log(`Vault token account created`);
      
      // Get vault token account
      vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        vaultPda,
        true // allowOwnerOffCurve for PDA
      );
      console.log(`Vault token account: ${vaultTokenAccount.address.toBase58()}`);
    });

    it("should successfully deposit SPL tokens", async function() {
      this.timeout(30000);
      
      const depositAmount = new BN(100000000); // 0.1 tokens with 9 decimals
      
      const deposits: AssetAmount[] = [
        { 
          asset: { splToken: { mint: testMint } }, 
          amount: depositAmount 
        },
      ];
      
      // Refresh user token account
      const userTokenBefore = await getAccount(connection, userTokenAccount.address);
      
      const remainingAccounts = [
        {
          pubkey: userTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
      ];
      
      await userClient.deposit(deposits, Date.now(), remainingAccounts);
      
      const userTokenAfter = await getAccount(connection, userTokenAccount.address);
      const transferred = userTokenBefore.amount - userTokenAfter.amount;
      
      expect(transferred.toString()).to.equal(depositAmount.toString());
    });

    it("should deposit both SOL and SPL tokens in same transaction", async function() {
      this.timeout(30000);
      
      const solAmount = new BN(0.5 * LAMPORTS_PER_SOL);
      const tokenAmount = new BN(50000000); // 0.05 tokens
      
      const deposits: AssetAmount[] = [
        { asset: { sol: {} }, amount: solAmount },
        { asset: { splToken: { mint: testMint } }, amount: tokenAmount },
      ];
      
      const treasuryBalanceBefore = await connection.getBalance(treasuryPda);
      const userTokenBefore = await getAccount(connection, userTokenAccount.address);
      
      const remainingAccounts = [
        {
          pubkey: userTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
      ];
      
      await userClient.deposit(deposits, Date.now(), remainingAccounts);
      
      const treasuryBalanceAfter = await connection.getBalance(treasuryPda);
      const userTokenAfter = await getAccount(connection, userTokenAccount.address);
      
      const solDeposited = (treasuryBalanceAfter - treasuryBalanceBefore) / LAMPORTS_PER_SOL;
      const tokensTransferred = userTokenBefore.amount - userTokenAfter.amount;
      
      expect(solDeposited).to.be.closeTo(0.5, 0.0001);
      expect(tokensTransferred.toString()).to.equal(tokenAmount.toString());
    });

    it("should fail when token accounts not provided in remaining_accounts", async function() {
      this.timeout(30000);
      
      const deposits: AssetAmount[] = [
        { 
          asset: { splToken: { mint: testMint } }, 
          amount: new BN(100000000) 
        },
      ];
      
      try {
        // Not providing remaining accounts
        await userClient.deposit(deposits, Date.now(), []);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("TokenAccountNotFound");
      }
    });

    it("should fail when depositing zero SPL tokens", async function() {
      this.timeout(30000);
      
      const deposits: AssetAmount[] = [
        { asset: { splToken: { mint: testMint } }, amount: new BN(0) },
      ];
      
      const remainingAccounts = [
        {
          pubkey: userTokenAccount.address,
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
        await userClient.deposit(deposits, Date.now(), remainingAccounts);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAmount");
      }
    });

    it("should handle large token deposits", async function() {
      this.timeout(30000);
      
      const largeAmount = new BN(500000000000); // 500 tokens
      
      const deposits: AssetAmount[] = [
        { asset: { splToken: { mint: testMint } }, amount: largeAmount },
      ];
      
      const userTokenBefore = await getAccount(connection, userTokenAccount.address);
      
      const remainingAccounts = [
        {
          pubkey: userTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultTokenAccount.address,
          isWritable: true,
          isSigner: false,
        },
      ];
      
      await userClient.deposit(deposits, Date.now(), remainingAccounts);
      
      const userTokenAfter = await getAccount(connection, userTokenAccount.address);
      const transferred = userTokenBefore.amount - userTokenAfter.amount;
      
      expect(transferred.toString()).to.equal(largeAmount.toString());
    });
  });

  describe("Edge Cases and Validation", () => {
    it("should accept same request_id for different users", async function() {
      this.timeout(30000);
      
      const user2 = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(
        user2.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig);
      
      const user2Client = setupUserClient(user2, ANCHOR_PROVIDER_URL, vaultSeed);
      
      const sameRequestId = 12345;
      
      await userClient.depositSol(0.1, sameRequestId);
      await user2Client.depositSol(0.1, sameRequestId);
      
      // Both should succeed - request_id is scoped per operation type
    });

    it("should allow reusing request_id after successful deposit", async function() {
      this.timeout(30000);
      
      const requestId = Date.now();
      
      await userClient.depositSol(0.1, requestId);
      // Reusing same request_id should work (no nonce check for deposits)
      await userClient.depositSol(0.1, requestId);
    });

    it("should verify treasury balance increases correctly", async function() {
      this.timeout(30000);
      
      const depositAmount = 2.5;
      const balanceBefore = await adminClient.getTreasuryBalance();
      
      await userClient.depositSol(depositAmount);
      
      const balanceAfter = await adminClient.getTreasuryBalance();
      const increase = balanceAfter - balanceBefore;
      
      expect(increase).to.be.closeTo(depositAmount, 0.001);
    });

    it("should handle deposits from accounts with minimal balance", async function() {
      this.timeout(30000);
      
      const poorUser = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(
        poorUser.publicKey,
        0.1 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig);
      
      const poorUserClient = setupUserClient(poorUser, ANCHOR_PROVIDER_URL, vaultSeed);
      
      // Try to deposit almost all balance (keeping some for fees)
      await poorUserClient.depositSol(0.05);
    });
  });
});