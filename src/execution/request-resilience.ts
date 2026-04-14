import {
  classifyExecutionError,
  ExecutionRequestError,
  type ExecutionOperation
} from './error-classification.ts';

type RetryOptions = {
  operation: ExecutionOperation;
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs?: number;
};

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildTimeoutError() {
  return new Error('timeout');
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  timeoutMs: number,
  attempt: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal, attempt);
  } catch (error) {
    if (controller.signal.aborted) {
      throw buildTimeoutError();
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeWithRetry<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let attempt = 0;

  while (attempt <= options.maxRetries) {
    attempt += 1;

    try {
      return await runWithTimeout(operation, options.timeoutMs, attempt);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? ((error as { status?: number }).status)
        : undefined;
      const classification = classifyExecutionError(normalized, {
        operation: options.operation,
        status
      });

      if (!classification.retryable || attempt > options.maxRetries) {
        throw new ExecutionRequestError(options.operation, classification, error, status);
      }

      const baseDelay = options.baseDelayMs ?? 50;
      const jitter = Math.floor(Math.random() * baseDelay);
      await sleep(baseDelay * attempt + jitter);
    }
  }

  throw new ExecutionRequestError(
    options.operation,
    {
      kind: 'hard',
      reason: 'retry-exhausted',
      retryable: false
    }
  );
}
