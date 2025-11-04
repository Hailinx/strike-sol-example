import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import {
  setupClient, 
  loadKeypairFromJson, 
  ANCHOR_WALLET, 
  ANCHOR_PROVIDER_URL, 
  printEnv,
  NetworkId,
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

  let M = 2, N = 5;
  const signers: Keypair[] = await loadOrCreateKeypairs(N_KEYS_PATH, N);
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

  const recipient = signers[0].publicKey;
  const amountSol = 0.5;
  const requestId = Date.now(); // Use timestamp as unique request ID
  const expiryDurationSeconds = 3600; // 1 hour

  // Determine network ID based on provider URL
  let networkId = NetworkId.DEVNET;
  if (ANCHOR_PROVIDER_URL.includes("mainnet")) {
    networkId = NetworkId.MAINNET;
  } else if (ANCHOR_PROVIDER_URL.includes("testnet")) {
    networkId = NetworkId.TESTNET;
  }
  await client.createAndExecuteWithdrawal(
    recipient,
    amountSol,
    requestId,
    [signers[1], signers[2]], // Provide M signatures
    expiryDurationSeconds,
    networkId
  );
}

main().catch(console.error);
