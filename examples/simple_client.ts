import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import {
  setupClient, 
  loadKeypairFromJson, 
  ANCHOR_WALLET, 
  ANCHOR_PROVIDER_URL, 
  printEnv,
} from "../src/client";
import { loadOrCreateKeypairs } from "./key_loader";

const N_KEYS_PATH = "./examples/n_test_keys.json";

async function main() {
  printEnv()

  let authority: Keypair;
  try {
    authority = loadKeypairFromJson(ANCHOR_WALLET);
  } catch (err) {
    console.error("Failed to load wallet:", (err as Error).message);
    process.exit(1);
  }
  console.log(`Authority public key: ${authority.publicKey.toBase58()}`);

  const client = setupClient(authority, ANCHOR_PROVIDER_URL);

  let M = 3, N = 5;
  const signers = await loadOrCreateKeypairs(N_KEYS_PATH, N);
  N = signers.length;

  const signersPubKeys = [];
  for (const signer of signers) {
    signersPubKeys.push(signer.publicKey);
    console.log(`signer: ${signer.publicKey.toBase58()}`);
  }

  try {
    const valueData = await client.getVaultData(authority.publicKey);
    console.log(`Vault exist: ${valueData.address.toBase58()}`);
  } catch {
    const { vaultAddress } = await client.initializeForSelf(M, signersPubKeys);
    console.log(`Vault created: ${vaultAddress.toBase58()}`);
  }

  await client.depositSolFromSelf(1.0);

  await client.withdrawSol(
    signers[0].publicKey,
    0.5,           // amount in SOL
    1,             // withdrawal ID
    [signers[0], signers[1], signers[2]]  // provide M signatures
  );
}

main().catch(console.error);
