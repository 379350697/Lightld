import { describe, expect, it } from 'vitest';

import { classifyExecutionError } from '../../../src/execution/error-classification';

describe('classifyExecutionError', () => {
  it('treats quote timeouts as transient errors', () => {
    expect(
      classifyExecutionError(new Error('timeout'), {
        operation: 'quote',
        status: 504
      })
    ).toEqual({
      kind: 'transient',
      reason: 'timeout',
      retryable: true
    });
  });

  it('treats broadcast timeouts as unknown outcomes', () => {
    expect(
      classifyExecutionError(new Error('timeout'), {
        operation: 'broadcast'
      })
    ).toEqual({
      kind: 'unknown',
      reason: 'broadcast-outcome-unknown',
      retryable: false
    });
  });

  it('treats client-side validation failures as hard errors', () => {
    expect(
      classifyExecutionError(new Error('bad request'), {
        operation: 'signer',
        status: 400
      })
    ).toEqual({
      kind: 'hard',
      reason: 'http-400',
      retryable: false
    });
  });
});
