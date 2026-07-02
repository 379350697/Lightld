import { generateKeyPairSync, sign as signBuffer } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/execution/solana/solana-transaction-signer.ts', () => ({
  signSwapTransaction: vi.fn(() => Buffer.from('residual-swap', 'utf8').toString('base64'))
}));

import { encodeBase58 } from '../../../src/shared/base58';
import { stableStringify } from '../../../src/shared/canonical-json';
import { createSolanaExecutionServer } from '../../../src/execution/solana/solana-execution-server';
import { signedIntentIdempotencyFingerprint } from '../../../src/execution/signed-intent-verifier';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

class FakeTransaction {
  recentBlockhash?: string;
  feePayer?: Keypair['publicKey'];
  signedBy: string[][] = [];

  constructor(private readonly payload: string) {}

  sign(...signers: Keypair[]) {
    this.signedBy.push(signers.map((signer) => signer.publicKey.toBase58()));
  }

  serialize() {
    return Buffer.from(this.payload, 'utf8');
  }
}

type BroadcastSide = 'sell' | 'add-lp' | 'withdraw-lp' | 'claim-fee';

type BroadcastIntentOverrides = Partial<{
  tokenMint: string;
  liquidateResidualTokenToSol: boolean;
  idempotencyKey: string;
  outputSol: number;
  fullPositionExit: boolean;
  openIntentId: string;
  positionId: string;
  chainPositionAddress: string;
}>;

function createIntentSigner() {
  const keypair = generateKeyPairSync('ed25519');
  const spki = Buffer.from(keypair.publicKey.export({
    format: 'der',
    type: 'spki'
  }));

  if (spki.subarray(0, ED25519_SPKI_PREFIX.length).compare(ED25519_SPKI_PREFIX) !== 0) {
    throw new Error('Unexpected Ed25519 public key format');
  }

  const signerId = encodeBase58(spki.subarray(ED25519_SPKI_PREFIX.length));

  return {
    signerId,
    sign(intent: ReturnType<typeof buildIntent>) {
      return {
        intent,
        signerId,
        signedAt: '2026-04-16T00:00:00.000Z',
        signature: signBuffer(
          null,
          Buffer.from(stableStringify(intent), 'utf8'),
          keypair.privateKey
        ).toString('base64')
      };
    }
  };
}

const defaultIntentSigner = createIntentSigner();

function buildIntent(side: BroadcastSide, intentOverrides: BroadcastIntentOverrides = {}) {
  return {
    strategyId: 'new-token-v1',
    poolAddress: 'pool-1',
    outputSol: 0.1,
    createdAt: '2026-04-16T00:00:00.000Z',
    idempotencyKey: `k-${side}`,
    side,
    tokenMint: '',
    fullPositionExit: false,
    liquidateResidualTokenToSol: false,
    ...intentOverrides
  };
}

function buildBroadcastPayload(
  side: BroadcastSide,
  intentOverrides: BroadcastIntentOverrides = {},
  signer = defaultIntentSigner
) {
  const intent = buildIntent(side, intentOverrides);

  return {
    intent: signer.sign(intent)
  };
}

