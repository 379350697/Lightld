import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalLiveSigner } from '../../../src/execution/local-live-signer';
import { buildOrderIntent } from '../../../src/execution/order-intent-builder';

function base64UrlToBuffer(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function encodeBase58(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  if (bytes.length === 0) {
    return '';
  }

  const digits = [0];

  for (const value of bytes) {
    let carry = value;

    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let output = '';

  for (const value of bytes) {
    if (value !== 0) {
      break;
    }

    output += alphabet[0];
  }

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += alphabet[digits[index]];
  }

  return output;
}

async function createSolanaKeypairFile(rootDir: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwkPrivate = privateKey.export({ format: 'jwk' }) as JsonWebKey;
  const jwkPublic = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const secretKey = [
    ...base64UrlToBuffer(jwkPrivate.d!),
    ...base64UrlToBuffer(jwkPublic.x!)
  ];
  const path = join(rootDir, 'id.json');

  await writeFile(path, JSON.stringify(secretKey), 'utf8');

  return {
    path,
    publicKey: encodeBase58(base64UrlToBuffer(jwkPublic.x!))
  };
}

describe('LocalLiveSigner', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('loads a Solana keypair file and signs a live order intent deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-signer-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const signer = new LocalLiveSigner({
      keypairPath: keypair.path,
      expectedPublicKey: keypair.publicKey
    });
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-24T00:00:00.000Z'
    });

    const first = await signer.sign(intent);
    const second = await signer.sign(intent);

    expect(first.signerId).toBe(keypair.publicKey);
    expect(first.signature).toBe(second.signature);
    expect(first.intent).toEqual(intent);
  });

  it('rejects a keypair file that does not match the expected public key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-signer-mismatch-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const signer = new LocalLiveSigner({
      keypairPath: keypair.path,
      expectedPublicKey: '11111111111111111111111111111111'
    });
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1
    });

    await expect(signer.sign(intent)).rejects.toThrow('does not match expected public key');
  });
});
