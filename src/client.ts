import * as fs from "fs";
import * as path from "path";
import os from "os";
import dotenv from "dotenv";

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { 
  Keypair, 
  Connection, 
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { keccak256 } from "ethereum-cryptography/keccak";
import { secp256k1 } from "ethereum-cryptography/secp256k1";
import { StrikeExample } from "../target/types/strike_example";
import idl from "../target/idl/strike_example.json";

dotenv.config();

export const ENV = process.env;
export const ANCHOR_WALLET = ENV.ANCHOR_WALLET || "~/.config/solana/id.json";
export const ANCHOR_PROVIDER_URL = ENV.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = ENV.PROGRAM_ID;

const DOMAIN_SEPARATOR = "strike-protocol-v1";

// Network IDs matching the contract
export enum NetworkId {
  MAINNET = 101,
  DEVNET = 102,
  TESTNET = 103,
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
  amount: BN;
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

  constructor(
    program: Program<StrikeExample>,
    provider: anchor.AnchorProvider
  ) {
    this.program = program;
    this.provider = provider;
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
  getVaultAddress(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.toBuffer()],
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
   * Initialize a new multisig vault with Ethereum addresses
   */
  async initialize(
    authority: Keypair,
    mThreshold: number,
    ethAddresses: Uint8Array[] // Array of 20-byte Ethereum addresses
  ): Promise<{ signature: string; vaultAddress: PublicKey }> {
    const [vaultPda] = this.getVaultAddress(authority.publicKey);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);

    // Convert to arrays for Anchor
    const signersArray = ethAddresses.map(addr => Array.from(addr));

    const tx = await this.program.methods
      .initialize(mThreshold, signersArray)
      .accounts({
        vault: vaultPda,
        treasury: treasuryPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([authority])
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
   * Initialize a new multisig vault with self as authority.
   */
  async initializeForSelf(
    mThreshold: number,
    ethAddresses: Uint8Array[]
  ): Promise<{ signature: string; vaultAddress: PublicKey }> {
    const authority = (this.provider.wallet as any).payer as Keypair;
    return this.initialize(authority, mThreshold, ethAddresses);
  }

  /**
   * Deposit SOL into the vault
   */
  async depositSol(
    user: Keypair,
    amountSol: number
  ): Promise<string> {
    const [vaultPda] = this.getVaultAddress(this.provider.wallet.publicKey);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);
    const amountLamports = amountSol * LAMPORTS_PER_SOL;

    const tx = await this.program.methods
      .depositSol(new BN(amountLamports))
      .accounts({
        vault: vaultPda,
        treasury: treasuryPda,
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([user])
      .rpc();

    console.log(`✅ Deposited ${amountSol} SOL to treasury`);
    console.log(`   Transaction: ${tx}`);

    return tx;
  }

  /**
   * Deposit SOL into the vault from myself.
   */
  async depositSolFromSelf(
    amountSol: number
  ): Promise<string> {
    const user = (this.provider.wallet as any).payer as Keypair;
    return this.depositSol(user, amountSol);
  }

  /**
   * Create a withdrawal ticket hash for signing (keccak256)
   */
  createTicketHash(ticket: WithdrawalTicket): Uint8Array {
    const data: Buffer[] = [];
    
    // Domain separator
    data.push(Buffer.from(DOMAIN_SEPARATOR, "utf8"));
    
    // Request ID (u64, little-endian)
    const requestIdBuf = Buffer.alloc(8);
    requestIdBuf.writeBigUInt64LE(BigInt(ticket.requestId.toString()));
    data.push(requestIdBuf);
    
    // Vault pubkey (32 bytes)
    data.push(ticket.vault.toBuffer());
    
    // Recipient pubkey (32 bytes)
    data.push(ticket.recipient.toBuffer());
    
    // Amount (u64, little-endian)
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(ticket.amount.toString()));
    data.push(amountBuf);
    
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
   * Sign a withdrawal ticket with an Ethereum keypair
   */
  signTicket(ticket: WithdrawalTicket, ethKeypair: EthereumKeypair): SignerWithSignature {
    const messageHash = this.createTicketHash(ticket);
    
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
   * Create a withdrawal ticket
   */
  createWithdrawalTicket(
    vaultAuthority: PublicKey,
    recipient: PublicKey,
    amountSol: number,
    requestId: number,
    expiryTimestamp: number,
    networkId: NetworkId = NetworkId.DEVNET
  ): WithdrawalTicket {
    const [vaultPda] = this.getVaultAddress(vaultAuthority);
    const amountLamports = amountSol * LAMPORTS_PER_SOL;

    return {
      requestId: new BN(requestId),
      vault: vaultPda,
      recipient,
      amount: new BN(amountLamports),
      expiry: new BN(expiryTimestamp),
      networkId: new BN(networkId),
    };
  }

  /**
   * Withdraw SOL from the vault with multisig approval using tickets
   */
  async withdrawSol(
    ticket: WithdrawalTicket,
    ethKeypairs: EthereumKeypair[],
    payer?: Keypair
  ): Promise<string> {
    const [treasuryPda] = this.getTreasuryAddress(ticket.vault);
    const [noncePda] = this.getNonceAddress(ticket.vault, ticket.requestId);
    
    const actualPayer = payer || (this.provider.wallet as any).payer as Keypair;

    // Sign the ticket with all provided signers
    const signersWithSigs = ethKeypairs.map(kp => this.signTicket(ticket, kp));

    // Convert ticket to program format
    const ticketArg = {
      requestId: ticket.requestId,
      vault: ticket.vault,
      recipient: ticket.recipient,
      amount: ticket.amount,
      expiry: ticket.expiry,
      networkId: ticket.networkId,
    };

    // Convert signatures to program format
    const sigsArg = signersWithSigs.map(s => ({
      signature: Array.from(s.signature),
      recoveryId: s.recoveryId,
    }));

    const tx = await this.program.methods
      .withdrawSol(ticketArg, sigsArg)
      .accounts({
        vault: ticket.vault,
        treasury: treasuryPda,
        recipient: ticket.recipient,
        nonceAccount: noncePda,
        payer: actualPayer.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([actualPayer])
      .rpc();

    const amountSol = ticket.amount.toNumber() / LAMPORTS_PER_SOL;
    console.log(`✅ Withdrew ${amountSol} SOL from vault`);
    console.log(`   Recipient: ${ticket.recipient.toBase58()}`);
    console.log(`   Request ID: ${ticket.requestId.toString()}`);
    console.log(`   Valid Signers: ${signersWithSigs.length}`);
    console.log(`   Transaction: ${tx}`);

    return tx;
  }

  /**
   * Convenience method: Create and execute a withdrawal with current timestamp + duration
   */
  async createAndExecuteWithdrawal(
    recipient: PublicKey,
    amountSol: number,
    requestId: number,
    ethKeypairs: EthereumKeypair[],
    expiryDurationSeconds: number = 3600, // 1 hour default
    networkId: NetworkId = NetworkId.DEVNET,
    payer?: Keypair
  ): Promise<string> {
    const vaultAuthority = this.provider.wallet.publicKey;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiryTimestamp = currentTimestamp + expiryDurationSeconds;

    const ticket = this.createWithdrawalTicket(
      vaultAuthority,
      recipient,
      amountSol,
      requestId,
      expiryTimestamp,
      networkId
    );

    return this.withdrawSol(ticket, ethKeypairs, payer);
  }

  /**
   * Fetch vault account data
   */
  async getVaultData(vaultAuthority: PublicKey) {
    const [vaultPda] = this.getVaultAddress(vaultAuthority);
    const vaultAccount = await this.program.account.vault.fetch(vaultPda);

    const [treasuryPda] = this.getTreasuryAddress(vaultPda);
    const balance = await this.provider.connection.getBalance(treasuryPda);

    return {
      address: vaultPda,
      authority: vaultAccount.authority,
      mThreshold: vaultAccount.mThreshold,
      signers: vaultAccount.signers,
      bump: vaultAccount.bump,
      balanceSol: balance / LAMPORTS_PER_SOL,
      balanceLamports: balance,
    };
  }

  /**
   * Get treasury balance in SOL
   */
  async getTreasuryBalance(vaultAuthority: PublicKey): Promise<number> {
    const [vaultPda] = this.getVaultAddress(vaultAuthority);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);
    const balance = await this.provider.connection.getBalance(treasuryPda);
    return balance / LAMPORTS_PER_SOL;
  }

  /**
   * Check if an Ethereum address is a valid signer for the vault
   */
  async isValidSigner(
    vaultAuthority: PublicKey,
    ethAddress: Uint8Array
  ): Promise<boolean> {
    const vaultData = await this.getVaultData(vaultAuthority);
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

/**
 * Setup function to create a client instance
 */
export function setupClient(authority: Keypair, provider_url: string): MultisigVaultClient {
  const connection = new Connection(provider_url, "confirmed");
  const wallet = new Wallet(authority);

  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });

  const program = new Program(idl, provider) as Program<StrikeExample>;

  return new MultisigVaultClient(program, provider);
}