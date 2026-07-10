import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LedgerEventV2Store,
  buildFinalizedLedgerProjection,
  buildLifecycleAccountingClosureFromLedgerStoreV2,
  buildLifecycleAccountingClosureV2,
  buildPnlBreakdownV2
} from '../../../src/runtime/ledger-event-v2';

const STATE_DIR = 'tmp/tests/ledger-event-v2';

afterEach(async () => {
  await rm(STATE_DIR, { recursive: true, force: true });
});

describe('LedgerEventV2', () => {
  it('is idempotent by signature, instruction, account and asset', async () => {
    const store = new LedgerEventV2Store(STATE_DIR);
    const event = {
      lifecycleKey: 'lifecycle-1',
      signature: 'signature-1',
      instructionIndex: 3,
      account: 'wallet-1',
      asset: 'SOL',
      mint: 'So11111111111111111111111111111111111111112',
      slot: 100,
      blockTime: '2026-07-10T00:00:00.000Z',
      finality: 'finalized' as const,
      preAmountRaw: '1000000000',
      postAmountRaw: '900000000',
      baseFeeLamports: '5000',
      priorityFeeLamports: '1000',
      jitoTipLamports: '0',
      rentLamports: '0',
      source: 'transaction-meta' as const
    };

    const first = await store.append(event);
    const second = await store.append(event);

    expect(second.eventId).toBe(first.eventId);
    expect((await store.read()).length).toBe(1);
    await expect(store.append({ ...event, postAmountRaw: '800000000' }))
      .rejects.toThrow(/ledger event identity conflict/);
  });

  it('excludes provisional events and applies finalized compensation events', () => {
    const events = [
      {
        eventId: 'final-1',
        lifecycleKey: 'lifecycle-1',
        signature: 'sig-final',
        instructionIndex: 0,
        account: 'wallet-1',
        asset: 'SOL',
        mint: 'So11111111111111111111111111111111111111112',
        slot: 100,
        blockTime: '2026-07-10T00:00:00.000Z',
        finality: 'finalized' as const,
        preAmountRaw: '1000000000',
        postAmountRaw: '900000000',
        baseFeeLamports: '5000',
        priorityFeeLamports: '0',
        jitoTipLamports: '0',
        rentLamports: '0',
        failedTransactionCostLamports: '7000',
        source: 'transaction-meta' as const
      },
      {
        eventId: 'provisional-1',
        lifecycleKey: 'lifecycle-1',
        signature: 'sig-provisional',
        instructionIndex: 0,
        account: 'wallet-1',
        asset: 'SOL',
        mint: 'So11111111111111111111111111111111111111112',
        slot: 101,
        blockTime: '2026-07-10T00:00:01.000Z',
        finality: 'confirmed' as const,
        preAmountRaw: '900000000',
        postAmountRaw: '700000000',
        baseFeeLamports: '5000',
        priorityFeeLamports: '0',
        jitoTipLamports: '0',
        rentLamports: '0',
        source: 'transaction-meta' as const
      },
      {
        eventId: 'compensation-1',
        lifecycleKey: 'lifecycle-1',
        signature: 'sig-compensation',
        instructionIndex: 0,
        account: 'wallet-1',
        asset: 'SOL',
        mint: 'So11111111111111111111111111111111111111112',
        slot: 102,
        blockTime: '2026-07-10T00:00:02.000Z',
        finality: 'finalized' as const,
        preAmountRaw: '0',
        postAmountRaw: '100000000',
        baseFeeLamports: '0',
        priorityFeeLamports: '0',
        jitoTipLamports: '0',
        rentLamports: '0',
        source: 'compensation' as const,
        compensatesEventId: 'final-1'
      }
    ];

    const projection = buildFinalizedLedgerProjection(events);
    expect(projection.balanceDeltaByAsset.SOL).toBe('0');
    expect(projection.provisionalEventCount).toBe(1);
    expect(projection.totalFailedTransactionCostLamports).toBe('7000');
  });

  it('marks PnL exact only when all economic components are reconciled', () => {
    expect(buildPnlBreakdownV2({
      principalChangeSol: -0.01,
      lpFeeIncomeSol: 0.02,
      inventoryPriceMoveSol: -0.005,
      hodlBenchmarkSol: 0.004,
      impermanentLossSol: -0.009,
      baseFeeSol: 0.000005,
      priorityFeeSol: 0.000002,
      jitoTipSol: 0,
      rentSol: 0,
      failedTransactionCostSol: 0,
      residualLiquidationImpactSol: -0.001,
      allAssetsClosed: true,
      finalized: true,
      reconciliationDeltaLamports: '0'
    })).toMatchObject({
      grossPnlSol: 0.005,
      netPnlSol: 0.003993,
      valuationConfidence: 'exact'
    });

    expect(buildPnlBreakdownV2({
      principalChangeSol: 0,
      lpFeeIncomeSol: 0,
      inventoryPriceMoveSol: 0,
      hodlBenchmarkSol: 0,
      impermanentLossSol: 0,
      baseFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      rentSol: 0,
      failedTransactionCostSol: 0,
      residualLiquidationImpactSol: 0,
      allAssetsClosed: false,
      finalized: true,
      reconciliationDeltaLamports: '1'
    }).valuationConfidence).toBe('untrusted');
  });

  it('marks lifecycle accounting exact only after finalized close and zero residual non-SOL assets', () => {
    const closure = buildLifecycleAccountingClosureV2({
      lifecycleKey: 'lifecycle-1',
      lifecycleStatus: 'finalized_closed',
      events: [
        {
          eventId: 'open-sol',
          lifecycleKey: 'lifecycle-1',
          signature: 'sig-open',
          instructionIndex: 0,
          account: 'wallet',
          asset: 'SOL',
          mint: 'SOL',
          slot: 1,
          blockTime: '2026-07-10T00:00:00.000Z',
          finality: 'finalized',
          preAmountRaw: '1000000000',
          postAmountRaw: '900000000',
          baseFeeLamports: '5000',
          priorityFeeLamports: '1000',
          jitoTipLamports: '0',
          rentLamports: '2039280',
          source: 'transaction-meta'
        },
        {
          eventId: 'open-token',
          lifecycleKey: 'lifecycle-1',
          signature: 'sig-open',
          instructionIndex: 1,
          account: 'token-account',
          asset: 'mint-1',
          mint: 'mint-1',
          slot: 1,
          blockTime: '2026-07-10T00:00:00.000Z',
          finality: 'finalized',
          preAmountRaw: '0',
          postAmountRaw: '10',
          baseFeeLamports: '0',
          priorityFeeLamports: '0',
          jitoTipLamports: '0',
          rentLamports: '0',
          source: 'transaction-meta'
        },
        {
          eventId: 'close-token',
          lifecycleKey: 'lifecycle-1',
          signature: 'sig-close',
          instructionIndex: 1,
          account: 'token-account',
          asset: 'mint-1',
          mint: 'mint-1',
          slot: 2,
          blockTime: '2026-07-10T01:00:00.000Z',
          finality: 'finalized',
          preAmountRaw: '10',
          postAmountRaw: '0',
          baseFeeLamports: '0',
          priorityFeeLamports: '0',
          jitoTipLamports: '0',
          rentLamports: '0',
          source: 'transaction-meta'
        }
      ]
    });

    expect(closure).toMatchObject({
      formalAccountingReady: true,
      valuationConfidence: 'exact',
      residualAssetDeltas: [],
      totalBaseFeeLamports: '5000',
      totalPriorityFeeLamports: '1000',
      totalRentLamports: '2039280',
      totalFailedTransactionCostLamports: '0',
      blockingReasons: []
    });
    expect(closure.balanceDeltaByAssetRaw).toMatchObject({
      SOL: '-100000000',
      'mint-1': '0'
    });
  });

  it('rebuilds lifecycle accounting closure from the append-only ledger store', async () => {
    const store = new LedgerEventV2Store(STATE_DIR);

    await store.append({
      lifecycleKey: 'lifecycle-store-1',
      signature: 'sig-open-store',
      instructionIndex: 0,
      account: 'wallet',
      asset: 'SOL',
      mint: 'SOL',
      slot: 1,
      blockTime: '2026-07-10T00:00:00.000Z',
      finality: 'finalized',
      preAmountRaw: '1000000000',
      postAmountRaw: '990000000',
      baseFeeLamports: '5000',
      priorityFeeLamports: '1000',
      jitoTipLamports: '0',
      rentLamports: '2039280',
      source: 'transaction-meta'
    });
    await store.append({
      lifecycleKey: 'lifecycle-store-1',
      signature: 'sig-open-store',
      instructionIndex: 1,
      account: 'token-account',
      asset: 'mint-store',
      mint: 'mint-store',
      slot: 1,
      blockTime: '2026-07-10T00:00:00.000Z',
      finality: 'finalized',
      preAmountRaw: '0',
      postAmountRaw: '10',
      source: 'transaction-meta'
    });
    await store.append({
      lifecycleKey: 'lifecycle-store-1',
      signature: 'sig-close-store',
      instructionIndex: 1,
      account: 'token-account',
      asset: 'mint-store',
      mint: 'mint-store',
      slot: 2,
      blockTime: '2026-07-10T01:00:00.000Z',
      finality: 'finalized',
      preAmountRaw: '10',
      postAmountRaw: '0',
      source: 'transaction-meta'
    });
    await store.append({
      lifecycleKey: 'unrelated-lifecycle',
      signature: 'sig-unrelated',
      instructionIndex: 0,
      account: 'wallet',
      asset: 'SOL',
      mint: 'SOL',
      slot: 3,
      blockTime: '2026-07-10T02:00:00.000Z',
      finality: 'finalized',
      preAmountRaw: '990000000',
      postAmountRaw: '980000000',
      source: 'transaction-meta'
    });

    const closure = await buildLifecycleAccountingClosureFromLedgerStoreV2({
      store,
      lifecycleKey: 'lifecycle-store-1',
      lifecycleStatus: 'finalized_closed'
    });

    expect(closure).toMatchObject({
      finalizedEventCount: 3,
      formalAccountingReady: true,
      valuationConfidence: 'exact',
      totalBaseFeeLamports: '5000',
      totalPriorityFeeLamports: '1000',
      totalRentLamports: '2039280',
      blockingReasons: []
    });
    expect(closure.balanceDeltaByAssetRaw).toMatchObject({
      SOL: '-10000000',
      'mint-store': '0'
    });
  });

  it('keeps lifecycle accounting partial or untrusted when events remain provisional, rolled back, or residual', () => {
    const baseEvent = {
      lifecycleKey: 'lifecycle-1',
      signature: 'sig',
      instructionIndex: 0,
      account: 'wallet',
      asset: 'SOL',
      mint: 'SOL',
      slot: 1,
      blockTime: '2026-07-10T00:00:00.000Z',
      preAmountRaw: '100',
      postAmountRaw: '90',
      baseFeeLamports: '0',
      priorityFeeLamports: '0',
      jitoTipLamports: '0',
      rentLamports: '0',
      source: 'transaction-meta' as const
    };

    expect(buildLifecycleAccountingClosureV2({
      lifecycleKey: 'lifecycle-1',
      lifecycleStatus: 'finalized_closed',
      events: [
        { ...baseEvent, eventId: 'sol-final', finality: 'finalized' as const },
        {
          ...baseEvent,
          eventId: 'token-residual',
          signature: 'sig-token',
          asset: 'mint-1',
          mint: 'mint-1',
          preAmountRaw: '0',
          postAmountRaw: '1',
          finality: 'finalized' as const
        }
      ]
    })).toMatchObject({
      formalAccountingReady: false,
      valuationConfidence: 'untrusted',
      blockingReasons: ['residual_asset_delta']
    });

    expect(buildLifecycleAccountingClosureV2({
      lifecycleKey: 'lifecycle-1',
      lifecycleStatus: 'finalized_closed',
      events: [
        { ...baseEvent, eventId: 'sol-final', finality: 'finalized' as const },
        { ...baseEvent, eventId: 'sol-confirmed', signature: 'sig-confirmed', finality: 'confirmed' as const }
      ]
    })).toMatchObject({
      formalAccountingReady: false,
      valuationConfidence: 'partial',
      blockingReasons: ['provisional_events_present']
    });

    expect(buildLifecycleAccountingClosureV2({
      lifecycleKey: 'lifecycle-1',
      lifecycleStatus: 'open_confirmed',
      events: [{ ...baseEvent, eventId: 'sol-final', finality: 'finalized' as const }]
    })).toMatchObject({
      formalAccountingReady: false,
      valuationConfidence: 'untrusted',
      blockingReasons: ['lifecycle_not_finalized']
    });
  });
});
