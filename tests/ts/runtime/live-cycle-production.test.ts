import { rm } from 'node:fs/promises';

import { beforeEach, describe, expect, it } from 'vitest';

import { HttpLiveAccountStateProvider } from '../../../src/runtime/live-account-provider';
import { HttpLiveConfirmationProvider } from '../../../src/execution/http-live-confirmation-provider';
import { runLiveCycle } from '../../../src/runtime/live-cycle';
import { HttpLiveBroadcaster } from '../../../src/execution/http-live-broadcaster';
import { HttpLiveQuoteProvider } from '../../../src/execution/http-live-quote-provider';
import { HttpLiveSigner } from '../../../src/execution/http-live-signer';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import { readJsonLines } from '../../../src/journals/jsonl-writer';

describe('runLiveCycle production adapters', () => {
  beforeEach(async () => {
    await rm('tmp/tests/runtime-live-cycle-production', { recursive: true, force: true });
    await rm('tmp/tests/runtime-live-cycle-production-state', { recursive: true, force: true });
  });

  it('can run through injected http providers and surface confirmation status', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'pos-target',
        lifecycleState: 'open',
        entrySol: 0.1,
        openedAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      quoteProvider: new HttpLiveQuoteProvider({
        url: 'https://quote.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              routeExists: true,
              outputSol: 0.1,
              slippageBps: 50,
              quotedAt: '2026-03-21T00:00:00.000Z',
              stale: false
            }),
            { status: 200 }
          )
      }),
      signer: new HttpLiveSigner({
        url: 'https://sign.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              signerId: 'prod-signer',
              signedAt: '2026-03-21T00:00:01.000Z',
              signature: 'sig-1'
            }),
            { status: 200 }
          )
      }),
      broadcaster: new HttpLiveBroadcaster({
        url: 'https://broadcast.example/api',
        fetchImpl: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as { intent: { intent: { idempotencyKey: string } } };
          return (
          new Response(
            JSON.stringify({
              status: 'submitted',
              submissionId: 'sub-1',
              idempotencyKey: request.intent.intent.idempotencyKey,
              confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm'
            }),
            { status: 200 }
          )
          );
        }
      }),
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-1',
              confirmationSignature: '4x3i8gm3UnPDkrtwSM4XckYmfZ6U1JDpoMscWV7VV7aXKWpDKEyHf9quovnRhxidwvNpEdFHuVyzx3wzgc3mdupm',
              status: 'confirmed',
              finality: 'finalized',
              checkedAt: '2026-03-21T00:00:02.000Z'
            }),
            { status: 200 }
          )
      }),
      accountProvider: new HttpLiveAccountStateProvider({
        url: 'https://account.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              observedAt: new Date(Date.now() + 1_000).toISOString(),
              walletSol: 1.25,
              journalSol: 1.25,
              walletLpPositions: [],
              journalLpPositions: [],
              walletTokens: [],
              journalTokens: [],
              fills: []
            }),
            { status: 200 }
          )
      })
    });

    expect(result.mode).toBe('LIVE');
    expect(result.confirmationStatus).toBe('confirmed');
  });

  it('blocks when account reconciliation fails', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'pos-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountProvider: new HttpLiveAccountStateProvider({
        url: 'https://account.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              observedAt: new Date(Date.now() + 1_000).toISOString(),
              walletSol: 1.5,
              journalSol: 1.25,
              walletLpPositions: [],
              journalLpPositions: [],
              walletTokens: [],
              journalTokens: [],
              fills: []
            }),
            { status: 200 }
          )
      })
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('balance-mismatch');
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('allows reduce-risk LP exits during reconciliation mismatch when wallet exposure is present', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'pos-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountProvider: new HttpLiveAccountStateProvider({
        url: 'https://account.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              observedAt: new Date(Date.now() + 1_000).toISOString(),
              walletSol: 1.5,
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
                solSide: 'tokenX',
                solDepletedBins: 65,
                hasLiquidity: true
              }],
              journalLpPositions: [],
              fills: []
            }),
            { status: 200 }
          )
      })
    });

    const incidentJournal = await readJsonLines<Record<string, unknown>>(result.journalPaths.liveIncidentPath);

    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('withdraw-lp');
    expect(result.liveOrderSubmitted).toBe(true);
    expect(incidentJournal).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'reconciliation',
        severity: 'warning',
        reason: 'balance-mismatch:reduce-risk-allowed'
      })
    ]));
  });

  it('blocks reconciliation mismatch when wallet LP exposure belongs to a different pool', async () => {
    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountProvider: new HttpLiveAccountStateProvider({
        url: 'https://account.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              observedAt: new Date(Date.now() + 1_000).toISOString(),
              walletSol: 1.5,
              journalSol: 1.25,
              walletTokens: [],
              journalTokens: [],
              walletLpPositions: [{
                poolAddress: 'pool-other',
                positionAddress: 'pos-other',
                mint: 'mint-safe',
                lowerBinId: 100,
                upperBinId: 168,
                activeBinId: 105,
                solSide: 'tokenX',
                solDepletedBins: 0,
                hasLiquidity: true
              }],
              journalLpPositions: [],
              fills: []
            }),
            { status: 200 }
          )
      })
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.action).toBe('withdraw-lp');
    expect(result.reason).toBe('balance-mismatch');
    expect(result.liveOrderSubmitted).toBe(false);
  });

  it('blocks a follow-up submission when a prior submission is still pending recovery', async () => {
    const first = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'pos-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: new HttpLiveBroadcaster({
        url: 'https://broadcast.example/api',
        fetchImpl: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as { intent: { intent: { idempotencyKey: string } } };
          return (
          new Response(
            JSON.stringify({
              status: 'submitted',
              submissionId: 'sub-2',
              confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
              idempotencyKey: request.intent.intent.idempotencyKey
            }),
            { status: 200 }
          )
          );
        }
      })
    });

    const second = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      positionState: {
        allowNewOpens: true,
        flattenOnly: false,
        lastAction: 'add-lp',
        activeMint: 'mint-safe',
        activePoolAddress: 'pool-1',
        chainPositionAddress: 'pos-1',
        lifecycleState: 'open',
        entrySol: 0.1,
        entrySolSource: 'actual_fill',
        entryFillSubmissionId: 'sub-open',
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(first.confirmationStatus).toBe('submitted');
    expect(second.mode).toBe('BLOCKED');
    expect(second.reason).toBe('pending-submission-recovery-required');
    expect(second.failureSource).toBe('recovery');
  });

  it('recovers a finalized pending submission before allowing a new order', async () => {
    const store = new PendingSubmissionStore('tmp/tests/runtime-live-cycle-production-state');
    await store.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-old',
      submissionId: 'sub-old',
      confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
      confirmationStatus: 'submitted',
      finality: 'processed',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:05:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE'
    });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-old',
              confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
              status: 'confirmed',
              finality: 'finalized',
              checkedAt: '2026-03-22T00:01:00.000Z'
            }),
            { status: 200 }
          )
      }),
      broadcaster: new HttpLiveBroadcaster({
        url: 'https://broadcast.example/api',
        fetchImpl: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as { intent: { intent: { idempotencyKey: string } } };
          return (
          new Response(
            JSON.stringify({
              status: 'submitted',
              submissionId: 'sub-new',
              idempotencyKey: request.intent.intent.idempotencyKey,
              confirmationSignature: '5KcyrPXoh77aWuwnD7FP8bf9UT1313jajkZ3kBkwZgPAzEbNKGiXpo5Qf59JhZ1C1uSa12TFk2WYbmS1pnYjYioz'
            }),
            { status: 200 }
          )
          );
        }
      }),
      accountState: {
        observedAt: '2026-03-22T00:02:00.000Z',
        walletSol: 1.25,
        journalSol: 1.25,
        walletLpPositions: [],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    await expect(store.read()).resolves.toBeNull();
    expect(result.mode).toBe('LIVE');
    expect(result.confirmationStatus).toBe('confirmed');
  });

  it('does not reuse a cleared pending snapshot as mint-open evidence later in the same tick', async () => {
    const stateDir = 'tmp/tests/runtime-live-cycle-production-state';
    const store = new PendingSubmissionStore(stateDir);
    await store.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-old',
      submissionId: 'sub-old',
      confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
      confirmationStatus: 'submitted',
      finality: 'processed',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:05:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE'
    });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-old',
              confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
              status: 'confirmed',
              finality: 'finalized',
              checkedAt: '2026-03-22T00:01:00.000Z'
            }),
            { status: 200 }
          )
      }),
      accountState: {
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        fills: []
      }
    });

    await expect(store.read()).resolves.toBeNull();
    expect(result.reason).not.toContain('mint-position-already-active:mint-safe:pending-open:submitted');
    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('add-lp');
    expect(result.liveOrderSubmitted).toBe(true);
  });

  it('blocks and surfaces timeout when pending recovery cannot resolve in time', async () => {
    const store = new PendingSubmissionStore('tmp/tests/runtime-live-cycle-production-state');
    await store.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-old',
      submissionId: 'sub-old',
      confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
      confirmationStatus: 'submitted',
      finality: 'processed',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2020-03-22T00:00:30.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE'
    });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-old',
              confirmationSignature: '2hcGSu65JCe7Te6VyvnKGb43icU4WJ6FSGxyLhb4Zo66nmo13X2N2NbDWhirWCjiFBLpdgbZrcdxTgmojdku3o5u',
              status: 'submitted',
              finality: 'processed',
              checkedAt: '2026-03-22T00:01:00.000Z'
            }),
            { status: 200 }
          )
      })
    });

    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('pending-submission-timeout');
    expect(result.failureSource).toBe('recovery');
  });

  it('clears stale pending recovery before returning an ingest block fallback', async () => {
    const stateDir = 'tmp/tests/runtime-live-cycle-production-state';
    const store = new PendingSubmissionStore(stateDir);
    await store.write({
      strategyId: 'new-token-v1',
      idempotencyKey: 'k-old',
      submissionId: '',
      confirmationSignature: undefined,
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      timeoutAt: '2026-03-22T00:05:00.000Z',
      tokenMint: 'mint-safe',
      tokenSymbol: 'SAFE',
      poolAddress: 'pool-1',
      chainPositionAddress: 'pos-1',
      orderAction: 'add-lp',
      reason: 'broadcast-outcome-unknown'
    });

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      context: {
        pool: { address: '', liquidityUsd: 0, hasSolRoute: false, blockReason: 'no-selected-candidate' },
        token: { mint: '', inSession: true, hasSolRoute: false, symbol: '', blockReason: 'no-selected-candidate' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: false, expectedOutSol: 0.1, slippageBps: 50, blockReason: 'no-selected-candidate' }
      },
      accountState: {
        observedAt: '2026-03-22T00:06:00.000Z',
        walletSol: 1.25,
        journalSol: 1.25,
        walletTokens: [],
        journalTokens: [],
        walletLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            hasLiquidity: true
          }
        ],
        journalLpPositions: [
          {
            poolAddress: 'pool-1',
            positionAddress: 'pos-1',
            mint: 'mint-safe',
            hasLiquidity: true
          }
        ],
        fills: []
      }
    });

    await expect(store.read()).resolves.toBeNull();
    expect(result.mode).toBe('BLOCKED');
    expect(result.reason).toBe('no-selected-candidate');
  });

  it('only records spending for exposure-increasing actions', async () => {
    const stateDir = 'tmp/tests/runtime-live-cycle-production-state';

    const openingResult = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000, feeTvlRatio24h: 0.06 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: false, hasLpPosition: false },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });
    await new PendingSubmissionStore(stateDir).clear();

    const exitResult = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: stateDir,
      requestedPositionSol: 0.1,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpSolDepletedBins: 61 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    const spendingStore = new SpendingLimitsStore(stateDir);
    const spendingState = await spendingStore.read();

    expect(openingResult.action).toBe('add-lp');
    expect(exitResult.action).toBe('withdraw-lp');
    expect(spendingState.dailySpendSol).toBe(0.1);
    expect(spendingState.orderCount).toBe(1);
  });
});
