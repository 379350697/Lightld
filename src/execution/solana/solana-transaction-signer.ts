import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { readFile } from 'node:fs/promises';

type SolanaKeypairOptions = {
  keypairPath: string;
  expectedPublicKey?: string;
};

export async function loadSolanaKeypair(options: SolanaKeypairOptions): Promise<Keypair> {
  const raw = (await readFile(options.keypairPath, 'utf8')).trim();
  const parsed = JSON.parse(raw) as unknown;

  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)
  ) {
    throw new Error('Expected a Solana keypair JSON array');
  }

  const bytes = Uint8Array.from(parsed);

  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte Solana keypair, received ${bytes.length}`);
  }

  const keypair = Keypair.fromSecretKey(bytes);

  if (
    options.expectedPublicKey &&
    keypair.publicKey.toBase58() !== options.expectedPublicKey
  ) {
    throw new Error(
      `Keypair public key ${keypair.publicKey.toBase58()} does not match expected ${options.expectedPublicKey}`
    );
  }

  return keypair;
}

export function signSwapTransaction(
  swapTransactionBase64: string,
  keypair: Keypair
): string {
  const transactionBuffer = Buffer.from(swapTransactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(transactionBuffer);
  transaction.sign([keypair]);
  const signed = transaction.serialize();
  return Buffer.from(signed).toString('base64');
}
