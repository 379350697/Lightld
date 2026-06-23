import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildIncidentReport,
  formatIncidentReport,
  parseSinceDuration
} from '../../../src/cli/show-incidents';
import { appendJsonLine } from '../../../src/journals/jsonl-writer';

describe('show incidents report', () => {
  it('groups typed incidents and summarizes recent trading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-show-incidents-'));
    const journalRootDir = join(root, 'journals');
    const stateRootDir = join(root, 'state');
    const now = new Date('2026-06-23T12:00:00.000Z');
    const recent = '2026-06-23T11:30:00.000Z';
    const old = '2026-06-22T00:00:00.000Z';

    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-incidents.jsonl'), {
      recordedAt: recent,
      severity: 'warning',
      reason: 'daily-spend-limit-exceeded',
      tokenMint: 'mint-a',
      poolAddress: 'pool-a',
      suppressedCount: 9
    });
    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-incidents.jsonl'), {
      recordedAt: recent,
      severity: 'warning',
      reason: 'valuation-unavailable:Jupiter quote failed: NO_ROUTES_FOUND',
      tokenMint: 'mint-b',
      poolAddress: 'pool-b'
    });
    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-incidents.jsonl'), {
      recordedAt: old,
      severity: 'warning',
      reason: 'Token balance is zero for mint old',
      tokenMint: 'old',
      poolAddress: 'old'
    });
    await appendFile(join(journalRootDir, 'new-token-v1-live-incidents.jsonl'), '{bad-json\n', 'utf8');
    await appendJsonLine(join(journalRootDir, 'new-token-v1-live-fills.jsonl'), {
      recordedAt: recent,
      side: 'add-lp'
    });
    await appendJsonLine(join(stateRootDir, 'evolution/new-token-v1/position-outcomes.jsonl'), {
      recordedAt: recent,
      action: 'add-lp',
      actualExitReason: 'lp-open-approved'
    });

    const report = await buildIncidentReport({
      journalRootDir,
      stateRootDir,
      strategyId: 'new-token-v1',
      sinceMs: parseSinceDuration('24h'),
      now
    });

    expect(report.incidentRecords).toBe(2);
    expect(report.incidentOccurrences).toBe(11);
    expect(report.invalidIncidentLines).toBe(1);
    expect(report.incidentSourceFiles).toBe(1);
    expect(report.fillSourceFiles).toBe(1);
    expect(report.outcomeSourceFiles).toBe(1);
    expect(report.groups.map((group) => group.kind)).toEqual([
      'spend_limit_blocked',
      'jupiter_no_route'
    ]);
    expect(report.trading.fillsBySide).toEqual({ 'add-lp': 1 });
    expect(report.trading.outcomesByAction).toEqual({ 'add-lp': 1 });

    const formatted = formatIncidentReport(report);
    expect(formatted).toContain('spend_limit_blocked');
    expect(formatted).toContain('jupiter_no_route');
    expect(formatted).toContain('incidentOccurrences=11');
    expect(formatted).toContain('incidentSourceFiles=1');
  });
});
