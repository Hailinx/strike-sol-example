import { Keypair } from "@solana/web3.js";
import { promises as fs } from "fs";
import * as path from "path";

export async function loadOrCreateKeypairs(
  filePath: string,
  n: number
): Promise<Keypair[]> {
  const isValidSecretArray = (arr: any): arr is number[] =>
    Array.isArray(arr) &&
    arr.length >= 32 &&
    arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);

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

    const keypairs: Keypair[] = [];
    for (const entry of parsed) {
      if (!isValidSecretArray(entry)) {
        throw new Error(`Invalid secret key entry found in ${filePath}. Each entry must be an array of numbers (bytes).`);
      }
      const secret = Uint8Array.from(entry);
      const kp = Keypair.fromSecretKey(secret);
      keypairs.push(kp);
    }

    if (keypairs.length === 0) {
      throw new Error(`No keypairs found in ${filePath}`);
    }

    console.log(`Loaded ${keypairs.length} keypair(s) from ${filePath}`);
    return keypairs;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`${filePath} not found — generating ${n} new keypair(s) and saving to file.`);
      const gens: Keypair[] = [];
      for (let i = 0; i < n; i++) {
        const signer = Keypair.generate();
        gens.push(signer);
        console.log(`create mock signer with public key: ${signer.publicKey.toBase58()}`);
      }

      const dir = path.dirname(filePath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (mkdirErr) {
        // ignore
      }

      const payload = JSON.stringify(
        gens.map((kp) => Array.from(kp.secretKey)),
        null,
        2
      );

      await fs.writeFile(filePath, payload, { mode: 0o600 });
      console.log(`Saved ${gens.length} keypair(s) to ${filePath} (permissions 0o600)`);

      return gens;
    }

    throw err;
  }
}
