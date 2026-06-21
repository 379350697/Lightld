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
  const actualFilledSol = toFiniteNumber(row.actualFilledSol);
  const filledSol = actualFilledSol > 0
    ? actualFilledSol
    : toFiniteNumber(row.filledSol ?? row.amount);
  const amount = filledSol > 0
    ? filledSol
    : toFiniteNumber(row.amount ?? row.filledSol);

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
    actualFilledSol: actualFilledSol > 0 ? actualFilledSol : undefined,
    actualWalletDeltaSol: toFiniteNumber(row.actualWalletDeltaSol),
    fillAmountSource: String(row.fillAmountSource ?? ''),
    requestedPositionSol: toFiniteNumber(row.requestedPositionSol),
    recordedAt: String(row.recordedAt ?? '')
  };
}
