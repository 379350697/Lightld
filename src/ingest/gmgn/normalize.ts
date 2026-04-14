type GmgnTraderPayload = {
  wallet?: string;
  labels?: string[];
  pnlUsd?: number;
  updatedAt?: string;
  capturedAt?: string;
  raw?: Record<string, unknown>;
};

export function normalizeGmgnTrader(payload: GmgnTraderPayload) {
  const capturedAt = payload.capturedAt ?? payload.updatedAt ?? new Date(0).toISOString();
  const freshnessAnchor = payload.updatedAt ?? payload.capturedAt;
  const updatedAtMs = freshnessAnchor ? Date.parse(freshnessAnchor) : Number.NaN;
  const freshnessMs = Number.isNaN(updatedAtMs) ? 0 : Math.max(0, Date.now() - updatedAtMs);

  return {
    source: 'gmgn',
    capturedAt,
    freshnessMs,
    labels: Array.isArray(payload.labels) ? payload.labels : [],
    wallet: payload.wallet ?? '',
    pnlUsd: payload.pnlUsd ?? 0,
    raw: payload.raw ?? payload
  };
}
