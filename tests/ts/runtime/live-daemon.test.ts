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
import { runLiveDaemon } from '../../../src/runtime/live-daemon';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import { RuntimeStateStore } from '../../../src/runtime/runtime-state-store';

describe('runLiveDaemon', () => {
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
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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

  it('warms the account provider once before the first tick', async () => {
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
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
          route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
        }
      })
    });

    expect(readState).toHaveBeenCalledTimes(1);
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
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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

    expect(outcomes).toEqual([
      expect.objectContaining({
        tokenMint: 'mint-safe',
        actualExitReason: 'lp-open-approved'
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
          trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
      timeoutAt: '2026-03-22T00:02:00.000Z'
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
        netWorthSol: 2.25,
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
              ? { hasInventory: false, hasLpPosition: true, lpNetPnlPct: -25 }
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
