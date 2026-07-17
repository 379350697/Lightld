import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOrderIntent } from '../../../src/execution/order-intent-builder';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';
import { runLiveCycle } from '../../../src/runtime/live-cycle';
import { runLiveDaemon } from '../../../src/runtime/live-daemon';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import { applyLiveCycleResultToLedger } from '../../../src/runtime/position-ledger';
import {
  PreparedBroadcastStore,
  buildPreparedBroadcastSnapshot
} from '../../../src/runtime/prepared-broadcast-store';
import { RuntimeStateStore } from '../../../src/runtime/runtime-state-store';

function account(input: {
  walletSol: number;
  amountRaw: string;
  currentValueSol: number;
}) {
  const token = {
    mint: 'mint-large',
    symbol: 'LARGE',
    amount: Number(input.amountRaw),
    amountRaw: input.amountRaw,
    currentValueSol: input.currentValueSol
  };
  return {
    observedAt: new Date().toISOString(),
    walletSol: input.walletSol,
    journalSol: input.walletSol,
    walletTokens: BigInt(input.amountRaw) > 0n ? [token] : [],
    journalTokens: BigInt(input.amountRaw) > 0n ? [token] : [],
    walletLpPositions: [],
    journalLpPositions: [],
    fills: []
  };
}

describe('large-pool spot ownership boundary', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('values and sells only the strategy-owned fraction of a same-mint wallet balance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spot-owned-exit-'));
    roots.push(root);
    const before = account({ walletSol: 1, amountRaw: '1000', currentValueSol: 0.25 });
    const after = account({ walletSol: 1.095, amountRaw: '600', currentValueSol: 0.15 });
    after.observedAt = new Date(Date.now() + 60_000).toISOString();
    const quoteProvider = {
      collect: vi.fn(async ({ expectedOutSol, slippageBps }: any) => ({
        routeExists: true,
        outputSol: expectedOutSol - 0.005,
        slippageBps,
        quotedAt: new Date().toISOString(),
        stale: false
      }))
    };
    const broadcaster = {
      broadcast: vi.fn(async (signed: any) => ({
        status: 'submitted' as const,
        submissionId: 'spot-close-submission',
        confirmationSignature: 'spot-close-signature',
        idempotencyKey: signed.intent.idempotencyKey
      }))
    };

    const result = await runLiveCycle({
      strategy: 'large-pool-v1',
      captureMode: 'mechanical-soak',
      stateRootDir: join(root, 'state'),
      journalRootDir: join(root, 'journals'),
      requestedPositionSol: 0.05,
      accountState: before,
      accountProvider: { readState: async () => after },
      positionState: {
        allowNewOpens: false,
        flattenOnly: false,
        lastAction: 'deploy',
        openIntentId: 'spot-open-intent',
        positionId: 'spot-position',
        activeMint: 'mint-large',
        activePoolAddress: 'pool-large',
        lifecycleState: 'open',
        ownedTokenAmountRaw: '400',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        openedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'unrelated-candidate-pool', liquidityUsd: 100_000 },
        token: { mint: 'unrelated-candidate-mint', symbol: 'OTHER', inSession: false, hasSolRoute: true },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.5, slippageBps: 80 }
      },
      quoteProvider,
      signer: {
        sign: async (intent) => ({ intent, signerId: 'paper', signedAt: new Date().toISOString(), signature: 'signed' })
      },
      broadcaster,
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: new Date().toISOString()
        })
      }
    });

    expect(result.action).toBe('dca-out');
    expect(result.mode).toBe('LIVE');
    expect(quoteProvider.collect).toHaveBeenCalledWith(expect.objectContaining({ expectedOutSol: 0.1 }));
    expect(result.quote?.outputSol).toBeCloseTo(0.095);
    expect(result.orderIntent).toMatchObject({
      side: 'sell',
      tokenMint: 'mint-large',
      inputAmountRaw: '400',
      preExitTokenAmountRaw: '1000',
      outputSol: 0.095,
      openIntentId: 'spot-open-intent',
      positionId: 'spot-position'
    });
    expect(result.fullExitClosureProven).toBe(true);
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
  });

  it('keeps owned spot exit pending when the fresh raw token decrease does not match the signed amount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spot-owned-exit-delta-mismatch-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const before = account({ walletSol: 1, amountRaw: '1000', currentValueSol: 0.25 });
    const after = account({ walletSol: 1.095, amountRaw: '650', currentValueSol: 0.15 });
    after.observedAt = new Date(Date.now() + 60_000).toISOString();

    const result = await runLiveCycle({
      strategy: 'large-pool-v1',
      captureMode: 'mechanical-soak',
      stateRootDir,
      journalRootDir: join(root, 'journals'),
      requestedPositionSol: 0.05,
      accountState: before,
      accountProvider: { readState: async () => after },
      positionState: {
        allowNewOpens: false,
        flattenOnly: false,
        lastAction: 'deploy',
        openIntentId: 'spot-open-intent',
        positionId: 'spot-position',
        activeMint: 'mint-large',
        activePoolAddress: 'pool-large',
        lifecycleState: 'open',
        ownedTokenAmountRaw: '400',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        openedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'pool-large', liquidityUsd: 100_000 },
        token: { mint: 'mint-large', symbol: 'LARGE', inSession: false, hasSolRoute: true },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 80 }
      },
      signer: {
        sign: async (intent) => ({ intent, signerId: 'paper', signedAt: new Date().toISOString(), signature: 'signed' })
      },
      broadcaster: {
        broadcast: async (signed) => ({
          status: 'submitted' as const,
          submissionId: 'spot-close-mismatch',
          confirmationSignature: 'spot-close-mismatch-signature',
          idempotencyKey: signed.intent.idempotencyKey
        })
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: after.observedAt
        })
      }
    });

    expect(result).toMatchObject({
      action: 'dca-out',
      confirmationStatus: 'confirmed',
      fullExitClosureProven: false,
      nextLifecycleState: 'inventory_exit_pending'
    });
    expect(await new PendingSubmissionStore(stateRootDir).read()).toMatchObject({
      orderAction: 'dca-out',
      preExitTokenAmountRaw: '1000',
      inputAmountRaw: '400',
      reason: 'pending-dca-out-awaiting-exact-token-delta-proof'
    });
  });

  it('requires reconciliation instead of selling the whole wallet when ownership is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spot-owned-missing-'));
    roots.push(root);
    const broadcaster = { broadcast: vi.fn() };
    const quoteProvider = { collect: vi.fn() };

    const result = await runLiveCycle({
      strategy: 'large-pool-v1',
      captureMode: 'mechanical-soak',
      stateRootDir: join(root, 'state'),
      journalRootDir: join(root, 'journals'),
      accountState: account({ walletSol: 1, amountRaw: '1000', currentValueSol: 0.25 }),
      positionState: {
        allowNewOpens: false,
        flattenOnly: false,
        lastAction: 'deploy',
        activeMint: 'mint-large',
        activePoolAddress: 'pool-large',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'pool-large', liquidityUsd: 100_000 },
        token: { mint: 'mint-large', symbol: 'LARGE', inSession: false, hasSolRoute: true },
        trader: { hasInventory: true, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.25, slippageBps: 80 }
      },
      quoteProvider: quoteProvider as any,
      signer: { sign: vi.fn() } as any,
      broadcaster: broadcaster as any
    });

    expect(result).toMatchObject({
      mode: 'BLOCKED',
      action: 'hold',
      reason: 'spot-ownership-reconcile-required:owned-token-amount-missing',
      nextLifecycleState: 'reconcile_required'
    });
    expect(quoteProvider.collect).not.toHaveBeenCalled();
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it('recovers a confirmed pre-broadcast WAL spot open without losing identity or ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spot-owned-wal-recovery-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const intent = buildOrderIntent({
      strategyId: 'large-pool-v1',
      poolAddress: 'pool-large',
      outputSol: 0.1,
      executionPolicy: 'simulate-only',
      side: 'buy',
      tokenMint: 'mint-large',
      openIntentId: 'recovered-open-intent',
      positionId: 'recovered-position',
      preEntryTokenAmountRaw: '200',
      preEntryWalletSol: 1
    });
    const signedIntent = {
      intent,
      signerId: 'paper-signer',
      signedAt: new Date().toISOString(),
      signature: 'paper-signature'
    };
    await new PreparedBroadcastStore(stateRootDir).write(buildPreparedBroadcastSnapshot({
      strategyId: 'large-pool-v1',
      signedIntent,
      action: 'deploy',
      captureMode: 'mechanical-soak',
      openIntentId: 'recovered-open-intent',
      positionId: 'recovered-position',
      poolAddress: 'pool-large',
      tokenMint: 'mint-large',
      tokenSymbol: 'LARGE',
      requestedPositionSol: 0.1,
      createdAt: intent.createdAt
    }));
    const recoveredAccount = account({ walletSol: 0.9, amountRaw: '1200', currentValueSol: 0.1 });
    const broadcaster = {
      broadcast: vi.fn(async () => ({
        status: 'submitted' as const,
        submissionId: 'recovered-submission',
        confirmationSignature: 'recovered-signature',
        idempotencyKey: intent.idempotencyKey
      }))
    };

    await runLiveDaemon({
      strategy: 'large-pool-v1',
      captureMode: 'mechanical-soak',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      broadcaster,
      accountProvider: { readState: async () => recoveredAccount },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: new Date().toISOString()
        })
      },
      buildCycleInput: async () => ({
        captureMode: 'mechanical-soak',
        accountState: recoveredAccount,
        context: {
          pool: { address: 'pool-large', liquidityUsd: 100_000 },
          token: { mint: 'mint-large', symbol: 'LARGE', inSession: true, hasSolRoute: true },
          trader: { hasInventory: true, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 80 }
        }
      })
    });

    const positionState = await new RuntimeStateStore(stateRootDir).readPositionState();
    expect(positionState).toMatchObject({
      activeMint: 'mint-large',
      activePoolAddress: 'pool-large',
      openIntentId: 'recovered-open-intent',
      positionId: 'recovered-position',
      lifecycleState: 'open',
      ownedTokenAmountRaw: '1000',
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'recovered-submission'
    });
    expect(positionState?.entrySol).toBeCloseTo(0.1);
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(1);
  });

  it('rejects a recovered open wallet delta above the requested exposure bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-spot-owned-wal-overbound-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const intent = buildOrderIntent({
      strategyId: 'large-pool-v1',
      poolAddress: 'pool-large',
      outputSol: 0.1,
      executionPolicy: 'simulate-only',
      side: 'buy',
      tokenMint: 'mint-large',
      openIntentId: 'overbound-open-intent',
      positionId: 'overbound-position',
      preEntryTokenAmountRaw: '0',
      preEntryWalletSol: 1
    });
    await new PreparedBroadcastStore(stateRootDir).write(buildPreparedBroadcastSnapshot({
      strategyId: 'large-pool-v1',
      signedIntent: {
        intent,
        signerId: 'paper-signer',
        signedAt: new Date().toISOString(),
        signature: 'paper-signature'
      },
      action: 'deploy',
      captureMode: 'mechanical-soak',
      openIntentId: 'overbound-open-intent',
      positionId: 'overbound-position',
      poolAddress: 'pool-large',
      tokenMint: 'mint-large',
      tokenSymbol: 'LARGE',
      requestedPositionSol: 0.1,
      createdAt: intent.createdAt
    }));
    const recoveredAccount = account({ walletSol: 0.5, amountRaw: '1000', currentValueSol: 0.1 });

    await runLiveDaemon({
      strategy: 'large-pool-v1',
      captureMode: 'mechanical-soak',
      stateRootDir,
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 1,
      maxTicks: 1,
      broadcaster: {
        broadcast: async () => ({
          status: 'submitted' as const,
          submissionId: 'overbound-submission',
          idempotencyKey: intent.idempotencyKey
        })
      },
      accountProvider: { readState: async () => recoveredAccount },
      buildCycleInput: async () => ({ accountState: recoveredAccount })
    });

    const state = await new RuntimeStateStore(stateRootDir).readPositionState();
    expect(state).toMatchObject({
      activeMint: 'mint-large',
      openIntentId: 'overbound-open-intent',
      lifecycleState: 'reconcile_required',
      lastReason: 'spot-ownership-reconcile-required:recovered-open-wallet-delta-out-of-bounds'
    });
    expect(state?.entrySol).toBeUndefined();
    expect(state?.ownedTokenAmountRaw).toBeUndefined();
  });

  it('recovers an LP exit with only its post-minus-pre residual as strategy-owned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-lp-exit-owned-residual-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const runtimeStore = new RuntimeStateStore(stateRootDir);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const intent = buildOrderIntent({
      strategyId: 'new-token-v1',
      poolAddress: 'pool-lp',
      outputSol: 0.1,
      executionPolicy: 'simulate-only',
      createdAt,
      side: 'withdraw-lp',
      tokenMint: 'mint-large',
      fullPositionExit: true,
      liquidateResidualTokenToSol: true,
      preExitTokenAmountRaw: '1000',
      openIntentId: 'lp-open-intent',
      positionId: 'position:lp-chain',
      chainPositionAddress: 'lp-chain'
    });
    await runtimeStore.writePositionState({
      allowNewOpens: false,
      flattenOnly: false,
      lastAction: 'add-lp',
      openIntentId: 'lp-open-intent',
      positionId: 'position:lp-chain',
      chainPositionAddress: 'lp-chain',
      activeMint: 'mint-large',
      activePoolAddress: 'pool-lp',
      lifecycleState: 'open',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      updatedAt: createdAt
    });
    await runtimeStore.writePositionLedger({
      version: 1,
      records: [{
        positionKey: 'chain-position:lp-chain',
        openIntentId: 'lp-open-intent',
        positionId: 'position:lp-chain',
        chainPositionAddress: 'lp-chain',
        activeMint: 'mint-large',
        activePoolAddress: 'pool-lp',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        lastAction: 'add-lp',
        updatedAt: createdAt
      }],
      updatedAt: createdAt
    });
    await new PreparedBroadcastStore(stateRootDir).write(buildPreparedBroadcastSnapshot({
      strategyId: 'new-token-v1',
      signedIntent: {
        intent,
        signerId: 'paper-signer',
        signedAt: createdAt,
        signature: 'paper-signature'
      },
      action: 'withdraw-lp',
      captureMode: 'mechanical-soak',
      openIntentId: 'lp-open-intent',
      positionId: 'position:lp-chain',
      chainPositionAddress: 'lp-chain',
      poolAddress: 'pool-lp',
      tokenMint: 'mint-large',
      tokenSymbol: 'LARGE',
      requestedPositionSol: 0.1,
      createdAt
    }));
    const recoveredAccount = account({ walletSol: 1.1, amountRaw: '1200', currentValueSol: 0.12 });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      captureMode: 'mechanical-soak',
      stateRootDir,
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 1,
      maxTicks: 1,
      broadcaster: {
        broadcast: async () => ({
          status: 'submitted' as const,
          submissionId: 'withdraw-submission',
          idempotencyKey: intent.idempotencyKey,
          mainExecutionStatus: 'confirmed' as const,
          residualSweepStatus: 'incomplete' as const,
          residualUnsoldAmountsRaw: { 'mint-large': '200' },
          chainPositionAddress: 'lp-chain'
        })
      },
      accountProvider: { readState: async () => recoveredAccount },
      buildCycleInput: async () => ({ accountState: recoveredAccount })
    });

    const ledger = await runtimeStore.readPositionLedger();
    expect(ledger?.records.find((record) => record.chainPositionAddress === 'lp-chain')).toMatchObject({
      lifecycleState: 'closed',
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupAmountRaw: '200'
    });
    expect(await new PendingSubmissionStore(stateRootDir).read()).toBeNull();
  });

  it('persists residual maintenance completion before clearing its recovered pending identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-residual-exit-durable-recovery-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const runtimeStore = new RuntimeStateStore(stateRootDir);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    await runtimeStore.writePositionLedger({
      version: 1,
      records: [{
        positionKey: 'residual:mint-large',
        activeMint: 'mint-large',
        lifecycleState: 'closed',
        residualCleanupStatus: 'residual_cleanup_pending',
        residualCleanupAmountRaw: '200',
        lastAction: 'withdraw-lp',
        updatedAt: createdAt
      }],
      updatedAt: createdAt
    });
    await new PendingSubmissionStore(stateRootDir).write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'residual-exit-idempotency',
      submissionId: 'residual-exit-submission',
      confirmationStatus: 'confirmed',
      finality: 'finalized',
      createdAt,
      updatedAt: createdAt,
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      poolAddress: '',
      tokenMint: 'mint-large',
      tokenSymbol: 'LARGE',
      preExitTokenAmountRaw: '1000',
      inputAmountRaw: '200',
      orderAction: 'dca-out'
    });
    const recoveredAccount = account({ walletSol: 1.1, amountRaw: '800', currentValueSol: 0.08 });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      captureMode: 'mechanical-soak',
      stateRootDir,
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: {
        readState: async () => ({
          ...recoveredAccount,
          observedAt: new Date().toISOString()
        })
      },
      buildCycleInput: async () => ({
        accountState: recoveredAccount,
        context: {
          pool: { address: '', blockReason: 'no-selected-candidate' },
          token: { mint: '', symbol: '', inSession: false, hasSolRoute: false },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, blockReason: 'no-selected-candidate' }
        }
      })
    });

    expect((await runtimeStore.readPositionLedger())?.records[0]).toMatchObject({
      positionKey: 'residual:mint-large',
      lifecycleState: 'closed',
      residualCleanupStatus: 'residual_cleanup_complete',
      lastReason: 'pending-submission-filled'
    });
    expect((await runtimeStore.readPositionLedger())?.records[0].residualCleanupAmountRaw).toBeUndefined();
    expect(await new PendingSubmissionStore(stateRootDir).read()).toBeNull();
  });

  it('releases a durable open-risk reservation before clearing a failed recovered submission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-open-failure-spend-recovery-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const spendingStore = new SpendingLimitsStore(stateRootDir);
    await spendingStore.reserveSpend('failed-open-idempotency', 0.1);
    await new PendingSubmissionStore(stateRootDir).write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'failed-open-idempotency',
      submissionId: 'failed-open-submission',
      confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
      confirmationStatus: 'submitted',
      finality: 'processed',
      createdAt,
      updatedAt: createdAt,
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      poolAddress: 'pool-failed',
      tokenMint: 'mint-failed',
      tokenSymbol: 'FAILED',
      requestedPositionSol: 0.1,
      orderAction: 'add-lp'
    });
    const flatAccount = {
      observedAt: new Date().toISOString(),
      walletSol: 1,
      journalSol: 1,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [],
      journalLpPositions: [],
      fills: []
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: { readState: async () => flatAccount },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'failed' as const,
          finality: 'failed' as const,
          checkedAt: new Date().toISOString(),
          reason: 'InstructionError'
        })
      },
      buildCycleInput: async () => ({
        accountState: flatAccount,
        context: {
          pool: { address: '', blockReason: 'no-selected-candidate' },
          token: { mint: '', symbol: '', inSession: false, hasSolRoute: false },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, blockReason: 'no-selected-candidate' }
        }
      })
    });

    expect(await new PendingSubmissionStore(stateRootDir).read()).toBeNull();
    expect(await spendingStore.read()).toMatchObject({
      dailySpendSol: 0,
      hourlySpendSol: 0,
      orderCount: 0,
      reservations: []
    });
  });

  it('recovers a confirmed fee claim while preserving only its post-minus-pre unsold fees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-claim-fee-durable-recovery-'));
    roots.push(root);
    const stateRootDir = join(root, 'state');
    const runtimeStore = new RuntimeStateStore(stateRootDir);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    await runtimeStore.writePositionState({
      allowNewOpens: false,
      flattenOnly: false,
      lastAction: 'add-lp',
      openIntentId: 'claim-open',
      positionId: 'position:claim-chain',
      chainPositionAddress: 'claim-chain',
      activeMint: 'mint-large',
      activePoolAddress: 'pool-lp',
      lifecycleState: 'open',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      updatedAt: createdAt
    });
    await runtimeStore.writePositionLedger({
      version: 1,
      records: [{
        positionKey: 'chain-position:claim-chain',
        openIntentId: 'claim-open',
        positionId: 'position:claim-chain',
        chainPositionAddress: 'claim-chain',
        activeMint: 'mint-large',
        activePoolAddress: 'pool-lp',
        lifecycleState: 'open',
        lastAction: 'add-lp',
        updatedAt: createdAt
      }],
      updatedAt: createdAt
    });
    await new PendingSubmissionStore(stateRootDir).write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'claim-fee-idempotency',
      submissionId: 'claim-fee-submission',
      openIntentId: 'claim-open',
      positionId: 'position:claim-chain',
      chainPositionAddress: 'claim-chain',
      confirmationStatus: 'confirmed',
      finality: 'finalized',
      createdAt,
      updatedAt: createdAt,
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      poolAddress: 'pool-lp',
      tokenMint: 'mint-large',
      tokenSymbol: 'LARGE',
      preExitTokenAmountRaw: '1000',
      orderAction: 'claim-fee',
      residualSweepStatus: 'incomplete',
      residualUnsoldAmountsRaw: { 'mint-large': '200' }
    });
    const postClaimAccount = {
      ...account({ walletSol: 1.02, amountRaw: '1200', currentValueSol: 0.12 }),
      observedAt: new Date().toISOString(),
      walletLpPositions: [{
        poolAddress: 'pool-lp',
        positionAddress: 'claim-chain',
        chainPositionAddress: 'claim-chain',
        mint: 'mint-large',
        hasLiquidity: true
      }],
      journalLpPositions: []
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      captureMode: 'mechanical-soak',
      stateRootDir,
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 1,
      maxTicks: 1,
      residualTokenSweepMinValueSol: 1,
      accountProvider: { readState: async () => postClaimAccount },
      buildCycleInput: async () => ({
        accountState: postClaimAccount,
        context: {
          pool: { address: 'pool-lp', liquidityUsd: 100_000 },
          token: { mint: 'mint-large', symbol: 'LARGE', inSession: true, hasSolRoute: true },
          trader: { hasInventory: true, hasLpPosition: true },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 80 }
        }
      })
    });

    expect((await runtimeStore.readPositionLedger())?.records.find((record) =>
      record.chainPositionAddress === 'claim-chain'
    )).toMatchObject({
      lifecycleState: 'open',
      residualCleanupStatus: 'residual_cleanup_pending',
      residualCleanupAmountRaw: '200'
    });
    expect(await new PendingSubmissionStore(stateRootDir).read()).toBeNull();
  });

  it('closes a spot ledger record on owned dca-out without closing an LP residual record', () => {
    const now = new Date().toISOString();
    const spotLedger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        records: [{
          positionKey: 'open-intent:spot-open',
          openIntentId: 'spot-open',
          positionId: 'spot-position',
          activeMint: 'mint-large',
          activePoolAddress: 'pool-large',
          lifecycleState: 'open',
          ownedTokenAmountRaw: '400',
          entrySol: 0.1,
          entrySolSource: 'actual_fill',
          lastAction: 'deploy',
          updatedAt: now
        }],
        updatedAt: now
      },
      actionIdentity: { openIntentId: 'spot-open', positionId: 'spot-position' },
      orderIntent: {
        idempotencyKey: 'spot-close',
        poolAddress: '',
        tokenMint: 'mint-large'
      },
      action: 'dca-out',
      reason: 'live-order-submitted',
      exitTriggerReason: 'take-profit',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      fullExitClosureProven: true,
      confirmedFill: {
        submissionId: 'spot-close-submission',
        filledSol: 0.12,
        actualFilledSol: 0.12,
        fillAmountSource: 'wallet-delta',
        recordedAt: now
      },
      now
    });
    expect(spotLedger.records[0]).toMatchObject({
      lifecycleState: 'closed',
      lastAction: 'dca-out',
      lastReason: 'take-profit'
    });
    expect(spotLedger.records[0].ownedTokenAmountRaw).toBeUndefined();

    const lpLedger = applyLiveCycleResultToLedger({
      ledger: {
        version: 1,
        records: [{
          positionKey: 'chain-position:lp-position',
          chainPositionAddress: 'lp-position',
          positionId: 'lp-position',
          activeMint: 'mint-large',
          activePoolAddress: 'pool-large',
          lifecycleState: 'open',
          residualCleanupStatus: 'residual_cleanup_pending',
          residualCleanupAmountRaw: '25',
          entrySol: 0.1,
          entrySolSource: 'actual_fill',
          lastAction: 'withdraw-lp',
          updatedAt: now
        }],
        updatedAt: now
      },
      actionIdentity: { chainPositionAddress: 'lp-position' },
      orderIntent: {
        idempotencyKey: 'lp-residual-sell',
        poolAddress: '',
        tokenMint: 'mint-large'
      },
      action: 'dca-out',
      reason: 'live-order-submitted',
      liveOrderSubmitted: true,
      confirmationStatus: 'confirmed',
      now
    });
    expect(lpLedger.records[0]).toMatchObject({
      lifecycleState: 'open',
      lastAction: 'withdraw-lp',
      residualCleanupStatus: 'residual_cleanup_pending'
    });
  });
});
