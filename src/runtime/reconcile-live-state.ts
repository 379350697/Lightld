type TokenBalance = {
  mint: string;
  symbol?: string;
  amount: number;
};

function buildTokenMap(tokens: TokenBalance[] = []) {
  const balances = new Map<string, { symbol: string; amount: number }>();

  for (const token of tokens) {
    balances.set(token.mint, {
      symbol: token.symbol ?? '',
      amount: token.amount
    });
  }

  return balances;
}

export function reconcileLiveState(input: {
  walletSol: number;
  journalSol: number;
  walletTokens?: TokenBalance[];
  journalTokens?: TokenBalance[];
}) {
  const deltaSol = Number((input.walletSol - input.journalSol).toFixed(9));
  const walletTokens = buildTokenMap(input.walletTokens);
  const journalTokens = buildTokenMap(input.journalTokens);
  const tokenMints = new Set([
    ...walletTokens.keys(),
    ...journalTokens.keys()
  ]);
  const tokenDeltas = Array.from(tokenMints)
    .map((mint) => {
      const wallet = walletTokens.get(mint);
      const journal = journalTokens.get(mint);
      const walletAmount = wallet?.amount ?? 0;
      const journalAmount = journal?.amount ?? 0;
      const deltaAmount = Number((walletAmount - journalAmount).toFixed(9));

      return {
        mint,
        symbol: wallet?.symbol || journal?.symbol || '',
        walletAmount,
        journalAmount,
        deltaAmount
      };
    })
    .filter((delta) => delta.deltaAmount !== 0);
  const ok = deltaSol === 0 && tokenDeltas.length === 0;

  return {
    ok,
    deltaSol,
    tokenDeltas,
    reason: ok ? ('matched' as const) : ('balance-mismatch' as const)
  };
}
