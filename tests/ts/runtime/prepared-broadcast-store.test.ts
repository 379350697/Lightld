import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExecutionRequestError } from '../../../src/execution/error-classification';
import type { LiveBroadcaster, LiveBroadcastResult } from '../../../src/execution/live-broadcaster';
import { buildOrderIntent } from '../../../src/execution/order-intent-builder';
import { TestLiveSigner, type SignedLiveOrderIntent } from '../../../src/execution/live-signer';
import { SpendingLimitsStore } from '../../../src/risk/spending-limits';
import { PendingSubmissionStore } from '../../../src/runtime/pending-submission-store';
import {
  PreparedBroadcastStore,
  buildPreparedBroadcastSnapshot,
  recoverPreparedBroadcast
} from '../../../src/runtime/prepared-broadcast-store';
import { runLiveCycle } from '../../../src/runtime/live-cycle';
import { runLiveDaemon } from '../../../src/runtime/live-daemon';

async function buildFixture(input: {
  root: string;
  action: 'add-lp' | 'withdraw-lp';
  captureMode: 'live' | 'mechanical-soak';
  spendReservationRequired?: boolean;
}) {
  const side = input.action;
  const intent = buildOrderIntent({
    strategyId: 'new-token-v1',
    poolAddress: 'pool-wal',
    outputSol: 0.1,
    createdAt: '2026-07-17T00:00:00.000Z',
    executionPolicy: input.captureMode === 'live' ? 'broadcast' : 'simulate-only',
    side,
    tokenMint: 'mint-wal',
    fullPositionExit: input.action === 'withdraw-lp',
    openIntentId: 'open-wal',
    positionId: 'position-wal'
  });
  const signedIntent = await new TestLiveSigner('wal-signer').sign(intent);
  const preparedBroadcastStore = new PreparedBroadcastStore(input.root);
  const pendingSubmissionStore = new PendingSubmissionStore(input.root);
  await preparedBroadcastStore.write(buildPreparedBroadcastSnapshot({
    strategyId: intent.strategyId,
    signedIntent,
    action: input.action,
    captureMode: input.captureMode,
    openIntentId: intent.openIntentId,
    positionId: intent.positionId,
    poolAddress: intent.poolAddress,
    tokenMint: intent.tokenMint,
    tokenSymbol: 'WAL',
    requestedPositionSol: intent.outputSol,
    spendReservationRequired: input.spendReservationRequired,
    createdAt: intent.createdAt
  }));

  return { signedIntent, preparedBroadcastStore, pendingSubmissionStore };
}

class IdempotentAcceptedBroadcaster implements LiveBroadcaster {
  readonly requests: SignedLiveOrderIntent[] = [];
  readonly accepted = new Map<string, LiveBroadcastResult>();

  async broadcast(intent: SignedLiveOrderIntent): Promise<LiveBroadcastResult> {
    this.requests.push(intent);
    const key = intent.intent.idempotencyKey;
    const existing = this.accepted.get(key);
    if (existing) {
      return existing;
    }

    const result: LiveBroadcastResult = {
      status: 'submitted',
      submissionId: `submission:${key}`,
      idempotencyKey: key
    };
    this.accepted.set(key, result);
    return result;
  }
}

