import * as fs from "fs";
import * as path from "path";
import os from "os";
import dotenv from "dotenv";
import nacl from "tweetnacl";
import * as crypto from "crypto";

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { 
  Keypair, 
  Connection, 
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
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

export interface SignerWithSignature {
  hash: Buffer,
  pubkey: PublicKey;
  signature: Buffer;
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
   * Initialize a new multisig vault
   */
  async initialize(
    authority: Keypair,
    mThreshold: number,
    signers: PublicKey[]
  ): Promise<{ signature: string; vaultAddress: PublicKey }> {
    const [vaultPda] = this.getVaultAddress(authority.publicKey);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);

    const tx = await this.program.methods
      .initialize(mThreshold, signers)
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
    console.log(`   M-of-N: ${mThreshold} of ${signers.length}`);

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
    signers: PublicKey[]
  ): Promise<{ signature: string; vaultAddress: PublicKey }> {
    const authority = (this.provider.wallet as any).payer as Keypair;
    return this.initialize(authority, mThreshold, signers);
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
   * Create a withdrawal ticket hash for signing
   */
  createTicketHash(ticket: WithdrawalTicket): Buffer {
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
    
    // Hash using Solana's hash function (SHA-256)
    return crypto.createHash("sha256").update(combined).digest();
  }

  /**
   * Sign a withdrawal ticket with a keypair
   */
  signTicket(ticket: WithdrawalTicket, signer: Keypair): SignerWithSignature {
    const messageHash = this.createTicketHash(ticket);
    const signature = nacl.sign.detached(messageHash, signer.secretKey);
    
    return {
      hash: Buffer.from(messageHash),
      pubkey: signer.publicKey,
      signature: Buffer.from(signature),
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
    signers: Keypair[],
    payer?: Keypair
  ): Promise<string> {
    const [treasuryPda] = this.getTreasuryAddress(ticket.vault);
    const [noncePda] = this.getNonceAddress(ticket.vault, ticket.requestId);
    
    const actualPayer = payer || (this.provider.wallet as any).payer as Keypair;

    // Sign the ticket with all provided signers
    const signersWithSigs = signers.map(signer => this.signTicket(ticket, signer));

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
      pubkey: s.pubkey,
      signature: Array.from(s.signature),
    }));

    const edIxs = signersWithSigs.map(s => 
      Ed25519Program.createInstructionWithPublicKey({
        publicKey: s.pubkey.toBytes(),
        message: s.hash,
        signature: s.signature,
      })
    );

    const tx = await this.program.methods
      .withdrawSol(ticketArg, sigsArg)
      .accounts({
        vault: ticket.vault,
        treasury: treasuryPda,
        recipient: ticket.recipient,
        nonceAccount: noncePda,
        payer: actualPayer.publicKey,
        systemProgram: SystemProgram.programId,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY
      } as any)
      .preInstructions(edIxs)
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
    signers: Keypair[],
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

    return this.withdrawSol(ticket, signers, payer);
  }

  /**
   * Fetch vault account data
   */
  async getVaultData(vaultAuthority: PublicKey) {
    const [vaultPda] = this.getVaultAddress(vaultAuthority);
    const vaultAccount = await this.program.account.vault.fetch(vaultPda);

    const balance = await this.provider.connection.getBalance(vaultPda);

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
   * Get vault balance in SOL
   */
  async getVaultBalance(vaultAuthority: PublicKey): Promise<number> {
    const [vaultPda] = this.getVaultAddress(vaultAuthority);
    const balance = await this.provider.connection.getBalance(vaultPda);
    return balance / LAMPORTS_PER_SOL;
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
   * Check if an account is a valid signer for the vault
   */
  async isValidSigner(
    vaultAuthority: PublicKey,
    signer: PublicKey
  ): Promise<boolean> {
    const vaultData = await this.getVaultData(vaultAuthority);
    return vaultData.signers.some((s) => s.equals(signer));
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

  // parsed should be an array of numbers (secret key)
  if (!Array.isArray(parsed)) {
    // Some files include an object like {"_keypair": { "secretKey": [...] } }
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