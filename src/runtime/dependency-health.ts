import type {
  DependencyHealthEntry,
  DependencyHealthSnapshot,
  DependencyKey
} from './state-types.ts';

function createDependencyHealthEntry(): DependencyHealthEntry {
  return {
    consecutiveFailures: 0,
    lastSuccessAt: '',
    lastFailureAt: '',
    lastFailureReason: ''
  };
}

export function createDependencyHealthSnapshot(): DependencyHealthSnapshot {
  return {
    quote: createDependencyHealthEntry(),
    signer: createDependencyHealthEntry(),
    broadcaster: createDependencyHealthEntry(),
    account: createDependencyHealthEntry(),
    confirmation: createDependencyHealthEntry()
  };
}

export function markDependencyFailure(
  snapshot: DependencyHealthSnapshot,
  key: DependencyKey,
  reason: string,
  at: string
): DependencyHealthSnapshot {
  return {
    ...snapshot,
    [key]: {
      ...snapshot[key],
      consecutiveFailures: snapshot[key].consecutiveFailures + 1,
      lastFailureAt: at,
      lastFailureReason: reason
    }
  };
}

export function markDependencySuccess(
  snapshot: DependencyHealthSnapshot,
  key: DependencyKey,
  at: string
): DependencyHealthSnapshot {
  return {
    ...snapshot,
    [key]: {
      ...snapshot[key],
      consecutiveFailures: 0,
      lastSuccessAt: at
    }
  };
}
