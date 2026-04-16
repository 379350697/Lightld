import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSolanaExecutionServer } from '../../../src/execution/solana/solana-execution-server';

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

function buildBroadcastPayload(side: 'add-lp' | 'withdraw-lp' | 'claim-fee') {
  return {
    intent: {
      intent: {
        strategyId: 'new-token-v1',
        poolAddress: 'pool-1',
        outputSol: 0.1,
        createdAt: '2026-04-16T00:00:00.000Z',
        idempotencyKey: `k-${side}`,
        side
      },
      signerId: 'signer-1',
      signedAt: '2026-04-16T00:00:00.000Z',
      signature: 'sig'
    }
  };
}

describe('createSolanaExecutionServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('broadcasts every tx returned by Meteora open batches and returns every tracked signature', async () => {
    const keypair = Keypair.generate();
    const newPositionKeypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('open-1'),
      new FakeTransaction('open-2'),
      new FakeTransaction('open-3')
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
        addLiquidityByStrategy: async () => ({
          transaction: transactions as any,
          newPositionKeypair
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

    await server.stop();
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

  it('preserves already accepted Meteora batch signatures when a later tx send fails', async () => {
    const keypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('batch-1'),
      new FakeTransaction('batch-2'),
      new FakeTransaction('batch-3')
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
          if (sent.length === 2) {
            throw new Error('rpc rejected tx 2');
          }

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

    await server.stop();
  });
});
