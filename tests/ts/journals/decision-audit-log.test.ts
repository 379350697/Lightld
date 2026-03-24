import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { DecisionAuditLog } from '../../../src/journals/decision-audit-log';

describe('DecisionAuditLog', () => {
  it('appends JSONL records', async () => {
    const path = 'tmp/journals/test-decision-audit.jsonl';
    await rm(path, { force: true });

    const journal = new DecisionAuditLog(path);
    await journal.append({
      strategyId: 'new-token-v1',
      action: 'hold',
      reason: 'test',
      recordedAt: new Date().toISOString()
    });

    await expect(journal.readAll()).resolves.toHaveLength(1);
  });
});
