import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IncidentDedupeStore } from '../../../src/runtime/incident-dedupe';
import { classifyIncidentReason } from '../../../src/runtime/incident-taxonomy';

describe('incident taxonomy', () => {
  it('classifies known operational incidents', () => {
    expect(classifyIncidentReason('daily-spend-limit-exceeded').kind).toBe('spend_limit_blocked');
    expect(classifyIncidentReason('valuation-unavailable:No RPC endpoint available for jupiter').kind).toBe('jupiter_rate_limited');
    expect(classifyIncidentReason('Jupiter quote failed: NO_ROUTES_FOUND').kind).toBe('jupiter_no_route');
    expect(classifyIncidentReason('pending-submission-partial-failure: No RPC endpoint available for jupiter').kind).toBe('pending_partial_failure');
    expect(classifyIncidentReason('Token balance is zero for mint abc').kind).toBe('zero_token_balance');
    expect(classifyIncidentReason('Solana RPC sendTransaction failed: custom program error: 0x1774').kind).toBe('dlmm_simulation_error');
    expect(classifyIncidentReason('Solana RPC sendTransaction failed: custom program error: 0x1771').rootCause).toContain('invalidBinId');
    expect(classifyIncidentReason('Solana RPC sendTransaction failed: custom program error: 0x1774').rootCause).toContain('exceededBinSlippageTolerance');
    expect(classifyIncidentReason('unknown_pending_reconciliation:missing-fill-evidence').kind).toBe('missing_fill_evidence');
    expect(classifyIncidentReason('lp-position-missing-entry-metadata:abc').kind).toBe('missing_lp_entry_metadata');
    expect(classifyIncidentReason('position-already-closed:Position not found for pool').kind).toBe('position_already_closed');
    expect(classifyIncidentReason('Position not found for pool').kind).toBe('position_already_closed');
  });

  it('suppresses duplicate incidents inside the ttl and summarizes when they recur later', async () => {
    let now = 1_000;
    const store = new IncidentDedupeStore({
      ttlMs: 10_000,
      nowMs: () => now
    });

    await expect(store.shouldAppend('key')).resolves.toMatchObject({
      append: true,
      duplicateCount: 0
    });
    now += 1_000;
    await expect(store.shouldAppend('key')).resolves.toEqual({ append: false });
    now += 1_000;
    await expect(store.shouldAppend('key')).resolves.toEqual({ append: false });
    now += 10_001;
    await expect(store.shouldAppend('key')).resolves.toMatchObject({
      append: true,
      duplicateCount: 2
    });
  });

  it('supports per-call ttl overrides for state-like incidents', async () => {
    let now = 1_000;
    const store = new IncidentDedupeStore({
      ttlMs: 10_000,
      nowMs: () => now
    });

    await expect(store.shouldAppend('spend-limit', { ttlMs: 24 * 60 * 60_000 })).resolves.toMatchObject({
      append: true
    });
    now += 60 * 60_000;
    await expect(store.shouldAppend('spend-limit', { ttlMs: 24 * 60 * 60_000 })).resolves.toEqual({
      append: false
    });
  });

  it('persists dedupe state across store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-incident-dedupe-'));
    const statePath = join(root, 'incident-dedupe-state.json');
    let now = 1_000;
    const first = new IncidentDedupeStore({
      ttlMs: 10_000,
      nowMs: () => now,
      statePath
    });

    await expect(first.shouldAppend('key')).resolves.toMatchObject({ append: true });

    now += 1_000;
    const second = new IncidentDedupeStore({
      ttlMs: 10_000,
      nowMs: () => now,
      statePath
    });

    await expect(second.shouldAppend('key')).resolves.toEqual({ append: false });
  });
});