describe('PreparedBroadcastStore recovery WAL', () => {
  it('persists the exact signed intent before runLiveCycle calls the network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-before-send-'));
    const journalRoot = await mkdtemp(join(tmpdir(), 'lightld-prepared-before-send-journal-'));
    const preparedBroadcastStore = new PreparedBroadcastStore(root);
    let observedSignedIntent: SignedLiveOrderIntent | undefined;

    const result = await runLiveCycle({
      strategy: 'new-token-v1',
      stateRootDir: root,
      journalRootDir: journalRoot,
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
      broadcaster: {
        async broadcast(signedIntent) {
          const prepared = await preparedBroadcastStore.read();
          expect(prepared?.signedIntent).toEqual(signedIntent);
          observedSignedIntent = signedIntent;
          return {
            status: 'submitted',
            submissionId: 'submission-before-send',
            idempotencyKey: signedIntent.intent.idempotencyKey
          };
        }
      }
    });

    expect(result.mode).toBe('LIVE');
    expect(observedSignedIntent?.intent.idempotencyKey).toBe(result.orderIntent?.idempotencyKey);
    expect(await preparedBroadcastStore.read()).toBeNull();
    expect(await new PendingSubmissionStore(root).read()).toMatchObject({
      submissionId: 'submission-before-send',
      idempotencyKey: result.orderIntent?.idempotencyKey
    });
  });

  it('replays the exact signed open after execution accepted and daemon crashed, without a second economic action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-open-'));
    const fixture = await buildFixture({ root, action: 'add-lp', captureMode: 'live' });
    const broadcaster = new IdempotentAcceptedBroadcaster();

    // Execution accepted this request, but the daemon died before persisting
    // the HTTP response into pending-submission.json.
    await broadcaster.broadcast(fixture.signedIntent);

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster
    });

    expect(recovery.status).toBe('submitted');
    expect(broadcaster.accepted.size).toBe(1);
    expect(broadcaster.requests).toHaveLength(2);
    expect(broadcaster.requests[1]).toEqual(fixture.signedIntent);
    expect(new Set(broadcaster.requests.map((request) => request.intent.idempotencyKey))).toEqual(
      new Set([fixture.signedIntent.intent.idempotencyKey])
    );
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toMatchObject({
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      submissionId: `submission:${fixture.signedIntent.intent.idempotencyKey}`,
      orderAction: 'add-lp'
    });

    await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster
    });
    expect(broadcaster.requests).toHaveLength(2);
  });

  it('books a missing open-risk reservation before replaying a prepared request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-open-spend-'));
    const fixture = await buildFixture({
      root,
      action: 'add-lp',
      captureMode: 'live',
      spendReservationRequired: true
    });
    const spendingLimitsStore = new SpendingLimitsStore(root);
    let reservationObservedBeforeBroadcast = false;

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      spendingLimitsStore,
      broadcaster: {
        async broadcast(intent) {
          const spendingState = await spendingLimitsStore.read();
          reservationObservedBeforeBroadcast = spendingState.reservations.some((reservation) =>
            reservation.idempotencyKey === intent.intent.idempotencyKey
            && reservation.requestedSol === 0.1
            && reservation.status === 'reserved'
          );
          return {
            status: 'submitted',
            submissionId: 'submission-reserved-before-replay',
            idempotencyKey: intent.intent.idempotencyKey
          };
        }
      }
    });

    expect(recovery.status).toBe('submitted');
    expect(reservationObservedBeforeBroadcast).toBe(true);
    expect((await spendingLimitsStore.read()).dailySpendSol).toBe(0.1);
  });

  it('does not replay a prepared open-risk request when its spending store is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-open-no-spend-store-'));
    const fixture = await buildFixture({
      root,
      action: 'add-lp',
      captureMode: 'live',
      spendReservationRequired: true
    });
    let broadcastCalls = 0;

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast(intent) {
          broadcastCalls += 1;
          return {
            status: 'submitted',
            submissionId: 'must-not-submit',
            idempotencyKey: intent.intent.idempotencyKey
          };
        }
      }
    });

    expect(recovery).toMatchObject({
      status: 'conflict',
      blocked: true,
      reason: 'prepared-broadcast-spending-store-unavailable'
    });
    expect(broadcastCalls).toBe(0);
    expect(await fixture.preparedBroadcastStore.read()).not.toBeNull();
  });

  it('releases a replay reservation after execution proves the request was not submitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-open-spend-rejected-'));
    const fixture = await buildFixture({
      root,
      action: 'add-lp',
      captureMode: 'live',
      spendReservationRequired: true
    });
    const spendingLimitsStore = new SpendingLimitsStore(root);

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      spendingLimitsStore,
      broadcaster: {
        async broadcast(intent) {
          expect((await spendingLimitsStore.read()).dailySpendSol).toBe(0.1);
          return {
            status: 'failed',
            reason: 'preflight-rejected',
            retryable: false,
            idempotencyKey: intent.intent.idempotencyKey
          };
        }
      }
    });

    expect(recovery.status).toBe('failed');
    expect(await spendingLimitsStore.read()).toMatchObject({
      dailySpendSol: 0,
      hourlySpendSol: 0,
      orderCount: 0,
      reservations: []
    });
  });

  it('finishes reservation release after a crash left a durable not-submitted WAL marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-release-crash-'));
    const fixture = await buildFixture({
      root,
      action: 'add-lp',
      captureMode: 'live',
      spendReservationRequired: true
    });
    const spendingLimitsStore = new SpendingLimitsStore(root);
    await spendingLimitsStore.reserveSpend(
      fixture.signedIntent.intent.idempotencyKey,
      0.1
    );
    await fixture.preparedBroadcastStore.markNotSubmitted('preflight-rejected');
    let broadcastCalls = 0;

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      spendingLimitsStore,
      broadcaster: {
        async broadcast(intent) {
          broadcastCalls += 1;
          return {
            status: 'submitted',
            submissionId: 'must-not-replay',
            idempotencyKey: intent.intent.idempotencyKey
          };
        }
      }
    });

    expect(recovery).toMatchObject({
      status: 'failed',
      blocked: false,
      reason: 'preflight-rejected'
    });
    expect(broadcastCalls).toBe(0);
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
    expect(await spendingLimitsStore.read()).toMatchObject({
      dailySpendSol: 0,
      orderCount: 0,
      reservations: []
    });
  });

  it('replays accepted WAL in daemon pre-ingest recovery before building a new candidate action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-daemon-restart-'));
    const journalRoot = await mkdtemp(join(tmpdir(), 'lightld-prepared-daemon-restart-journal-'));
    const fixture = await buildFixture({
      root,
      action: 'add-lp',
      captureMode: 'live',
      spendReservationRequired: true
    });
    const broadcaster = new IdempotentAcceptedBroadcaster();
    await broadcaster.broadcast(fixture.signedIntent);
    let replayObservedBeforeBuild = false;

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir: root,
      journalRootDir: journalRoot,
      spendingLimitsConfig: {
        maxSingleOrderSol: 1,
        maxDailySpendSol: 1
      },
      maxTicks: 1,
      tickIntervalMs: 1,
      broadcaster,
      accountProvider: {
        async readState() {
          return {
            observedAt: new Date(Date.now() + 1_000).toISOString(),
            walletSol: 1,
            journalSol: 1,
            walletTokens: [],
            journalTokens: [],
            walletLpPositions: [],
            journalLpPositions: [],
            fills: []
          };
        }
      },
      buildCycleInput: async () => {
        replayObservedBeforeBuild = broadcaster.requests.length === 2;
        return {
          context: {
            pool: { address: '', blockReason: 'no-selected-candidate' },
            token: { mint: '', inSession: false, hasSolRoute: false },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: false, blockReason: 'no-selected-candidate' }
          }
        };
      }
    });

    expect(replayObservedBeforeBuild).toBe(true);
    expect(broadcaster.accepted.size).toBe(1);
    expect(broadcaster.requests).toHaveLength(2);
    expect(broadcaster.requests[1]).toEqual(fixture.signedIntent);
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toMatchObject({
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      submissionId: `submission:${fixture.signedIntent.intent.idempotencyKey}`
    });
    expect(await new SpendingLimitsStore(root).read()).toMatchObject({
      dailySpendSol: 0.1,
      orderCount: 1
    });
  });

  it('recovers a timed-out paper withdraw reservation when the exact overlay LP is still open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-paper-timeout-'));
    const journalRoot = await mkdtemp(join(tmpdir(), 'lightld-prepared-paper-timeout-journal-'));
    const fixture = await buildFixture({ root, action: 'withdraw-lp', captureMode: 'mechanical-soak' });
    const oldCreatedAt = '2026-07-16T00:00:00.000Z';
    await fixture.pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      submissionId: '',
      openIntentId: 'open-wal',
      positionId: 'position-wal',
      chainPositionAddress: 'chain-position-wal',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
      timeoutAt: '2026-07-16T00:05:00.000Z',
      tokenMint: 'mint-wal',
      tokenSymbol: 'WAL',
      poolAddress: 'pool-wal',
      orderAction: 'withdraw-lp',
      reason: 'http-409'
    });
    let buildReached = false;

    await runLiveDaemon({
      strategy: 'new-token-v1',
      stateRootDir: root,
      journalRootDir: journalRoot,
      captureMode: 'mechanical-soak',
      maxTicks: 1,
      tickIntervalMs: 1,
      broadcaster: {
        async broadcast() {
          throw new ExecutionRequestError('broadcast', {
            kind: 'hard',
            reason: 'http-409',
            retryable: false
          }, undefined, 409, 'idempotency key pending: request is reserved');
        }
      },
      accountProvider: {
        async readState() {
          return {
            observedAt: new Date().toISOString(),
            walletSol: 1,
            journalSol: 1,
            walletTokens: [],
            journalTokens: [],
            walletLpPositions: [{
              poolAddress: 'pool-wal',
              positionAddress: 'chain-position-wal',
              mint: 'mint-wal',
              hasLiquidity: true
            }],
            journalLpPositions: [],
            fills: []
          };
        }
      },
      buildCycleInput: async () => {
        buildReached = true;
        return {
          context: {
            pool: { address: '', blockReason: 'no-selected-candidate' },
            token: { mint: '', inSession: false, hasSolRoute: false },
            trader: { hasInventory: false, hasLpPosition: false },
            route: { hasSolRoute: false, blockReason: 'no-selected-candidate' }
          }
        };
      }
    });

    expect(buildReached).toBe(true);
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toBeNull();
  });

  it('submits a paper exit exactly once after a pre-send crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-paper-exit-'));
    const fixture = await buildFixture({ root, action: 'withdraw-lp', captureMode: 'mechanical-soak' });
    const broadcaster = new IdempotentAcceptedBroadcaster();

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster
    });

    expect(recovery.status).toBe('submitted');
    expect(broadcaster.requests).toEqual([fixture.signedIntent]);
    expect(broadcaster.requests[0]?.intent.executionPolicy).toBe('simulate-only');
    expect(await fixture.pendingSubmissionStore.read()).toMatchObject({
      orderAction: 'withdraw-lp',
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey
    });
  });

  it('clears WAL and its untracked unknown placeholder after an explicit not-submitted result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-failed-'));
    const fixture = await buildFixture({ root, action: 'add-lp', captureMode: 'live' });

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast(intent) {
          return {
            status: 'failed',
            reason: 'preflight-rejected',
            retryable: false,
            idempotencyKey: intent.intent.idempotencyKey
          };
        }
      }
    });

    expect(recovery).toMatchObject({ status: 'failed', blocked: false, reason: 'preflight-rejected' });
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toBeNull();
  });

  it('keeps WAL and blocks when the replay outcome is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-unknown-'));
    const fixture = await buildFixture({ root, action: 'withdraw-lp', captureMode: 'live' });

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast() {
          throw new ExecutionRequestError('broadcast', {
            kind: 'unknown',
            reason: 'broadcast-outcome-unknown',
            retryable: false
          });
        }
      }
    });

    expect(recovery).toMatchObject({
      status: 'unknown',
      blocked: true,
      reason: 'broadcast-outcome-unknown'
    });
    expect(await fixture.preparedBroadcastStore.read()).not.toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toMatchObject({
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      confirmationStatus: 'unknown',
      reason: 'broadcast-outcome-unknown'
    });
  });

  it('keeps WAL when execution reports the same idempotency key is still pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-server-pending-'));
    const fixture = await buildFixture({ root, action: 'add-lp', captureMode: 'live' });

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast() {
          throw new ExecutionRequestError('broadcast', {
            kind: 'hard',
            reason: 'http-409',
            retryable: false
          }, undefined, 409, 'idempotency key pending');
        }
      }
    });

    expect(recovery).toMatchObject({ status: 'unknown', blocked: true, reason: 'http-409' });
    expect(await fixture.preparedBroadcastStore.read()).not.toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toMatchObject({
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      confirmationStatus: 'unknown'
    });
  });

  it('clears WAL and an empty pending placeholder after a structured 409 rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-policy-mismatch-'));
    const fixture = await buildFixture({ root, action: 'withdraw-lp', captureMode: 'mechanical-soak' });
    await fixture.pendingSubmissionStore.write({
      strategyId: 'new-token-v1',
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      submissionId: '',
      confirmationStatus: 'unknown',
      finality: 'unknown',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:01.000Z',
      timeoutAt: '2026-07-17T00:05:00.000Z',
      tokenMint: 'mint-wal',
      tokenSymbol: 'WAL',
      poolAddress: 'pool-wal',
      orderAction: 'withdraw-lp',
      reason: 'http-409'
    });

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast() {
          throw new ExecutionRequestError('broadcast', {
            kind: 'hard',
            reason: 'http-409',
            retryable: false
          }, undefined, 409, 'execution policy mismatch: signed intent requires simulate-only');
        }
      }
    });

    expect(recovery).toMatchObject({ status: 'failed', blocked: false, reason: 'http-409' });
    expect(recovery.pendingSubmission).toBeNull();
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toBeNull();
  });

  it('keeps WAL when the execution response is not bound to the signed idempotency key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-wrong-response-'));
    const fixture = await buildFixture({ root, action: 'add-lp', captureMode: 'live' });

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast() {
          return {
            status: 'submitted',
            submissionId: 'submission-wrong-key',
            idempotencyKey: 'another-economic-action'
          };
        }
      }
    });

    expect(recovery).toMatchObject({
      status: 'conflict',
      blocked: true,
      reason: 'prepared-broadcast-response-idempotency-mismatch'
    });
    expect(await fixture.preparedBroadcastStore.read()).not.toBeNull();
    expect(await fixture.pendingSubmissionStore.read()).toMatchObject({
      idempotencyKey: fixture.signedIntent.intent.idempotencyKey,
      confirmationStatus: 'unknown'
    });
  });

  it('clears WAL after a hard HTTP rejection proves no submission was accepted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-prepared-hard-'));
    const fixture = await buildFixture({ root, action: 'add-lp', captureMode: 'live' });

    const recovery = await recoverPreparedBroadcast({
      preparedBroadcastStore: fixture.preparedBroadcastStore,
      pendingSubmissionStore: fixture.pendingSubmissionStore,
      broadcaster: {
        async broadcast() {
          throw new ExecutionRequestError('broadcast', {
            kind: 'hard',
            reason: 'http-400',
            retryable: false
          });
        }
      }
    });

    expect(recovery).toMatchObject({ status: 'failed', blocked: false, reason: 'http-400' });
    expect(await fixture.preparedBroadcastStore.read()).toBeNull();
  });
});
