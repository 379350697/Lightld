import { randomUUID } from 'node:crypto';

export type LpValuationStatus = 'ready' | 'unavailable' | 'stale' | 'invalid';

export type LpPositionIdentityRecord = {
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  poolAddress?: string;
  tokenMint?: string;
  entrySol?: number;
  openedAt?: string;
  valuationStatus?: LpValuationStatus;
  valuationReason?: string;
  lastValuationAt?: string;
};

export function createOpenIntentId() {
  return `lp-open-intent:${randomUUID()}`;
}

export function createPositionId(input: {
  chainPositionAddress?: string;
  poolAddress?: string;
  tokenMint?: string;
}) {
  if (typeof input.chainPositionAddress === 'string' && input.chainPositionAddress.length > 0) {
    return input.chainPositionAddress;
  }

  if (typeof input.poolAddress === 'string' && input.poolAddress.length > 0
    && typeof input.tokenMint === 'string' && input.tokenMint.length > 0) {
    return `${input.poolAddress}:${input.tokenMint}`;
  }

  return `lp-position:${randomUUID()}`;
}

export function markOrphanedLpPosition(input: LpPositionIdentityRecord): LpPositionIdentityRecord {
  return {
    ...input,
    entrySol: undefined,
    openedAt: undefined,
    valuationStatus: 'unavailable',
    valuationReason: 'orphaned-position-without-bound-entry'
  };
}
