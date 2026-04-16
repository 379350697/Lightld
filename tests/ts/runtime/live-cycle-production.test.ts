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
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              status: 'submitted',
              submissionId: 'sub-1',
              idempotencyKey: 'k',
              confirmationSignature: 'tx-sig-1'
            }),
            { status: 200 }
          )
      }),
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-1',
              confirmationSignature: 'tx-sig-1',
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
              walletSol: 1.25,
              journalSol: 1.25,
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
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      accountProvider: new HttpLiveAccountStateProvider({
        url: 'https://account.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              walletSol: 1.5,
              journalSol: 1.25,
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

  it('blocks a follow-up submission when a prior submission is still pending recovery', async () => {
    const first = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      broadcaster: new HttpLiveBroadcaster({
        url: 'https://broadcast.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              status: 'submitted',
              submissionId: 'sub-2',
              idempotencyKey: 'k2'
            }),
            { status: 200 }
          )
      })
    });

    const second = await runLiveCycle({
      strategy: 'new-token-v1',
      journalRootDir: 'tmp/tests/runtime-live-cycle-production',
      stateRootDir: 'tmp/tests/runtime-live-cycle-production-state',
      requestedPositionSol: 0.1,
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
      confirmationSignature: 'tx-old',
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { mint: 'mint-safe', inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-old',
              confirmationSignature: 'tx-old',
              status: 'confirmed',
              finality: 'finalized',
              checkedAt: '2026-03-22T00:01:00.000Z'
            }),
            { status: 200 }
          )
      }),
      broadcaster: new HttpLiveBroadcaster({
        url: 'https://broadcast.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              status: 'submitted',
              submissionId: 'sub-new',
              idempotencyKey: 'k-new',
              confirmationSignature: 'tx-new'
            }),
            { status: 200 }
          )
      }),
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
      confirmationSignature: 'tx-old',
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
              confirmationSignature: 'tx-old',
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
      confirmationSignature: 'tx-old',
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      },
      confirmationProvider: new HttpLiveConfirmationProvider({
        url: 'https://confirm.example/api',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              submissionId: 'sub-old',
              confirmationSignature: 'tx-old',
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
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
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
        trader: { hasInventory: true, hasLpPosition: true, lpNetPnlPct: -25 },
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
