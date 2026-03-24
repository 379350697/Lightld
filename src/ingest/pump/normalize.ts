type PumpTokenPayload = {
  mint?: string;
  symbol?: string;
  holders?: number;
  timestamp?: string;
  capturedAt?: string;
  raw?: Record<string, unknown>;
};

type PumpWalletTradePayload = {
  wallet?: string;
  mint?: string;
  side?: string;
  amount?: number;
  timestamp?: string;
  capturedAt?: string;
  raw?: Record<string, unknown>;
};

export function normalizePumpTokenEvent(payload: PumpTokenPayload) {
  const capturedAt = payload.capturedAt ?? payload.timestamp ?? new Date(0).toISOString();

  return {
    source: 'pump',
    mint: payload.mint ?? '',
    symbol: payload.symbol ?? '',
    holders: payload.holders ?? 0,
    capturedAt,
    raw: payload.raw ?? payload
  };
}

export function normalizePumpWalletTrade(payload: PumpWalletTradePayload) {
  const capturedAt = payload.capturedAt ?? payload.timestamp ?? new Date(0).toISOString();

  return {
    source: 'pump',
    wallet: payload.wallet ?? '',
    mint: payload.mint ?? '',
    side: payload.side ?? 'buy',
    amount: payload.amount ?? 0,
    capturedAt,
    raw: payload.raw ?? payload
  };
}
