type NewTokenSnapshot = {
  inSession: boolean;
  hasInventory: boolean;
};

export function buildNewTokenDecision(
  snapshot: NewTokenSnapshot
): { action: 'dca-out' | 'hold' } {
  return {
    action: snapshot.inSession && snapshot.hasInventory ? 'dca-out' : 'hold'
  };
}
