import { describe, expect, it } from 'vitest';

import { shouldSendAlert } from '../../../src/runtime/alert-sink';

describe('shouldSendAlert', () => {
  it('alerts on circuit_open but not on healthy ticks', () => {
    expect(
      shouldSendAlert({
        previousMode: 'healthy',
        nextMode: 'circuit_open',
        reason: 'quote-failures'
      })
    ).toBe(true);

    expect(
      shouldSendAlert({
        previousMode: 'healthy',
        nextMode: 'healthy',
        reason: 'healthy'
      })
    ).toBe(false);
  });
});