describe('createSolanaExecutionServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('broadcasts every tx returned by Meteora open batches and returns every tracked signature', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const newPositionKeypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('open-1'),
      new FakeTransaction('open-2'),
      new FakeTransaction('open-3')
    ];
    const sent: string[] = [];
    const invalidatePositionSnapshots = vi.fn();

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: transactions as any,
          newPositionKeypair
        }),
        invalidatePositionSnapshots
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp'))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(sent).toEqual(['open-1', 'open-2', 'open-3']);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-3',
      confirmationSignature: 'sig-3',
      submissionIds: ['sig-1', 'sig-2', 'sig-3'],
      confirmationSignatures: ['sig-1', 'sig-2', 'sig-3']
    });
    expect(transactions[0].signedBy[0]).toEqual([
      keypair.publicKey.toBase58(),
      newPositionKeypair.publicKey.toBase58()
    ]);
    expect(invalidatePositionSnapshots).toHaveBeenCalledWith(keypair.publicKey);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"event":"solana-execution-broadcast"');
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"side":"add-lp"');
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"result":"submitted"');
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"buildMs":');
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"blockhashMs":');
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"sendTxMs":[');

    await server.stop();
  });

  it('accepts a canonical signed add-lp intent with lifecycle identity fields', async () => {
    const keypair = Keypair.generate();
    const newPositionKeypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-identity-'));
    const sendRawTransaction = vi.fn(async () => 'sig-identity');
    const signer = createIntentSigner();
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-identity'),
          newPositionKeypair
        }),
        invalidatePositionSnapshots: vi.fn()
      } as any,
      authToken: 'test-token',
      expectedSignerPublicKeys: [signer.signerId]
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'k-add-lp-identity',
        tokenMint: 'mint-identity',
        openIntentId: 'lp-open-intent:identity',
        positionId: 'pool-1:mint-identity',
        chainPositionAddress: 'chain-position-identity'
      }, signer))
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-identity',
      openIntentId: 'lp-open-intent:identity',
      positionId: 'pool-1:mint-identity',
      chainPositionAddress: 'chain-position-identity'
    });

    await server.stop();
    await rm(stateRootDir, { recursive: true, force: true });
  });

  it('rejects a signed add-lp intent when lifecycle identity is changed after signing', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-tamper-'));
    const signer = createIntentSigner();
    const payload = buildBroadcastPayload('add-lp', {
      idempotencyKey: 'k-add-lp-tamper',
      tokenMint: 'mint-identity',
      openIntentId: 'lp-open-intent:identity',
      positionId: 'pool-1:mint-identity',
      chainPositionAddress: 'chain-position-identity'
    }, signer);
    payload.intent.intent.chainPositionAddress = 'chain-position-tampered';
    const sendRawTransaction = vi.fn(async () => 'sig-tamper');
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-tamper')
        })
      } as any,
      authToken: 'test-token',
      expectedSignerPublicKeys: [signer.signerId]
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Signed intent verification failed');
    expect(sendRawTransaction).not.toHaveBeenCalled();

    await server.stop();
    await rm(stateRootDir, { recursive: true, force: true });
  });

  it('returns a failed broadcast and releases idempotency when a sent transaction never becomes visible', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-'));
    let failVisibility = true;
    const sendRawTransactionAndWaitForVisibility = vi.fn(async () => {
      if (failVisibility) {
        throw new Error('Solana transaction was not visible after broadcast attempts; acceptedSignatures=sig-dropped');
      }

      return { signature: 'sig-visible' };
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransactionAndWaitForVisibility,
        sendRawTransaction: async () => 'legacy-sig'
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        }),
        invalidatePositionSnapshots: vi.fn()
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const request = () => fetch(server.origin + '/broadcast', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', { idempotencyKey: 'k-visible-required' }))
    });

    const failedResponse = await request();
    const failedPayload = await failedResponse.json();

    expect(failedResponse.status).toBe(200);
    expect(failedPayload).toMatchObject({
      status: 'failed',
      idempotencyKey: 'k-visible-required',
      retryable: true
    });
    expect(failedPayload.reason).toContain('not visible after broadcast attempts');

    failVisibility = false;
    const retriedResponse = await request();
    const retriedPayload = await retriedResponse.json();

    expect(retriedResponse.status).toBe(200);
    expect(retriedPayload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-visible',
      confirmationSignature: 'sig-visible'
    });
    expect(sendRawTransactionAndWaitForVisibility).toHaveBeenCalledTimes(2);

    await server.stop();
    await rm(stateRootDir, { recursive: true, force: true });
  });
  it('rejects a broadcast when the signed intent signature is invalid before sending transactions', async () => {
    const keypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => 'sig-1');
    const payload = buildBroadcastPayload('add-lp');
    payload.intent.signature = Buffer.from('invalid-signature').toString('base64');

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Signed intent verification failed');
    expect(sendRawTransaction).not.toHaveBeenCalled();

    await server.stop();
  });

  it('rejects a broadcast from a signer outside the allowed signer list before sending transactions', async () => {
    const keypair = Keypair.generate();
    const allowedSigner = createIntentSigner();
    const rejectedSigner = createIntentSigner();
    const sendRawTransaction = vi.fn(async () => 'sig-1');

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token',
      expectedSignerPublicKeys: [allowedSigner.signerId]
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {}, rejectedSigner))
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('not in the allowed signer list');
    expect(sendRawTransaction).not.toHaveBeenCalled();

    await server.stop();
  });

  it('returns the first broadcast result for duplicate idempotency keys without resending transactions', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-'));
    const sent: string[] = [];

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token'
    });

    try {
      await server.start();
      const request = {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildBroadcastPayload('add-lp', {
          idempotencyKey: 'same-key'
        }))
      };

      const firstResponse = await fetch(`${server.origin}/broadcast`, request);
      const firstPayload = await firstResponse.json();
      const secondResponse = await fetch(`${server.origin}/broadcast`, request);
      const secondPayload = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(secondPayload).toEqual(firstPayload);
      expect(sent).toEqual(['open-1']);
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent duplicate idempotency keys before broadcasting transactions', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-'));
    const sent: string[] = [];
    let firstSendStarted: (() => void) | undefined;
    const firstSendStartedPromise = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          firstSendStarted?.();
          await new Promise((resolve) => setTimeout(resolve, 25));
          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token'
    });

    try {
      await server.start();
      const request = {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildBroadcastPayload('add-lp', {
          idempotencyKey: 'same-key'
        }))
      };

      const first = fetch(`${server.origin}/broadcast`, request);
      await firstSendStartedPromise;
      const second = fetch(`${server.origin}/broadcast`, request);
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      const [firstPayload, secondPayload] = await Promise.all([
        firstResponse.json(),
        secondResponse.json()
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(secondPayload).toEqual(firstPayload);
      expect(sent).toEqual(['open-1']);
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate idempotency keys when the signed intent changes', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-'));
    const sent: string[] = [];

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction(`open-${sent.length + 1}`)
        })
      } as any,
      authToken: 'test-token'
    });

    try {
      await server.start();

      const firstResponse = await fetch(`${server.origin}/broadcast`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildBroadcastPayload('add-lp', {
          idempotencyKey: 'same-key',
          outputSol: 0.1
        }))
      });
      const secondResponse = await fetch(`${server.origin}/broadcast`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildBroadcastPayload('add-lp', {
          idempotencyKey: 'same-key',
          outputSol: 0.11
        }))
      });
      const secondPayload = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(409);
      expect(secondPayload.error).toContain('idempotency key conflict');
      expect(sent).toEqual(['open-1']);
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('fails closed without rebroadcasting when an idempotency key is still pending', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-'));
    const payload = buildBroadcastPayload('add-lp', {
      idempotencyKey: 'pending-key'
    });
    const sendRawTransaction = vi.fn(async () => 'sig-1');

    await writeFile(join(stateRootDir, 'solana-execution-submissions.json'), JSON.stringify({
      submissions: [
        {
          idempotencyKey: 'pending-key',
          signedIntentFingerprint: signedIntentIdempotencyFingerprint(payload.intent),
          signedIntent: payload.intent,
          status: 'pending',
          receivedAt: '2026-04-16T00:00:00.000Z',
          updatedAt: '2026-04-16T00:00:00.000Z'
        }
      ]
    }), 'utf8');

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token'
    });

    try {
      await server.start();

      const response = await fetch(`${server.origin}/broadcast`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('idempotency key pending');
      expect(sendRawTransaction).not.toHaveBeenCalled();
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('returns failed and releases idempotency when rpc send fails before visibility', async () => {
    const keypair = Keypair.generate();
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-solana-exec-'));
    const sendRawTransaction = vi.fn(async () => {
      throw new Error('rpc write timeout');
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token'
    });

    try {
      await server.start();
      const request = {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildBroadcastPayload('add-lp', {
          idempotencyKey: 'unknown-send-key'
        }))
      };

      const firstResponse = await fetch(`${server.origin}/broadcast`, request);
      const firstBody = await firstResponse.json();
      const secondResponse = await fetch(`${server.origin}/broadcast`, request);
      const secondBody = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(firstBody).toMatchObject({
        status: 'failed',
        idempotencyKey: 'unknown-send-key',
        reason: 'rpc write timeout'
      });
      expect(secondResponse.status).toBe(200);
      expect(secondBody).toMatchObject({
        status: 'failed',
        idempotencyKey: 'unknown-send-key',
        reason: 'rpc write timeout'
      });
      expect(sendRawTransaction).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('broadcasts every tx returned by Meteora close batches', async () => {
    const keypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('close-1'),
      new FakeTransaction('close-2')
    ];
    const sent: string[] = [];

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        removeLiquidity: async () => transactions as any
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp'))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(sent).toEqual(['close-1', 'close-2']);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-2',
      confirmationSignature: 'sig-2',
      submissionIds: ['sig-1', 'sig-2'],
      confirmationSignatures: ['sig-1', 'sig-2']
    });
    expect(transactions[0].signedBy[0]).toEqual([keypair.publicKey.toBase58()]);

    await server.stop();
  });

  it('passes lifecycle chain position to Meteora close execution', async () => {
    const keypair = Keypair.generate();
    const transactions = [new FakeTransaction('close-1')];
    const removeLiquidity = vi.fn(async () => transactions as any);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async () => 'sig-1'
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        removeLiquidity
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        chainPositionAddress: 'chain-position-1'
      }))
    });

    expect(response.status).toBe(200);
    expect(removeLiquidity).toHaveBeenCalledWith(keypair.publicKey, 'pool-1', 'chain-position-1');

    await server.stop();
  });

  it('does not apply the opening output limit to withdraw-lp exits', async () => {
    const keypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('close-1'),
      new FakeTransaction('close-2')
    ];
    const sent: string[] = [];

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        removeLiquidity: async () => transactions as any
      } as any,
      authToken: 'test-token',
      maxOutputSol: 0.1
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', { outputSol: 0.2 }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(sent).toEqual(['close-1', 'close-2']);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-2',
      confirmationSignature: 'sig-2'
    });

    await server.stop();
  });

  it('waits for withdraw-lp signatures to confirm before checking residual token inventory', async () => {
    const keypair = Keypair.generate();
    const getTokenAccountsByOwner = vi.fn(async (_owner?: string) => [
      {
        pubkey: 'token-account-1',
        account: {
          data: {
            parsed: {
              info: {
                mint: 'earthcoin-mint',
                owner: keypair.publicKey.toBase58(),
                tokenAmount: {
                  amount: '12345',
                  decimals: 6,
                  uiAmount: 0.012345,
                  uiAmountString: '0.012345'
                }
              },
              type: 'account'
            },
            program: 'spl-token'
          }
        }
      }
    ]);
    const getSignatureStatuses = vi.fn(async (_signatures?: string[]) => ({
      value: [
        { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
        { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }
      ]
    }));
    const order: string[] = [];
    const sent: string[] = [];

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        },
        getSignatureStatuses: async (signatures: string[]) => {
          order.push(`status:${signatures.join(',')}`);
          return getSignatureStatuses(signatures);
        },
        getTokenAccountsByOwner: async () => {
          order.push('token-accounts');
          return getTokenAccountsByOwner();
        }
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(() => ({ inputMint: 'earthcoin-mint' })),
        getQuote: vi.fn(async () => ({ routePlan: [], outAmount: String(0.02 * 1_000_000_000) })),
        getSwapTransaction: vi.fn(async () => ({ swapTransaction: 'signed-swap-ignored-by-mock' }))
      } as any,
      dlmmClient: {
        removeLiquidity: async () => [
          new FakeTransaction('close-1'),
          new FakeTransaction('close-2')
        ] as any
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'earthcoin-mint',
        liquidateResidualTokenToSol: true
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionIds: ['sig-1', 'sig-2', 'sig-3']
    });
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
    expect(getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['status:sig-1,sig-2', 'token-accounts', 'token-accounts']);
    expect(sent).toEqual(['close-1', 'close-2', 'residual-swap']);

    await server.stop();
  });

  it('uses same-pool Meteora direct swap for residual token liquidation before Jupiter', async () => {
    const keypair = Keypair.generate();
    const residualTokenAccount = {
      pubkey: 'token-account-1',
      account: {
        data: {
          parsed: {
            info: {
              mint: 'earthcoin-mint',
              owner: keypair.publicKey.toBase58(),
              tokenAmount: {
                amount: '12345',
                decimals: 6,
                uiAmount: 0.012345,
                uiAmountString: '0.012345'
              }
            },
            type: 'account'
          },
          program: 'spl-token'
        }
      }
    };
    const getTokenAccountsByOwner = vi.fn(async () =>
      getTokenAccountsByOwner.mock.calls.length === 1 ? [] : [residualTokenAccount]
    );
    const sent: string[] = [];
    const getQuote = vi.fn();
    const swapTokenToSol = vi.fn(async () => ({
      transaction: new FakeTransaction('meteora-direct-residual'),
      outAmountLamports: '9000',
      minOutAmountLamports: '8500',
      consumedInAmountLamports: '12345',
      provider: 'meteora-dlmm-direct'
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        },
        getSignatureStatuses: async () => ({
          value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }]
        }),
        getTokenAccountsByOwner
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(),
        getQuote,
        getSwapTransaction: vi.fn()
      } as any,
      dlmmClient: {
        removeLiquidity: async () => [new FakeTransaction('close-1')] as any,
        swapTokenToSol,
        invalidatePositionSnapshots: vi.fn()
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'earthcoin-mint',
        liquidateResidualTokenToSol: true
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionIds: ['sig-1', 'sig-2']
    });
    expect(swapTokenToSol).toHaveBeenCalledWith(
      keypair.publicKey,
      'pool-1',
      'earthcoin-mint',
      '12345',
      expect.any(Number)
    );
    expect(getQuote).not.toHaveBeenCalled();
    expect(getTokenAccountsByOwner).toHaveBeenCalledTimes(3);
    expect(sent).toEqual(['close-1', 'meteora-direct-residual']);

    await server.stop();
  });

  it('uses same-pool Meteora direct swap for full sell exits before Jupiter', async () => {
    const keypair = Keypair.generate();
    const sent: string[] = [];
    const getQuote = vi.fn();
    const swapTokenToSol = vi.fn(async () => ({
      transaction: new FakeTransaction('meteora-direct-sell'),
      outAmountLamports: '9000',
      minOutAmountLamports: '8500',
      consumedInAmountLamports: '12345',
      provider: 'meteora-dlmm-direct'
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        },
        getTokenAccountsByOwner: async () => [
          {
            pubkey: 'token-account-1',
            account: {
              data: {
                parsed: {
                  info: {
                    mint: 'earthcoin-mint',
                    owner: keypair.publicKey.toBase58(),
                    tokenAmount: {
                      amount: '12345',
                      decimals: 6,
                      uiAmount: 0.012345,
                      uiAmountString: '0.012345'
                    }
                  },
                  type: 'account'
                },
                program: 'spl-token'
              }
            }
          }
        ]
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(),
        getQuote,
        getSwapTransaction: vi.fn()
      } as any,
      dlmmClient: {
        swapTokenToSol
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('sell', {
        tokenMint: 'earthcoin-mint',
        fullPositionExit: true
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionIds: ['sig-1']
    });
    expect(swapTokenToSol).toHaveBeenCalledWith(
      keypair.publicKey,
      'pool-1',
      'earthcoin-mint',
      '12345',
      expect.any(Number)
    );
    expect(getQuote).not.toHaveBeenCalled();
    expect(sent).toEqual(['meteora-direct-sell']);

    await server.stop();
  });

  it('waits for claim-fee tx visibility before selling claimed non-SOL fees', async () => {
    const keypair = Keypair.generate();
    const getSignatureStatuses = vi.fn(async () => ({
      value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }]
    }));
    const getTokenAccountsByOwner = vi.fn(async () => [
      {
        pubkey: 'token-account-1',
        account: {
          data: {
            parsed: {
              info: {
                mint: 'earthcoin-mint',
                owner: keypair.publicKey.toBase58(),
                tokenAmount: {
                  amount: '12345',
                  decimals: 6,
                  uiAmount: 0.012345,
                  uiAmountString: '0.012345'
                }
              },
              type: 'account'
            },
            program: 'spl-token'
          }
        }
      }
    ]);
    const sent: string[] = [];

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        },
        getSignatureStatuses,
        getTokenAccountsByOwner
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(() => ({ inputMint: 'earthcoin-mint' })),
        getQuote: vi.fn(async () => ({ routePlan: [], outAmount: String(0.02 * 1_000_000_000) })),
        getSwapTransaction: vi.fn(async () => ({ swapTransaction: 'signed-swap-ignored-by-mock' }))
      } as any,
      dlmmClient: {
        claimFee: async () => [new FakeTransaction('claim-1')] as any
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('claim-fee', {
        tokenMint: 'earthcoin-mint',
        liquidateResidualTokenToSol: true
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionIds: ['sig-1', 'sig-2']
    });
    expect(getSignatureStatuses).toHaveBeenCalledWith(['sig-1']);
    expect(getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(['claim-1', 'residual-swap']);

    await server.stop();
  });

  it('keeps withdraw-lp submitted when residual liquidation quote fails after close tx is visible', async () => {
    const keypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => 'sig-close');
    const getTokenAccountsByOwner = vi.fn(async () => [
      {
        pubkey: 'token-account-1',
        account: {
          data: {
            parsed: {
              info: {
                mint: 'earthcoin-mint',
                owner: keypair.publicKey.toBase58(),
                tokenAmount: {
                  amount: '12345',
                  decimals: 6,
                  uiAmount: 0.012345,
                  uiAmountString: '0.012345'
                }
              },
              type: 'account'
            },
            program: 'spl-token'
          }
        }
      }
    ]);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction,
        getSignatureStatuses: async () => ({
          value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }]
        }),
        getTokenAccountsByOwner
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(() => ({ inputMint: 'earthcoin-mint' })),
        getQuote: vi.fn(async () => {
          throw new Error('residual quote unavailable');
        })
      } as any,
      dlmmClient: {
        removeLiquidity: async () => [new FakeTransaction('close-1')] as any,
        invalidatePositionSnapshots: vi.fn()
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const request = () => fetch(server.origin + '/broadcast', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'earthcoin-mint',
        liquidateResidualTokenToSol: true
      }))
    });

    const firstResponse = await request();
    const firstPayload = await firstResponse.json();
    const replayResponse = await request();
    const replayPayload = await replayResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstPayload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-close',
      submissionIds: ['sig-close'],
      batchStatus: 'complete',
      mainExecutionStatus: 'confirmed',
      residualSweepStatus: 'incomplete',
      residualUnsoldMints: ['earthcoin-mint']
    });
    expect(firstPayload.reason).toContain('residual quote unavailable');
    expect(replayResponse.status).toBe(200);
    expect(replayPayload).toMatchObject(firstPayload);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(getTokenAccountsByOwner).toHaveBeenCalled();

    await server.stop();
  });

  it('keeps withdraw-lp submitted when only residual dust remains after the close tx is visible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => 'sig-close');
    const getTokenAccountsByOwner = vi.fn(async () => [
      {
        pubkey: 'token-account-dust',
        account: {
          data: {
            parsed: {
              info: {
                mint: 'dust-mint',
                owner: keypair.publicKey.toBase58(),
                tokenAmount: {
                  amount: '9',
                  decimals: 6,
                  uiAmount: 0.000009,
                  uiAmountString: '0.000009'
                }
              },
              type: 'account'
            },
            program: 'spl-token'
          }
        }
      }
    ]);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction,
        getSignatureStatuses: async () => ({
          value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }]
        }),
        getTokenAccountsByOwner
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(() => ({ inputMint: 'dust-mint' })),
        getQuote: vi.fn(async () => {
          throw new Error('amount below minimum');
        })
      } as any,
      dlmmClient: {
        removeLiquidity: async () => [new FakeTransaction('close-1')] as any,
        invalidatePositionSnapshots: vi.fn()
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(server.origin + '/broadcast', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'dust-mint',
        liquidateResidualTokenToSol: true
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-close',
      submissionIds: ['sig-close'],
      mainExecutionStatus: 'confirmed',
      batchStatus: 'complete',
      residualSweepStatus: 'dust_ignored',
      residualIgnoredMints: ['dust-mint']
    });
    expect(payload.reason).toContain('residual_dust_ignored');
    expect(payload.reason).not.toContain('residual token sweep incomplete');
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(getTokenAccountsByOwner).toHaveBeenCalled();

    await server.stop();
  });

  it('keeps withdraw-lp submitted when residual sweep leaves a non-SOL token unsold', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const sent: string[] = [];
    const invalidatePositionSnapshots = vi.fn();
    const getTokenAccountsByOwner = vi.fn(async () => [
      {
        pubkey: 'token-account-target',
        account: {
          data: {
            parsed: {
              info: {
                mint: 'earthcoin-mint',
                owner: keypair.publicKey.toBase58(),
                tokenAmount: {
                  amount: '12345',
                  decimals: 6,
                  uiAmount: 0.012345,
                  uiAmountString: '0.012345'
                }
              },
              type: 'account'
            },
            program: 'spl-token'
          }
        }
      },
      {
        pubkey: 'token-account-stale',
        account: {
          data: {
            parsed: {
              info: {
                mint: 'stale-mint',
                owner: keypair.publicKey.toBase58(),
                tokenAmount: {
                  amount: '98765',
                  decimals: 6,
                  uiAmount: 0.098765,
                  uiAmountString: '0.098765'
                }
              },
              type: 'account'
            },
            program: 'spl-token'
          }
        }
      }
    ]);
    const buildSellQuoteParams = vi.fn((mint: string, amount: number) => ({ inputMint: mint, amount }));
    const getQuote = vi.fn(async (params: { inputMint: string }) => {
      if (params.inputMint === 'stale-mint') {
        throw new Error('stale quote unavailable');
      }

      return { routePlan: [], outAmount: String(0.02 * 1_000_000_000) };
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          return `sig-${sent.length}`;
        },
        getSignatureStatuses: async () => ({
          value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }]
        }),
        getTokenAccountsByOwner
      } as any,
      jupiterClient: {
        buildSellQuoteParams,
        getQuote,
        getSwapTransaction: vi.fn(async () => ({ swapTransaction: 'signed-swap-ignored-by-mock' }))
      } as any,
      dlmmClient: {
        removeLiquidity: async () => [new FakeTransaction('close-1')] as any,
        invalidatePositionSnapshots
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(server.origin + '/broadcast', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'earthcoin-mint',
        liquidateResidualTokenToSol: true
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-2',
      submissionIds: ['sig-1', 'sig-2'],
      batchStatus: 'complete',
      mainExecutionStatus: 'confirmed',
      residualSweepStatus: 'incomplete',
      residualUnsoldMints: ['stale-mint']
    });
    expect(payload.reason).toContain('residual token sweep incomplete: stale-mint');
    expect(payload.reason).toContain('stale quote unavailable');
    expect(sent).toEqual(['close-1', 'residual-swap']);
    expect(buildSellQuoteParams).not.toHaveBeenCalled();
    expect(getQuote).toHaveBeenCalledWith(expect.objectContaining({
      inputMint: 'earthcoin-mint',
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: '12345'
    }));
    expect(getQuote).toHaveBeenCalledWith(expect.objectContaining({
      inputMint: 'stale-mint',
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: '98765'
    }));
    expect(invalidatePositionSnapshots).toHaveBeenCalledWith(keypair.publicKey);

    await server.stop();
  });

  it('serves account-state with Token-2022 balances and currentValueSol on walletTokens', async () => {
    const keypair = Keypair.generate();
    const getQuote = vi.fn(async () => ({ outAmount: String(0.18 * 1_000_000_000), routePlan: [] }));
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2 * 1_000_000_000,
        getTokenAccountsByOwner: async () => [
          {
            pubkey: 'token-account-2022',
            account: {
              data: {
                parsed: {
                  info: {
                    mint: 'token-2022-mint',
                    owner: keypair.publicKey.toBase58(),
                    tokenAmount: {
                      amount: '2500000',
                      decimals: 6,
                      uiAmount: 2.5,
                      uiAmountString: '2.5'
                    }
                  },
                  type: 'account'
                },
                program: 'spl-token-2022'
              }
            }
          }
        ]
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn((mint: string, amount: number) => ({ mint, amount })),
        getQuote
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/account-state`, {
      headers: {
        authorization: 'Bearer test-token'
      }
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.walletSol).toBe(2);
    expect(payload.walletTokens).toEqual([
      expect.objectContaining({
        mint: 'token-2022-mint',
        amount: 2.5,
        currentValueSol: 0.18
      })
    ]);
    expect(payload.journalTokens).toEqual(payload.walletTokens);

    const secondResponse = await fetch(`${server.origin}/account-state`, {
      headers: {
        authorization: 'Bearer test-token'
      }
    });
    const secondPayload = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(secondPayload.walletTokens).toEqual(payload.walletTokens);
    expect(getQuote).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it('returns retryable service unavailable when account-state balance read fails', async () => {
    const keypair = Keypair.generate();
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => {
          throw new Error('fetch failed');
        },
        getTokenAccountsByOwner: async () => []
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(),
        getQuote: vi.fn()
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/account-state`, {
      headers: {
        authorization: 'Bearer test-token'
      }
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      error: 'account-state unavailable',
      reason: 'fetch failed'
    });

    await server.stop();
  });

  it('serves wallet LP positions with withdraw-simulation plus quote-only exit valuation', async () => {
    const keypair = Keypair.generate();
    const buildSellQuoteParams = vi.fn((mint: string, amount: number) => ({ mint, amount }));
    const getQuote = vi.fn(async () => ({ outAmount: String(0.02 * 1_000_000_000), routePlan: [] }));
    const quoteTokenToSol = vi.fn(async () => ({
      providerName: 'meteora-dlmm-quote-only' as const,
      valueSol: 0.02,
      trust: 'exit_quote' as const,
      source: 'meteora-dlmm-swap-quote'
    }));
    const getPositionSnapshots = vi.fn(async () => [{
      poolAddress: 'pool-lp-1',
      positionAddress: 'position-lp-1',
      mint: 'earthcoin-mint',
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 130,
      binCount: 69,
      fundedBinCount: 2,
      solSide: 'tokenX' as const,
      solDepletedBins: 30,
      currentValueSol: undefined,
      withdrawSolAmount: 0.08,
      withdrawTokenAmountLamports: 123456,
      withdrawTokenAmountRaw: '123456',
      withdrawTokenMint: 'earthcoin-mint',
      unclaimedFeeSol: 0.001,
      unclaimedFeeSolAmount: 0.001,
      unclaimedFeeTokenAmountLamports: 0,
      unclaimedFeeTokenAmountRaw: '0',
      recoverableRentSol: 0.057416045,
      positionStatus: 'active' as const,
      hasLiquidity: true,
      hasClaimableFees: true,
      valuationStatus: 'unavailable' as const,
      valuationReason: 'withdraw-token-quote-required',
      valuationSource: 'meteora-withdraw-simulation'
    }]);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2 * 1_000_000_000,
        getTokenAccountsByOwner: async () => []
      } as any,
      jupiterClient: {
        buildSellQuoteParams,
        getQuote,
      } as any,
      dlmmClient: { getPositionSnapshots } as any,
      valuationProviderChain: { quoteTokenToSol } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(server.origin + '/account-state', {
      headers: {
        authorization: 'Bearer test-token'
      }
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.walletLpPositions).toEqual([
      expect.objectContaining({
        poolAddress: 'pool-lp-1',
        positionAddress: 'position-lp-1',
        mint: 'earthcoin-mint',
        withdrawSolAmount: 0.08,
        withdrawTokenAmountLamports: 123456,
        withdrawTokenAmountRaw: '123456',
        withdrawTokenValueSol: 0.02,
        liquidityValueSol: 0.1,
        unclaimedFeeValueSol: 0.001,
        claimedFeeValueSol: 0,
        recoverableRentSol: 0.057416045,
        lpTotalValueSol: 0.158416045,
        exitQuoteValueSol: 0.158416045,
        displayValueSol: 0.158416045,
        valuationTrust: 'exit_quote',
        currentValueSol: 0.158416045,
        valuationStatus: 'ready',
        valuationReason: '',
        valuationCompleteness: 'complete',
        valuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote+position-account-rent'
      })
    ]);
    expect(payload.journalLpPositions).toEqual(payload.walletLpPositions);
    expect(buildSellQuoteParams).not.toHaveBeenCalled();
    expect(getQuote).not.toHaveBeenCalled();
    expect(quoteTokenToSol).toHaveBeenCalledWith(expect.objectContaining({
      inputMint: 'earthcoin-mint',
      amountLamports: '123456',
      poolAddress: 'pool-lp-1'
    }));
    expect(getPositionSnapshots).toHaveBeenCalledWith(keypair.publicKey);

    await server.stop();
  });

  it('does not downgrade LP exit valuation when only withdraw token market value is dust', async () => {
    const keypair = Keypair.generate();
    const quoteTokenToSol = vi.fn(async () => ({
      valueSol: 0.00000000058,
      source: 'jupiter-price-v3',
      trust: 'market_price'
    }));
    const getPositionSnapshots = vi.fn(async () => [{
      poolAddress: 'pool-lp-1',
      positionAddress: 'position-lp-1',
      mint: 'earthcoin-mint',
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 130,
      binCount: 69,
      fundedBinCount: 2,
      solSide: 'tokenX' as const,
      solDepletedBins: 30,
      withdrawSolAmount: 0.08,
      withdrawTokenAmountLamports: 61,
      withdrawTokenAmountRaw: '61',
      withdrawTokenMint: 'earthcoin-mint',
      unclaimedFeeSol: 0.000000009,
      unclaimedFeeSolAmount: 0.000000009,
      unclaimedFeeTokenAmountLamports: 0,
      unclaimedFeeTokenAmountRaw: '0',
      recoverableRentSol: 0.057416045,
      positionStatus: 'active' as const,
      hasLiquidity: true,
      hasClaimableFees: true,
      valuationStatus: 'unavailable' as const,
      valuationReason: 'withdraw-token-quote-required',
      valuationSource: 'meteora-withdraw-simulation'
    }]);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2 * 1_000_000_000,
        getTokenAccountsByOwner: async () => []
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(),
        getQuote: vi.fn(),
      } as any,
      dlmmClient: { getPositionSnapshots } as any,
      valuationProviderChain: { quoteTokenToSol } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(server.origin + '/account-state', {
      headers: {
        authorization: 'Bearer test-token'
      }
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.walletLpPositions).toEqual([
      expect.objectContaining({
        liquidityValueSol: 0.08000000058000001,
        unclaimedFeeValueSol: 0.000000009,
        lpTotalValueSol: 0.13741605458,
        exitQuoteValueSol: 0.13741605458,
        displayValueSol: 0.13741605458,
        valuationTrust: 'exit_quote',
        valuationStatus: 'ready',
        valuationReason: '',
        valuationCompleteness: 'complete',
        valuationSource: 'meteora-withdraw-simulation+token-dust-jupiter-price-v3+position-account-rent'
      })
    ]);
    expect(quoteTokenToSol).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it('does not downgrade LP exit valuation when only fee token market value is dust', async () => {
    const keypair = Keypair.generate();
    const quoteTokenToSol = vi.fn(async ({ amountLamports }: { amountLamports: string }) => {
      if (amountLamports === '123456') {
        return {
          valueSol: 0.02,
          source: 'meteora-dlmm-swap-quote',
          trust: 'exit_quote'
        };
      }

      return {
        valueSol: 0.00000001,
        source: 'dexscreener-pair',
        trust: 'market_price'
      };
    });
    const getPositionSnapshots = vi.fn(async () => [{
      poolAddress: 'pool-lp-1',
      positionAddress: 'position-lp-1',
      mint: 'earthcoin-mint',
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 130,
      binCount: 69,
      fundedBinCount: 2,
      solSide: 'tokenX' as const,
      solDepletedBins: 30,
      withdrawSolAmount: 0.08,
      withdrawTokenAmountLamports: 123456,
      withdrawTokenAmountRaw: '123456',
      withdrawTokenMint: 'earthcoin-mint',
      unclaimedFeeSol: 0,
      unclaimedFeeSolAmount: 0,
      unclaimedFeeTokenAmountLamports: 12,
      unclaimedFeeTokenAmountRaw: '12',
      unclaimedFeeTokenMint: 'earthcoin-mint',
      recoverableRentSol: 0.057416045,
      positionStatus: 'active' as const,
      hasLiquidity: true,
      hasClaimableFees: true,
      valuationStatus: 'unavailable' as const,
      valuationReason: 'withdraw-token-quote-required',
      valuationSource: 'meteora-withdraw-simulation'
    }]);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2 * 1_000_000_000,
        getTokenAccountsByOwner: async () => []
      } as any,
      jupiterClient: {
        buildSellQuoteParams: vi.fn(),
        getQuote: vi.fn(),
      } as any,
      dlmmClient: { getPositionSnapshots } as any,
      valuationProviderChain: { quoteTokenToSol } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(server.origin + '/account-state', {
      headers: {
        authorization: 'Bearer test-token'
      }
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.walletLpPositions).toEqual([
      expect.objectContaining({
        liquidityValueSol: 0.1,
        unclaimedFeeValueSol: 0.00000001,
        lpTotalValueSol: 0.157416055,
        exitQuoteValueSol: 0.157416055,
        displayValueSol: 0.157416055,
        valuationTrust: 'exit_quote',
        valuationStatus: 'ready',
        valuationReason: '',
        valuationCompleteness: 'complete',
        valuationSource: 'meteora-withdraw-simulation+meteora-dlmm-swap-quote+fee-dust-dexscreener-pair+position-account-rent'
      })
    ]);
    expect(quoteTokenToSol).toHaveBeenCalledTimes(2);

    await server.stop();
  });

  it('keeps DLMM pool-price LP valuation when Jupiter exit valuation is unavailable', async () => {
    const keypair = Keypair.generate();
    const buildSellQuoteParams = vi.fn((mint: string, amount: number) => ({ mint, amount }));
    const getQuote = vi.fn(async () => {
      throw new Error('No RPC endpoint available for jupiter');
    });
    const getPositionSnapshots = vi.fn(async () => [{
      poolAddress: 'pool-lp-1',
      positionAddress: 'position-lp-1',
      mint: 'earthcoin-mint',
      lowerBinId: 100,
      upperBinId: 168,
      activeBinId: 130,
      binCount: 69,
      fundedBinCount: 2,
      solSide: 'tokenX' as const,
      solDepletedBins: 30,
      currentValueSol: 0.11,
      withdrawSolAmount: 0.08,
      withdrawTokenAmountLamports: 123456,
      withdrawTokenAmountRaw: '123456',
      withdrawTokenMint: 'earthcoin-mint',
      withdrawTokenValueSol: 0.03,
      unclaimedFeeSol: 0.001,
      unclaimedFeeSolAmount: 0.001,
      unclaimedFeeTokenAmountLamports: 0,
      unclaimedFeeTokenAmountRaw: '0',
      positionStatus: 'active' as const,
      hasLiquidity: true,
      hasClaimableFees: true,
      valuationStatus: 'ready' as const,
      valuationReason: '',
      valuationSource: 'meteora-withdraw-simulation+dlmm-active-bin-price-fallback'
    }]);

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2 * 1_000_000_000,
        getTokenAccountsByOwner: async () => []
      } as any,
      jupiterClient: {
        buildSellQuoteParams,
        getQuote,
      } as any,
      dlmmClient: { getPositionSnapshots } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(server.origin + '/account-state', {
      headers: {
        authorization: 'Bearer test-token'
      }
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.walletLpPositions).toEqual([
      expect.objectContaining({
        poolAddress: 'pool-lp-1',
        positionAddress: 'position-lp-1',
        mint: 'earthcoin-mint',
        withdrawTokenValueSol: 0.03,
        currentValueSol: 0.111,
        liquidityValueSol: 0.11,
        unclaimedFeeValueSol: 0.001,
        lpTotalValueSol: 0.111,
        displayValueSol: 0.111,
        valuationStatus: 'stale',
        valuationReason: 'valuation-not-exit-quote:meteora-withdraw-simulation+dlmm-active-bin-price-fallback',
        valuationCompleteness: 'untrusted',
        valuationTrust: 'fallback_display',
        valuationSource: 'meteora-withdraw-simulation+dlmm-active-bin-price-fallback'
      })
    ]);
    expect(payload.journalLpPositions).toEqual(payload.walletLpPositions);
    expect(buildSellQuoteParams).not.toHaveBeenCalled();
    expect(getQuote).not.toHaveBeenCalled();

    await server.stop();
  });

  it('preserves already accepted Meteora batch signatures when a later tx send fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('batch-1'),
      new FakeTransaction('batch-2'),
      new FakeTransaction('batch-3')
    ];
    const sent: string[] = [];
    const invalidatePositionSnapshots = vi.fn();

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async (base64: string) => {
          sent.push(Buffer.from(base64, 'base64').toString('utf8'));
          if (sent.length === 2) {
            throw new Error('rpc rejected tx 2');
          }

          return `sig-${sent.length}`;
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        removeLiquidity: async () => transactions as any,
        invalidatePositionSnapshots
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp'))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(sent).toEqual(['batch-1', 'batch-2']);
    expect(payload).toMatchObject({
      status: 'submitted',
      submissionId: 'sig-1',
      confirmationSignature: 'sig-1',
      submissionIds: ['sig-1'],
      confirmationSignatures: ['sig-1'],
      batchStatus: 'partial'
    });
    expect(String(payload.reason)).toContain('rpc rejected tx 2');
    expect(invalidatePositionSnapshots).toHaveBeenCalledWith(keypair.publicKey);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"event":"solana-execution-broadcast"');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"side":"withdraw-lp"');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"result":"partial"');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"acceptedSignatureCount":1');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('rpc rejected tx 2');

    await server.stop();
  });

  it('logs a structured error when broadcast fails before any signature is accepted', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: async () => {
          throw new Error('rpc send failed immediately');
        }
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        removeLiquidity: async () => [new FakeTransaction('close-1')] as any
      } as any,
      authToken: 'test-token'
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp'))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'failed',
      reason: 'rpc send failed immediately'
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"event":"solana-execution-broadcast"');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"side":"withdraw-lp"');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"result":"failed"');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"acceptedSignatureCount":0');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('rpc send failed immediately');

    await server.stop();
  });
});
