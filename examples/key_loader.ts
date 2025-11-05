import { promises as fs } from "fs";
import * as path from "path";
import { MultisigVaultClient, EthereumKeypair } from "../src/client";

interface StoredEthKeypair {
  privateKey: string; // hex string
  address: string;    // hex string (0x prefixed)
}

export async function loadOrCreateEthKeypairs(
  filePath: string,
  n: number
): Promise<EthereumKeypair[]> {
  try {
    const raw = await fs.readFile(filePath, { encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse JSON from ${filePath}: ${(err as Error).message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid format: expected JSON array in ${filePath}`);
    }

    const keypairs: EthereumKeypair[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || !entry.privateKey || !entry.address) {
        throw new Error(`Invalid keypair entry in ${filePath}`);
      }
      const stored = entry as StoredEthKeypair;
      const kp = MultisigVaultClient.loadEthereumKeypair(stored.privateKey);
      keypairs.push(kp);
    }

    if (keypairs.length === 0) {
      throw new Error(`No keypairs found in ${filePath}`);
    }

    console.log(`Loaded ${keypairs.length} Ethereum keypair(s) from ${filePath}`);
    return keypairs;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`${filePath} not found — generating ${n} new Ethereum keypair(s) and saving to file.`);
      const gens: EthereumKeypair[] = [];
      const toStore: StoredEthKeypair[] = [];
      
      for (let i = 0; i < n; i++) {
        const kp = MultisigVaultClient.generateEthereumKeypair();
        gens.push(kp);
        
        const privateKeyHex = Buffer.from(kp.privateKey).toString("hex");
        const addressHex = "0x" + Buffer.from(kp.address).toString("hex");
        
        toStore.push({
          privateKey: privateKeyHex,
          address: addressHex,
        });
        
        console.log(`Generated Ethereum signer with address: ${addressHex}`);
      }

      const dir = path.dirname(filePath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (mkdirErr) {
        // ignore
      }

      const payload = JSON.stringify(toStore, null, 2);
      await fs.writeFile(filePath, payload, { mode: 0o600 });
      console.log(`Saved ${gens.length} Ethereum keypair(s) to ${filePath} (permissions 0o600)`);

      return gens;
    }

    throw err;
  }
}