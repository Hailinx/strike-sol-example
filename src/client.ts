import * as fs from "fs";
import * as path from "path";
import os from "os";
import dotenv from "dotenv";
import { createHash } from "crypto";

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { 
  Keypair, 
  Connection, 
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak256 } from "ethereum-cryptography/keccak";
import { secp256k1 } from "ethereum-cryptography/secp256k1";
import { StrikeExample } from "../target/types/strike_example";
import idl from "../target/idl/strike_example.json";

dotenv.config();

export const ENV = process.env;
export const ANCHOR_WALLET = ENV.ANCHOR_WALLET || "~/.config/solana/id.json";
export const ANCHOR_PROVIDER_URL = ENV.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = ENV.PROGRAM_ID;

const DOMAIN_SEPARATOR_WITHDRAWAL = "strike-protocol-v1-Withdrawal";
const DOMAIN_SEPARATOR_ADD_ASSET = "strike-protocol-v1-AddAsset";
const DOMAIN_SEPARATOR_REMOVE_ASSET = "strike-protocol-v1-RemoveAsset";

// Network IDs matching the contract
export enum NetworkId {
  MAINNET = 101,
  DEVNET = 102,
  TESTNET = 103,
}

// Asset types
export type Asset = 
  | { sol: {} }
  | { splToken: { mint: PublicKey } };

export interface AssetAmount {
  asset: Asset;
  amount: BN;
}

export function printEnv() {
  console.log("ANCHOR_PROVIDER_URL =", ANCHOR_PROVIDER_URL);
  console.log("ANCHOR_WALLET =", ANCHOR_WALLET);
  console.log("PROGRAM_ID =", PROGRAM_ID);
}

export interface WithdrawalTicket {
  requestId: BN;
  vault: PublicKey;
  recipient: PublicKey;
  withdrawals: AssetAmount[];
  expiry: BN;
  networkId: BN;
}

export interface AddAssetTicket {
  requestId: BN;
  vault: PublicKey;
  asset: Asset;
  expiry: BN;
  networkId: BN;
}

export interface RemoveAssetTicket {
  requestId: BN;
  vault: PublicKey;
  asset: Asset;
  expiry: BN;
  networkId: BN;
}

export interface EthereumKeypair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array;  // 64 bytes (uncompressed, without prefix)
  address: Uint8Array;    // 20 bytes (Ethereum address)
}

export interface SignerWithSignature {
  ethAddress: Uint8Array;  // 20 bytes
  signature: Uint8Array;   // 64 bytes (r + s)
  recoveryId: number;      // 0, 1, 27, or 28
}

export class MultisigVaultClient {
  program: Program<StrikeExample>;
  provider: anchor.AnchorProvider;
  vaultSeed: string;

  constructor(
    program: Program<StrikeExample>,
    provider: anchor.AnchorProvider,
    vaultSeed: string,
  ) {
    this.program = program;
    this.provider = provider;
    this.vaultSeed = vaultSeed;
  }

  /**
   * Generate an Ethereum-compatible keypair
   */
  static generateEthereumKeypair(): EthereumKeypair {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const publicKeyFull = secp256k1.getPublicKey(privateKey, false); // uncompressed (65 bytes with 0x04 prefix)
    const publicKey = publicKeyFull.slice(1); // Remove 0x04 prefix (64 bytes)
    
    // Ethereum address: keccak256(publicKey)[12:32]
    const hash = keccak256(publicKey);
    const address = hash.slice(-20);
    
    return {
      privateKey,
      publicKey,
      address,
    };
  }

  /**
   * Load Ethereum keypair from hex string (private key)
   */
  static loadEthereumKeypair(privateKeyHex: string): EthereumKeypair {
    // Remove 0x prefix if present
    const hex = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
    const privateKey = new Uint8Array(Buffer.from(hex, "hex"));
    
    const publicKeyFull = secp256k1.getPublicKey(privateKey, false);
    const publicKey = publicKeyFull.slice(1);
    
    const hash = keccak256(publicKey);
    const address = hash.slice(-20);
    
    return {
      privateKey,
      publicKey,
      address,
    };
  }

