import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalLiveSignerServer } from '../../../src/execution/local-live-signer-server';

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

describe('createLocalLiveSignerServer', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('serves authenticated signing requests and exposes a health endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-signer-server-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const server = createLocalLiveSignerServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'test-token',
      keypairPath: keypair.path,
      expectedPublicKey: keypair.publicKey
    });

    await server.start();

    const healthResponse = await fetch(`${server.origin}/health`);
    const signResponse = await fetch(`${server.origin}/sign`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token'
      },
      body: JSON.stringify({
        intent: {
          strategyId: 'new-token-v1',
          poolAddress: 'pool-1',
          outputSol: 0.1,
          createdAt: '2026-03-24T00:00:00.000Z',
          idempotencyKey: 'new-token-v1:pool-1:2026-03-24T00:00:00.000Z'
        }
      })
    });

    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      status: 'ok',
      signerId: keypair.publicKey,
      publicKey: keypair.publicKey
    });

    expect(signResponse.status).toBe(200);
    await expect(signResponse.json()).resolves.toMatchObject({
      signerId: keypair.publicKey,
      signature: expect.any(String)
    });

    await server.stop();
  });

  it('rejects signing requests without the expected bearer token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-signer-auth-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const server = createLocalLiveSignerServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'test-token',
      keypairPath: keypair.path,
      expectedPublicKey: keypair.publicKey
    });

    await server.start();

    const response = await fetch(`${server.origin}/sign`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        intent: {
          strategyId: 'new-token-v1',
          poolAddress: 'pool-1',
          outputSol: 0.1,
          createdAt: '2026-03-24T00:00:00.000Z',
          idempotencyKey: 'new-token-v1:pool-1:2026-03-24T00:00:00.000Z'
        }
      })
    });

    expect(response.status).toBe(401);
    await server.stop();
  });
});
