import { describe, expect, it } from 'vitest';

import {
  ResearchGradeLiveCycleOutcomeV2Schema,
  type LiveCycleOutcomeRecord
} from '../../../src/evolution';
import type { LifecycleAccountingClosureV2 } from '../../../src/runtime/ledger-event-v2';

function researchGradeOutcome(overrides: Partial<LiveCycleOutcomeRecord> = {}): LiveCycleOutcomeRecord {
  return {
    schemaVersion: 2,
    lifecycleKey: 'lifecycle-1',
    runId: 'run-1',
    configSnapshotId: 'config-1',
    openIntentId: 'open-1',
    chainPositionAddress: 'chain-position-1',
    finality: 'finalized',
    exitReasons: ['lp-stop-loss', 'lp-range-exit:above:9'],
    primaryReason: 'lp-stop-loss',
    evidenceStatus: 'partial',
    cycleId: 'cycle-1',
    strategyId: 'new-token-v1',
    recordedAt: '2026-07-10T02:00:00.000Z',
    tokenMint: 'mint-1',
    tokenSymbol: 'ONE',
    poolAddress: 'pool-1',
    runtimeMode: 'healthy',
    sessionPhase: 'active',
    positionId: 'chain-position-1',
    action: 'withdraw-lp',
    actualExitReason: 'lp-stop-loss',
    openedAt: '2026-07-10T01:00:00.000Z',
    closedAt: '2026-07-10T02:00:00.000Z',
    entrySol: 0.01,
    lpStopLossNetPnlPctAtEntry: 20,
    lpTakeProfitNetPnlPctAtEntry: 30,
    liveOrderSubmitted: true,
    parameterSnapshot: {
      lpEnabled: true,
      lpStopLossNetPnlPct: 20,
      lpTakeProfitNetPnlPct: 30,
      maxHoldHours: 8
    },
    exitMetrics: {
      requestedPositionSol: 0.01,
      lpNetPnlPct: -21,
      valuationCompleteness: 'complete'
    },
    ...overrides
  };
}

describe('ResearchGradeLiveCycleOutcomeV2Schema', () => {
  it('accepts finalized V2 outcomes with immutable lifecycle and entry config identity', () => {
    expect(ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome())).toMatchObject({
      schemaVersion: 2,
      lifecycleKey: 'lifecycle-1',
      runId: 'run-1',
      finality: 'finalized',
      evidenceStatus: 'partial'
    });
  });

  it('rejects V1, provisional, untrusted, or identity-incomplete outcomes for research', () => {
    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      schemaVersion: 1
    }))).toThrow(/schemaVersion 2/i);
    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      finality: 'provisional'
    }))).toThrow(/finalized close/i);
    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      evidenceStatus: 'untrusted'
    }))).toThrow(/trusted exact or partial/i);
    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      runId: undefined
    }))).toThrow(/runId/i);
    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      primaryReason: 'different'
    }))).toThrow(/primaryReason/i);
  });

  it('requires exact lifecycle accounting closure before exact PnL evidence can be claimed', () => {
    const exactClosure: LifecycleAccountingClosureV2 = {
      schemaVersion: 2,
      lifecycleKey: 'lifecycle-1',
      lifecycleStatus: 'finalized_closed',
      finalizedEventCount: 3,
      provisionalEventCount: 0,
      rolledBackEventCount: 0,
      compensationEventCount: 0,
      balanceDeltaByAssetRaw: {
        SOL: '1000',
        'mint-1': '0'
      },
      residualAssetDeltas: [],
      totalBaseFeeLamports: '5000',
      totalPriorityFeeLamports: '0',
      totalJitoTipLamports: '0',
      totalRentLamports: '0',
      totalFailedTransactionCostLamports: '0',
      allAssetsClosed: true,
      formalAccountingReady: true,
      valuationConfidence: 'exact',
      blockingReasons: []
    };

    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      evidenceStatus: 'exact'
    }))).toThrow(/exact finalized accounting closure/i);

    expect(ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      evidenceStatus: 'exact',
      lifecycleAccountingClosure: exactClosure
    }))).toMatchObject({
      evidenceStatus: 'exact',
      lifecycleAccountingClosure: {
        valuationConfidence: 'exact',
        formalAccountingReady: true
      }
    });

    expect(() => ResearchGradeLiveCycleOutcomeV2Schema.parse(researchGradeOutcome({
      lifecycleAccountingClosure: {
        ...exactClosure,
        lifecycleKey: 'other-lifecycle'
      }
    }))).toThrow(/lifecycleKey/i);
  });
});