  /**
   * Derive the vault PDA address
   */
  getVaultAddress(vaultSeed: string): [PublicKey, number] {
    if (!vaultSeed || vaultSeed.length === 0 || vaultSeed.length > 32) {
      throw new Error('Vault seed must be between 1 and 32 characters');
    }
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(vaultSeed, 'utf-8')],
      this.program.programId
    );
  }

  /**
   * Derive the treasury PDA address
   */
  getTreasuryAddress(vaultPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), vaultPda.toBuffer()],
      this.program.programId
    );
  }

  /**
   * Derive the nonce account PDA address
   */
  getNonceAddress(vaultPda: PublicKey, requestId: BN): [PublicKey, number] {
    const requestIdBuffer = Buffer.alloc(8);
    requestIdBuffer.writeBigUInt64LE(BigInt(requestId.toString()));
    
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nonce"), vaultPda.toBuffer(), requestIdBuffer],
      this.program.programId
    );
  }

  /**
   * Serialize asset for hashing
   */
  private serializeAsset(asset: Asset): Buffer {
    const buffers: Buffer[] = [];
    
    if ('sol' in asset) {
      buffers.push(Buffer.from([0])); // Sol variant = 0
    } else if ('splToken' in asset) {
      buffers.push(Buffer.from([1])); // SplToken variant = 1
      buffers.push(asset.splToken.mint.toBuffer());
    }
    
    return Buffer.concat(buffers);
  }

  /**
   * Serialize AssetAmount for hashing
   */
  private serializeAssetAmount(assetAmount: AssetAmount): Buffer {
    const buffers: Buffer[] = [];
    
    buffers.push(this.serializeAsset(assetAmount.asset));
    buffers.push(Buffer.from([64])); // Separator byte
    
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(assetAmount.amount.toString()));
    buffers.push(amountBuf);
    
    return Buffer.concat(buffers);
  }

  /**
   * Create a withdrawal ticket hash for signing (keccak256)
   */
  createWithdrawalTicketHash(ticket: WithdrawalTicket): Uint8Array {
    const data: Buffer[] = [];
    
    // Domain separator
    data.push(Buffer.from(DOMAIN_SEPARATOR_WITHDRAWAL, "utf8"));
    
    // Request ID (u64, little-endian)
    const requestIdBuf = Buffer.alloc(8);
    requestIdBuf.writeBigUInt64LE(BigInt(ticket.requestId.toString()));
    data.push(requestIdBuf);
    
    // Vault pubkey (32 bytes)
    data.push(ticket.vault.toBuffer());
    
    // Recipient pubkey (32 bytes)
    data.push(ticket.recipient.toBuffer());
    
    // Withdrawals
    for (const withdrawal of ticket.withdrawals) {
      data.push(this.serializeAssetAmount(withdrawal));
    }
    
    // Expiry (i64, little-endian)
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(ticket.expiry.toString()));
    data.push(expiryBuf);
    
    // Network ID (u64, little-endian)
    const networkIdBuf = Buffer.alloc(8);
    networkIdBuf.writeBigUInt64LE(BigInt(ticket.networkId.toString()));
    data.push(networkIdBuf);
    
    // Concatenate all data
    const combined = Buffer.concat(data);
    
    // Hash using keccak256 (Ethereum compatible)
    return keccak256(combined);
  }

  /**
   * Create an add asset ticket hash for signing (keccak256)
   */
  createAddAssetTicketHash(ticket: AddAssetTicket): Uint8Array {
    const data: Buffer[] = [];
    
    // Domain separator
    data.push(Buffer.from(DOMAIN_SEPARATOR_ADD_ASSET, "utf8"));
    
    // Request ID (u64, little-endian)
    const requestIdBuf = Buffer.alloc(8);
    requestIdBuf.writeBigUInt64LE(BigInt(ticket.requestId.toString()));
    data.push(requestIdBuf);
    
    // Vault pubkey (32 bytes)
    data.push(ticket.vault.toBuffer());
    
    // Expiry (i64, little-endian)
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(ticket.expiry.toString()));
    data.push(expiryBuf);
    
    // Network ID (u64, little-endian)
    const networkIdBuf = Buffer.alloc(8);
    networkIdBuf.writeBigUInt64LE(BigInt(ticket.networkId.toString()));
    data.push(networkIdBuf);
    
    // Asset
    data.push(this.serializeAsset(ticket.asset));
    
    // Concatenate all data
    const combined = Buffer.concat(data);
    
    // Hash using keccak256 (Ethereum compatible)
    return keccak256(combined);
  }

  /**
   * Create a remove asset ticket hash for signing (keccak256)
   */
  createRemoveAssetTicketHash(ticket: RemoveAssetTicket): Uint8Array {
    const data: Buffer[] = [];
    
    // Domain separator
    data.push(Buffer.from(DOMAIN_SEPARATOR_REMOVE_ASSET, "utf8"));
    
    // Request ID (u64, little-endian)
    const requestIdBuf = Buffer.alloc(8);
    requestIdBuf.writeBigUInt64LE(BigInt(ticket.requestId.toString()));
    data.push(requestIdBuf);
    
    // Vault pubkey (32 bytes)
    data.push(ticket.vault.toBuffer());
    
    // Expiry (i64, little-endian)
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(ticket.expiry.toString()));
    data.push(expiryBuf);
    
    // Network ID (u64, little-endian)
    const networkIdBuf = Buffer.alloc(8);
    networkIdBuf.writeBigUInt64LE(BigInt(ticket.networkId.toString()));
    data.push(networkIdBuf);
    
    // Asset
    data.push(this.serializeAsset(ticket.asset));
    
    // Concatenate all data
    const combined = Buffer.concat(data);
    
    // Hash using keccak256 (Ethereum compatible)
    return keccak256(combined);
  }

  /**
   * Sign a withdrawal ticket with an Ethereum keypair
   */
  signWithdrawalTicket(ticket: WithdrawalTicket, ethKeypair: EthereumKeypair): SignerWithSignature {
    const messageHash = this.createWithdrawalTicketHash(ticket);
    
    // Sign with secp256k1
    const sig = secp256k1.sign(messageHash, ethKeypair.privateKey);
    
    // Extract r, s, and recovery ID
    const signature = sig.toCompactRawBytes(); // 64 bytes (r + s)
    const recoveryId = sig.recovery!; // 0 or 1
    
    return {
      ethAddress: ethKeypair.address,
      signature,
      recoveryId,
    };
  }

  /**
   * Sign an add asset ticket with an Ethereum keypair
   */
  signAddAssetTicket(ticket: AddAssetTicket, ethKeypair: EthereumKeypair): SignerWithSignature {
    const messageHash = this.createAddAssetTicketHash(ticket);
    
    const sig = secp256k1.sign(messageHash, ethKeypair.privateKey);
    const signature = sig.toCompactRawBytes();
    const recoveryId = sig.recovery!;
    
    return {
      ethAddress: ethKeypair.address,
      signature,
      recoveryId,
    };
  }

  /**
   * Sign a remove asset ticket with an Ethereum keypair
   */
  signRemoveAssetTicket(ticket: RemoveAssetTicket, ethKeypair: EthereumKeypair): SignerWithSignature {
    const messageHash = this.createRemoveAssetTicketHash(ticket);
    
    const sig = secp256k1.sign(messageHash, ethKeypair.privateKey);
    const signature = sig.toCompactRawBytes();
    const recoveryId = sig.recovery!;
    
    return {
      ethAddress: ethKeypair.address,
      signature,
      recoveryId,
    };
  }

  /**
   * Create a withdrawal ticket
   */
  createWithdrawalTicket(
    recipient: PublicKey,
    withdrawals: AssetAmount[],
    requestId: number,
    expiryTimestamp: number,
    networkId: NetworkId = NetworkId.DEVNET
  ): WithdrawalTicket {
    const [vaultPda] = this.getVaultAddress(this.vaultSeed);

    return {
      requestId: new BN(requestId),
      vault: vaultPda,
      recipient,
      withdrawals,
      expiry: new BN(expiryTimestamp),
      networkId: new BN(networkId),
    };
  }

  /**
   * Deposit assets into the vault
   */
  async deposit(
    deposits: AssetAmount[],
    requestId: number,
    remainingAccounts: any[] = []
  ): Promise<string> {
    const user = this.provider.wallet.publicKey;

    const [vaultPda] = this.getVaultAddress(this.vaultSeed);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);

    const depositsArg = deposits.map(d => ({
      asset: d.asset,
      amount: d.amount,
    }));

    const tx = await this.program.methods
      .deposit(depositsArg, new BN(requestId))
      .accounts({
        vault: vaultPda,
        treasury: treasuryPda,
        user: user,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log(`✅ Deposited assets to treasury`);
    console.log(`   Transaction: ${tx}`);

    return tx;
  }

  /**
   * Deposit SOL into the vault (convenience method)
   */
  async depositSol(
    amountSol: number,
    requestId?: number
  ): Promise<string> {
    const amountLamports = amountSol * LAMPORTS_PER_SOL;
    const deposits: AssetAmount[] = [{
      asset: { sol: {} },
      amount: new BN(amountLamports),
    }];

    const reqId = requestId || Date.now();
    return this.deposit(deposits, reqId);
  }

  /**
   * Withdraw assets from the vault with multisig approval using tickets
   */
  async withdraw(
    ticket: WithdrawalTicket,
    ethKeypairs: EthereumKeypair[],
    remainingAccounts: any[] = []
  ): Promise<string> {
    const [treasuryPda] = this.getTreasuryAddress(ticket.vault);
    const [noncePda] = this.getNonceAddress(ticket.vault, ticket.requestId);
    
    const actualPayer = this.provider.wallet.publicKey;

    // Sign the ticket with all provided signers
    const signersWithSigs = ethKeypairs.map(kp => this.signWithdrawalTicket(ticket, kp));

    // Convert ticket to program format
    const ticketArg = {
      requestId: ticket.requestId,
      vault: ticket.vault,
      recipient: ticket.recipient,
      withdrawals: ticket.withdrawals,
      expiry: ticket.expiry,
      networkId: ticket.networkId,
    };

    // Convert signatures to program format
    const sigsArg = signersWithSigs.map(s => ({
      signature: Array.from(s.signature),
      recoveryId: s.recoveryId,
    }));

    const tx = await this.program.methods
      .withdraw(ticketArg, sigsArg)
      .accounts({
        vault: ticket.vault,
        treasury: treasuryPda,
        recipient: ticket.recipient,
        nonceAccount: noncePda,
        payer: actualPayer,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log(`✅ Withdrew assets from vault`);
    console.log(`   Recipient: ${ticket.recipient.toBase58()}`);
    console.log(`   Request ID: ${ticket.requestId.toString()}`);
    console.log(`   Valid Signers: ${signersWithSigs.length}`);
    console.log(`   Transaction: ${tx}`);

    return tx;
  }

  /**
   * Convenience method: Withdraw SOL with current timestamp + duration
   */
  async createAndExecuteWithdrawal(
    recipient: PublicKey,
    amountSol: number,
    requestId: number,
    ethKeypairs: EthereumKeypair[],
    expiryDurationSeconds: number = 3600, // 1 hour default
    networkId: NetworkId = NetworkId.DEVNET,
  ): Promise<string> {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

    const withdrawals: AssetAmount[] = [{
      asset: { sol: {} },
      amount: new BN(amountSol * LAMPORTS_PER_SOL),
    }];

    const ticket = this.createWithdrawalTicket(
      recipient,
      withdrawals,
      requestId,
      expiryTimestamp,
      networkId
    );

    return this.withdraw(ticket, ethKeypairs);
  }

  /**
   * Fetch vault account data
   */
  async getVaultData() {
    const [vaultPda] = this.getVaultAddress(this.vaultSeed);
    const vaultAccount = await this.program.account.vault.fetch(vaultPda);

    const [treasuryPda] = this.getTreasuryAddress(vaultPda);
    const balance = await this.provider.connection.getBalance(treasuryPda);

    return {
      address: vaultPda,
      authority: vaultAccount.authority,
      mThreshold: vaultAccount.mThreshold,
      signers: vaultAccount.signers,
      whitelistedAssets: vaultAccount.whitelistedAssets,
      bump: vaultAccount.bump,
      balanceSol: balance / LAMPORTS_PER_SOL,
      balanceLamports: balance,
    };
  }

  /**
   * Get treasury balance in SOL
   */
  async getTreasuryBalance(): Promise<number> {
    const [vaultPda] = this.getVaultAddress(this.vaultSeed);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);
    const balance = await this.provider.connection.getBalance(treasuryPda);
    return balance / LAMPORTS_PER_SOL;
  }

  /**
   * Check if an Ethereum address is a valid signer for the vault
   */
  async isValidSigner(
    ethAddress: Uint8Array
  ): Promise<boolean> {
    const vaultData = await this.getVaultData();
    return vaultData.signers.some((s: number[]) => 
      s.every((byte, idx) => byte === ethAddress[idx])
    );
  }

  /**
   * Check if a nonce has been used
   */
  async isNonceUsed(vaultPda: PublicKey, requestId: BN): Promise<boolean> {
    try {
      const [noncePda] = this.getNonceAddress(vaultPda, requestId);
      const nonceAccount = await this.program.account.nonceAccount.fetch(noncePda);
      return nonceAccount.used;
    } catch (error) {
      // Nonce account doesn't exist yet
      return false;
    }
  }
}

export class MultisigAdminClient extends MultisigVaultClient {
  constructor(
    program: Program<StrikeExample>,
    provider: anchor.AnchorProvider,
    vaultSeed: string,
  ) {
    super(program, provider, vaultSeed);
  }

  /**
   * Initialize a new multisig vault with Ethereum addresses
   */
  async initialize(
    mThreshold: number,
    ethAddresses: Uint8Array[] // Array of 20-byte Ethereum addresses
  ): Promise<{ signature: string; vaultAddress: PublicKey }> {
    const authority = this.provider.wallet.publicKey;

    const [vaultPda, bump] = this.getVaultAddress(this.vaultSeed);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);

    // Convert to arrays for Anchor
    const signersArray = ethAddresses.map(addr => Array.from(addr));

    const tx = await this.program.methods
      .initialize(this.vaultSeed, mThreshold, signersArray)
      .accounts({
        vault: vaultPda,
        treasury: treasuryPda,
        authority: authority,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    console.log(`✅ Vault initialized: ${vaultPda.toBase58()}`);
    console.log(`   Treasury: ${treasuryPda.toBase58()}`);
    console.log(`   Transaction: ${tx}`);
    console.log(`   M-of-N: ${mThreshold} of ${ethAddresses.length}`);

    return {
      signature: tx,
      vaultAddress: vaultPda,
    };
  }

  /**
   * Add an asset to the vault whitelist
   */
  async addAsset(
    asset: Asset,
    requestId: number,
    ethKeypairs: EthereumKeypair[],
    expiryDurationSeconds: number = 3600,
    networkId: NetworkId = NetworkId.DEVNET,
  ): Promise<string> {
    const [vaultPda] = this.getVaultAddress(this.vaultSeed);
    const [noncePda] = this.getNonceAddress(vaultPda, new BN(requestId));
    
    const actualPayer = this.provider.wallet.publicKey;
    
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

    const ticket: AddAssetTicket = {
      requestId: new BN(requestId),
      vault: vaultPda,
      asset,
      expiry: new BN(expiryTimestamp),
      networkId: new BN(networkId),
    };

    const signersWithSigs = ethKeypairs.map(kp => this.signAddAssetTicket(ticket, kp));

    const sigsArg = signersWithSigs.map(s => ({
      signature: Array.from(s.signature),
      recoveryId: s.recoveryId,
    }));

    const tx = await this.program.methods
      .addAsset(ticket, sigsArg)
      .accounts({
        vault: vaultPda,
        nonceAccount: noncePda,
        payer: actualPayer,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    console.log(`✅ Added asset to whitelist`);
    console.log(`   Transaction: ${tx}`);

    return tx;
  }

  /**
   * Remove an asset from the vault whitelist
   */
  async removeAsset(
    asset: Asset,
    requestId: number,
    ethKeypairs: EthereumKeypair[],
    expiryDurationSeconds: number = 3600,
    networkId: NetworkId = NetworkId.DEVNET,
  ): Promise<string> {
    const [vaultPda] = this.getVaultAddress(this.vaultSeed);
    const [noncePda] = this.getNonceAddress(vaultPda, new BN(requestId));
    
    const actualPayer = this.provider.wallet.publicKey;
    
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

    const ticket: RemoveAssetTicket = {
      requestId: new BN(requestId),
      vault: vaultPda,
      asset,
      expiry: new BN(expiryTimestamp),
      networkId: new BN(networkId),
    };

    const signersWithSigs = ethKeypairs.map(kp => this.signRemoveAssetTicket(ticket, kp));

    const sigsArg = signersWithSigs.map(s => ({
      signature: Array.from(s.signature),
      recoveryId: s.recoveryId,
    }));

    const tx = await this.program.methods
      .removeAsset(ticket, sigsArg)
      .accounts({
        vault: vaultPda,
        nonceAccount: noncePda,
        payer: actualPayer,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    console.log(`✅ Removed asset from whitelist`);
    console.log(`   Transaction: ${tx}`);

    return tx;
  }

  async createVaultTokenAccount(
    mint: PublicKey,
  ) {
    const [vaultPda] = this.getVaultAddress(this.vaultSeed);
    const actualPayer = this.provider.wallet.publicKey;

    try {
      const createVaultTokenAccountTx = await this.program.methods
        .createVaultTokenAccount()
        .accounts({
          vault: vaultPda,
          mint: mint,
          payer: actualPayer,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        } as any)
        .rpc();

      console.log(`✅ Vault token account created`);
      console.log(`   Transaction: ${createVaultTokenAccountTx}`);
    } catch (err: any) {
      if (err.message?.includes("already in use")) {
        console.log(`✅ Vault token account already exists`);
      } else {
        throw err;
      }
    }
  }
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2));
  }
  return p;
}

/** Load Keypair from a local file containing the secret key array (Solana CLI id.json) */
export function loadKeypairFromJson(filePath: string): Keypair {
  const expanded = expandHome(filePath);
  if (!fs.existsSync(expanded)) {
    throw new Error(`Wallet file not found: ${expanded}`);
  }
  const raw = fs.readFileSync(expanded, { encoding: "utf8" });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON in ${expanded}: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    if ((parsed as any)._keypair?.secretKey) {
      const sk = Uint8Array.from((parsed as any)._keypair.secretKey);
      return Keypair.fromSecretKey(sk);
    }
    throw new Error(`Unsupported wallet file format (expected array of numbers): ${expanded}`);
  }
  const secret = Uint8Array.from(parsed);
  return Keypair.fromSecretKey(secret);
}

export function computeVaultSeed(signers: Uint8Array[], mThreshold: number): string {
  const sortedEthAddresses = [...signers].sort((a, b) => {
    for (let i = 0; i < 20; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });

  const h = createHash("sha256");
  h.update(Buffer.from("strike"));              // namespace prefix
  h.update(Buffer.from([mThreshold & 0xff]));     // one-byte threshold
  for (const s of sortedEthAddresses) {
    if (s.length !== 20) throw new Error("each signer must be 20 bytes (ethereum address)");
    h.update(Buffer.from(s));
  }
  const hash = h.digest(); // Buffer(32)
  return hash.subarray(0, 16).toString('hex');
}

export function setupProvider(
  authorityOrWallet: Keypair | Wallet | PublicKey, 
  providerUrl: string,
): anchor.AnchorProvider {
const connection = new Connection(providerUrl, "confirmed");

  let wallet: Wallet | null = null;

  // Init wallet directly from keypair.
  if (authorityOrWallet instanceof Keypair) {
    wallet = new Wallet(authorityOrWallet);
  } 
  // Already be anchor Wallet (frontend wallet-adapter or customized implementation).
  else if (
    authorityOrWallet && "publicKey" in authorityOrWallet && 
    typeof (authorityOrWallet as any).signTransaction === "function"
  ) {
    wallet = authorityOrWallet as Wallet;
  } 
  // Readonly
  else if (authorityOrWallet instanceof PublicKey) {
    wallet = {
      publicKey: authorityOrWallet,
      signTransaction: async (tx: Transaction) => {
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => txs,
    } as Wallet;
  }

  if (wallet == null) {
    throw Error("null wallet is not allowed");
  }

  return new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
}

/**
 * Setup function to create a client instance
 */
export function setupUserClient(
  authorityOrWallet: Keypair | Wallet | PublicKey, 
  providerUrl: string,
  vaultSeed: string,
): MultisigVaultClient {
  const provider = setupProvider(authorityOrWallet, providerUrl);
  const program = new Program(idl, provider) as Program<StrikeExample>;

  return new MultisigVaultClient(program, provider, vaultSeed);
}

export function setupAdminClient(
  authorityOrWallet: Keypair | Wallet | PublicKey, 
  providerUrl: string,
  vaultSeed: string,
): MultisigAdminClient {
  const provider = setupProvider(authorityOrWallet, providerUrl);
  const program = new Program(idl, provider) as Program<StrikeExample>;

  return new MultisigAdminClient(program, provider, vaultSeed);
}
