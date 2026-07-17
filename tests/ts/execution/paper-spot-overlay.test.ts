import { generateKeyPairSync, sign as signBuffer } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSolanaExecutionServer } from '../../../src/execution/solana/solana-execution-server';
import { SOL_MINT } from '../../../src/execution/solana/jupiter-client';
import { encodeBase58 } from '../../../src/shared/base58';
import { stableStringify } from '../../../src/shared/canonical-json';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function createIntentSigner() {
  const keypair = generateKeyPairSync('ed25519');
  const spki = Buffer.from(keypair.publicKey.export({ format: 'der', type: 'spki' }));
  const signerId = encodeBase58(spki.subarray(ED25519_SPKI_PREFIX.length));
  return {
    sign(intent: Record<string, unknown>) {
      return {
        intent,
        signerId,
        signedAt: '2026-07-17T00:00:00.000Z',
        signature: signBuffer(
          null,
          Buffer.from(stableStringify(intent), 'utf8'),
          keypair.privateKey
        ).toString('base64')
      };
    }
  };
}

function buildPayload(input: {
  side: 'buy' | 'sell';
  idempotencyKey: string;
  inputAmountRaw?: string;
}) {
  const signer = createIntentSigner();
  const intent = {
    strategyId: 'large-pool-v1',
    poolAddress: 'paper-pool-1',
    outputSol: 0.1,
    createdAt: '2026-07-17T00:00:00.000Z',
    idempotencyKey: input.idempotencyKey,
    executionPolicy: 'simulate-only' as const,
    side: input.side,
    tokenMint: 'paper-token-1',
    fullPositionExit: input.side === 'sell',
    liquidateResidualTokenToSol: false,
    openIntentId: 'paper-open-1',
    positionId: 'paper-position-1',
    ...(input.inputAmountRaw ? { inputAmountRaw: input.inputAmountRaw } : {})
  };
  return { intent: signer.sign(intent) };
}

function buildWithdrawPayload(chainPositionAddress: string, positionId = 'paper-lp-position-1') {
  const signer = createIntentSigner();
  return {
    intent: signer.sign({
      strategyId: 'new-token-v1',
      poolAddress: 'paper-pool-1',
      outputSol: 0.1,
      createdAt: '2026-07-17T00:00:00.000Z',
      idempotencyKey: `paper-withdraw-${chainPositionAddress}`,
      executionPolicy: 'simulate-only',
      side: 'withdraw-lp',
      tokenMint: 'paper-token-1',
      fullPositionExit: true,
      liquidateResidualTokenToSol: false,
      positionId,
      chainPositionAddress
    })
  };
}

function makeDryRunServer(input: {
  stateRootDir: string;
  executeExactIn: ReturnType<typeof vi.fn>;
  quoteExactIn: ReturnType<typeof vi.fn>;
  getTokenAccountsByOwner: ReturnType<typeof vi.fn>;
}) {
  return createSolanaExecutionServer({
    host: '127.0.0.1',
    port: 0,
    stateRootDir: input.stateRootDir,
    keypair: Keypair.generate(),
    rpcClient: {
      getBalance: vi.fn(async () => 123_000_000),
      getTokenAccountsByOwner: input.getTokenAccountsByOwner,
      simulateRawTransaction: vi.fn(async () => ({ value: { err: null, logs: ['paper simulation ok'] } })),
      sendRawTransaction: vi.fn(async () => 'must-not-send')
    } as any,
    jupiterClient: {} as any,
    swapProviderChain: {
      executeExactIn: input.executeExactIn,
      quoteExactIn: input.quoteExactIn
    } as any,
    authToken: 'paper-test-token',
    dryRun: true
  });
}

