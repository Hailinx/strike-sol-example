import { describe, it, before } from "mocha";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  MultisigAdminClient,
  setupAdminClient,
  computeVaultSeed,
} from "../src/client";

describe("Initialize Vault Tests", () => {
  const ANCHOR_PROVIDER_URL = "http://127.0.0.1:8899";

  let adminClient: MultisigAdminClient;
  let authority: Keypair;
  let connection: anchor.web3.Connection;
  
  // Test signers
  let ethKeypair1: any;
  let ethKeypair2: any;
  let ethKeypair3: any;

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
      throw new Error("Solana validator not running. Start with 'solana-test-validator'");
    }

    authority = Keypair.generate();
    console.log(`Generated authority: ${authority.publicKey.toBase58()}`);
    
    // Airdrop SOL for testing
    try {
      const signature = await connection.requestAirdrop(
        authority.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(signature);
      console.log("Airdropped 5 SOL");
    } catch (error: any) {
      console.error("Airdrop failed:", error.message);
      throw error;
    }

    // Generate test Ethereum keypairs
    ethKeypair1 = MultisigAdminClient.generateEthereumKeypair();
    ethKeypair2 = MultisigAdminClient.generateEthereumKeypair();
    ethKeypair3 = MultisigAdminClient.generateEthereumKeypair();
    
    console.log("Test setup complete\n");
  });

  describe("Successful Initialization", () => {
    it("should initialize a 2-of-3 multisig vault", async function() {
      this.timeout(30000);
      
      const mThreshold = 2;
      const ethAddresses = [
        ethKeypair1.address,
        ethKeypair2.address,
        ethKeypair3.address,
      ];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      expect(result.signature).to.be.a("string");
      expect(result.vaultAddress).to.be.instanceOf(PublicKey);

      // Verify vault data
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(vaultData.mThreshold).to.equal(mThreshold);
      expect(vaultData.signers).to.have.lengthOf(3);
      expect(vaultData.whitelistedAssets).to.have.lengthOf(0);
    });

    it("should initialize a 1-of-1 multisig vault", async function() {
      this.timeout(30000);
      
      const mThreshold = 1;
      const ethAddresses = [ethKeypair1.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      expect(result.signature).to.be.a("string");
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.mThreshold).to.equal(1);
      expect(vaultData.signers).to.have.lengthOf(1);
    });

    it("should initialize with maximum signers (10)", async function() {
      this.timeout(30000);
      
      const mThreshold = 5;
      const ethAddresses = Array.from({ length: 10 }, () =>
        MultisigAdminClient.generateEthereumKeypair().address
      );

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      expect(result.signature).to.be.a("string");
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.signers).to.have.lengthOf(10);
      expect(vaultData.mThreshold).to.equal(5);
    });

    it("should initialize with N-of-N threshold", async function() {
      this.timeout(30000);
      
      const mThreshold = 3;
      const ethAddresses = [
        ethKeypair1.address,
        ethKeypair2.address,
        ethKeypair3.address,
      ];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      expect(result.signature).to.be.a("string");
      
      const vaultData = await adminClient.getVaultData();
      expect(vaultData.mThreshold).to.equal(3);
      expect(vaultData.signers).to.have.lengthOf(3);
    });
  });

  describe("Validation Errors", () => {
    it("should fail with threshold = 0", async function() {
      this.timeout(30000);
      
      const mThreshold = 0;
      const ethAddresses = [ethKeypair1.address, ethKeypair2.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      try {
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Error code: InvalidThreshold (0x1771)
        expect(error.message).to.match(/Invalid threshold|InvalidThreshold/i);
      }
    });

    it("should fail with threshold greater than number of signers", async function() {
      this.timeout(30000);
      
      const mThreshold = 4;
      const ethAddresses = [
        ethKeypair1.address,
        ethKeypair2.address,
        ethKeypair3.address,
      ];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      try {
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Error code: InvalidThreshold (0x1771)
        expect(error.message).to.match(/Invalid threshold|InvalidThreshold/i);
      }
    });

    it("should fail with empty signers array", async function() {
      this.timeout(30000);
      
      const mThreshold = 1;
      const ethAddresses: Uint8Array[] = [];

      try {
        const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
        adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Error code: InvalidSignersCount (0x1770)
        expect(error.message).to.match(/Invalid signers count|InvalidSignersCount/i);
      }
    });

    it("should fail with more than MAX_SIGNERS", async function() {
      this.timeout(30000);
      
      const mThreshold = 6;
      const ethAddresses = Array.from({ length: 11 }, () =>
        MultisigAdminClient.generateEthereumKeypair().address
      );

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      try {
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Error code: InvalidSignersCount (0x1770)
        expect(error.message).to.match(/Invalid signers count|InvalidSignersCount/i);
      }
    });

    it("should fail with duplicate signers", async function() {
      this.timeout(30000);
      
      const mThreshold = 2;
      const ethAddresses = [
        ethKeypair1.address,
        ethKeypair1.address, // Duplicate
        ethKeypair2.address,
      ];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      try {
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Error code: DuplicateSigner (0x1772)
        expect(error.message).to.match(/Duplicate signer detected|DuplicateSigner/i);
      }
    });

    it("should fail when trying to initialize same vault twice", async function() {
      this.timeout(60000);
      
      const mThreshold = 2;
      const ethAddresses = [ethKeypair1.address, ethKeypair2.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      // First initialization should succeed
      await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      // Second initialization should fail
      try {
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        // Anchor error: account already in use
        expect(error.message).to.match(/already in use|invalid account data/i);
      }
    });

    it("should fail with invalid vault seed (too long)", async () => {
      const mThreshold = 2;
      const ethAddresses = [ethKeypair1.address, ethKeypair2.address];
      const longSeed = "a".repeat(33); // 33 characters, exceeds max of 32

      try {
        adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, longSeed);
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Vault seed must be between 1 and 32");
      }
    });

    it("should fail with empty vault seed", async () => {
      const mThreshold = 2;
      const ethAddresses = [ethKeypair1.address, ethKeypair2.address];

      try {
        adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, "");
        await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).to.include("Vault seed must be between 1 and 32");
      }
    });
  });

  describe("State Verification", () => {
    it("should correctly store all initialization parameters", async function() {
      this.timeout(30000);
      
      // Generate unique keypairs for this test
      const kp1 = MultisigAdminClient.generateEthereumKeypair();
      const kp2 = MultisigAdminClient.generateEthereumKeypair();
      
      const mThreshold = 2;
      const ethAddresses = [kp1.address, kp2.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
      const vaultData = await adminClient.getVaultData();

      // Verify all fields
      expect(vaultData.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(vaultData.mThreshold).to.equal(mThreshold);
      expect(vaultData.bump).to.be.a("number");
      expect(vaultData.signers).to.have.lengthOf(2);
      expect(vaultData.whitelistedAssets).to.be.an("array").that.is.empty;
      
      // Verify signers are stored correctly
      ethAddresses.forEach((addr, idx) => {
        const storedSigner = vaultData.signers[idx];
        expect(Buffer.from(storedSigner)).to.deep.equal(Buffer.from(addr));
      });
    });

    it("should create treasury PDA correctly", async function() {
      this.timeout(30000);
      
      // Generate unique keypairs for this test
      const kp1 = MultisigAdminClient.generateEthereumKeypair();
      const kp2 = MultisigAdminClient.generateEthereumKeypair();
      
      const mThreshold = 2;
      const ethAddresses = [kp1.address, kp2.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      // Verify treasury PDA exists
      const [vaultPda] = adminClient.getVaultAddress(vaultSeed);
      const [treasuryPda] = adminClient.getTreasuryAddress(vaultPda);
      
      const treasuryAccount = await connection.getAccountInfo(treasuryPda);
      
      expect(treasuryAccount).to.not.be.null;
    });

    it("should have zero balance initially", async function() {
      this.timeout(30000);
      
      // Generate unique keypairs for this test
      const kp1 = MultisigAdminClient.generateEthereumKeypair();
      const kp2 = MultisigAdminClient.generateEthereumKeypair();
      
      const mThreshold = 2;
      const ethAddresses = [kp1.address, kp2.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      const balance = await adminClient.getTreasuryBalance();
      const lamports = await connection.getMinimumBalanceForRentExemption(8);
      const expectedSol = lamports / LAMPORTS_PER_SOL;

      expect(balance).to.equal(expectedSol);
    });
  });

  describe("Network ID Validation", () => {
    it("should store correct network ID for devnet", async function() {
      this.timeout(30000);
      
      // Generate unique keypairs for this test
      const kp1 = MultisigAdminClient.generateEthereumKeypair();
      const kp2 = MultisigAdminClient.generateEthereumKeypair();
      
      const mThreshold = 2;
      const ethAddresses = [kp1.address, kp2.address];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);

      const program = adminClient.program;
      const [vaultPda] = adminClient.getVaultAddress(vaultSeed);
      const vaultAccount = await program.account.vault.fetch(vaultPda);

      // For localhost, network ID should be 102 (DEVNET)
      expect(vaultAccount.networkId.toNumber()).to.equal(102);
    });
  });

  describe("Edge Cases", () => {
    it("should handle vault with all signers having same first byte", async function() {
      this.timeout(30000);
      
      const mThreshold = 2;
      // Create unique addresses that start with same byte
      const addr1 = new Uint8Array(20);
      addr1[0] = 0xBB; // Changed from 0xAA to make it unique
      for (let i = 1; i < 20; i++) addr1[i] = Math.floor(Math.random() * 256);
      
      const addr2 = new Uint8Array(20);
      addr2[0] = 0xBB; // Same first byte
      for (let i = 1; i < 20; i++) addr2[i] = Math.floor(Math.random() * 256);

      const ethAddresses = [addr1, addr2];

      const vaultSeed = computeVaultSeed(ethAddresses, mThreshold);
      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, vaultSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
      expect(result.signature).to.be.a("string");
    });

    it("should handle vault with maximum length seed (32 chars)", async function() {
      this.timeout(30000);
      
      // Generate unique keypairs for this test
      const kp1 = MultisigAdminClient.generateEthereumKeypair();
      const kp2 = MultisigAdminClient.generateEthereumKeypair();
      
      const mThreshold = 2;
      const ethAddresses = [kp1.address, kp2.address];
      const maxSeed = "b".repeat(32); // Changed from 'a' to 'b' to make it unique

      adminClient = setupAdminClient(authority, ANCHOR_PROVIDER_URL, maxSeed);

      const result = await adminClient.initialize(mThreshold, ethAddresses.length, ethAddresses);
      expect(result.signature).to.be.a("string");
    });
  });
});