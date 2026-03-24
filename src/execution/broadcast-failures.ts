export function classifyBroadcastFailure(error: Error) {
  return {
    retryable: /timeout/i.test(error.message),
    reason: error.message
  };
}
