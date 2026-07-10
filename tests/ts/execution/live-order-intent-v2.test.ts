import { describe, expect, it } from 'vitest';

import {
  computeIntentQuoteHash,
  LiveOrderIntentSchema,
  validateIntentExecutionEnvelope,
  validateLiveOrderIntentBoundary
} from '../../../src/execution/live-order-intent-schema';
import { buildOrderIntentV2 } from '../../../src/execution/order-intent-builder';

const NOW = '2026-07-10T02:00:02.000Z';

function buildOpenIntent(overrides: Partial<Parameters<typeof buildOrderIntentV2>[0]> = {}) {
  return buildOrderIntentV2({
    strategyId: 'new-token-v1',
    poolAddress: 'pool-1',
    tokenMint: 'mint-1',
    outputSol: 0.01,
    side: 'add-lp',
    createdAt: '2026-07-10T02:00:01.000Z',
    runId: 'run-1',
    lifecycleKey: 'lifecycle-1',
    openIntentId: 'open-1',
    configSnapshotId: 'config-1',
    riskSnapshotId: 'risk-1',
    maxInputSol: 0.01,
    maxSlippageBps: 100,
    maxImpactBps: 200,
    quotedImpactBps: 125,
    maxTotalFeeLamports: 100_000,
    estimatedTotalFeeLamports: 50_000,
    quoteHash: computeIntentQuoteHash({ id: 'quote-1' }),
    quoteSlot: 123,
    quoteCreatedAt: '2026-07-10T02:00:00.500Z',
    candidateObservedAt: '2026-07-10T01:59:55.000Z',
    expiresAt: '2026-07-10T02:00:05.000Z',
    lastValidBlockHeight: 999,
    ...overrides
  });
}

describe('LiveOrderIntentV2', () => {
  it('builds a risk-bound canonical V2 open intent', () => {
    const intent = buildOpenIntent();

    expect(intent).toMatchObject({
      schemaVersion: 2,
      runId: 'run-1',
      lifecycleKey: 'lifecycle-1',
      idempotencyKey: 'run-1:lifecycle-1:add-lp',
      maxInputSol: 0.01,
      riskSnapshotId: 'risk-1'
    });
    expect(LiveOrderIntentSchema.parse(intent)).toEqual(intent);
  });

  it('requires maxInputSol for risk-increasing actions', () => {
    const intent = buildOpenIntent();
    const { maxInputSol: _removed, ...invalid } = intent;

    expect(() => LiveOrderIntentSchema.parse(invalid)).toThrow(/maxInputSol/i);
  });

  it('requires minOutputSol and lifecycle position identity for exits', () => {
    expect(() => buildOrderIntentV2({
      ...buildOpenIntent(),
      side: 'withdraw-lp',
      maxInputSol: undefined,
      minOutputSol: undefined,
      positionId: undefined,
      chainPositionAddress: undefined
    })).toThrow(/minOutputSol|positionId|chainPositionAddress/i);
  });

  it('rejects quoted impact or estimated fees outside the signed envelope', () => {
    expect(() => LiveOrderIntentSchema.parse({
      ...buildOpenIntent(),
      quotedImpactBps: 201
    })).toThrow(/quotedImpactBps/i);
    expect(() => LiveOrderIntentSchema.parse({
      ...buildOpenIntent(),
      estimatedTotalFeeLamports: 100_001
    })).toThrow(/estimatedTotalFeeLamports/i);
  });

  it('revalidates observed execution values against the signed envelope', () => {
    const intent = buildOpenIntent({
      quoteHash: computeIntentQuoteHash({ route: 'route-1', outAmount: '100' })
    });

    expect(() => validateIntentExecutionEnvelope(intent, {
      actualInputSol: 0.011,
      actualSlippageBps: 100,
      actualImpactBps: 125,
      actualTotalFeeLamports: 50_000,
      actualQuoteHash: intent.quoteHash
    })).toThrow(/maxInputSol/i);
    expect(() => validateIntentExecutionEnvelope(intent, {
      actualInputSol: 0.01,
      actualSlippageBps: 101,
      actualImpactBps: 201,
      actualTotalFeeLamports: 100_001,
      actualQuoteHash: 'different-quote'
    })).toThrow();
    expect(() => validateIntentExecutionEnvelope(intent, {
      actualInputSol: 0.01,
      actualSlippageBps: 100,
      actualImpactBps: 125,
      actualTotalFeeLamports: 50_000,
      actualQuoteHash: intent.quoteHash
    })).not.toThrow();
  });

  it('allows V1 only when the boundary explicitly runs in mechanical-soak mode', () => {
    const v1 = {
      strategyId: 'new-token-v1',
      poolAddress: 'pool-1',
      outputSol: 0.1,
      createdAt: '2026-07-10T02:00:00.000Z',
      idempotencyKey: 'legacy-1'
    };

    expect(validateLiveOrderIntentBoundary(v1, {
      mode: 'mechanical-soak',
      stage: 'sign',
      now: NOW
    }).schemaVersion).toBe(1);
    expect(() => validateLiveOrderIntentBoundary(v1, {
      mode: 'live',
      stage: 'sign',
      now: NOW
    })).toThrow(/V1.*mechanical-soak/i);
  });

  it('enforces candidate and quote freshness for opens at signing and broadcast', () => {
    expect(() => validateLiveOrderIntentBoundary(buildOpenIntent({
      candidateObservedAt: '2026-07-10T01:59:46.999Z'
    }), {
      mode: 'live',
      stage: 'sign',
      now: NOW
    })).toThrow(/candidate.*stale/i);

    expect(() => validateLiveOrderIntentBoundary(buildOpenIntent({
      quoteCreatedAt: '2026-07-10T01:59:59.999Z'
    }), {
      mode: 'live',
      stage: 'sign',
      now: NOW
    })).toThrow(/quote.*stale/i);

    expect(validateLiveOrderIntentBoundary(buildOpenIntent(), {
      mode: 'live',
      stage: 'broadcast',
      now: '2026-07-10T02:00:03.000Z',
      currentBlockHeight: 998
    }).schemaVersion).toBe(2);
  });

  it('fails closed on expiration or unavailable/expired block height at broadcast', () => {
    expect(() => validateLiveOrderIntentBoundary(buildOpenIntent(), {
      mode: 'live',
      stage: 'broadcast',
      now: NOW
    })).toThrow(/block height.*unavailable/i);
    expect(() => validateLiveOrderIntentBoundary(buildOpenIntent(), {
      mode: 'live',
      stage: 'broadcast',
      now: '2026-07-10T02:00:05.000Z',
      currentBlockHeight: 998
    })).toThrow(/expired/i);
    expect(() => validateLiveOrderIntentBoundary(buildOpenIntent(), {
      mode: 'live',
      stage: 'broadcast',
      now: NOW,
      currentBlockHeight: 1_000
    })).toThrow(/block height.*expired/i);
  });

  it('does not apply candidate freshness to risk-reducing exits', () => {
    const exit = buildOrderIntentV2({
      ...buildOpenIntent(),
      side: 'withdraw-lp',
      maxInputSol: undefined,
      minOutputSol: 0.005,
      positionId: 'position-1',
      chainPositionAddress: 'chain-position-1',
      candidateObservedAt: '2026-07-01T00:00:00.000Z'
    });

    expect(validateLiveOrderIntentBoundary(exit, {
      mode: 'live',
      stage: 'broadcast',
      now: NOW,
      currentBlockHeight: 998
    }).schemaVersion).toBe(2);
  });
});
