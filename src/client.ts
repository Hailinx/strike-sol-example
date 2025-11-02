import * as fs from "fs";
import * as path from "path";
import os from "os";
import dotenv from "dotenv";

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, Connection, PublicKey, Transaction, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { StrikeExample } from "../target/types/strike_example";
import idl from "../target/idl/strike_example.json";

dotenv.config();

export const ENV = process.env;
export const ANCHOR_WALLET = ENV.ANCHOR_WALLET || "~/.config/solana/id.json";
export const ANCHOR_PROVIDER_URL = ENV.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = ENV.PROGRAM_ID;

export function printEnv() {
  console.log("ANCHOR_PROVIDER_URL =", ANCHOR_PROVIDER_URL);
  console.log("ANCHOR_WALLET =", ANCHOR_WALLET);
  console.log("PROGRAM_ID =", PROGRAM_ID);
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

    console.log(`✅ Deposited ${amountSol} SOL to vault`);
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
   * Withdraw SOL from the vault with multisig approval
   */
  async withdrawSol(
    recipient: PublicKey,
    amountSol: number,
    withdrawalId: number,
    signers: Keypair[]
  ): Promise<string> {
    const [vaultPda] = this.getVaultAddress(this.provider.wallet.publicKey);
    const [treasuryPda] = this.getTreasuryAddress(vaultPda);
    const amountLamports = amountSol * LAMPORTS_PER_SOL;

    // Build remaining accounts for signers
    const remainingAccounts = signers.map((signer) => ({
      pubkey: signer.publicKey,
      isWritable: false,
      isSigner: true,
    }));

    const tx = await this.program.methods
      .withdrawSol(
        new BN(amountLamports),
        new BN(withdrawalId),
      )
      .accounts({
        vault: vaultPda,
        treasury: treasuryPda,
        recipient: recipient,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(remainingAccounts)
      .signers(signers)
      .rpc();

    console.log(`✅ Withdrew ${amountSol} SOL from vault`);
    console.log(`   Recipient: ${recipient.toBase58()}`);
    console.log(`   Signers: ${signers.length}`);
    console.log(`   Transaction: ${tx}`);

    return tx;
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
   * Check if an account is a valid signer for the vault
   */
  async isValidSigner(
    vaultAuthority: PublicKey,
    signer: PublicKey
  ): Promise<boolean> {
    const vaultData = await this.getVaultData(vaultAuthority);
    return vaultData.signers.some((s) => s.equals(signer));
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
