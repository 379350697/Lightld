export const MIN_ACTIONABLE_TOKEN_LAMPORTS = 1_000;

export type TokenInventoryAmount = {
  amount: number;
  amountLamports?: number;
};

export function hasActionableTokenAmount(
  token: TokenInventoryAmount,
  minActionableLamports = MIN_ACTIONABLE_TOKEN_LAMPORTS
) {
  if (
    typeof token.amountLamports === 'number' &&
    Number.isFinite(token.amountLamports)
  ) {
    return token.amountLamports >= minActionableLamports;
  }

  return token.amount > 0;
}
