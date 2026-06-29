import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveEvolutionPaths, WatchlistStore } from '../../../src/evolution';
import { appendJsonLine, resolveActiveJsonlPath } from '../../../src/journals/jsonl-writer';
import type { MirrorEvent } from '../../../src/observability/mirror-events';
import { ExecutionRequestError } from '../../../src/execution/error-classification';
import { createHousekeepingRunner } from '../../../src/runtime/housekeeping';
import { buildLiveCycleInputFromIngest } from '../../../src/runtime/ingest-context-builder';
import { resolveLifecycleStateForPersist, runLiveDaemon } from '../../../src/runtime/live-daemon';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import { ResidualTokenSweepStore } from '../../../src/runtime/residual-token-sweep-store';
import { RuntimeStateStore } from '../../../src/runtime/runtime-state-store';
import { TargetOpenCooldownStore } from '../../../src/runtime/target-open-cooldown-store';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';

describe('runLiveDaemon', () => {
  it('treats a flat account as closed even when a stale reduce-risk snapshot says open', () => {
    expect(resolveLifecycleStateForPersist({
      nextLifecycleState: 'open',
      previousLifecycleState: 'inventory_exit_ready',
      pendingSubmission: false,
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [],
        journalLpPositions: [],
        fills: []
      },
      lastAction: 'dca-out',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-safe'
    })).toBe('closed');
  });

  it('preserves the previous lifecycle state when account state is unavailable', () => {
    expect(resolveLifecycleStateForPersist({
      previousLifecycleState: 'open',
      pendingSubmission: false,
      lastAction: 'hold',
      lastReason: 'account-state-timeout',
      chainPositionAddress: 'pos-open',
      activeMint: 'mint-open',
      activePoolAddress: 'pool-open'
    })).toBe('open');
  });

  it('clears active identity when persisted account state is terminally closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-flat-terminal-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const recentOpenedAt = new Date(Date.now() - 30 * 60_000).toISOString();

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-safe',
      lifecycleState: 'open',
      updatedAt: '2026-03-22T00:00:00.000Z'
    });

    let positionStateSeenByBuild: Awaited<ReturnType<RuntimeStateStore['readPositionState']>> | undefined;
    const flatAccountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [],
      journalLpPositions: [],
      fills: []
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: {
        readState: async () => flatAccountState
      },
      signer: {
        sign: async (intent) => ({
          intent,
          signerId: 'test-signer',
          signedAt: '2026-03-22T00:00:01.000Z',
          signature: 'sig'
        })
      },
      broadcaster: {
        broadcast: async (signedIntent) => ({
          status: 'submitted' as const,
          submissionId: 'sub-flat-terminal',
          idempotencyKey: signedIntent.intent.idempotencyKey
        })
      },
      buildCycleInput: async (_tick, context) => {
        positionStateSeenByBuild = context?.positionState;
        return {
          requestedPositionSol: 0.1,
          context: {
            pool: { address: 'pool-safe', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            token: { mint: 'mint-safe', symbol: 'SAFE', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
          }
        };
      }
    });

    expect(positionStateSeenByBuild).toMatchObject({
      lifecycleState: 'closed'
    });
    expect(positionStateSeenByBuild?.activeMint).toBeUndefined();
    expect(positionStateSeenByBuild?.activePoolAddress).toBeUndefined();

    const positionState = await runtimeStateStore.readPositionState();
    const health = await runtimeStateStore.readHealthReport();
    expect(positionState).toMatchObject({
      allowNewOpens: true,
      lifecycleState: 'closed'
    });
    expect(health).toMatchObject({
      allowNewOpens: true
    });
    expect(positionState?.activeMint).toBeUndefined();
    expect(positionState?.activePoolAddress).toBeUndefined();
  });

  it('records a 60 minute same target reopen cooldown after LP stop-loss exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-stop-loss-cooldown-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const openedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await new RuntimeStateStore(stateRootDir).writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lifecycleState: 'open',
      activeMint: 'mint-loss',
      activePoolAddress: 'pool-loss',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      openedAt,
      updatedAt: openedAt
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-loss', liquidityUsd: 20_000 },
          token: { mint: 'mint-loss', inSession: true, hasSolRoute: true, symbol: 'LOSS' },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            lpNetPnlPct: -25,
            lpTotalValueSol: 0.08,
            exitQuoteValueSol: 0.08,
            lpTradingValueSol: 0.08,
            lpEntryTradingSol: 0.1,
            valuationStatus: 'ready',
            valuationTrust: 'exit_quote',
            valuationCompleteness: 'complete',
            pendingConfirmationStatus: 'confirmed'
          },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const cooldown = await new TargetOpenCooldownStore(stateRootDir).readActive({
      poolAddress: 'pool-loss',
      tokenMint: 'mint-loss',
      now: new Date().toISOString()
    });
    expect(cooldown).toMatchObject({
      poolAddress: 'pool-loss',
      tokenMint: 'mint-loss'
    });
    expect(cooldown?.reason).toContain('lp-stop-loss');
    expect(Date.parse(cooldown!.cooldownUntil) - Date.now()).toBeGreaterThan(50 * 60_000);
  });

  it('records only a short reconcile cooldown after LP take-profit exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-take-profit-cooldown-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const openedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await new RuntimeStateStore(stateRootDir).writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lifecycleState: 'open',
      activeMint: 'mint-profit',
      activePoolAddress: 'pool-profit',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      openedAt,
      updatedAt: openedAt
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-profit', liquidityUsd: 20_000 },
          token: { mint: 'mint-profit', inSession: true, hasSolRoute: true, symbol: 'PROFIT' },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            holdTimeMs: 10 * 60_000,
            lpNetPnlPct: 50,
            lpTotalValueSol: 0.15,
            exitQuoteValueSol: 0.15,
            lpTradingValueSol: 0.15,
            lpEntryTradingSol: 0.1,
            valuationStatus: 'ready',
            valuationTrust: 'exit_quote',
            valuationCompleteness: 'complete',
            pendingConfirmationStatus: 'confirmed'
          },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const cooldown = await new TargetOpenCooldownStore(stateRootDir).readActive({
      poolAddress: 'pool-profit',
      tokenMint: 'mint-profit',
      now: new Date().toISOString()
    });
    expect(cooldown?.reason).toContain('lp-take-profit');
    expect(Date.parse(cooldown!.cooldownUntil) - Date.now()).toBeLessThan(10 * 60_000);
  });

  it('rebounds a mixed local position state to the chain-backed account LP identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-position-rebind-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const recentOpenedAt = new Date(Date.now() - 30 * 60_000).toISOString();

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lastReason: 'hold',
      activeMint: 'mint-quest',
      activePoolAddress: 'pool-quest',
      positionId: 'pos-world',
      chainPositionAddress: 'pos-world',
      lifecycleState: 'open',
      entrySol: 0.137416044,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-world-open',
      openedAt: recentOpenedAt,
      updatedAt: '2026-06-24T14:53:31.571Z'
    });

    const accountState = {
      walletSol: 0.322224573,
      journalSol: 0.322224573,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [{
        mint: 'mint-world',
        poolAddress: 'pool-world',
        positionAddress: 'pos-world',
        chainPositionAddress: 'pos-world',
        lowerBinId: 100,
        upperBinId: 168,
        activeBinId: 130,
        solSide: 'tokenX' as const,
        solDepletedBins: 0,
        hasLiquidity: true,
        currentValueSol: 0.137406241,
        exitQuoteValueSol: 0.137406241,
        displayValueSol: 0.137406241,
        lpTotalValueSol: 0.137406241,
        valuationStatus: 'ready' as const,
        valuationTrust: 'exit_quote' as const,
        valuationCompleteness: 'complete' as const,
        valuationSource: 'meteora-dlmm-swap-quote'
      }],
      journalLpPositions: [],
      fills: [{
        submissionId: 'sub-world-open',
        mint: 'mint-world',
        side: 'add-lp' as const,
        amount: 0.137416044,
        filledSol: 0.137416044,
        actualFilledSol: 0.137416044,
        actualWalletDeltaSol: 0.137416044,
        fillAmountSource: 'wallet-delta' as const,
        hasFillEvidence: true,
        recordedAt: recentOpenedAt
      }]
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: {
        readState: async () => accountState
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.08,
        accountState,
        context: {
          pool: { address: 'pool-quest', liquidityUsd: 10_000 },
          token: { mint: 'mint-quest', inSession: true, hasSolRoute: true, symbol: 'QUEST' },
          trader: { hasInventory: false, hasLpPosition: true, lpSolDepletedBins: 0 },
          route: { hasSolRoute: true, expectedOutSol: 0.08, slippageBps: 50 }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(positionState).toMatchObject({
      lifecycleState: 'open',
      activeMint: 'mint-world',
      activePoolAddress: 'pool-world',
      positionId: 'pos-world',
      chainPositionAddress: 'pos-world',
      entrySol: 0.137416044,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-world-open',
      valuationStatus: 'ready',
      valuationTrust: 'exit_quote',
      valuationCompleteness: 'complete',
      exitQuoteValueSol: 0.137406241,
      lpTotalValueSol: 0.137406241
    });
  });

  it('writes a health snapshot after running a single tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      housekeepingRunner: createHousekeepingRunner({
        intervalMs: 1,
        runJournalCleanup: async () => 2,
        runMirrorPrune: async () => 3,
        runGmgnCacheSweep: () => ({
          expiredDeleted: 0,
          evictedDeleted: 0,
          remainingEntries: 4
        })
      }),
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
      housekeeping?: {
        journalCleanupDeletedFiles: number;
        mirrorPruneDeletedRows: number;
      };
    };

    expect(result.tickCount).toBe(1);
    expect(health.mode).toBe('healthy');
    expect(health.housekeeping?.journalCleanupDeletedFiles).toBe(2);
    expect(health.housekeeping?.mirrorPruneDeletedRows).toBe(3);
  });

  it('skips the new-open pass after safe LP maintenance hold while a managed LP remains active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-two-pass-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = new Date().toISOString();
    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lifecycleState: 'open',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active',
      positionId: 'position-active',
      chainPositionAddress: 'position-active',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      openedAt,
      updatedAt: openedAt
    });
    const accountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      fills: [],
      walletLpPositions: [{
        poolAddress: 'pool-active',
        positionAddress: 'position-active',
        mint: 'mint-active',
        hasLiquidity: true,
        currentValueSol: 0.11,
        liquidityValueSol: 0.1,
        lpTotalValueSol: 0.11,
        exitQuoteValueSol: 0.11,
        valuationTrust: 'exit_quote' as const,
        valuationStatus: 'ready' as const,
        valuationCompleteness: 'complete' as const
      }],
      journalLpPositions: []
    };
    const modes: Array<string | undefined> = [];
    const skipMints: string[][] = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      maxActivePositions: 2,
      openAfterMaintenanceHold: true,
      accountProvider: {
        readState: async () => accountState
      },
      buildCycleInput: async (_tick, context) => {
        modes.push(context?.selectionMode);
        skipMints.push(context?.skipMints ?? []);
        if (context?.selectionMode === 'new-open-only') {
          throw new Error('new-open pass should be skipped while a managed LP remains active');
        }

        return {
          requestedPositionSol: 0.1,
          accountState,
          context: {
            pool: { address: 'pool-active', liquidityUsd: 20_000 },
            token: { mint: 'mint-active', inSession: true, hasSolRoute: true, symbol: 'ACTIVE' },
            trader: {
              hasInventory: true,
              hasLpPosition: true,
              lpCurrentValueSol: 0.11,
              lpTotalValueSol: 0.11,
              exitQuoteValueSol: 0.11,
              lpTradingValueSol: 0.1,
              lpEntryTradingSol: 0.1,
              lpNetPnlPct: 0,
              valuationStatus: 'ready',
              valuationTrust: 'exit_quote',
              valuationCompleteness: 'complete'
            },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          }
        };
      }
    });

    const nextPositionState = await runtimeStateStore.readPositionState();
    expect(modes).toEqual(['maintenance-only']);
    expect(skipMints).toEqual([[]]);
    expect(nextPositionState).toMatchObject({
      lastAction: 'hold',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active',
      positionId: 'position-active'
    });
    expect(nextPositionState?.chainPositionAddress).toBe('position-active');
  });

  it('rebounds inventory-exit-ready to open when the bound LP is still active before new-open pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-two-pass-rebound-inventory-exit-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = new Date().toISOString();
    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lifecycleState: 'inventory_exit_ready',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active',
      positionId: 'position-active',
      chainPositionAddress: 'position-active',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      openedAt,
      updatedAt: openedAt
    });
    const accountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [{ mint: 'mint-dust', symbol: 'DUST', amount: 0.01, amountLamports: 10_000, currentValueSol: 0.00002 }],
      journalTokens: [],
      fills: [],
      walletLpPositions: [{
        poolAddress: 'pool-active',
        positionAddress: 'position-active',
        mint: 'mint-active',
        hasLiquidity: true,
        currentValueSol: 0.11,
        liquidityValueSol: 0.1,
        lpTotalValueSol: 0.11,
        exitQuoteValueSol: 0.11,
        valuationTrust: 'exit_quote' as const,
        valuationStatus: 'ready' as const,
        valuationCompleteness: 'complete' as const
      }],
      journalLpPositions: []
    };
    const modes: Array<string | undefined> = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      maxActivePositions: 2,
      openAfterMaintenanceHold: true,
      accountProvider: {
        readState: async () => accountState
      },
      buildCycleInput: async (_tick, context) => {
        modes.push(context?.selectionMode);
        if (context?.selectionMode === 'new-open-only') {
          throw new Error('new-open pass should be skipped while the bound LP remains active');
        }

        return {
          requestedPositionSol: 0.1,
          accountState,
          context: {
            pool: { address: 'pool-active', liquidityUsd: 20_000 },
            token: { mint: 'mint-active', inSession: true, hasSolRoute: true, symbol: 'ACTIVE' },
            trader: {
              hasInventory: true,
              hasLpPosition: true,
              lpCurrentValueSol: 0.11,
              lpTotalValueSol: 0.11,
              exitQuoteValueSol: 0.11,
              lpTradingValueSol: 0.1,
              lpEntryTradingSol: 0.1,
              lpNetPnlPct: 0,
              lifecycleState: 'inventory_exit_ready',
              valuationStatus: 'ready',
              valuationTrust: 'exit_quote',
              valuationCompleteness: 'complete'
            },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          }
        };
      }
    });

    const nextPositionState = await runtimeStateStore.readPositionState();
    expect(modes).toEqual(['maintenance-only']);
    expect(nextPositionState).toMatchObject({
      lastAction: 'hold',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active'
    });
  });

  it('skips the new-open pass when residual token inventory needs exit handling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-two-pass-inventory-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = new Date().toISOString();
    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lifecycleState: 'open',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active',
      positionId: 'position-active',
      chainPositionAddress: 'position-active',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      openedAt,
      updatedAt: openedAt
    });
    const modes: Array<string | undefined> = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      maxActivePositions: 2,
      openAfterMaintenanceHold: true,
      buildCycleInput: async (_tick, context) => {
        modes.push(context?.selectionMode);
        if (context?.selectionMode === 'new-open-only') {
          throw new Error('new-open pass should be skipped while residual inventory exists');
        }

        return {
          requestedPositionSol: 0.1,
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [{ mint: 'mint-residual', symbol: 'RES', amount: 5, currentValueSol: 0.2 }],
            fills: [],
            walletLpPositions: [{
              poolAddress: 'pool-active',
              positionAddress: 'position-active',
              mint: 'mint-active',
              hasLiquidity: true,
              currentValueSol: 0.11,
              liquidityValueSol: 0.1,
              lpTotalValueSol: 0.11,
              valuationStatus: 'ready' as const,
              valuationCompleteness: 'complete' as const
            }],
            journalLpPositions: []
          },
          context: {
            pool: { address: 'pool-active', liquidityUsd: 20_000 },
            token: { mint: 'mint-active', inSession: true, hasSolRoute: true, symbol: 'ACTIVE' },
            trader: {
              hasInventory: true,
              hasLpPosition: true,
              lpCurrentValueSol: 0.11,
              lpTotalValueSol: 0.11,
              lpTradingValueSol: 0.1,
              lpEntryTradingSol: 0.1,
              lpNetPnlPct: 0,
              valuationStatus: 'ready',
              valuationCompleteness: 'complete'
            },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          }
        };
      }
    });

    expect(modes).toEqual(['maintenance-only']);
  });

  it('does not start a new-open pass that could overwrite the safe maintenance hold result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-two-pass-fail-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = new Date().toISOString();
    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lifecycleState: 'open',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active',
      positionId: 'position-active',
      chainPositionAddress: 'position-active',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      openedAt,
      updatedAt: openedAt
    });
    const accountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      fills: [],
      walletLpPositions: [{
        poolAddress: 'pool-active',
        positionAddress: 'position-active',
        mint: 'mint-active',
        hasLiquidity: true,
        currentValueSol: 0.11,
        liquidityValueSol: 0.1,
        lpTotalValueSol: 0.11,
        exitQuoteValueSol: 0.11,
        valuationTrust: 'exit_quote' as const,
        valuationStatus: 'ready' as const,
        valuationCompleteness: 'complete' as const
      }],
      journalLpPositions: []
    };
    const modes: Array<string | undefined> = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      maxActivePositions: 2,
      openAfterMaintenanceHold: true,
      buildCycleInput: async (_tick, context) => {
        modes.push(context?.selectionMode);
        if (context?.selectionMode === 'new-open-only') {
          throw new Error('new-open pass should be skipped while a managed LP remains active');
        }

        return {
          requestedPositionSol: 0.1,
          accountState,
          context: {
            pool: { address: 'pool-active', liquidityUsd: 20_000 },
            token: { mint: 'mint-active', inSession: true, hasSolRoute: true, symbol: 'ACTIVE' },
            trader: {
              hasInventory: true,
              hasLpPosition: true,
              lpCurrentValueSol: 0.11,
              lpTotalValueSol: 0.11,
              exitQuoteValueSol: 0.11,
              lpTradingValueSol: 0.1,
              lpEntryTradingSol: 0.1,
              lpNetPnlPct: 0,
              valuationStatus: 'ready',
              valuationTrust: 'exit_quote',
              valuationCompleteness: 'complete'
            },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          }
        };
      }
    });

    const nextPositionState = await runtimeStateStore.readPositionState();
    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
    };
    expect(modes).toEqual(['maintenance-only']);
    expect(nextPositionState).toMatchObject({
      lastAction: 'hold',
      activeMint: 'mint-active',
      activePoolAddress: 'pool-active'
    });
    expect(health.mode).toBe('healthy');
  });

  it('warms the account provider before the first tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-account-warmup-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const readState = vi.fn(async () => ({
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      fills: []
    }));

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: { readState },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    expect(readState).toHaveBeenCalledTimes(2);
  });

  it('tracks watchlist tokens from selected, filtered, wallet, and lp sources and emits due snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00.000Z'));

    try {
      const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-watchlist-'));
      const stateRootDir = join(root, 'state');
      const journalRootDir = join(root, 'journals');
      const evolutionPaths = resolveEvolutionPaths('new-token-v1', join(stateRootDir, 'evolution'));
      const watchlistStore = new WatchlistStore({
        trackedTokensPath: evolutionPaths.watchlistTrackedTokensPath,
        snapshotsPath: evolutionPaths.watchlistSnapshotsPath
      });

      await runLiveDaemon({
        strategy: 'new-token-v1',
        stateRootDir,
        journalRootDir,
        tickIntervalMs: 1,
        maxTicks: 2,
        sleep: async () => {
          vi.advanceTimersByTime(60 * 60 * 1000);
        },
        buildCycleInput: async () => ({
          requestedPositionSol: 0.1,
          evolutionWatchlistCandidates: [
            {
              tokenMint: 'mint-selected',
              tokenSymbol: 'SAFE',
              poolAddress: 'pool-selected',
              sourceReason: 'selected',
              trackedSince: '2026-04-18T00:00:00.000Z'
            },
            {
              tokenMint: 'mint-filtered',
              tokenSymbol: 'RISK',
              poolAddress: 'pool-filtered',
              sourceReason: 'filtered_out',
              trackedSince: '2026-04-18T00:00:00.000Z'
            }
          ],
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [
              { mint: 'mint-wallet', symbol: 'WAL', amount: 2, currentValueSol: 0.27 }
            ],
            journalTokens: [
              { mint: 'mint-wallet', symbol: 'WAL', amount: 2, currentValueSol: 0.27 }
            ],
            walletLpPositions: [
              {
                poolAddress: 'pool-lp',
                positionAddress: 'pos-lp',
                mint: 'mint-lp',
                currentValueSol: 0.4,
                unclaimedFeeSol: 0.02,
                activeBinId: 123,
                lowerBinId: 100,
                upperBinId: 140,
                binCount: 41,
                fundedBinCount: 20,
                solDepletedBins: 5,
                hasLiquidity: true
              }
            ],
            journalLpPositions: [
              {
                poolAddress: 'pool-lp',
                positionAddress: 'pos-lp',
                mint: 'mint-lp',
                currentValueSol: 0.4,
                unclaimedFeeSol: 0.02,
                activeBinId: 123,
                lowerBinId: 100,
                upperBinId: 140,
                binCount: 41,
                fundedBinCount: 20,
                solDepletedBins: 5,
                hasLiquidity: true
              }
            ],
            fills: []
          },
          context: {
            pool: { address: 'pool-selected', liquidityUsd: 10_000 },
            token: { mint: 'mint-selected', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          }
        })
      });

      const trackedTokens = await watchlistStore.readTrackedTokens();
      const snapshots = await watchlistStore.readSnapshots();

      expect(trackedTokens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tokenMint: 'mint-selected', sourceReason: 'selected' }),
          expect.objectContaining({ tokenMint: 'mint-filtered', sourceReason: 'filtered_out' }),
          expect.objectContaining({ tokenMint: 'mint-wallet', sourceReason: 'wallet_inventory' }),
          expect.objectContaining({ tokenMint: 'mint-lp', sourceReason: 'lp_position' })
        ])
      );
      expect(snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tokenMint: 'mint-selected',
            windowLabel: '1h'
          }),
          expect.objectContaining({
            tokenMint: 'mint-lp',
            windowLabel: '1h',
            currentValueSol: 0.4,
            unclaimedFeeSol: 0.02
          }),
          expect.objectContaining({
            tokenMint: 'mint-wallet',
            windowLabel: '1h',
            currentValueSol: 0.27
          })
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ticking when the evolution watchlist store fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-watchlist-failure-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      evolutionWatchlistStore: {
        readTrackedTokens: async () => [],
        writeTrackedTokens: async () => {
          throw new Error('watchlist-write-failed');
        },
        readSnapshots: async () => [],
        appendSnapshot: async () => undefined
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        evolutionWatchlistCandidates: [
          {
            tokenMint: 'mint-selected',
            tokenSymbol: 'SAFE',
            poolAddress: 'pool-selected',
            sourceReason: 'selected',
            trackedSince: '2026-04-18T00:00:00.000Z'
          }
        ],
        context: {
          pool: { address: 'pool-selected', liquidityUsd: 10_000 },
          token: { mint: 'mint-selected', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
    };

    expect(result.tickCount).toBe(1);
    expect(health.mode).toBe('healthy');
  });

  it('emits live-cycle outcome evidence through the daemon-owned evolution sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-outcome-store-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const outcomes: Array<{ tokenMint: string; actualExitReason: string }> = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      evolutionOutcomeStore: {
        appendOutcome: async (record) => {
          outcomes.push({
            tokenMint: record.tokenMint,
            actualExitReason: record.actualExitReason
          });
        }
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [{
            mint: 'mint-safe',
            symbol: 'SAFE',
            amount: 10,
            amountLamports: 10_000_000
          }],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: { hasInventory: true, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    expect(outcomes).toEqual([
      expect.objectContaining({
        tokenMint: 'mint-safe',
        actualExitReason: 'inventory-exit-ready'
      })
    ]);
  });

  it('can drive a tick from ingest-backed context building', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-ingest-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () =>
        buildLiveCycleInputFromIngest({
          strategy: 'new-token-v1',
          traderWallet: 'wallet-1',
          requestedPositionSol: 0.1,
          safetyFilterConfig: { disabled: true, minHolders: 1000, minBluechipPct: 0.8, minSafetyScore: 0 },
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [
              { mint: 'mint-safe', symbol: 'SAFE', amount: 1 }
            ],
            journalTokens: [
              { mint: 'mint-safe', symbol: 'SAFE', amount: 1 }
            ],
            fills: []
          },
          now: new Date('2026-03-22T10:00:00'),
          fetchMeteoraPoolsImpl: async () => [
            {
              address: 'pool-safe',
              baseMint: 'mint-safe',
              quoteMint: 'So11111111111111111111111111111111111111112',
              baseSymbol: 'SAFE',
              liquidityUsd: 10_000,
              volume_5m: 5_000,
              updatedAt: '2026-03-22T09:59:00.000Z'
            }
          ],
          fetchPumpTradesImpl: async () => [
            {
              mint: 'mint-safe',
              symbol: 'SAFE',
              holders: 40,
              timestamp: '2026-03-22T09:58:00.000Z'
            },
            {
              wallet: 'wallet-1',
              mint: 'mint-safe',
              side: 'buy',
              amount: 1,
              timestamp: '2026-03-22T09:59:30.000Z'
            }
          ]
        })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
      pendingSubmission: boolean;
    };

    expect(result.tickCount).toBe(1);
    expect(health.mode).toBe('healthy');
    expect(health.pendingSubmission).toBe(false);
  });

  it('recomputes runtime mode after a successful account tick clears reconcile failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-reconcile-recovery-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'reconcile-failures',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await runtimeStateStore.writeDependencyHealth({
      quote: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      signer: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      broadcaster: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      account: {
        consecutiveFailures: 2,
        lastSuccessAt: '',
        lastFailureAt: '2026-03-22T00:04:00.000Z',
        lastFailureReason: 'balance-mismatch'
      },
      confirmation: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' }
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountProvider: {
          readState: async () => ({
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            fills: []
          })
        },
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false },
          token: { mint: '', symbol: '', inSession: true, hasSolRoute: false },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const health = await runtimeStateStore.readHealthReport();

    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: ''
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      allowNewOpens: true,
      dependencyHealth: {
        reconcileFailures: 0
      }
    });
  });

  it('clears unknown broadcast pending and recovers from timeout once full LP evidence appears on-chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-unknown-open-recovery-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'timeout',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await runtimeStateStore.writePositionState({
      allowNewOpens: false,
      flattenOnly: false,
      lastAction: 'hold',
      lastReason: 'pending-submission-timeout',
      activeMint: '',
      lifecycleState: 'closed',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-open',
      submissionId: '',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:30:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      orderAction: 'add-lp',
      reason: 'broadcast-outcome-unknown'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        accountProvider: {
          readState: async () => ({
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            walletLpPositions: [
              {
                poolAddress: 'pool-1',
                positionAddress: 'pos-1',
                mint: 'mint-safe',
                binCount: 69,
                fundedBinCount: 69,
                hasLiquidity: true
              }
            ],
            journalLpPositions: [
              {
                poolAddress: 'pool-1',
                positionAddress: 'pos-1',
                mint: 'mint-safe',
                binCount: 69,
                fundedBinCount: 69,
                hasLiquidity: true
              }
            ],
            fills: []
          })
        },
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          fills: []
        },
        requestedPositionSol: 0.1,
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const positionState = await runtimeStateStore.readPositionState();
    const health = await runtimeStateStore.readHealthReport();

    await expect(readFile(join(stateRootDir, 'pending-submission.json'), 'utf8')).rejects.toThrow();
    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: ''
    });
    expect(positionState).toMatchObject({
      allowNewOpens: true,
      lifecycleState: 'open'
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      pendingSubmission: false
    });
  });

  it('recovers unknown pending from provider-fetched account state and clears timeout circuit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-provider-open-recovery-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'timeout',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await runtimeStateStore.writePositionState({
      allowNewOpens: false,
      flattenOnly: false,
      lastAction: 'hold',
      lastReason: 'pending-submission-timeout',
      activeMint: '',
      lifecycleState: 'closed',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-provider-open',
      submissionId: '',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:30:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-1',
      orderAction: 'add-lp',
      reason: 'broadcast-outcome-unknown'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        accountProvider: {
          readState: async () => ({
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            walletLpPositions: [
              {
                poolAddress: 'pool-1',
                positionAddress: 'pos-1',
                mint: 'mint-safe',
                binCount: 69,
                fundedBinCount: 69,
                hasLiquidity: true
              }
            ],
            journalLpPositions: [
              {
                poolAddress: 'pool-1',
                positionAddress: 'pos-1',
                mint: 'mint-safe',
                binCount: 69,
                fundedBinCount: 69,
                hasLiquidity: true
              }
            ],
            fills: []
          })
        },
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: 'mint-safe', symbol: 'SAFE', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const positionState = await runtimeStateStore.readPositionState();
    const health = await runtimeStateStore.readHealthReport();

    await expect(pendingSubmissionStore.read()).resolves.toBeNull();
    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: ''
    });
    expect(positionState).toMatchObject({
      allowNewOpens: true,
      lifecycleState: 'open'
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      pendingSubmission: false
    });
  });

  it('recovers unknown LP pending from pool-address evidence even when token mint is missing locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-pool-recovery-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'timeout',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-open-pool',
      submissionId: '',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:30:00.000Z',
      tokenMint: '',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-1',
      orderAction: 'add-lp',
      reason: 'broadcast-outcome-unknown'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          fills: []
        },
        requestedPositionSol: 0.1,
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const health = await runtimeStateStore.readHealthReport();

    await expect(pendingSubmissionStore.read()).resolves.toBeNull();
    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: ''
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      pendingSubmission: false
    });
  });

  it('recovers legacy unknown LP pending without orderAction once full LP evidence exists on-chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-legacy-open-recovery-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'timeout',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await runtimeStateStore.writePositionState({
      allowNewOpens: false,
      flattenOnly: false,
      lastAction: 'hold',
      lastReason: 'pending-submission-timeout',
      activeMint: '',
      lifecycleState: 'closed',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'legacy-k-open',
      submissionId: '',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:30:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      reason: 'broadcast-outcome-unknown'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          fills: []
        },
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: 'mint-safe', symbol: 'SAFE', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const positionState = await runtimeStateStore.readPositionState();
    const health = await runtimeStateStore.readHealthReport();

    await expect(pendingSubmissionStore.read()).resolves.toBeNull();
    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: ''
    });
    expect(positionState).toMatchObject({
      allowNewOpens: true,
      lifecycleState: 'open'
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      pendingSubmission: false
    });
  });

  it('clears recoverable unknown pending before buildCycleInput runs, even if ingest/build fails afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-pre-ingest-recovery-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'timeout',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await runtimeStateStore.writePositionState({
      allowNewOpens: false,
      flattenOnly: false,
      lastAction: 'hold',
      lastReason: 'pending-submission-timeout',
      activeMint: '',
      lifecycleState: 'closed',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'legacy-k-open',
      submissionId: '',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:30:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      reason: 'broadcast-outcome-unknown'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: {
        readState: async () => ({
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              binCount: 69,
              fundedBinCount: 69,
              hasLiquidity: true
            }
          ],
          fills: []
        })
      },
      buildCycleInput: async () => {
        throw new Error('fetch failed');
      }
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const positionState = await runtimeStateStore.readPositionState();
    const health = await runtimeStateStore.readHealthReport();

    await expect(pendingSubmissionStore.read()).resolves.toBeNull();
    expect(runtimeState).toMatchObject({
      mode: 'circuit_open',
      circuitReason: 'fetch failed'
    });
    expect(positionState).toMatchObject({
      lifecycleState: 'open'
    });
    expect(health).toMatchObject({
      pendingSubmission: false
    });
  });

  it('auto-heals transient fetch-failed circuit state after two consecutive successful ticks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-fetch-auto-heal-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    let buildAttempts = 0;

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 3,
      buildCycleInput: async () => {
        buildAttempts += 1;
        if (buildAttempts === 1) {
          throw new Error('fetch failed');
        }

        return {
          requestedPositionSol: 0.1,
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            fills: []
          },
          context: {
            pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
          }
        };
      }
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const health = await runtimeStateStore.readHealthReport();

    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      transientRecoverySuccessTicks: 0
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      allowNewOpens: true
    });
  });

  it('auto-heals legacy fetch-failed circuit state even when eligibility flag was not persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-legacy-fetch-auto-heal-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'fetch failed',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      transientAutoHealEligible: false,
      transientRecoverySuccessTicks: 0,
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 2,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const health = await runtimeStateStore.readHealthReport();

    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      transientAutoHealEligible: false,
      transientRecoverySuccessTicks: 0
    });
    expect(health).toMatchObject({
      mode: 'healthy',
      allowNewOpens: true
    });
  });

  it('auto-heals transient account timeout circuit state after two consecutive successful ticks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-account-timeout-auto-heal-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    let buildAttempts = 0;

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 3,
      buildCycleInput: async () => {
        buildAttempts += 1;
        if (buildAttempts === 1) {
          throw new ExecutionRequestError(
            'account',
            { kind: 'transient', reason: 'timeout', retryable: true }
          );
        }

        return {
          requestedPositionSol: 0.1,
          accountProvider: {
            readState: async () => ({
              walletSol: 1.25,
              journalSol: 1.25,
              walletTokens: [],
              journalTokens: [],
              fills: []
            })
          },
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            fills: []
          },
          context: {
            pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
          }
        };
      }
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const dependencyHealth = await runtimeStateStore.readDependencyHealth();
    const health = await runtimeStateStore.readHealthReport();

    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      transientRecoverySuccessTicks: 0
    });
    expect(dependencyHealth?.account.consecutiveFailures).toBe(0);
    expect(health).toMatchObject({
      mode: 'healthy',
      allowNewOpens: true,
      dependencyHealth: {
        reconcileFailures: 0
      }
    });
  });

  it('auto-heals legacy account http-400 circuit state after two consecutive successful ticks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-account-http400-auto-heal-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'http-400',
      cooldownUntil: '2026-03-22T00:10:00.000Z',
      transientAutoHealEligible: false,
      transientRecoverySuccessTicks: 0,
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:05:00.000Z'
    });
    await runtimeStateStore.writeDependencyHealth({
      quote: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      signer: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      broadcaster: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      account: { consecutiveFailures: 1, lastSuccessAt: '', lastFailureAt: '2026-03-22T00:05:00.000Z', lastFailureReason: 'http-400' },
      confirmation: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' }
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 2,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
        }
      })
    });

    const runtimeState = await runtimeStateStore.readRuntimeState();
    const dependencyHealth = await runtimeStateStore.readDependencyHealth();
    const health = await runtimeStateStore.readHealthReport();

    expect(runtimeState).toMatchObject({
      mode: 'healthy',
      circuitReason: '',
      cooldownUntil: '',
      transientRecoverySuccessTicks: 0
    });
    expect(dependencyHealth?.account.consecutiveFailures).toBe(0);
    expect(health).toMatchObject({
      mode: 'healthy',
      allowNewOpens: true,
      dependencyHealth: {
        reconcileFailures: 0
      }
    });
  });

  it('keeps the daemon ticking when the mirror runtime degrades', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-mirror-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    let flushes = 0;

    const result = await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      mirrorRuntime: {
        enqueue() {},
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => {
          flushes += 1;
          return false;
        },
        snapshot: () => ({
          enabled: true,
          state: 'open',
          path: join(root, 'mirror.sqlite'),
          queueDepth: 3,
          queueCapacity: 1000,
          droppedEvents: 1,
          droppedLowPriority: 1,
          consecutiveFailures: 3,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '2026-03-22T00:10:00.000Z',
          lastError: 'db locked'
        })
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const health = JSON.parse(await readFile(join(stateRootDir, 'health.json'), 'utf8')) as {
      mode: string;
      mirror?: {
        state: string;
      };
    };

    expect(result.tickCount).toBe(1);
    expect(flushes).toBe(1);
    expect(health.mode).toBe('healthy');
    expect(health.mirror?.state).toBe('open');
  });

  it('persists submitted open actions as open_pending until inventory or confirmation evidence exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-open-pending-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(positionState).toMatchObject({
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      lifecycleState: 'open_pending'
    });
  });

  it('blocks repeated add-lp while same mint remains open_pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-open-pending-guard-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      lifecycleState: 'open_pending',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-03-22T00:00:00.000Z'
    });

    await appendJsonLine(join(stateRootDir, 'pending-submission.json'), {
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-pending',
      submissionId: 'sub-pending',
      confirmationSignature: 'tx-pending',
      confirmationStatus: 'submitted',
      finality: 'unknown',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      orderAction: 'add-lp',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2099-03-22T00:02:00.000Z'
    }, { rotateDaily: false });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        confirmationProvider: {
          poll: async () => ({
            submissionId: 'sub-pending',
            confirmationSignature: 'tx-pending',
            status: 'submitted',
            finality: 'unknown',
            checkedAt: '2026-03-22T00:00:02.000Z'
          })
        },
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: { hasInventory: false, hasLpPosition: false, lifecycleState: 'open_pending' },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(positionState).toMatchObject({
      lastAction: 'hold',
      lastReason: 'mint-open-pending-recovery:mint-safe',
      activeMint: 'mint-safe',
      lifecycleState: 'open_pending'
    });
  });

  it('preserves the active LP target when a hold tick sees a different candidate pool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-stable-lp-target-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-open',
      activePoolAddress: 'pool-open',
      lifecycleState: 'open',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-open',
      openedAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        runtimeMode: 'paused',
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-open',
              positionAddress: 'pos-open',
              mint: 'mint-open',
              currentValueSol: 0.1,
              unclaimedFeeSol: 0,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [],
          fills: [{
            submissionId: 'sub-open',
            mint: 'mint-open',
            side: 'add-lp' as const,
            amount: 0.1,
            filledSol: 0.1,
            actualFilledSol: 0.1,
            actualWalletDeltaSol: 0.1,
            fillAmountSource: 'wallet-delta' as const,
            hasFillEvidence: true,
            recordedAt: '2026-04-18T00:00:00.000Z'
          }]
        },
        context: {
          pool: { address: 'pool-selected-other', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-other', inSession: true, hasSolRoute: true, symbol: 'OTHER', score: 90 },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50, poolAddress: 'pool-selected-other' }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(positionState).toMatchObject({
      lastAction: 'hold',
      lastReason: 'runtime-paused',
      activeMint: 'mint-open',
      activePoolAddress: 'pool-open',
      lifecycleState: 'open',
      entrySol: 0.1,
      openedAt: '2026-04-18T00:00:00.000Z'
    });
  });

  it('recovers a missing active mint from the bound account LP position', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-recover-active-mint-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: '',
      activePoolAddress: 'pool-open',
      positionId: 'pos-open',
      chainPositionAddress: 'pos-open',
      lifecycleState: 'open',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-open',
      openedAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        runtimeMode: 'paused',
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-open',
              positionAddress: 'pos-open',
              mint: 'mint-open',
              currentValueSol: 0.1,
              unclaimedFeeSol: 0,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [],
          fills: [{
            submissionId: 'sub-open',
            mint: 'mint-open',
            side: 'add-lp' as const,
            amount: 0.1,
            filledSol: 0.1,
            actualFilledSol: 0.1,
            actualWalletDeltaSol: 0.1,
            fillAmountSource: 'wallet-delta' as const,
            hasFillEvidence: true,
            recordedAt: '2026-04-18T00:00:00.000Z'
          }]
        },
        context: {
          pool: { address: 'pool-selected-other', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-other', inSession: true, hasSolRoute: true, symbol: 'OTHER', score: 90 },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50, poolAddress: 'pool-selected-other' }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();

    expect(positionState).toMatchObject({
      lastAction: 'hold',
      lastReason: 'runtime-paused',
      activeMint: 'mint-open',
      activePoolAddress: 'pool-open',
      positionId: 'pos-open',
      chainPositionAddress: 'pos-open',
      lifecycleState: 'open',
      entrySol: 0.1,
      openedAt: '2026-04-18T00:00:00.000Z'
    });
  });

  it('does not fabricate LP entry metadata during recovery when no trusted bound fill exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-orphaned-lp-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-1',
      lifecycleState: 'open',
      lastClosedMint: '',
      lastClosedAt: '',
      updatedAt: '2026-04-18T00:00:00.000Z'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              currentValueSol: 0.7,
              unclaimedFeeSol: 0.1,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-safe',
              currentValueSol: 0.7,
              unclaimedFeeSol: 0.1,
              hasLiquidity: true
            }
          ],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: false, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            lpCurrentValueSol: 0.7,
            lpUnclaimedFeeSol: 0.1
          },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    expect(positionState).not.toBeNull();
    if (!positionState) {
      throw new Error('expected position state to be persisted');
    }

    expect(positionState.entrySol).toBeUndefined();
    expect(positionState.openedAt).toBeUndefined();
  });

  it('repairs legacy LP entry from trusted wallet-delta add-lp fill evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-repair-lp-entry-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = '2026-04-18T00:00:00.000Z';

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'live-order-submitted',
      activeMint: 'mint-fugu',
      activePoolAddress: 'pool-fugu',
      chainPositionAddress: 'pos-fugu',
      lifecycleState: 'open',
      entrySol: 0.02,
      openedAt,
      updatedAt: openedAt
    });

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-fills.jsonl'), {
      submissionId: 'sub-fugu-open',
      mint: 'mint-fugu',
        side: 'add-lp',
        amount: 0.077416045,
        filledSol: 0.077416045,
        actualFilledSol: 0.077416045,
        actualWalletDeltaSol: 0.077416045,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        chainPositionAddress: 'pos-fugu',
        recordedAt: openedAt
    }, {
      rotateDaily: true,
      now: new Date(openedAt)
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        runtimeMode: 'paused',
        requestedPositionSol: 0.02,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-fugu',
              positionAddress: 'pos-fugu',
              mint: 'mint-fugu',
              currentValueSol: 0.04,
              unclaimedFeeSol: 0,
              hasLiquidity: true
            }
          ],
          journalLpPositions: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-fugu', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-fugu', inSession: true, hasSolRoute: true, symbol: 'FUGU', score: 90 },
          trader: { hasInventory: true, hasLpPosition: true },
          route: { hasSolRoute: true, expectedOutSol: 0.02, slippageBps: 50, poolAddress: 'pool-fugu' }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    expect(positionState).toMatchObject({
      activeMint: 'mint-fugu',
      activePoolAddress: 'pool-fugu',
      lifecycleState: 'open',
      entrySol: 0.077416045,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-fugu-open',
      openedAt
    });
  });

  it('repairs orphaned LP entry from chain evidence and settles spending reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-chain-entry-repair-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const spendingStore = new SpendingLimitsStore(stateRootDir);
    const openedAt = '2026-04-18T00:00:00.000Z';
    const events: MirrorEvent[] = [];

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'orphaned-position-without-bound-entry',
      lastOrderIdempotencyKey: 'order-fugu-open',
      activeMint: 'mint-fugu',
      activePoolAddress: 'pool-fugu',
      chainPositionAddress: 'pos-fugu',
      lifecycleState: 'open',
      updatedAt: openedAt
    });
    await spendingStore.reserveSpend('order-fugu-open', 0.08);

    const evidenceProvider = {
      reconstructEntry: vi.fn(async () => ({
        status: 'trusted' as const,
        entrySol: 0.137416044,
        openedAt,
        signature: 'sig-fugu-open',
        source: 'reconstructed_chain' as const,
        poolAddress: 'pool-fugu',
        chainPositionAddress: 'pos-fugu'
      }))
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      lpEntryEvidenceProvider: evidenceProvider,
      mirrorRuntime: {
        enqueue(event) {
          events.push(event);
        },
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => true,
        snapshot: () => ({
          enabled: true,
          state: 'healthy',
          path: join(root, 'mirror.sqlite'),
          queueDepth: 0,
          queueCapacity: 64,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      },
      buildCycleInput: async () => ({
        runtimeMode: 'paused',
        requestedPositionSol: 0.08,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [{
            poolAddress: 'pool-fugu',
            positionAddress: 'pos-fugu',
            mint: 'mint-fugu',
            currentValueSol: 0.16,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          }],
          journalLpPositions: [],
          fills: []
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    const spendingState = await spendingStore.read();
    const fillPath = resolveActiveJsonlPath(
      join(journalRootDir, 'new-token-v1-live-fills.jsonl'),
      new Date(openedAt)
    );
    const fillLines = (await readFile(fillPath, 'utf8')).trim().split(/\r?\n/);
    const fills = fillLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(evidenceProvider.reconstructEntry).toHaveBeenCalledTimes(1);
    expect(positionState?.entrySol).toBeCloseTo(0.137416044);
    expect(positionState?.entrySolSource).toBe('reconstructed_chain');
    expect(positionState?.entryFillSubmissionId).toBe('sig-fugu-open');
    expect(spendingState.dailySpendSol).toBeCloseTo(0.137416044);
    expect(spendingState.hourlySpendSol).toBeCloseTo(0.137416044);
    expect(fills).toContainEqual(expect.objectContaining({
      submissionId: 'sig-fugu-open',
      side: 'add-lp',
      filledSol: 0.137416044,
      fillAmountSource: 'chain-reconstructed',
      hasFillEvidence: true
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'fill',
      payload: expect.objectContaining({
        submissionId: 'sig-fugu-open',
        filledSol: 0.137416044,
        fillAmountSource: 'chain-reconstructed',
        hasFillEvidence: true
      })
    }));
    });

    it('clears a trusted LP entry bound to another mint before reconstructing the active chain position', async () => {
      const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-entry-mismatch-repair-'));
      const stateRootDir = join(root, 'state');
      const journalRootDir = join(root, 'journals');
      const runtimeStateStore = new RuntimeStateStore(stateRootDir);
      const questOpenedAt = '2026-06-24T14:40:02.959Z';
      const condorOpenedAt = '2026-06-24T15:00:40.000Z';

      await runtimeStateStore.writePositionState({
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        lastReason: 'live-order-submitted',
        activeMint: 'mint-condor',
        activePoolAddress: 'pool-condor',
        chainPositionAddress: 'pos-condor',
        lifecycleState: 'open',
        entrySol: 0.107416045,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-quest-open',
        openedAt: questOpenedAt,
        updatedAt: condorOpenedAt
      });

      await appendJsonLine(join(journalRootDir, 'new-token-v1-live-fills.jsonl'), {
        submissionId: 'sub-quest-open',
        mint: 'mint-quest',
        side: 'add-lp',
        amount: 0.107416045,
        filledSol: 0.107416045,
        actualFilledSol: 0.107416045,
        actualWalletDeltaSol: 0.107416045,
        fillAmountSource: 'wallet-delta',
        hasFillEvidence: true,
        chainPositionAddress: 'pos-quest',
        recordedAt: questOpenedAt
      }, {
        rotateDaily: true,
        now: new Date(questOpenedAt)
      });

      const evidenceProvider = {
        reconstructEntry: vi.fn(async () => ({
          status: 'trusted' as const,
          entrySol: 0.077416045,
          openedAt: condorOpenedAt,
          signature: 'sig-condor-open',
          source: 'reconstructed_chain' as const,
          poolAddress: 'pool-condor',
          chainPositionAddress: 'pos-condor'
        }))
      };
      const accountState = {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-condor',
          positionAddress: 'pos-condor',
          mint: 'mint-condor',
          currentValueSol: 0.078,
          exitQuoteValueSol: 0.078,
          lpTotalValueSol: 0.078,
          valuationStatus: 'ready' as const,
          valuationTrust: 'exit_quote' as const,
          valuationCompleteness: 'complete' as const,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      };

      await runLiveDaemon({
        strategy: 'new-token-v1',
        stateRootDir,
        journalRootDir,
        tickIntervalMs: 1,
        maxTicks: 1,
        lpEntryEvidenceProvider: evidenceProvider,
        accountProvider: {
          readState: async () => accountState
        },
        buildCycleInput: async () => ({
          runtimeMode: 'paused',
          requestedPositionSol: 0.08,
          accountState
        })
      });

      const positionState = await runtimeStateStore.readPositionState();
      const incidentPath = resolveActiveJsonlPath(
        join(journalRootDir, 'new-token-v1-live-incidents.jsonl'),
        new Date()
      );
      const incidentLines = (await readFile(incidentPath, 'utf8')).trim().split(/\r?\n/);
      const incidents = incidentLines.map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(evidenceProvider.reconstructEntry).toHaveBeenCalledTimes(1);
      expect(positionState).toMatchObject({
        activeMint: 'mint-condor',
        activePoolAddress: 'pool-condor',
        chainPositionAddress: 'pos-condor',
        lifecycleState: 'open',
        entrySol: 0.077416045,
        entrySolSource: 'reconstructed_chain',
        entryFillSubmissionId: 'sig-condor-open',
        openedAt: condorOpenedAt,
        valuationStatus: 'ready',
        valuationTrust: 'exit_quote',
        valuationCompleteness: 'complete'
      });
      expect(incidents).toContainEqual(expect.objectContaining({
        reason: 'entry-fill-target-mismatch: trusted LP entry fill belongs to a different active mint',
        tokenMint: 'mint-condor',
        poolAddress: 'pool-condor',
        chainPositionAddress: 'pos-condor'
      }));
  });

  it('prefers trusted account open-fill evidence over stale persisted LP entry metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-stale-entry-account-fill-repair-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const staleOpenedAt = '2026-06-25T02:32:09.860Z';
    const realOpenedAt = '2026-06-25T02:25:44.622Z';

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'hold',
      lastReason: 'hold',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-safe',
      lifecycleState: 'open',
      entrySol: 0.137416044,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'stale-open',
      openedAt: staleOpenedAt,
      updatedAt: staleOpenedAt
    });

    const accountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [{
        poolAddress: 'pool-safe',
        positionAddress: 'current-position',
        mint: 'mint-safe',
        currentValueSol: 0.07740664,
        exitQuoteValueSol: 0.07740664,
        lpTotalValueSol: 0.07740664,
        liquidityValueSol: 0.019999289,
        unclaimedFeeValueSol: 0.000001271,
        recoverableRentSol: 0.05740608,
        valuationStatus: 'ready' as const,
        valuationTrust: 'exit_quote' as const,
        valuationCompleteness: 'complete' as const,
        hasLiquidity: true
      }],
      journalLpPositions: [],
      fills: [{
        submissionId: 'real-open',
        mint: 'mint-safe',
        side: 'add-lp' as const,
        amount: 0.077416045,
        actualFilledSol: 0.077416045,
        actualWalletDeltaSol: -0.077416045,
        fillAmountSource: 'wallet-delta' as const,
        hasFillEvidence: true,
        positionId: 'pool-safe:mint-safe',
        recordedAt: realOpenedAt
      }]
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      accountProvider: {
        readState: async () => accountState
      },
      buildCycleInput: async () => ({
        runtimeMode: 'paused',
        requestedPositionSol: 0.08,
        accountState
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    expect(positionState).toMatchObject({
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-safe',
      lifecycleState: 'open',
      entrySol: 0.077416045,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'real-open',
      openedAt: realOpenedAt
    });
  });

  it('does not keep an actual-fill LP entry when the fill evidence is missing locally', async () => {
      const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-entry-missing-evidence-repair-'));
      const stateRootDir = join(root, 'state');
      const journalRootDir = join(root, 'journals');
      const runtimeStateStore = new RuntimeStateStore(stateRootDir);
      const staleOpenedAt = '2026-06-24T15:11:38.375Z';
      const repairedOpenedAt = '2026-06-24T15:00:40.000Z';

      await runtimeStateStore.writePositionState({
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'hold',
        lastReason: 'hold',
        activeMint: 'mint-condor',
        activePoolAddress: 'pool-condor',
        chainPositionAddress: 'pos-condor',
        lifecycleState: 'open',
        entrySol: 0.107416045,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-missing-local-evidence',
        openedAt: staleOpenedAt,
        updatedAt: staleOpenedAt
      });

      const evidenceProvider = {
        reconstructEntry: vi.fn(async () => ({
          status: 'trusted' as const,
          entrySol: 0.077416045,
          openedAt: repairedOpenedAt,
          signature: 'sig-condor-reconstructed',
          source: 'reconstructed_chain' as const,
          poolAddress: 'pool-condor',
          chainPositionAddress: 'pos-condor'
        }))
      };
      const accountState = {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [{
          poolAddress: 'pool-condor',
          positionAddress: 'pos-condor',
          mint: 'mint-condor',
          currentValueSol: 0.078,
          exitQuoteValueSol: 0.078,
          lpTotalValueSol: 0.078,
          valuationStatus: 'ready' as const,
          valuationTrust: 'exit_quote' as const,
          valuationCompleteness: 'complete' as const,
          hasLiquidity: true
        }],
        journalLpPositions: [],
        fills: []
      };

      await runLiveDaemon({
        strategy: 'new-token-v1',
        stateRootDir,
        journalRootDir,
        tickIntervalMs: 1,
        maxTicks: 1,
        lpEntryEvidenceProvider: evidenceProvider,
        accountProvider: {
          readState: async () => accountState
        },
        buildCycleInput: async () => ({
          runtimeMode: 'paused',
          requestedPositionSol: 0.08,
          accountState
        })
      });

      const positionState = await runtimeStateStore.readPositionState();

      expect(evidenceProvider.reconstructEntry).toHaveBeenCalledTimes(1);
      expect(positionState).toMatchObject({
        activeMint: 'mint-condor',
        activePoolAddress: 'pool-condor',
        chainPositionAddress: 'pos-condor',
        lifecycleState: 'open',
        entrySol: 0.077416045,
        entrySolSource: 'reconstructed_chain',
        entryFillSubmissionId: 'sig-condor-reconstructed',
        openedAt: repairedOpenedAt
      });
    });

    it('does not mark reconstructed LP entry trusted when reconstructed fill mirroring fails', async () => {
      const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-chain-entry-mirror-failure-'));
      const stateRootDir = join(root, 'state');
      const journalRootDir = join(root, 'journals');
      const runtimeStateStore = new RuntimeStateStore(stateRootDir);
      const openedAt = '2026-04-18T00:00:00.000Z';
      const events: MirrorEvent[] = [];

      await runtimeStateStore.writePositionState({
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        lastReason: 'orphaned-position-without-bound-entry',
        lastOrderIdempotencyKey: 'order-fugu-open',
        activeMint: 'mint-fugu',
        activePoolAddress: 'pool-fugu',
        chainPositionAddress: 'pos-fugu',
        lifecycleState: 'open',
        updatedAt: openedAt
      });

      await runLiveDaemon({
        strategy: 'new-token-v1',
        stateRootDir,
        journalRootDir,
        tickIntervalMs: 1,
        maxTicks: 1,
        lpEntryEvidenceProvider: {
          reconstructEntry: vi.fn(async () => ({
            status: 'trusted' as const,
            entrySol: 0.137416044,
            openedAt,
            signature: 'sig-fugu-open',
            source: 'reconstructed_chain' as const,
            poolAddress: 'pool-fugu',
            chainPositionAddress: 'pos-fugu'
          }))
        },
        mirrorRuntime: {
          enqueue(event) {
            if (event.type === 'fill') {
              throw new Error('mirror-fill-failed');
            }
            events.push(event);
          },
          start: async () => {},
          stop: async () => {},
          flushOnce: async () => true,
          snapshot: () => ({
            enabled: true,
            state: 'healthy',
            path: join(root, 'mirror.sqlite'),
            queueDepth: 0,
            queueCapacity: 64,
            droppedEvents: 0,
            droppedLowPriority: 0,
            consecutiveFailures: 0,
            lastFlushAt: '',
            lastFlushLatencyMs: 0,
            cooldownUntil: '',
            lastError: ''
          })
        },
        buildCycleInput: async () => ({
          runtimeMode: 'paused',
          requestedPositionSol: 0.08,
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            walletLpPositions: [{
              poolAddress: 'pool-fugu',
              positionAddress: 'pos-fugu',
              mint: 'mint-fugu',
              currentValueSol: 0.16,
              unclaimedFeeSol: 0,
              hasLiquidity: true
            }],
            journalLpPositions: [],
            fills: []
          }
        })
      });

      const positionState = await runtimeStateStore.readPositionState();

      expect(positionState?.entrySol).toBeUndefined();
      expect(positionState?.entrySolSource).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        type: 'incident',
        payload: expect.objectContaining({
          reason: 'orphaned-position-without-bound-entry: active LP entry reconstruction failed'
        })
      }));
    });

    it('keeps orphaned LP entry unresolved when chain evidence is ambiguous and records an incident', async () => {
      const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-chain-entry-ambiguous-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'orphaned-position-without-bound-entry',
      activeMint: 'mint-fugu',
      activePoolAddress: 'pool-fugu',
      chainPositionAddress: 'pos-fugu',
      lifecycleState: 'open',
      updatedAt: '2026-04-18T00:00:00.000Z'
    });

    const evidenceProvider = {
      reconstructEntry: vi.fn(async () => ({
        status: 'ambiguous' as const,
        reason: 'multiple matching LP entry transactions',
        candidates: [
          { entrySol: 0.08, signature: 'sig-1' },
          { entrySol: 0.137416044, signature: 'sig-2' }
        ]
      }))
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      lpEntryEvidenceProvider: evidenceProvider,
      buildCycleInput: async () => ({
        runtimeMode: 'paused',
        requestedPositionSol: 0.08,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [{
            poolAddress: 'pool-fugu',
            positionAddress: 'pos-fugu',
            mint: 'mint-fugu',
            currentValueSol: 0.16,
            unclaimedFeeSol: 0,
            hasLiquidity: true
          }],
          journalLpPositions: [],
          fills: []
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    const incidentPath = resolveActiveJsonlPath(
      join(journalRootDir, 'new-token-v1-live-incidents.jsonl'),
      new Date()
    );
    const incidentLines = (await readFile(incidentPath, 'utf8')).trim().split(/\r?\n/);
    const incidents = incidentLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(evidenceProvider.reconstructEntry).toHaveBeenCalledTimes(1);
    expect(positionState?.entrySol).toBeUndefined();
    expect(positionState?.entrySolSource).toBeUndefined();
    expect(incidents).toContainEqual(expect.objectContaining({
      kind: 'entry_reconstruction_ambiguous',
      reason: expect.stringContaining('entry-reconstruction-ambiguous'),
      tokenMint: 'mint-fugu',
      poolAddress: 'pool-fugu'
    }));
  });

  it('persists canonical LP identity fields from pending submissions and bound chain positions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-lp-identity-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const pendingSubmissionStore = new PendingSubmissionStore(stateRootDir);

    await pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'idem-1',
      submissionId: 'sub-1',
      openIntentId: 'lp-open-intent:test-1',
      positionId: 'pool-1:mint-safe',
      confirmationStatus: 'submitted',
      finality: 'unknown',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:01.000Z',
      poolAddress: 'pool-1',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      orderAction: 'add-lp'
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-bound',
              mint: 'mint-safe',
              currentValueSol: 0.52,
              unclaimedFeeSol: 0.01,
              hasLiquidity: true,
              valuationStatus: 'ready',
              valuationReason: '',
              lastValuationAt: '2026-04-18T00:00:02.000Z'
            }
          ],
          journalLpPositions: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000, score: 90 },
          token: { mint: 'mint-safe', inSession: false, hasSolRoute: true, symbol: 'SAFE', score: 90 },
          trader: {
            hasInventory: true,
            hasLpPosition: true,
            lpCurrentValueSol: 0.52,
            lpUnclaimedFeeSol: 0.01
          },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    expect(positionState).not.toBeNull();
    if (!positionState) {
      throw new Error('expected position state to be persisted');
    }

    expect(positionState.openIntentId).toBe('lp-open-intent:test-1');
    expect(positionState.positionId).toBe('pos-bound');
    expect(positionState.chainPositionAddress).toBe('pos-bound');
    expect(positionState.valuationStatus).toBe('unavailable');
    expect(positionState.valuationReason).toBe('orphaned-position-without-bound-entry');
  });

  it('runs mirror catch-up during a healthy tick and advances the journal cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-catchup-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-orders.jsonl'), {
      cycleId: 'cycle-preexisting',
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-preexisting',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      requestedPositionSol: 0.1,
      quotedOutputSol: 0.1,
      createdAt: '2026-03-22T00:00:00.000Z'
    }, {
      rotateDaily: true,
      now: new Date()
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      mirrorRuntime: {
        enqueue(event) {
          events.push(event);
        },
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => true,
        snapshot: () => ({
          enabled: true,
          state: 'healthy',
          path: join(root, 'mirror.sqlite'),
          queueDepth: 0,
          queueCapacity: 64,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const cursor = JSON.parse(
      await readFile(join(stateRootDir, 'mirror-cursor.json'), 'utf8')
    ) as {
      offsets: Record<string, number>;
    };

    expect(events.some((event) => event.type === 'order' && event.priority === 'low')).toBe(true);
    expect(Object.values(cursor.offsets).some((value) => value > 0)).toBe(true);
  });

  it('emits a runtime snapshot mirror event with wallet and LP equity summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-equity-snapshot-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const events: MirrorEvent[] = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      mirrorRuntime: {
        enqueue(event) {
          events.push(event);
        },
        start: async () => {},
        stop: async () => {},
        flushOnce: async () => true,
        snapshot: () => ({
          enabled: true,
          state: 'healthy',
          path: join(root, 'mirror.sqlite'),
          queueDepth: 0,
          queueCapacity: 64,
          droppedEvents: 0,
          droppedLowPriority: 0,
          consecutiveFailures: 0,
          lastFlushAt: '',
          lastFlushLatencyMs: 0,
          cooldownUntil: '',
          lastError: ''
        })
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.2,
          journalSol: 1.2,
          walletLpPositions: [
            {
              poolAddress: 'pool-1',
              positionAddress: 'pos-1',
              mint: 'mint-1',
              currentValueSol: 0.7,
              unclaimedFeeSol: 0.04,
              hasLiquidity: true
            },
            {
              poolAddress: 'pool-2',
              positionAddress: 'pos-2',
              mint: 'mint-2',
              currentValueSol: 0.3,
              unclaimedFeeSol: 0.01,
              hasLiquidity: true
            }
          ],
          walletTokens: [],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: '', liquidityUsd: 0, hasSolRoute: false },
          token: { mint: '', symbol: '', inSession: true, hasSolRoute: false },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    const snapshotEvent = events.find((event) => event.type === 'runtime_snapshot');

    expect(snapshotEvent).toMatchObject({
      type: 'runtime_snapshot',
      payload: {
        walletSol: 1.2,
        lpValueSol: 1.0,
        unclaimedFeeSol: 0.05,
        netWorthSol: 2.2,
        openPositionCount: 2
      }
    });
  });

  it('proves the staged exit chain withdraw-lp -> inventory -> dca-out across ticks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-exit-chain-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);

    const accountStates = [
      {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        fills: []
      },
      {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 1200 }],
        journalTokens: [{ mint: 'mint-safe', symbol: 'SAFE', amount: 1200 }],
        fills: [{
          submissionId: 'sub-1',
          confirmationSignature: 'tx-1',
          mint: 'mint-safe',
          symbol: 'SAFE',
          side: 'buy' as const,
          amount: 1200,
          recordedAt: '2026-03-22T00:00:02.000Z'
        }]
      }
    ];

    let tick = 0;
    const seenActions: string[] = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 2,
      buildCycleInput: async () => {
        const current = tick;
        tick += 1;
        const accountState = accountStates[Math.min(current, accountStates.length - 1)];

        return {
          requestedPositionSol: 0.1,
          accountState,
          context: {
            pool: { address: 'pool-1', liquidityUsd: 10_000 },
            token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
            trader: current === 0
              ? { hasInventory: false, hasLpPosition: true, lpSolDepletedBins: 61 }
              : { hasInventory: true, hasLpPosition: false },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          },
          signer: {
            sign: async (intent) => ({
              intent,
              signerId: 'test-signer',
              signedAt: '2026-03-22T00:00:01.000Z',
              signature: 'sig'
            })
          },
          broadcaster: {
            broadcast: async (signedIntent) => {
              seenActions.push(signedIntent.intent.side ?? 'unknown');
              return {
                status: 'submitted' as const,
                submissionId: `sub-${current + 1}`,
                idempotencyKey: signedIntent.intent.idempotencyKey,
                confirmationSignature: `tx-${current + 1}`
              };
            }
          },
          confirmationProvider: {
            poll: async ({ submissionId, confirmationSignature }) => ({
              submissionId,
              confirmationSignature,
              status: 'confirmed' as const,
              finality: 'finalized' as const,
              checkedAt: '2026-03-22T00:00:02.000Z'
            })
          }
        };
      }
    });

    const ordersRaw = await readFile(
      resolveActiveJsonlPath(join(journalRootDir, 'new-token-v1-live-orders.jsonl')),
      'utf8'
    );
    const orders = ordersRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) as Array<{ side: string }>;
    const positionState = await runtimeStateStore.readPositionState();

    expect(seenActions).toEqual(['withdraw-lp', 'sell']);
    expect(orders.map((order) => order.side)).toEqual(['withdraw-lp', 'sell']);
    expect(positionState?.lastAction).toBe('dca-out');
  });

  it('keeps close state pending when confirmed withdraw lacks fill evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-close-evidence-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = '2026-03-22T00:00:00.000Z';

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-1',
      lifecycleState: 'open',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-open',
      openedAt,
      chainPositionAddress: 'pos-1',
      updatedAt: openedAt
    });

    const accountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [{
        poolAddress: 'pool-1',
        positionAddress: 'pos-1',
        mint: 'mint-safe',
        lowerBinId: 100,
        upperBinId: 168,
        activeBinId: 165,
        solSide: 'tokenX' as const,
        solDepletedBins: 65,
        hasLiquidity: true
      }],
      journalLpPositions: [],
      fills: [{
        submissionId: 'sub-open',
        mint: 'mint-safe',
        side: 'add-lp' as const,
        amount: 0.1,
        filledSol: 0.1,
        actualFilledSol: 0.1,
        actualWalletDeltaSol: 0.1,
        fillAmountSource: 'wallet-delta' as const,
        hasFillEvidence: true,
        recordedAt: openedAt
      }]
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState,
        accountProvider: {
          readState: async () => accountState
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        },
        signer: {
          sign: async (intent) => ({
            intent,
            signerId: 'test-signer',
            signedAt: '2026-03-22T00:00:01.000Z',
            signature: 'sig'
          })
        },
        broadcaster: {
          broadcast: async (signedIntent) => ({
            status: 'submitted' as const,
            submissionId: 'sub-close',
            idempotencyKey: signedIntent.intent.idempotencyKey,
            confirmationSignature: 'tx-close'
          })
        },
        confirmationProvider: {
          poll: async ({ submissionId, confirmationSignature }) => ({
            submissionId,
            confirmationSignature,
            status: 'confirmed' as const,
            finality: 'finalized' as const,
            checkedAt: '2026-03-22T00:00:02.000Z'
          })
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    const pendingSubmission = await new PendingSubmissionStore(stateRootDir).read();

    expect(pendingSubmission).toBeNull();
    expect(positionState).toMatchObject({
      lastAction: 'withdraw-lp',
      lifecycleState: 'lp_exit_pending',
      activeMint: 'mint-safe',
      activePoolAddress: 'pool-1',
      chainPositionAddress: 'pos-1',
      entrySol: 0.1,
      openedAt
    });
  });

  it('records closed mint and clears active target when a confirmed withdraw-lp leaves no matching LP in the account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-full-exit-closed-mint-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const openedAt = new Date(Date.now() - 19 * 60 * 60 * 1000).toISOString();

    await runtimeStateStore.writePositionState({
      allowNewOpens: true,
      flattenOnly: false,
      lastAction: 'add-lp',
      lastReason: 'lp-open-approved',
      activeMint: 'mint-closing',
      activePoolAddress: 'pool-closing',
      chainPositionAddress: 'pos-closing',
      lifecycleState: 'open',
      entrySol: 0.1,
      entrySolSource: 'actual_fill',
      entryFillSubmissionId: 'sub-open',
      openedAt,
      updatedAt: openedAt
    });

    const accountState = {
      walletSol: 1.25,
      journalSol: 1.25,
      walletTokens: [],
      journalTokens: [],
      walletLpPositions: [{
        poolAddress: 'pool-other',
        positionAddress: 'pos-other',
        mint: 'mint-other',
        lowerBinId: 100,
        upperBinId: 168,
        activeBinId: 165,
        solSide: 'tokenX' as const,
        solDepletedBins: 0,
        hasLiquidity: true
      }],
      journalLpPositions: [{
        poolAddress: 'pool-other',
        positionAddress: 'pos-other',
        mint: 'mint-other',
        lowerBinId: 100,
        upperBinId: 168,
        activeBinId: 165,
        solSide: 'tokenX' as const,
        solDepletedBins: 0,
        hasLiquidity: true
      }],
      fills: []
    };

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      maxTicks: 1,
      buildCycleInput: async () => ({
        reconciliationStatus: 'matched' as const,
        requestedPositionSol: 0.1,
        accountState,
        accountProvider: {
          readState: async () => accountState
        },
        context: {
          pool: { address: 'pool-closing', liquidityUsd: 10_000 },
          token: { mint: 'mint-closing', inSession: true, hasSolRoute: true, symbol: 'CLOSE' },
          trader: { hasInventory: false, hasLpPosition: true, lpSolDepletedBins: 61 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        },
        signer: {
          sign: async (intent: any) => ({
            intent,
            signerId: 'test-signer',
            signedAt: '2026-03-22T00:00:01.000Z',
            signature: 'sig'
          })
        },
        broadcaster: {
          broadcast: async (signedIntent: any) => ({
            status: 'submitted' as const,
            submissionId: 'sub-close',
            idempotencyKey: signedIntent.intent.idempotencyKey,
            confirmationSignature: 'tx-close'
          })
        },
        confirmationProvider: {
          poll: async ({ submissionId, confirmationSignature }: any) => ({
            submissionId,
            confirmationSignature,
            status: 'confirmed' as const,
            finality: 'finalized' as const,
            checkedAt: '2026-03-22T00:00:02.000Z'
          })
        }
      })
    });

    const positionState = await runtimeStateStore.readPositionState();
    const health = await runtimeStateStore.readHealthReport();

    expect(positionState).toMatchObject({
      lastAction: 'withdraw-lp',
      lastClosedMint: 'mint-closing',
      allowNewOpens: false
    });
    expect(health).toMatchObject({
      allowNewOpens: false
    });
    expect(positionState?.lastClosedAt).toBeTruthy();
  });

  it('runs maintenance sell sweeps from runtime wallet inventory and records mint cooldown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-maintenance-sweep-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const residualTokenSweepStore = new ResidualTokenSweepStore(stateRootDir);
    const seenMints: string[] = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      residualTokenSweepIntervalMs: 60_000,
      residualTokenSweepCooldownMs: 120_000,
      maxTicks: 2,
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [
            { mint: 'mint-maint-1', symbol: 'M1', amount: 10, currentValueSol: 0.35 },
            { mint: 'mint-maint-2', symbol: 'M2', amount: 8, currentValueSol: 0.2 }
          ],
          journalTokens: [],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: false, hasLpPosition: false },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        },
        signer: {
          sign: async (intent) => ({
            intent,
            signerId: 'maintenance-signer',
            signedAt: '2026-04-27T00:00:00.000Z',
            signature: 'maintenance-signature'
          })
        },
        broadcaster: {
          broadcast: async (signedIntent) => {
            seenMints.push(signedIntent.intent.tokenMint ?? '');
            return {
              status: 'submitted' as const,
              submissionId: `maintenance-${seenMints.length}`,
              idempotencyKey: signedIntent.intent.idempotencyKey,
              confirmationSignature: `maintenance-tx-${seenMints.length}`
            };
          }
        },
        confirmationProvider: {
          poll: async ({ submissionId, confirmationSignature }) => ({
            submissionId,
            confirmationSignature,
            status: 'confirmed' as const,
            finality: 'finalized' as const,
            checkedAt: '2026-04-27T00:00:01.000Z'
          })
        }
      })
    });

    const cooldown = await residualTokenSweepStore.readActive('mint-maint-1', '2000-01-01T00:00:00.000Z');

    expect(seenMints).toEqual(['mint-maint-1']);
    expect(cooldown).toMatchObject({ mint: 'mint-maint-1' });
    expect(await residualTokenSweepStore.readActive('mint-maint-2', '2000-01-01T00:00:00.000Z')).toBeNull();
  });

  it('honors mint cooldowns when the global maintenance sweep interval is due again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T00:00:00.000Z'));

    try {
      const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-maintenance-cooldown-'));
      const stateRootDir = join(root, 'state');
      const journalRootDir = join(root, 'journals');
      const seenMints: string[] = [];

      await runLiveDaemon({
        strategy: 'new-token-v1',
        stateRootDir,
        journalRootDir,
        tickIntervalMs: 1,
        residualTokenSweepIntervalMs: 1,
        residualTokenSweepCooldownMs: 60_000,
        maxTicks: 2,
        sleep: async () => {
          vi.advanceTimersByTime(5_000);
        },
        buildCycleInput: async () => ({
          requestedPositionSol: 0.1,
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [
              { mint: 'mint-maint-cooldown', symbol: 'MCD', amount: 10, currentValueSol: 0.4 }
            ],
            journalTokens: [],
            fills: []
          },
          context: {
            pool: { address: 'pool-1', liquidityUsd: 10_000 },
            token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
          },
          signer: {
            sign: async (intent) => ({
              intent,
              signerId: 'maintenance-signer',
              signedAt: '2026-04-27T00:00:00.000Z',
              signature: 'maintenance-signature'
            })
          },
          broadcaster: {
            broadcast: async (signedIntent) => {
              seenMints.push(signedIntent.intent.tokenMint ?? '');
              return {
                status: 'submitted' as const,
                submissionId: `maintenance-${seenMints.length}`,
                idempotencyKey: signedIntent.intent.idempotencyKey,
                confirmationSignature: `maintenance-tx-${seenMints.length}`
              };
            }
          },
          confirmationProvider: {
            poll: async ({ submissionId, confirmationSignature }) => ({
              submissionId,
              confirmationSignature,
              status: 'confirmed' as const,
              finality: 'finalized' as const,
              checkedAt: '2026-04-27T00:00:01.000Z'
            })
          }
        })
      });

      expect(seenMints).toEqual(['mint-maint-cooldown']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs maintenance sweep before ingest when runtime is circuit_open from fetch failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-pre-ingest-maintenance-sweep-'));
    const stateRootDir = join(root, 'state');
    const journalRootDir = join(root, 'journals');
    const runtimeStateStore = new RuntimeStateStore(stateRootDir);
    const residualTokenSweepStore = new ResidualTokenSweepStore(stateRootDir);
    const seenMints: string[] = [];

    await runtimeStateStore.writeRuntimeState({
      mode: 'circuit_open',
      circuitReason: 'fetch failed',
      cooldownUntil: '2099-01-01T00:00:00.000Z',
      transientAutoHealEligible: false,
      transientRecoverySuccessTicks: 0,
      lastHealthyAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z'
    });
    await runtimeStateStore.writeDependencyHealth({
      quote: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      signer: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      broadcaster: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' },
      account: { consecutiveFailures: 1, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: 'fetch failed' },
      confirmation: { consecutiveFailures: 0, lastSuccessAt: '', lastFailureAt: '', lastFailureReason: '' }
    });

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir,
      journalRootDir,
      tickIntervalMs: 1,
      residualTokenSweepIntervalMs: 60_000,
      residualTokenSweepCooldownMs: 120_000,
      residualTokenSweepMinValueSol: 0.2,
      maxTicks: 1,
      accountProvider: {
        readState: async () => ({
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [
            { mint: 'mint-pre-ingest-maint', symbol: 'PIM', amount: 10, currentValueSol: 0.35 }
          ],
          journalTokens: [],
          fills: []
        })
      },
      signer: {
        sign: async (intent) => ({
          intent,
          signerId: 'maintenance-signer',
          signedAt: '2026-04-27T00:00:00.000Z',
          signature: 'maintenance-signature'
        })
      },
      broadcaster: {
        broadcast: async (signedIntent) => {
          seenMints.push(signedIntent.intent.tokenMint ?? '');
          return {
            status: 'submitted' as const,
            submissionId: 'maintenance-1',
            idempotencyKey: signedIntent.intent.idempotencyKey,
            confirmationSignature: 'maintenance-tx-1'
          };
        }
      },
      confirmationProvider: {
        poll: async ({ submissionId, confirmationSignature }) => ({
          submissionId,
          confirmationSignature,
          status: 'confirmed' as const,
          finality: 'finalized' as const,
          checkedAt: '2026-04-27T00:00:01.000Z'
        })
      },
      buildCycleInput: async () => {
        throw new Error('fetch failed');
      }
    });

    expect(seenMints).toEqual(['mint-pre-ingest-maint']);
    expect(await residualTokenSweepStore.readActive('mint-pre-ingest-maint', '2000-01-01T00:00:00.000Z')).toMatchObject({
      mint: 'mint-pre-ingest-maint'
    });
  });

  it('uses the hot polling interval when LP exit signals are near thresholds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-hot-interval-'));
    const waits: number[] = [];

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir: join(root, 'state'),
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 30_000,
      hotTickIntervalMs: 10_000,
      maxTicks: 2,
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      buildCycleInput: async () => ({
        requestedPositionSol: 0.1,
        accountState: {
          walletSol: 1.25,
          journalSol: 1.25,
          walletTokens: [],
          journalTokens: [],
          walletLpPositions: [{
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            hasLiquidity: true,
            solDepletedBins: 64
          }],
          journalLpPositions: [{
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            hasLiquidity: true,
            solDepletedBins: 64
          }],
          fills: []
        },
        context: {
          pool: { address: 'pool-1', liquidityUsd: 10_000 },
          token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: 27 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    expect(waits).toEqual([10_000]);
  });

  it('backs off polling when the tick fails with a rate-limited account error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-live-daemon-rate-limit-backoff-'));
    const waits: number[] = [];
    let attempts = 0;

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir: join(root, 'state'),
      journalRootDir: join(root, 'journals'),
      tickIntervalMs: 30_000,
      hotTickIntervalMs: 10_000,
      rateLimitBackoffIntervalMs: 60_000,
      maxTicks: 2,
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      buildCycleInput: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ExecutionRequestError('account', {
            kind: 'transient',
            reason: 'rate-limited',
            retryable: true
          });
        }

        return {
          requestedPositionSol: 0.1,
          accountState: {
            walletSol: 1.25,
            journalSol: 1.25,
            walletTokens: [],
            journalTokens: [],
            fills: []
          },
          context: {
            pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            token: { mint: '', symbol: '', inSession: true, hasSolRoute: false, blockReason: 'no-selected-candidate' },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
          }
        };
      }
    });

    expect(waits).toEqual([60_000]);
  });
});
