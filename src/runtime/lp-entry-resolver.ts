import type { LiveAccountState } from './live-account-provider.ts';
import type { PositionEntrySolSource, PositionStateSnapshot } from './state-types.ts';

export type TrustedFillAmountSource = 'wallet-delta' | 'chain-reconstructed';

export type LpEntryFillCandidate = NonNullable<LiveAccountState['fills']>[number];

export type TrustedLpEntryResolution = {
  entrySol: number;
  entrySolSource: PositionEntrySolSource;
  entryFillSubmissionId?: string;
  openedAt?: string;
};

function isPoolMintPositionId(value: string | undefined) {
  return typeof value === 'string' && value.includes(':');
}

function isWithinStrictEntryWindow(fillRecordedAt: string, openedAt: string) {
  const fillRecordedAtMs = Date.parse(fillRecordedAt);
  const openedAtMs = Date.parse(openedAt);

  if (!Number.isFinite(fillRecordedAtMs) || !Number.isFinite(openedAtMs)) {
    return false;
  }

  return fillRecordedAtMs >= openedAtMs - 60_000 && fillRecordedAtMs <= openedAtMs + 10 * 60_000;
}

export function isTrustedEntrySolSource(source: unknown): source is PositionEntrySolSource {
  return source === 'actual_fill' || source === 'reconstructed_chain';
}

export function isTrustedFillAmountSource(source: unknown): source is TrustedFillAmountSource {
  return source === 'wallet-delta' || source === 'chain-reconstructed';
}

export function isTrustedLpOpenFill(fill: LpEntryFillCandidate | undefined): fill is LpEntryFillCandidate {
  return fill?.side === 'add-lp'
    && fill.amount > 0
    && fill.hasFillEvidence === true
    && isTrustedFillAmountSource(fill.fillAmountSource);
}

export function matchesPositionStateLifecycle(
  position: NonNullable<LiveAccountState['walletLpPositions']>[number],
  positionState?: PositionStateSnapshot
) {
  if (!positionState) {
    return false;
  }

  if (typeof positionState.chainPositionAddress === 'string' && positionState.chainPositionAddress.length > 0) {
    return positionState.chainPositionAddress === position.positionAddress
      || positionState.chainPositionAddress === position.chainPositionAddress;
  }

  if (
    typeof positionState.positionId === 'string'
    && positionState.positionId.length > 0
    && !isPoolMintPositionId(positionState.positionId)
    && typeof position.positionId === 'string'
    && position.positionId.length > 0
  ) {
    return positionState.positionId === position.positionId;
  }

  return positionState.activePoolAddress === position.poolAddress
    && positionState.activeMint === position.mint;
}

function fillMatchesActivePool(fill: LpEntryFillCandidate, positionState: PositionStateSnapshot) {
  if (!positionState.activePoolAddress) {
    return false;
  }

  return fill.positionId === `${positionState.activePoolAddress}:${positionState.activeMint ?? fill.mint}`
    || fill.positionId?.startsWith(`${positionState.activePoolAddress}:`) === true;
}

export function classifyLpEntryFillBinding(input: {
  fill: LpEntryFillCandidate;
  positionState: PositionStateSnapshot;
}): 'strong' | 'strict-window' | 'none' {
  const { fill, positionState } = input;

  if (!isTrustedLpOpenFill(fill) || fill.mint !== positionState.activeMint) {
    return 'none';
  }

  if (positionState.chainPositionAddress && fill.chainPositionAddress === positionState.chainPositionAddress) {
    return 'strong';
  }

  if (
    positionState.positionId
    && !isPoolMintPositionId(positionState.positionId)
    && fill.positionId === positionState.positionId
  ) {
    return 'strong';
  }

  if (
    positionState.openIntentId
    && fill.openIntentId === positionState.openIntentId
    && (
      !positionState.positionId
      || fill.positionId === positionState.positionId
      || fillMatchesActivePool(fill, positionState)
    )
  ) {
    return 'strong';
  }

  if (
    positionState.openedAt
    && fillMatchesActivePool(fill, positionState)
    && isWithinStrictEntryWindow(fill.recordedAt, positionState.openedAt)
  ) {
    return 'strict-window';
  }

  return 'none';
}

export function resolveTrustedEntryFromPositionState(input: {
  positionState?: PositionStateSnapshot;
  lifecycleBound?: boolean;
}): TrustedLpEntryResolution | undefined {
  if (
    input.lifecycleBound
    && isTrustedEntrySolSource(input.positionState?.entrySolSource)
    && typeof input.positionState?.entrySol === 'number'
    && input.positionState.entrySol > 0
  ) {
    return {
      entrySol: input.positionState.entrySol,
      entrySolSource: input.positionState.entrySolSource,
      entryFillSubmissionId: input.positionState.entryFillSubmissionId,
      openedAt: input.positionState.openedAt
    };
  }

  return undefined;
}

export function resolveTrustedEntryFromOpenFill(input: {
  openFill?: LpEntryFillCandidate;
}): TrustedLpEntryResolution | undefined {
  if (!isTrustedLpOpenFill(input.openFill)) {
    return undefined;
  }

  return {
    entrySol: input.openFill.amount,
    entrySolSource: input.openFill.fillAmountSource === 'chain-reconstructed'
      ? 'reconstructed_chain'
      : 'actual_fill',
    entryFillSubmissionId: input.openFill.submissionId,
    openedAt: input.openFill.recordedAt
  };
}

export function resolveTrustedLpEntry(input: {
  positionState?: PositionStateSnapshot;
  openFill?: LpEntryFillCandidate;
  lifecycleBound?: boolean;
}): TrustedLpEntryResolution | undefined {
  return resolveTrustedEntryFromOpenFill({ openFill: input.openFill })
    ?? resolveTrustedEntryFromPositionState({
    positionState: input.positionState,
    lifecycleBound: input.lifecycleBound
  });
}

export function resolveTrustedEntryFromFills(input: {
  positionState?: PositionStateSnapshot;
  fills?: LpEntryFillCandidate[];
}): TrustedLpEntryResolution | undefined {
  const positionState = input.positionState;
  if (
    !positionState
    || positionState.lifecycleState !== 'open'
    || !positionState.activeMint
  ) {
    return undefined;
  }

  const strongCandidates = (input.fills ?? [])
    .filter((fill) => classifyLpEntryFillBinding({ fill, positionState }) === 'strong')
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));

  const strictWindowCandidates = (input.fills ?? [])
    .filter((fill) => classifyLpEntryFillBinding({ fill, positionState }) === 'strict-window')
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));

  const uniquePoolCandidates = (input.fills ?? [])
    .filter((fill) =>
      isTrustedLpOpenFill(fill)
      && fill.mint === positionState.activeMint
      && fillMatchesActivePool(fill, positionState)
    )
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));

  const selected = strongCandidates[0]
    ?? (strictWindowCandidates.length === 1 ? strictWindowCandidates[0] : undefined)
    ?? (uniquePoolCandidates.length === 1 ? uniquePoolCandidates[0] : undefined);
  if (!selected) {
    return resolveTrustedEntryFromPositionState({
      positionState,
      lifecycleBound: true
    });
  }

  return {
    ...resolveTrustedEntryFromOpenFill({ openFill: selected })!,
    openedAt: selected.recordedAt
  };
}
