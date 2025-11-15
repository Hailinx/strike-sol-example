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
  EthereumKeypair,
} from "../src/client";

describe("Admin Functions Tests", () => {
  const ANCHOR_PROVIDER_URL = "http://127.0.0.1:8899";

  let adminClient: MultisigAdminClient;
  let userClient: MultisigVaultClient;
  let authority: Keypair;
  let user: Keypair;
  let connection: anchor.web3.Connection;
  
  // Test signers
  let ethKeypair1: EthereumKeypair;
  let ethKeypair2: EthereumKeypair;
  let ethKeypair3: EthereumKeypair;
  
  let vaultSeed: string;
  let vaultPda: PublicKey;
  let treasuryPda: PublicKey;

  // SPL Token test variables
  let testMint: PublicKey;
  let testMint2: PublicKey;

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
    
    // Create test mints
    testMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    
    testMint2 = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      9
    );
    
    console.log(`Test Mint 1: ${testMint.toBase58()}`);
    console.log(`Test Mint 2: ${testMint2.toBase58()}`);
    
    console.log("\nTest setup complete\n");
  });

  beforeEach(async function() {
    this.timeout(30000);
    
    // Generate new Ethereum keypairs for each test to avoid reuse
    ethKeypair1 = MultisigAdminClient.generateEthereumKeypair();
    ethKeypair2 = MultisigAdminClient.generateEthereumKeypair();
    ethKeypair3 = MultisigAdminClient.generateEthereumKeypair();
    
    // Initialize vault for each test
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
  });

  describe("Add Asset", () => {
    it("should successfully add SOL to whitelist", async function() {
      this.timeout(30000);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      await adminClient.addAsset(
        solAsset,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(1);
      expect(vaultData.whitelistedAssets[0]).to.have.property('sol');
    });

    it("should successfully add SPL token to whitelist", async function() {
      this.timeout(30000);
      
      const splAsset: Asset = { splToken: { mint: testMint } };
      const requestId = Date.now();
      
      await adminClient.addAsset(
        splAsset,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(1);
      expect(vaultData.whitelistedAssets[0]).to.have.property('splToken');
    });

    it("should add multiple different assets to whitelist", async function() {
      this.timeout(60000);
      
      const solAsset: Asset = { sol: {} };
      const splAsset1: Asset = { splToken: { mint: testMint } };
      const splAsset2: Asset = { splToken: { mint: testMint2 } };
      
      await adminClient.addAsset(
        solAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await adminClient.addAsset(
        splAsset1,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await adminClient.addAsset(
        splAsset2,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(3);
    });

    it("should not duplicate asset if already whitelisted", async function() {
      this.timeout(60000);
      
      const solAsset: Asset = { sol: {} };
      
      await adminClient.addAsset(
        solAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to add same asset again
      await adminClient.addAsset(
        solAsset,
        Date.now() + 1,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(1);
    });

    it("should fail with insufficient signatures", async function() {
      this.timeout(30000);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      try {
        // Only provide 1 signature when threshold is 2
        await adminClient.addAsset(
          solAsset,
          requestId,
          [ethKeypair1],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Insufficient signatures provided");
      }
    });

    it("should fail with expired ticket", async function() {
      this.timeout(30000);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      try {
        // Use negative expiry duration to create expired ticket
        await adminClient.addAsset(
          solAsset,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
          -3600, // Expired 1 hour ago
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Ticket has expired");
      }
    });

    it("should fail with duplicate request ID (nonce reuse)", async function() {
      this.timeout(60000);
      
      const solAsset: Asset = { sol: {} };
      const splAsset: Asset = { splToken: { mint: testMint } };
      const requestId = Date.now();
      
      await adminClient.addAsset(
        solAsset,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      try {
        // Try to reuse same request ID
        await adminClient.addAsset(
          splAsset,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Account already exists error or nonce already used
        expect(error.message).to.match(/already in use|Nonce has already been used/);
      }
    });

    it("should fail when called by non-authority", async function() {
      this.timeout(30000);
      
      // Create client with user instead of authority
      const nonAuthClient = setupAdminClient(user, ANCHOR_PROVIDER_URL, vaultSeed);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      try {
        await nonAuthClient.addAsset(
          solAsset,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Unauthorized user");
      }
    });
  });

  describe("Remove Asset", () => {
    beforeEach(async function() {
      this.timeout(30000);
      
      // Add assets before removal tests
      const solAsset: Asset = { sol: {} };
      const splAsset: Asset = { splToken: { mint: testMint } };
      
      await adminClient.addAsset(
        solAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await adminClient.addAsset(
        splAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
    });

    it("should successfully remove SOL from whitelist", async function() {
      this.timeout(30000);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      await adminClient.removeAsset(
        solAsset,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(1);
      expect(vaultData.whitelistedAssets[0]).to.have.property('splToken');
    });

    it("should successfully remove SPL token from whitelist", async function() {
      this.timeout(30000);
      
      const splAsset: Asset = { splToken: { mint: testMint } };
      const requestId = Date.now();
      
      await adminClient.removeAsset(
        splAsset,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(1);
      expect(vaultData.whitelistedAssets[0]).to.have.property('sol');
    });

    it("should not fail when removing non-existent asset", async function() {
      this.timeout(30000);
      
      const nonExistentAsset: Asset = { splToken: { mint: testMint2 } };
      const requestId = Date.now();
      
      // Should succeed but log that asset wasn't found
      await adminClient.removeAsset(
        nonExistentAsset,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(2);
    });

    it("should fail with insufficient signatures", async function() {
      this.timeout(30000);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      try {
        await adminClient.removeAsset(
          solAsset,
          requestId,
          [ethKeypair1], // Only 1 signature
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Insufficient signatures provided");
      }
    });

    it("should fail when called by non-authority", async function() {
      this.timeout(30000);
      
      const nonAuthClient = setupAdminClient(user, ANCHOR_PROVIDER_URL, vaultSeed);
      
      const solAsset: Asset = { sol: {} };
      const requestId = Date.now();
      
      try {
        await nonAuthClient.removeAsset(
          solAsset,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Unauthorized user");
      }
    });
  });

  describe("Rotate Validators", () => {
    it("should successfully rotate validators", async function() {
      this.timeout(30000);
      
      // Generate new validator set
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [newEthKeypair1.address, newEthKeypair2.address];
      const newThreshold = 2;
      const requestId = Date.now();
      
      await adminClient.rotateValidators(
        newSigners,
        newThreshold,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3], // Current validators sign
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.signers).to.have.lengthOf(2);
      expect(vaultData.mThreshold).to.equal(newThreshold);
    });

    it("should rotate to different threshold", async function() {
      this.timeout(30000);
      
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair3 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair4 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [
        newEthKeypair1.address,
        newEthKeypair2.address,
        newEthKeypair3.address,
        newEthKeypair4.address,
      ];
      const newThreshold = 3; // 3-of-4
      const requestId = Date.now();
      
      await adminClient.rotateValidators(
        newSigners,
        newThreshold,
        requestId,
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.signers).to.have.lengthOf(4);
      expect(vaultData.mThreshold).to.equal(3);
    });

    it("should fail with duplicate signers", async function() {
      this.timeout(30000);
      
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [
        newEthKeypair1.address,
        newEthKeypair1.address, // Duplicate
      ];
      const newThreshold = 2;
      const requestId = Date.now();
      
      try {
        await adminClient.rotateValidators(
          newSigners,
          newThreshold,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Duplicate signer detected");
      }
    });

    it("should fail with invalid threshold (zero)", async function() {
      this.timeout(30000);
      
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [newEthKeypair1.address, newEthKeypair2.address];
      const newThreshold = 0;
      const requestId = Date.now();
      
      try {
        await adminClient.rotateValidators(
          newSigners,
          newThreshold,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Client-side validation throws before hitting the contract
        expect(error.message).to.match(/Invalid threshold|Invalid m_threshold/);
      }
    });

    it("should fail with threshold greater than signers count", async function() {
      this.timeout(30000);
      
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [newEthKeypair1.address, newEthKeypair2.address];
      const newThreshold = 3; // More than signers count
      const requestId = Date.now();
      
      try {
        await adminClient.rotateValidators(
          newSigners,
          newThreshold,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Client-side validation throws before hitting the contract
        expect(error.message).to.match(/Invalid threshold|Invalid m_threshold/);
      }
    });

    it("should fail with empty signers array", async function() {
      this.timeout(30000);
      
      const newSigners: Uint8Array[] = [];
      const newThreshold = 1;
      const requestId = Date.now();
      
      try {
        await adminClient.rotateValidators(
          newSigners,
          newThreshold,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Invalid signers count");
      }
    });

    it("should fail with insufficient current validator signatures", async function() {
      this.timeout(30000);
      
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [newEthKeypair1.address, newEthKeypair2.address];
      const newThreshold = 2;
      const requestId = Date.now();
      
      try {
        // Only provide 1 current validator signature
        await adminClient.rotateValidators(
          newSigners,
          newThreshold,
          requestId,
          [ethKeypair1],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Insufficient signatures provided");
      }
    });

    it("should fail when called by non-authority", async function() {
      this.timeout(30000);
      
      const nonAuthClient = setupAdminClient(user, ANCHOR_PROVIDER_URL, vaultSeed);
      
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [newEthKeypair1.address, newEthKeypair2.address];
      const newThreshold = 2;
      const requestId = Date.now();
      
      try {
        await nonAuthClient.rotateValidators(
          newSigners,
          newThreshold,
          requestId,
          [ethKeypair1, ethKeypair2, ethKeypair3],
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Unauthorized user");
      }
    });
  });

  describe("Create Vault Token Account", () => {
    it("should successfully create vault token account", async function() {
      this.timeout(30000);
      
      await adminClient.createVaultTokenAccount(testMint);
      
      // Verify account was created
      const [vaultPda] = adminClient.getVaultAddress(vaultSeed);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        vaultPda,
        true
      );
      
      expect(ata.owner.toBase58()).to.equal(vaultPda.toBase58());
      expect(ata.mint.toBase58()).to.equal(testMint.toBase58());
    });

    it("should create multiple token accounts for different mints", async function() {
      this.timeout(60000);
      
      await adminClient.createVaultTokenAccount(testMint);
      await adminClient.createVaultTokenAccount(testMint2);
      
      const [vaultPda] = adminClient.getVaultAddress(vaultSeed);
      
      const ata1 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        vaultPda,
        true
      );
      
      const ata2 = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint2,
        vaultPda,
        true
      );
      
      expect(ata1.mint.toBase58()).to.equal(testMint.toBase58());
      expect(ata2.mint.toBase58()).to.equal(testMint2.toBase58());
    });

    it("should fail when called by non-authority", async function() {
      this.timeout(30000);
      
      const nonAuthClient = setupAdminClient(user, ANCHOR_PROVIDER_URL, vaultSeed);
      
      try {
        await nonAuthClient.createVaultTokenAccount(testMint);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Unauthorized user");
      }
    });
  });

  describe("Admin Function Integration", () => {
    it("should add asset, deposit, then remove asset", async function() {
      this.timeout(60000);
      
      // Add SPL token
      const splAsset: Asset = { splToken: { mint: testMint } };
      await adminClient.addAsset(
        splAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      // Create vault token account
      await adminClient.createVaultTokenAccount(testMint);
      
      // Mint tokens to user
      const userAta = await getOrCreateAssociatedTokenAccount(
        connection,
        user,
        testMint,
        user.publicKey
      );
      
      await mintTo(
        connection,
        authority,
        testMint,
        userAta.address,
        authority,
        1000000
      );
      
      // Deposit tokens
      const deposits: AssetAmount[] = [{
        asset: splAsset,
        amount: new BN(500000),
      }];
      
      const [vaultPda] = adminClient.getVaultAddress(vaultSeed);
      const vaultAta = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        testMint,
        vaultPda,
        true
      );
      
      await userClient.deposit(
        deposits,
        Date.now(),
        [
          { pubkey: userAta.address, isWritable: true, isSigner: false },
          { pubkey: vaultAta.address, isWritable: true, isSigner: false },
        ]
      );
      
      // Verify deposit
      const vaultTokenAccount = await getAccount(connection, vaultAta.address);
      expect(Number(vaultTokenAccount.amount)).to.equal(500000);
      
      // Remove asset from whitelist
      await new Promise(resolve => setTimeout(resolve, 1000));
      await adminClient.removeAsset(
        splAsset,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(0);
    });

    it("should rotate validators and verify new validators can add assets", async function() {
      this.timeout(60000);
      
      // Rotate validators
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair3 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [
        newEthKeypair1.address,
        newEthKeypair2.address,
        newEthKeypair3.address,
      ];
      const newThreshold = 2;
      
      await adminClient.rotateValidators(
        newSigners,
        newThreshold,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      // Wait a bit to ensure state is updated
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to add asset with NEW validators
      const solAsset: Asset = { sol: {} };
      await adminClient.addAsset(
        solAsset,
        Date.now(),
        [newEthKeypair1, newEthKeypair2, newEthKeypair3],
      );
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.whitelistedAssets).to.have.lengthOf(1);
    });

    it("should fail to use old validators after rotation", async function() {
      this.timeout(60000);
      
      // Rotate validators
      const newEthKeypair1 = MultisigAdminClient.generateEthereumKeypair();
      const newEthKeypair2 = MultisigAdminClient.generateEthereumKeypair();
      
      const newSigners = [newEthKeypair1.address, newEthKeypair2.address];
      const newThreshold = 2;
      
      await adminClient.rotateValidators(
        newSigners,
        newThreshold,
        Date.now(),
        [ethKeypair1, ethKeypair2, ethKeypair3],
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to add asset with OLD validators - should fail
      const solAsset: Asset = { sol: {} };
      try {
        await adminClient.addAsset(
          solAsset,
          Date.now(),
          [ethKeypair1, ethKeypair2], // Old validators
        );
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Error could be in the logs or message
        const errorStr = error.toString() + (error.logs ? error.logs.join(' ') : '');
        expect(errorStr).to.match(/Not enough valid signatures|InsufficientValidSignatures/);
      }
    });
  });
});