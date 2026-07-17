import { describe, expect, it } from 'vitest';

import {
  classifyExecutionError,
  ExecutionRequestError,
  isDefinitelyNotSubmittedBroadcastError
} from '../../../src/execution/error-classification';

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

  it('distinguishes rejected 409 requests from accepted idempotency reservations', () => {
    const policyMismatch = new ExecutionRequestError('broadcast', {
      kind: 'hard',
      reason: 'http-409',
      retryable: false
    }, undefined, 409, 'execution policy mismatch: signed intent requires broadcast');
    const idempotencyPending = new ExecutionRequestError('broadcast', {
      kind: 'hard',
      reason: 'http-409',
      retryable: false
    }, undefined, 409, 'idempotency key pending: request is reserved');
    const unstructuredConflict = new ExecutionRequestError('broadcast', {
      kind: 'hard',
      reason: 'http-409',
      retryable: false
    }, undefined, 409);

    expect(isDefinitelyNotSubmittedBroadcastError(policyMismatch)).toBe(true);
    expect(isDefinitelyNotSubmittedBroadcastError(idempotencyPending)).toBe(false);
    expect(isDefinitelyNotSubmittedBroadcastError(unstructuredConflict)).toBe(false);
  });
});
