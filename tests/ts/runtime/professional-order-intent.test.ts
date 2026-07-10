import { describe, expect, it } from 'vitest';

import { computeIntentQuoteHash } from '../../../src/execution/live-order-intent-schema';
import { CANARY_RISK_LIMITS, createInitialRiskStateV2 } from '../../../src/risk/risk-policy-v2';
import {
  buildProfessionalOrderIntent,
  buildProfessionalQuoteCommitment
} from '../../../src/runtime/professional-order-intent';

const now = '2026-07-10T00:00:02.000Z';

function quote() {
  const evidence = {
    action: 'add-lp',
    poolAddress: 'pool-safe',
    tokenMint: 'mint-safe',
    requestedPositionSol: 0.01,
    routeExists: true,
    outputSol: 0.01,
    slippageBps: 50,
    quotedAt: '2026-07-10T00:00:01.000Z',
    quoteSlot: 123,
    impactBps: 8,
    estimatedTotalFeeLamports: 7_000,
    maxTotalFeeLamports: 10_000,
    lastValidBlockHeight: 456,
    expiresAt: '2026-07-10T00:00:05.000Z'
  } as const;
  return {
    ...evidence,
    stale: false,
    quoteHash: computeIntentQuoteHash(buildProfessionalQuoteCommitment(evidence))
  };
}

describe('buildProfessionalOrderIntent', () => {
  it('binds manifest, lifecycle, risk and quote evidence into a V2 open intent', () => {
    const riskState = createInitialRiskStateV2({
      now,
      startOfDayEquitySol: 1,
      currentEquitySol: 1,
      availableSol: 1
    });
    const intent = buildProfessionalOrderIntent({
      strategyId: 'new-token-v1',
      action: 'add-lp',
      poolAddress: 'pool-safe',
      tokenMint: 'mint-safe',
      requestedPositionSol: 0.01,
      quote: quote(),
      candidateObservedAt: '2026-07-10T00:00:00.000Z',
      lifecycle: {
        lifecycleKey: 'lifecycle-1',
        openIntentId: 'open-intent-1',
        positionId: 'position-1'
      },
      run: {
        runId: '8ea0d26f-1d22-4472-9346-95ca6f76da69',
        mode: 'canary',
        configSnapshotId: 'config-sha-1',
        parameterSnapshot: { maxPositionSol: 0.01 }
      },
      riskState,
      riskLimits: CANARY_RISK_LIMITS,
      now
    });

    expect(intent).toMatchObject({
      schemaVersion: 2,
      runId: '8ea0d26f-1d22-4472-9346-95ca6f76da69',
      lifecycleKey: 'lifecycle-1',
      openIntentId: 'open-intent-1',
      riskSnapshotId: riskState.riskSnapshotId,
      maxInputSol: 0.01,
      quoteSlot: 123
    });
  });

  it('fails closed when quote evidence is incomplete or the safety envelope cannot fund the risk', () => {
    const riskState = createInitialRiskStateV2({
      now,
      startOfDayEquitySol: 0.05,
      currentEquitySol: 0.05,
      availableSol: 0.05
    });
    const input = {
      strategyId: 'new-token-v1' as const,
      action: 'add-lp' as const,
      poolAddress: 'pool-safe',
      tokenMint: 'mint-safe',
      requestedPositionSol: 0.01,
      quote: quote(),
      candidateObservedAt: '2026-07-10T00:00:00.000Z',
      lifecycle: { lifecycleKey: 'lifecycle-1', openIntentId: 'open-intent-1', positionId: 'position-1' },
      run: {
        runId: '8ea0d26f-1d22-4472-9346-95ca6f76da69',
        mode: 'canary' as const,
        configSnapshotId: 'config-sha-1',
        parameterSnapshot: {}
      },
      riskState,
      riskLimits: CANARY_RISK_LIMITS,
      now
    };

    expect(() => buildProfessionalOrderIntent(input)).toThrow(/insufficient-sol-reserve/);
    expect(() => buildProfessionalOrderIntent({
      ...input,
      quote: { ...input.quote, quoteHash: undefined }
    })).toThrow(/quote evidence is incomplete/);
  });
});