async function postBroadcast(origin: string, payload: unknown) {
  const response = await fetch(`${origin}/broadcast`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer paper-test-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

async function readAccount(origin: string) {
  const response = await fetch(`${origin}/account-state`, {
    headers: { authorization: 'Bearer paper-test-token' }
  });
  return { response, body: await response.json() };
}

describe('paper spot token overlay', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('persists a simulated buy, revalues it, closes it, and applies each idempotency key once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-spot-'));
    roots.push(stateRootDir);
    const getTokenAccountsByOwner = vi.fn(async () => {
      throw new Error('paper spot must not read real wallet tokens');
    });
    const executeExactIn = vi.fn(async (request: any, context: any) => {
      await context.sendRawTransaction(Buffer.from(`paper-${request.inputMint}`, 'utf8').toString('base64'));
      return {
        providerName: 'jupiter-v1',
        outAmountLamports: request.inputMint === SOL_MINT ? '2500000' : '120000000',
        signature: 'provider-simulation-signature'
      };
    });
    const quoteExactIn = vi.fn(async () => ({
      providerName: 'jupiter-v1',
      outAmountLamports: '90000000'
    }));

    let server = makeDryRunServer({
      stateRootDir,
      executeExactIn,
      quoteExactIn,
      getTokenAccountsByOwner
    });
    await server.start();

    const buyPayload = buildPayload({ side: 'buy', idempotencyKey: 'paper-buy-1' });
    const buy = await postBroadcast(server.origin, buyPayload);
    expect(buy.response.status).toBe(200);
    expect(buy.body).toMatchObject({
      status: 'submitted',
      reason: 'paper-dry-run-simulated',
      mainExecutionStatus: 'confirmed'
    });

    const afterBuy = await readAccount(server.origin);
    expect(afterBuy.response.status).toBe(200);
    expect(afterBuy.body.walletSol).toBeCloseTo(0.023, 9);
    expect(afterBuy.body.walletTokens).toEqual([
      expect.objectContaining({
        mint: 'paper-token-1',
        amountRaw: '2500000',
        currentValueSol: 0.09,
        positionId: 'paper-position-1'
      })
    ]);
    expect(getTokenAccountsByOwner).not.toHaveBeenCalled();

    await server.stop();
    server = makeDryRunServer({
      stateRootDir,
      executeExactIn,
      quoteExactIn,
      getTokenAccountsByOwner
    });
    await server.start();

    const afterRestart = await readAccount(server.origin);
    expect(afterRestart.body.walletSol).toBeCloseTo(0.023, 9);
    expect(afterRestart.body.walletTokens[0]).toMatchObject({
      mint: 'paper-token-1',
      amountRaw: '2500000'
    });

    const sellPayload = buildPayload({ side: 'sell', idempotencyKey: 'paper-sell-1' });
    const sell = await postBroadcast(server.origin, sellPayload);
    expect(sell.body).toMatchObject({
      status: 'submitted',
      reason: 'paper-dry-run-quoted-shadow-settlement',
      mainExecutionStatus: 'confirmed'
    });
    expect(sell.body.submissionId).not.toBe('provider-simulation-signature');
    expect(executeExactIn).toHaveBeenCalledTimes(1);
    expect(quoteExactIn).toHaveBeenCalledWith(expect.objectContaining({
      inputMint: 'paper-token-1',
      outputMint: SOL_MINT,
      amountLamports: '2500000',
      skipBalanceDependentProviders: true
    }));

    const afterSell = await readAccount(server.origin);
    expect(afterSell.body.walletSol).toBeCloseTo(0.113, 9);
    expect(afterSell.body.walletTokens).toEqual([]);

    const executeCountAfterSell = executeExactIn.mock.calls.length;
    const replay = await postBroadcast(server.origin, sellPayload);
    expect(replay.body).toEqual(sell.body);
    expect(executeExactIn).toHaveBeenCalledTimes(executeCountAfterSell);
    const afterReplay = await readAccount(server.origin);
    expect(afterReplay.body.walletSol).toBeCloseTo(0.113, 9);
    expect(afterReplay.body.walletTokens).toEqual([]);
    expect(getTokenAccountsByOwner).not.toHaveBeenCalled();

    await server.stop();
  });

  it('fails closed when a dry-run sell has no matching synthetic inventory', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-spot-empty-'));
    roots.push(stateRootDir);
    const executeExactIn = vi.fn();
    const getTokenAccountsByOwner = vi.fn(async () => [{ real: 'wallet-token-must-be-ignored' }]);
    const server = makeDryRunServer({
      stateRootDir,
      executeExactIn,
      quoteExactIn: vi.fn(),
      getTokenAccountsByOwner
    });
    await server.start();

    const result = await postBroadcast(
      server.origin,
      buildPayload({ side: 'sell', idempotencyKey: 'paper-sell-missing' })
    );
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'failed',
      retryable: false,
      executionFailureKind: 'paper_inventory_missing',
      executionFailureOperation: 'paper-sell-ownership'
    });
    expect(executeExactIn).not.toHaveBeenCalled();
    expect(getTokenAccountsByOwner).not.toHaveBeenCalled();

    const account = await readAccount(server.origin);
    expect(account.body.walletSol).toBe(0.123);
    expect(account.body.walletTokens).toEqual([]);
    await server.stop();
  });

  it('does not fall back to pool and mint when an explicit paper LP identity is stale', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-lp-identity-'));
    roots.push(stateRootDir);
    await writeFile(join(stateRootDir, 'paper-dry-run-state.json'), JSON.stringify({
      version: 1,
      walletSolDelta: -0.1,
      positions: [{
        poolAddress: 'paper-pool-1',
        positionAddress: 'paper-chain-position-real',
        chainPositionAddress: 'paper-chain-position-real',
        positionId: 'paper-lp-position-1',
        mint: 'paper-token-1',
        entrySol: 0.1,
        currentValueSol: 0.1,
        openedAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z'
      }]
      // Intentionally omit tokens/appliedSwapKeys to prove old state remains readable.
    }), 'utf8');
    const server = makeDryRunServer({
      stateRootDir,
      executeExactIn: vi.fn(),
      quoteExactIn: vi.fn(),
      getTokenAccountsByOwner: vi.fn()
    });
    await server.start();

    const result = await postBroadcast(
      server.origin,
      buildWithdrawPayload('paper-chain-position-stale')
    );
    expect(result.body).toMatchObject({
      status: 'failed',
      retryable: false,
      executionFailureKind: 'paper_lp_inventory_missing',
      executionFailureOperation: 'paper-withdraw-ownership'
    });
    const account = await readAccount(server.origin);
    expect(account.body.walletSol).toBeCloseTo(0.023, 9);
    expect(account.body.walletLpPositions).toEqual([
      expect.objectContaining({ chainPositionAddress: 'paper-chain-position-real' })
    ]);
    await server.stop();
  });

  it('closes the exact paper LP by chain address when recovery normalized positionId', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-lp-recovered-id-'));
    roots.push(stateRootDir);
    await writeFile(join(stateRootDir, 'paper-dry-run-state.json'), JSON.stringify({
      version: 1,
      walletSolDelta: -0.1,
      positions: [{
        poolAddress: 'paper-pool-1',
        positionAddress: 'paper-chain-position-real',
        chainPositionAddress: 'paper-chain-position-real',
        positionId: 'paper-pool-1:paper-token-1',
        openIntentId: 'paper-open-1',
        mint: 'paper-token-1',
        entrySol: 0.1,
        currentValueSol: 0.1,
        openedAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z'
      }]
    }), 'utf8');
    const server = makeDryRunServer({
      stateRootDir,
      executeExactIn: vi.fn(),
      quoteExactIn: vi.fn(),
      getTokenAccountsByOwner: vi.fn()
    });
    await server.start();

    const result = await postBroadcast(
      server.origin,
      buildWithdrawPayload('paper-chain-position-real', 'paper-chain-position-real')
    );
    expect(result.body).toMatchObject({
      status: 'submitted',
      mainExecutionStatus: 'confirmed',
      reason: 'paper-dry-run-shadow-close',
      chainPositionAddress: 'paper-chain-position-real'
    });
    const account = await readAccount(server.origin);
    expect(account.body.walletSol).toBeCloseTo(0.123, 9);
    expect(account.body.walletLpPositions).toEqual([]);
    await server.stop();
  });

  it('fails closed when chainPositionAddress and positionId identify different paper LPs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stateRootDir = await mkdtemp(join(tmpdir(), 'lightld-paper-lp-conflicting-id-'));
    roots.push(stateRootDir);
    await writeFile(join(stateRootDir, 'paper-dry-run-state.json'), JSON.stringify({
      version: 1,
      walletSolDelta: -0.2,
      positions: [
        {
          poolAddress: 'paper-pool-1',
          positionAddress: 'paper-chain-position-a',
          chainPositionAddress: 'paper-chain-position-a',
          positionId: 'paper-logical-position-a',
          mint: 'paper-token-1',
          entrySol: 0.1,
          currentValueSol: 0.1,
          openedAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z'
        },
        {
          poolAddress: 'paper-pool-1',
          positionAddress: 'paper-chain-position-b',
          chainPositionAddress: 'paper-chain-position-b',
          positionId: 'paper-logical-position-b',
          mint: 'paper-token-1',
          entrySol: 0.1,
          currentValueSol: 0.1,
          openedAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z'
        }
      ]
    }), 'utf8');
    const server = makeDryRunServer({
      stateRootDir,
      executeExactIn: vi.fn(),
      quoteExactIn: vi.fn(),
      getTokenAccountsByOwner: vi.fn()
    });
    await server.start();

    const result = await postBroadcast(
      server.origin,
      buildWithdrawPayload('paper-chain-position-a', 'paper-logical-position-b')
    );
    expect(result.body).toMatchObject({
      status: 'failed',
      retryable: false,
      executionFailureKind: 'paper_lp_inventory_missing',
      executionFailureOperation: 'paper-withdraw-ownership'
    });
    const account = await readAccount(server.origin);
    expect(account.body.walletLpPositions).toHaveLength(2);
    expect(account.body.walletLpPositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ chainPositionAddress: 'paper-chain-position-a' }),
      expect.objectContaining({ chainPositionAddress: 'paper-chain-position-b' })
    ]));
    await server.stop();
  });
});
