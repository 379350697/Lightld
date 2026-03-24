import { rm } from 'node:fs/promises';

import { beforeEach, describe, expect, it } from 'vitest';

import { runStrategyCycle } from '../../../src/cli/run-strategy-cycle';

describe('runStrategyCycle', () => {
  beforeEach(async () => {
    await rm('tmp/tests/run-strategy-cycle-state', { recursive: true, force: true });
    await rm('tmp/tests/run-strategy-cycle-journals', { recursive: true, force: true });
  });

  it('returns a live decision summary', async () => {
    const result = await runStrategyCycle({
      strategy: 'new-token-v1',
      stateRootDir: 'tmp/tests/run-strategy-cycle-state',
      journalRootDir: 'tmp/tests/run-strategy-cycle-journals',
      requestedPositionSol: 0.1,
      whitelist: ['SAFE'],
      context: {
        pool: { address: 'pool-1', liquidityUsd: 10_000 },
        token: { inSession: true, hasSolRoute: true, symbol: 'SAFE' },
        trader: { hasInventory: true },
        route: { hasSolRoute: true, expectedOutSol: 0.1, slippageBps: 50 }
      }
    });

    expect(result.status).toBe('ok');
    expect(result.mode).toBe('LIVE');
    expect(result.action).toBe('dca-out');
  });
});
