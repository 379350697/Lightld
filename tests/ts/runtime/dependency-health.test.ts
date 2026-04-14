import { describe, expect, it } from 'vitest';

import {
  createDependencyHealthSnapshot,
  markDependencyFailure,
  markDependencySuccess
} from '../../../src/runtime/dependency-health';

describe('dependency health', () => {
  it('tracks consecutive failures and resets them on success', () => {
    const initial = createDependencyHealthSnapshot();
    const failed = markDependencyFailure(initial, 'quote', 'timeout', '2026-03-22T00:00:00.000Z');
    const recovered = markDependencySuccess(failed, 'quote', '2026-03-22T00:00:05.000Z');

    expect(failed.quote).toMatchObject({
      consecutiveFailures: 1,
      lastFailureReason: 'timeout'
    });
    expect(recovered.quote).toMatchObject({
      consecutiveFailures: 0,
      lastSuccessAt: '2026-03-22T00:00:05.000Z'
    });
  });
});
