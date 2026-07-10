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

  it('dry-runs Meteora open batches through simulation without sending transactions', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const transactions = [
      new FakeTransaction('open-1'),
      new FakeTransaction('open-2')
    ];
    const simulated: string[] = [];
    const sendRawTransaction = vi.fn(async () => 'unexpected-live-signature');
    const simulateRawTransaction = vi.fn(async (base64: string) => {
      simulated.push(Buffer.from(base64, 'base64').toString('utf8'));
      return { value: { err: null, logs: ['simulation ok'] } };
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction,
        simulateRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: transactions as any
        }),
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const healthResponse = await fetch(`${server.origin}/health`);
    const health = await healthResponse.json();
    expect(health).toMatchObject({ status: 'ok', dryRun: true });

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
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(simulated).toEqual(['open-1', 'open-2']);
    expect(payload).toMatchObject({
      status: 'submitted',
      idempotencyKey: 'k-add-lp',
      mainExecutionStatus: 'confirmed',
      reason: 'paper-dry-run-simulated',
      batchStatus: 'complete'
    });
    expect(payload.chainPositionAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
    expect(payload.submissionIds).toHaveLength(2);
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"dryRun":true');
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('"reason":"paper-dry-run-simulated"');

    const accountResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const account = await accountResponse.json();

    expect(account.walletSol).toBe(999_999.9);
    expect(account.walletLpPositions).toEqual([
      expect.objectContaining({
        poolAddress: 'pool-1',
        positionAddress: payload.chainPositionAddress,
        chainPositionAddress: payload.chainPositionAddress,
        mint: 'pool-1',
        currentValueSol: 0.1,
        valuationSource: 'paper-dry-run-overlay'
      })
    ]);

    await server.stop();
  });

  it('marks paper LP positions to live DLMM active-bin value before account-state and close', async () => {
    const keypair = Keypair.generate();
    const newPositionKeypair = Keypair.generate();
    const simulateRawTransaction = vi.fn(async () => ({ value: { err: null, logs: ['ok'] } }));
    const getPoolPriceSnapshot = vi.fn(async () => ({
      poolAddress: 'pool-1',
      activeBinId: 134,
      binStep: 100,
      tokenXMint: 'So11111111111111111111111111111111111111112',
      tokenYMint: 'earthcoin-mint',
      tokenXIsSol: true,
      tokenYIsSol: false,
      solSide: 'tokenX' as const,
      currentPrice: 1
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(async () => 'unexpected-live-signature'),
        simulateRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1'),
          newPositionKeypair,
          activeBinId: 100,
          lowerBinId: 100,
          upperBinId: 168,
          binSlippageBps: 100,
          solSide: 'tokenX' as const
        }),
        getPoolPriceSnapshot,
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const openResponse = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'dry-run-mark-to-market',
        outputSol: 1,
        tokenMint: 'earthcoin-mint'
      }))
    });
    const openPayload = await openResponse.json();

    expect(openPayload).toMatchObject({
      status: 'submitted',
      chainPositionAddress: newPositionKeypair.publicKey.toBase58(),
      activeBinIdAtBuild: 100,
      lowerBinIdAtBuild: 100,
      upperBinIdAtBuild: 168
    });

    const accountResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const account = await accountResponse.json();

    expect(account.walletLpPositions).toEqual([
      expect.objectContaining({
        chainPositionAddress: newPositionKeypair.publicKey.toBase58(),
        currentValueSol: 1.09,
        withdrawSolAmount: 1.09,
        unclaimedFeeValueSol: 0,
        claimedFeeValueSol: 0,
        recoverableRentSol: 0,
        exitQuoteValueSol: 1.09,
        activeBinId: 134,
        lowerBinId: 100,
        upperBinId: 168,
        solDepletedBins: 34,
        valuationSource: 'paper-shadow-dlmm-active-bin'
      })
    ]);
    expect(account.fills).toEqual([
      expect.objectContaining({
        side: 'add-lp',
        mint: 'earthcoin-mint',
        chainPositionAddress: newPositionKeypair.publicKey.toBase58(),
        amount: 1,
        actualFilledSol: 1,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true
      })
    ]);
    expect(account.walletSol).toBe(999_999);

    const closeResponse = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        idempotencyKey: 'dry-run-mark-to-market-close',
        outputSol: 1,
        tokenMint: 'earthcoin-mint',
        chainPositionAddress: newPositionKeypair.publicKey.toBase58()
      }))
    });
    const closePayload = await closeResponse.json();

    expect(closePayload).toMatchObject({
      status: 'submitted',
      reason: 'paper-dry-run-simulated',
      chainPositionAddress: newPositionKeypair.publicKey.toBase58()
    });

    const closedAccountResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const closedAccount = await closedAccountResponse.json();

    expect(closedAccount.walletLpPositions).toEqual([]);
    expect(closedAccount.walletSol).toBe(1_000_000.09);
    expect(getPoolPriceSnapshot).toHaveBeenCalledWith('pool-1');
    expect(simulateRawTransaction).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it('does not mark SOL-side above-range paper LP positions below entry value', async () => {
    const keypair = Keypair.generate();
    const newPositionKeypair = Keypair.generate();
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(),
        simulateRawTransaction: vi.fn(async () => ({ value: { err: null, logs: ['ok'] } }))
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-token-y-sol'),
          newPositionKeypair,
          activeBinId: 168,
          lowerBinId: 100,
          upperBinId: 168,
          binSlippageBps: 100,
          solSide: 'tokenY' as const
        }),
        getPoolPriceSnapshot: async () => ({
          poolAddress: 'pool-1',
          activeBinId: 180,
          binStep: 100,
          tokenXMint: 'earthcoin-mint',
          tokenYMint: 'So11111111111111111111111111111111111111112',
          tokenXIsSol: false,
          tokenYIsSol: true,
          solSide: 'tokenY' as const,
          currentPrice: 1
        }),
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    try {
      await fetch(`${server.origin}/broadcast`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(buildBroadcastPayload('add-lp', {
          idempotencyKey: 'dry-run-token-y-sol',
          outputSol: 1,
          tokenMint: 'earthcoin-mint'
        }))
      });

      const accountResponse = await fetch(`${server.origin}/account-state`, {
        headers: { authorization: 'Bearer test-token' }
      });
      const account = await accountResponse.json();

      expect(account.walletLpPositions[0]).toMatchObject({
        chainPositionAddress: newPositionKeypair.publicKey.toBase58(),
        solSide: 'tokenY',
        activeBinId: 180,
        lowerBinId: 100,
        upperBinId: 168,
        valuationSource: 'paper-shadow-dlmm-active-bin'
      });
      expect(account.walletLpPositions[0].currentValueSol).toBeGreaterThanOrEqual(1);
    } finally {
      await server.stop();
    }
  });

  it('backfills historical paper LP build ranges from submitted add-lp evidence before valuation', async () => {
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-backfill-'));
    const keypair = Keypair.generate();
    const signedIntent = defaultIntentSigner.sign(buildIntent('add-lp', {
      idempotencyKey: 'historical-open',
      outputSol: 1,
      tokenMint: 'earthcoin-mint',
      openIntentId: 'open-1',
      positionId: 'pool-1:earthcoin-mint'
    }));

    await writeFile(join(stateRootDir, 'paper-dry-run-state.json'), JSON.stringify({
      version: 1,
      walletSolDelta: -1,
      positions: [{
        poolAddress: 'pool-1',
        positionAddress: 'paper-position-1',
        chainPositionAddress: 'paper-position-1',
        positionId: 'pool-1:earthcoin-mint',
        openIntentId: 'open-1',
        mint: 'earthcoin-mint',
        currentValueSol: 1,
        openedAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z'
      }]
    }));
    await writeFile(join(stateRootDir, 'solana-execution-submissions.json'), JSON.stringify({
      submissions: [{
        idempotencyKey: 'historical-open',
        signedIntentFingerprint: 'historical-open-fingerprint',
        signedIntent,
        status: 'submitted',
        result: {
          status: 'submitted',
          submissionId: 'dry-run-sig',
          idempotencyKey: 'historical-open',
          confirmationSignature: 'dry-run-sig',
          submissionIds: ['dry-run-sig'],
          confirmationSignatures: ['dry-run-sig'],
          batchStatus: 'complete',
          reason: 'paper-dry-run-simulated',
          mainExecutionStatus: 'confirmed',
          openIntentId: 'open-1',
          positionId: 'pool-1:earthcoin-mint',
          chainPositionAddress: 'paper-position-1',
          activeBinIdAtBuild: 100,
          lowerBinIdAtBuild: 100,
          upperBinIdAtBuild: 168,
          binSlippageBps: 100
        },
        receivedAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z'
      }]
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(),
        simulateRawTransaction: vi.fn()
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        getPoolPriceSnapshot: async () => ({
          poolAddress: 'pool-1',
          activeBinId: 134,
          binStep: 100,
          tokenXMint: 'So11111111111111111111111111111111111111112',
          tokenYMint: 'earthcoin-mint',
          tokenXIsSol: true,
          tokenYIsSol: false,
          solSide: 'tokenX' as const,
          currentPrice: 1
        }),
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    try {
      const accountResponse = await fetch(`${server.origin}/account-state`, {
        headers: { authorization: 'Bearer test-token' }
      });
      const account = await accountResponse.json();

      expect(account.walletLpPositions).toEqual([
        expect.objectContaining({
          chainPositionAddress: 'paper-position-1',
          currentValueSol: 1.09,
          activeBinId: 134,
          lowerBinId: 100,
          upperBinId: 168,
          solSide: 'tokenX',
          valuationSource: 'paper-shadow-dlmm-active-bin'
        })
      ]);
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('marks paper LP valuation unavailable when open bin side evidence is missing', async () => {
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-missing-side-'));
    const keypair = Keypair.generate();
    await writeFile(join(stateRootDir, 'paper-dry-run-state.json'), JSON.stringify({
      version: 1,
      walletSolDelta: -1,
      positions: [{
        poolAddress: 'pool-1',
        positionAddress: 'paper-position-missing-side',
        chainPositionAddress: 'paper-position-missing-side',
        positionId: 'pool-1:earthcoin-mint',
        openIntentId: 'open-missing-side',
        mint: 'earthcoin-mint',
        currentValueSol: 1,
        openedAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z'
      }]
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      stateRootDir,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(),
        simulateRawTransaction: vi.fn()
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        getPoolPriceSnapshot: async () => ({
          poolAddress: 'pool-1',
          activeBinId: 180,
          binStep: 100,
          tokenXMint: 'earthcoin-mint',
          tokenYMint: 'So11111111111111111111111111111111111111112',
          tokenXIsSol: false,
          tokenYIsSol: true,
          solSide: 'tokenY' as const,
          currentPrice: 1
        }),
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    try {
      const accountResponse = await fetch(`${server.origin}/account-state`, {
        headers: { authorization: 'Bearer test-token' }
      });
      const account = await accountResponse.json();

      expect(account.walletLpPositions[0]).toMatchObject({
        chainPositionAddress: 'paper-position-missing-side',
        valuationStatus: 'unavailable',
        valuationReason: 'paper-open-bin-evidence-missing',
        valuationSource: 'paper-dry-run-overlay'
      });
    } finally {
      await server.stop();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it('uses an effectively unlimited paper SOL balance for dry-run account state', async () => {
    const keypair = Keypair.generate();
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 181_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(async () => 'unexpected-live-signature'),
        simulateRawTransaction: vi.fn(async () => ({
          value: {
            err: { InstructionError: [1, { Custom: 1 }] },
            logs: ['Transfer: insufficient lamports 181000000, need 1000000000']
          }
        }))
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        }),
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const beforeResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const beforeAccount = await beforeResponse.json();

    expect(beforeAccount.walletSol).toBeGreaterThan(100_000);

    await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'dry-run-paper-unlimited-sol',
        outputSol: 1
      }))
    });

    const afterResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const afterAccount = await afterResponse.json();

    expect(afterAccount.walletSol).toBeGreaterThan(100_000);

    await server.stop();
  });

  it('keeps dry-run account state paper-only even when the real wallet is unavailable', async () => {
    const keypair = Keypair.generate();
    const getBalance = vi.fn(async () => {
      throw new Error('real wallet balance should not gate paper mode');
    });
    const getTokenAccountsByOwner = vi.fn(async () => {
      throw new Error('real wallet tokens should not gate paper mode');
    });
    const getPositionSnapshots = vi.fn(async () => {
      throw new Error('real wallet LP positions should not gate paper mode');
    });
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance,
        getTokenAccountsByOwner,
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(async () => 'unexpected-live-signature'),
        simulateRawTransaction: vi.fn(async () => ({ value: { err: null, logs: ['ok'] } }))
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        getPositionSnapshots
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const response = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const account = await response.json();

    expect(response.status).toBe(200);
    expect(account.walletSol).toBe(1_000_000);
    expect(account.walletTokens).toEqual([]);
    expect(account.walletLpPositions).toEqual([]);
    expect(getBalance).not.toHaveBeenCalled();
    expect(getTokenAccountsByOwner).not.toHaveBeenCalled();
    expect(getPositionSnapshots).not.toHaveBeenCalled();

    await server.stop();
  });

  it('closes dry-run overlay LP positions without touching live send', async () => {
    const keypair = Keypair.generate();
    const newPositionKeypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => 'unexpected-live-signature');
    const simulateRawTransaction = vi.fn(async () => ({ value: { err: null, logs: ['ok'] } }));
    const removeLiquidity = vi.fn(async () => {
      throw new Error('paper close should not require a live Meteora position');
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 2_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction,
        simulateRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1'),
          newPositionKeypair
        }),
        removeLiquidity,
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const openResponse = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        tokenMint: 'earthcoin-mint',
        idempotencyKey: 'dry-run-open-close'
      }))
    });
    const openPayload = await openResponse.json();

    expect(openPayload.chainPositionAddress).toBe(newPositionKeypair.publicKey.toBase58());

    const closeResponse = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'earthcoin-mint',
        idempotencyKey: 'dry-run-close',
        chainPositionAddress: openPayload.chainPositionAddress
      }))
    });
    const closePayload = await closeResponse.json();

    expect(closePayload).toMatchObject({
      status: 'submitted',
      mainExecutionStatus: 'confirmed',
      reason: 'paper-dry-run-simulated',
      chainPositionAddress: openPayload.chainPositionAddress
    });
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(removeLiquidity).not.toHaveBeenCalled();

    const accountResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const account = await accountResponse.json();

    expect(account.walletSol).toBe(1_000_000);
    expect(account.walletLpPositions).toEqual([]);

    const alreadyClosedResponse = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('withdraw-lp', {
        tokenMint: 'earthcoin-mint',
        idempotencyKey: 'dry-run-close-retry',
        chainPositionAddress: openPayload.chainPositionAddress
      }))
    });
    const alreadyClosedPayload = await alreadyClosedResponse.json();

    expect(alreadyClosedPayload).toMatchObject({
      status: 'submitted',
      mainExecutionStatus: 'confirmed',
      reason: 'paper-dry-run-position-already-closed',
      chainPositionAddress: openPayload.chainPositionAddress
    });
    expect(removeLiquidity).not.toHaveBeenCalled();

    await server.stop();
  });

  it('returns failed and does not send when dry-run simulation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const keypair = Keypair.generate();
    const sendRawTransaction = vi.fn(async () => 'unexpected-live-signature');
    const simulateRawTransaction = vi.fn(async () => ({
      value: {
        err: { InstructionError: [1, { Custom: 1 }] },
        logs: [
          'Program log: Error Code: InsufficientFunds',
          'Program failed: custom program error: 0x1'
        ]
      }
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction,
        simulateRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => ({
          transaction: new FakeTransaction('open-1')
        })
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'dry-run-sim-failed'
      }))
    });

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      status: 'failed',
      idempotencyKey: 'dry-run-sim-failed',
      retryable: true
    });
    expect(payload.reason).toContain('Solana dry-run simulation failed');
    expect(payload.reason).toContain('InsufficientFunds');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"dryRun":true');

    await server.stop();
  });

  it('rebuilds a dry-run add-lp once when DLMM bin slippage moves before simulation', async () => {
    const keypair = Keypair.generate();
    const firstPositionKeypair = Keypair.generate();
    const secondPositionKeypair = Keypair.generate();
    const addLiquidityByStrategy = vi.fn()
      .mockResolvedValueOnce({
        transaction: new FakeTransaction('open-stale-bin'),
        newPositionKeypair: firstPositionKeypair
      })
      .mockResolvedValueOnce({
        transaction: new FakeTransaction('open-refreshed-bin'),
        newPositionKeypair: secondPositionKeypair
      });
    const simulated: string[] = [];
    const simulateRawTransaction = vi.fn(async (base64: string) => {
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      simulated.push(decoded);
      if (decoded === 'open-stale-bin') {
        return {
          value: {
            err: { InstructionError: [6, { Custom: 6004 }] },
            logs: [
              'Program log: Error Code: ExceededBinSlippageTolerance',
              'Program failed: custom program error: 0x1774'
            ]
          }
        };
      }
      return { value: { err: null, logs: ['simulation ok after rebuild'] } };
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 1_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(async () => 'unexpected-live-signature'),
        simulateRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy,
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'dry-run-bin-rebuild',
        tokenMint: 'earthcoin-mint'
      }))
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(addLiquidityByStrategy).toHaveBeenCalledTimes(2);
    expect(simulated).toEqual(['open-stale-bin', 'open-refreshed-bin']);
    expect(payload).toMatchObject({
      status: 'submitted',
      reason: 'paper-dry-run-simulated',
      rebuildAttemptCount: 1,
      chainPositionAddress: secondPositionKeypair.publicKey.toBase58()
    });

    const accountResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const account = await accountResponse.json();

    expect(account.walletLpPositions).toEqual([
      expect.objectContaining({
        chainPositionAddress: secondPositionKeypair.publicKey.toBase58(),
        valuationSource: 'paper-dry-run-overlay'
      })
    ]);

    await server.stop();
  });

  it('keeps a repeated dry-run bin slippage failure as not submitted with structured reason', async () => {
    const keypair = Keypair.generate();
    const addLiquidityByStrategy = vi.fn(async () => ({
      transaction: new FakeTransaction('open-bin-slippage')
    }));
    const simulateRawTransaction = vi.fn(async () => ({
      value: {
        err: { InstructionError: [6, { Custom: 6004 }] },
        logs: [
          'Program log: Error Code: ExceededBinSlippageTolerance',
          'Program failed: custom program error: 0x1774'
        ]
      }
    }));

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 1_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction: vi.fn(async () => 'unexpected-live-signature'),
        simulateRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy,
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'dry-run-bin-rebuild-fails',
        tokenMint: 'earthcoin-mint'
      }))
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(addLiquidityByStrategy).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({
      status: 'failed',
      idempotencyKey: 'dry-run-bin-rebuild-fails',
      retryable: true,
      executionFailureKind: 'dlmm_bin_slippage',
      executionFailureOperation: 'rpc-simulate',
      rebuildAttemptCount: 1
    });
    expect(payload.reason).toContain('rpc-simulate-dlmm-bin-slippage');
    expect(payload.reason).toContain('ExceededBinSlippageTolerance');

    const accountResponse = await fetch(`${server.origin}/account-state`, {
      headers: { authorization: 'Bearer test-token' }
    });
    const account = await accountResponse.json();
    expect(account.walletLpPositions).toEqual([]);

    await server.stop();
  });

  it('classifies live add-lp bin slippage failures without rebuilding or submitting a second attempt', async () => {
    const keypair = Keypair.generate();
    const addLiquidityByStrategy = vi.fn(async () => ({
      transaction: new FakeTransaction('open-live-bin-slippage')
    }));
    const sendRawTransaction = vi.fn(async () => {
      throw new Error('Solana RPC sendTransaction error: Transaction simulation failed: custom program error: 0x1774 ExceededBinSlippageTolerance');
    });

    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getBalance: async () => 1_000_000_000,
        getTokenAccountsByOwner: async () => [],
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } }),
        sendRawTransaction
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy,
        getPositionSnapshots: async () => []
      } as any,
      authToken: 'test-token',
      dryRun: false
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'live-bin-slippage',
        tokenMint: 'earthcoin-mint'
      }))
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(addLiquidityByStrategy).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      status: 'failed',
      idempotencyKey: 'live-bin-slippage',
      executionFailureKind: 'dlmm_bin_slippage',
      executionFailureOperation: 'rpc-send',
      rebuildAttemptCount: 0,
      targetCooldownMs: 300_000
    });
    expect(payload.reason).toContain('rpc-send-dlmm-bin-slippage');

    await server.stop();
  });

  it('classifies DLMM build fetch failures by operation instead of returning a bare fetch failed', async () => {
    const keypair = Keypair.generate();
    const server = createSolanaExecutionServer({
      host: '127.0.0.1',
      port: 0,
      keypair,
      rpcClient: {
        getLatestBlockhash: async () => ({ value: { blockhash: 'blockhash-1', lastValidBlockHeight: 1 } })
      } as any,
      jupiterClient: {} as any,
      dlmmClient: {
        addLiquidityByStrategy: async () => {
          throw new TypeError('fetch failed');
        }
      } as any,
      authToken: 'test-token',
      dryRun: true
    });

    await server.start();

    const response = await fetch(`${server.origin}/broadcast`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildBroadcastPayload('add-lp', {
        idempotencyKey: 'dry-run-build-fetch-failed',
        tokenMint: 'earthcoin-mint'
      }))
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'failed',
      idempotencyKey: 'dry-run-build-fetch-failed',
      executionFailureKind: 'fetch_failed',
      executionFailureOperation: 'dlmm-build'
    });
    expect(payload.reason).toBe('dlmm-build-fetch-failed: fetch failed');

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
