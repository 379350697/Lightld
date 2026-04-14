import { describe, expect, it } from 'vitest';

import { executeWithRetry } from '../../../src/execution/request-resilience';

describe('executeWithRetry', () => {
  it('retries transient failures and returns the successful result', async () => {
    let attempts = 0;

    await expect(
      executeWithRetry(
        async () => {
          attempts += 1;

          if (attempts < 3) {
            throw new Error('timeout');
          }

          return 'ok';
        },
        {
          operation: 'quote',
          timeoutMs: 1_000,
          maxRetries: 2,
          baseDelayMs: 1
        }
      )
    ).resolves.toBe('ok');

    expect(attempts).toBe(3);
  });
});
