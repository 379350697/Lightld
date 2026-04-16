import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HttpLiveBroadcaster } from '../../../src/execution/http-live-broadcaster';
import { HttpLiveConfirmationProvider } from '../../../src/execution/http-live-confirmation-provider';
import { LocalLiveSigner } from '../../../src/execution/local-live-signer';
import { createLocalLiveExecutionServer } from '../../../src/execution/local-live-execution-server';
import { buildOrderIntent } from '../../../src/execution/order-intent-builder';
import { HttpLiveAccountStateProvider } from '../../../src/runtime/live-account-provider';

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

describe('createLocalLiveExecutionServer', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('serves broadcast, confirmation, and account-state contracts through the existing HTTP adapters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-execution-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const signer = new LocalLiveSigner({
      keypairPath: keypair.path,
      expectedPublicKey: keypair.publicKey
    });
    const accountStatePath = join(root, 'account-state.json');

    await writeFile(accountStatePath, JSON.stringify({
      walletSol: 1.25,
      journalSol: 1.25,
      walletLpPositions: [
        { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe' }
      ],
      journalLpPositions: [
        { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe' }
      ],
      walletTokens: [
        { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
      ],
      journalTokens: [
        { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
      ],
      fills: []
    }), 'utf8');

    const server = createLocalLiveExecutionServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'test-token',
      stateRootDir: join(root, 'execution-state'),
      accountStatePath,
      expectedSignerPublicKeys: [keypair.publicKey],
      autoFinalizeAfterMs: 0
    });

    await server.start();

    const signedIntent = await signer.sign(buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-03-24T00:00:00.000Z'
    }));
    const broadcaster = new HttpLiveBroadcaster({
      url: `${server.origin}/broadcast`,
      authToken: 'test-token'
    });
    const confirmationProvider = new HttpLiveConfirmationProvider({
      url: `${server.origin}/confirmation`,
      authToken: 'test-token'
    });
    const accountProvider = new HttpLiveAccountStateProvider({
      url: `${server.origin}/account-state`,
      authToken: 'test-token'
    });

    const broadcast = await broadcaster.broadcast(signedIntent);
    expect(broadcast.status).toBe('submitted');

    if (broadcast.status !== 'submitted') {
      throw new Error('expected submitted broadcast');
    }

    await expect(confirmationProvider.poll({
      submissionId: broadcast.submissionId,
      confirmationSignature: broadcast.confirmationSignature
    })).resolves.toMatchObject({
      submissionId: broadcast.submissionId,
      confirmationSignature: broadcast.confirmationSignature,
      status: 'confirmed',
      finality: 'finalized'
    });

    await expect(accountProvider.readState()).resolves.toEqual({
      walletSol: 1.25,
      journalSol: 1.25,
      walletLpPositions: [
        { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe' }
      ],
      journalLpPositions: [
        { poolAddress: 'pool-1', positionAddress: 'pos-1', mint: 'mint-safe' }
      ],
      walletTokens: [
        { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
      ],
      journalTokens: [
        { mint: 'mint-safe', symbol: 'SAFE', amount: 2 }
      ],
      fills: []
    });

    await server.stop();
  });

  it('accepts LP-capable action intents through the broadcast contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-execution-lp-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const signer = new LocalLiveSigner({
      keypairPath: keypair.path,
      expectedPublicKey: keypair.publicKey
    });
    const server = createLocalLiveExecutionServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'test-token',
      stateRootDir: join(root, 'execution-state'),
      expectedSignerPublicKeys: [keypair.publicKey]
    });

    await server.start();

    const signedIntent = await signer.sign(buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      side: 'add-lp'
    }));
    const broadcaster = new HttpLiveBroadcaster({
      url: `${server.origin}/broadcast`,
      authToken: 'test-token'
    });

    const broadcast = await broadcaster.broadcast(signedIntent);

    expect(broadcast.status).toBe('submitted');

    await server.stop();
  });

  it('rejects unauthorized broadcast requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-local-execution-auth-'));
    directories.push(root);
    const keypair = await createSolanaKeypairFile(root);
    const signer = new LocalLiveSigner({
      keypairPath: keypair.path,
      expectedPublicKey: keypair.publicKey
    });
    const server = createLocalLiveExecutionServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'test-token',
      stateRootDir: join(root, 'execution-state'),
      expectedSignerPublicKeys: [keypair.publicKey]
    });

    await server.start();

    const signedIntent = await signer.sign(buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1
    }));

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        intent: signedIntent
      })
    });

    expect(response.status).toBe(401);
    await server.stop();
  });
});
