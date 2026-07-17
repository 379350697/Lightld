import type { LiveAccountState } from './live-account-provider.ts';
import type {
  PendingSubmissionSnapshot,
  PositionLedgerRecord,
  PositionLedgerSnapshot,
  PositionStateSnapshot
} from './state-types.ts';

export const UNBOUND_ACCOUNT_LP_REASON = 'lp-ownership-reconcile-required:unbound-account-position';

type AccountLpPosition = NonNullable<LiveAccountState['walletLpPositions']>[number];

function hasIdentity(input: {
  openIntentId?: string;
  idempotencyKey?: string;
  entryFillSubmissionId?: string;
}) {
  return Boolean(input.openIntentId || input.idempotencyKey || input.entryFillSubmissionId);
}

export function positionLedgerRecordHasOwnershipEvidence(record?: PositionLedgerRecord) {
  return Boolean(
    record
    && record.lifecycleState !== 'closed'
    && record.lifecycleState !== 'failed_terminal'
    && record.importStatus !== 'superseded_closed'
    && hasIdentity(record)
  );
}

function ledgerRecordOwnsLpPosition(
  position: AccountLpPosition,
  record?: PositionLedgerRecord
) {
  if (!positionLedgerRecordHasOwnershipEvidence(record)) {
    return false;
  }

  const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
  const recordPositionIdIsPoolMint = record!.positionId === `${record!.activePoolAddress}:${record!.activeMint}`;
  const recordChainPositionAddress = record!.chainPositionAddress
    || (record!.positionKey.startsWith('chain-position:')
      ? record!.positionKey.slice('chain-position:'.length)
      : undefined)
    || (!recordPositionIdIsPoolMint ? record!.positionId : undefined);
  return Boolean(
    chainPositionAddress
    && recordChainPositionAddress
    && chainPositionAddress === recordChainPositionAddress
  );
}

export function positionStateOwnsLpPosition(
  position: AccountLpPosition,
  positionState?: PositionStateSnapshot | null
) {
  const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
  const statePositionIdIsPoolMint = positionState?.positionId === `${positionState?.activePoolAddress}:${positionState?.activeMint}`;
  const stateChainPositionAddress = positionState?.chainPositionAddress
    || (!statePositionIdIsPoolMint ? positionState?.positionId : undefined);
  return Boolean(
    positionState
    && positionState.lifecycleState !== 'closed'
    && chainPositionAddress
    && stateChainPositionAddress
    && chainPositionAddress === stateChainPositionAddress
    && hasIdentity({
      openIntentId: positionState.openIntentId,
      idempotencyKey: positionState.lastOrderIdempotencyKey,
      entryFillSubmissionId: positionState.entryFillSubmissionId
    })
  );
}

export function pendingSubmissionOwnsLpPosition(
  position: AccountLpPosition,
  pendingSubmission?: PendingSubmissionSnapshot | null
) {
  if (
    !pendingSubmission
    || pendingSubmission.orderAction !== 'add-lp'
    || pendingSubmission.confirmationStatus === 'failed'
    || !hasIdentity({
      openIntentId: pendingSubmission.openIntentId,
      idempotencyKey: pendingSubmission.idempotencyKey
    })
  ) {
    return false;
  }

  const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
  return Boolean(
    pendingSubmission.chainPositionAddress
    && chainPositionAddress
    && pendingSubmission.chainPositionAddress === chainPositionAddress
  );
}

export function findOwnershipEvidencedLpRecord(
  position: AccountLpPosition,
  ledger?: PositionLedgerSnapshot | null
) {
  const records = ledger?.records ?? [];
  const chainPositionAddress = position.chainPositionAddress || position.positionAddress;
  if (chainPositionAddress) {
    const exact = records.find((record) =>
      positionLedgerRecordHasOwnershipEvidence(record)
      && (
        record.chainPositionAddress === chainPositionAddress
        || record.positionId === chainPositionAddress
        || record.positionKey === `chain-position:${chainPositionAddress}`
      )
    );
    if (exact) {
      return exact;
    }

    // A concrete on-chain address is the strongest identity. Falling back to
    // pool/mint here could make a manually-created sibling LP look owned just
    // because Lightld manages another position in the same pool.
    return undefined;
  }

  return undefined;
}

export function hasLightldLpOwnershipEvidence(input: {
  position: AccountLpPosition;
  ledgerRecord?: PositionLedgerRecord;
  ledger?: PositionLedgerSnapshot | null;
  positionState?: PositionStateSnapshot | null;
  pendingSubmission?: PendingSubmissionSnapshot | null;
  pendingOpenBound?: boolean;
  trustedOpenFillBound?: boolean;
}) {
  return Boolean(
    ledgerRecordOwnsLpPosition(input.position, input.ledgerRecord)
    || findOwnershipEvidencedLpRecord(input.position, input.ledger)
    || positionStateOwnsLpPosition(input.position, input.positionState)
    || pendingSubmissionOwnsLpPosition(input.position, input.pendingSubmission)
    || input.pendingOpenBound === true
    || input.trustedOpenFillBound === true
  );
}
