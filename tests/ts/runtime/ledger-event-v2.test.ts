import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LedgerEventV2Store,
  buildFinalizedLedgerProjection,
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
});
