export type ExecutionOperation = 'quote' | 'signer' | 'broadcast' | 'account' | 'confirmation';
export type ExecutionFailureKind = 'transient' | 'hard' | 'unknown';

type ClassificationInput = {
  operation: ExecutionOperation;
  status?: number;
};

export type ExecutionErrorClassification = {
  kind: ExecutionFailureKind;
  reason: string;
  retryable: boolean;
};

function hasTimeoutSignal(error: Error) {
  return /timeout/i.test(error.message) || error.name === 'AbortError';
}

export function classifyExecutionError(
  error: Error,
  input: ClassificationInput
): ExecutionErrorClassification {
  if (hasTimeoutSignal(error)) {
    if (input.operation === 'broadcast') {
      return {
        kind: 'unknown',
        reason: 'broadcast-outcome-unknown',
        retryable: false
      };
    }

    return {
      kind: 'transient',
      reason: 'timeout',
      retryable: true
    };
  }

  if (input.status === 429) {
    return {
      kind: 'transient',
      reason: 'rate-limited',
      retryable: true
    };
  }

  if ((input.status ?? 0) >= 500) {
    return {
      kind: 'transient',
      reason: `http-${input.status}`,
      retryable: true
    };
  }

  if ((input.status ?? 0) >= 400) {
    return {
      kind: 'hard',
      reason: `http-${input.status}`,
      retryable: false
    };
  }

  return {
    kind: 'hard',
    reason: error.message || 'unknown-error',
    retryable: false
  };
}

export class ExecutionRequestError extends Error {
  readonly kind: ExecutionFailureKind;
  readonly reason: string;
  readonly operation: ExecutionOperation;
  readonly status?: number;

  constructor(
    operation: ExecutionOperation,
    classification: ExecutionErrorClassification,
    cause?: unknown,
    status?: number
  ) {
    super(classification.reason);
    this.name = 'ExecutionRequestError';
    this.operation = operation;
    this.kind = classification.kind;
    this.reason = classification.reason;
    this.status = status;

    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}
