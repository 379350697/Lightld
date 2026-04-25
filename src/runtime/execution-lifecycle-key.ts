export function buildExecutionLifecycleKey(input: {
  tokenMint: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
}) {
  if (input.chainPositionAddress && input.chainPositionAddress.length > 0) {
    return `chain-position:${input.chainPositionAddress}`;
  }

  if (input.positionId && input.positionId.length > 0) {
    return `position:${input.positionId}`;
  }

  if (input.openIntentId && input.openIntentId.length > 0) {
    return `intent:${input.openIntentId}`;
  }

  return `token:${input.tokenMint}`;
}

export function listExecutionIdentityKeys(input: {
  submissionId?: string;
  idempotencyKey?: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
}) {
  const keys: string[] = [];

  if (input.submissionId && input.submissionId.length > 0) {
    keys.push(`submission:${input.submissionId}`);
  }

  if (input.chainPositionAddress && input.chainPositionAddress.length > 0) {
    keys.push(`chain-position:${input.chainPositionAddress}`);
  }

  if (input.positionId && input.positionId.length > 0) {
    keys.push(`position:${input.positionId}`);
  }

  if (input.openIntentId && input.openIntentId.length > 0) {
    keys.push(`intent:${input.openIntentId}`);
  }

  if (input.idempotencyKey && input.idempotencyKey.length > 0) {
    keys.push(`order:${input.idempotencyKey}`);
  }

  return keys;
}
