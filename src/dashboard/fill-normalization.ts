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
  const amount = toFiniteNumber(row.amount ?? row.filledSol ?? row.requestedPositionSol);
  const filledSol = toFiniteNumber(row.filledSol ?? row.amount ?? row.requestedPositionSol);

  return {
    fillId: String(row.fillId ?? row.submissionId ?? row.cycleId ?? ''),
    submissionId: String(row.submissionId ?? ''),
    tokenMint: String(row.tokenMint ?? ''),
    tokenSymbol: String(row.tokenSymbol ?? ''),
    side: String(row.side ?? 'unknown'),
    amount,
    filledSol,
    recordedAt: String(row.recordedAt ?? '')
  };
}
