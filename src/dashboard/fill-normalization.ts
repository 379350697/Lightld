function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

export function normalizeDashboardJournalFill(row: Record<string, unknown>) {
  const amount = toFiniteNumber(row.amount ?? row.filledSol);
  const filledSol = toFiniteNumber(row.filledSol ?? row.amount);

  return {
    fillId: String(row.fillId ?? row.submissionId ?? row.cycleId ?? ''),
    submissionId: String(row.submissionId ?? ''),
    openIntentId: String(row.openIntentId ?? ''),
    positionId: String(row.positionId ?? ''),
    chainPositionAddress: String(row.chainPositionAddress ?? row.positionAddress ?? ''),
    tokenMint: String(row.tokenMint ?? row.mint ?? ''),
    tokenSymbol: String(row.tokenSymbol ?? row.symbol ?? ''),
    side: String(row.side ?? 'unknown'),
    amount,
    filledSol,
    recordedAt: String(row.recordedAt ?? '')
  };
}
