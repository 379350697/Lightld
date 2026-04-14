type MeteoraPoolPayload = {
  address?: string;
  baseMint?: string;
  quoteMint?: string;
  liquidityUsd?: number;
  updatedAt?: string;
  capturedAt?: string;
  raw?: Record<string, unknown>;
};

export function normalizeMeteoraPool(payload: MeteoraPoolPayload) {
  const capturedAt = payload.capturedAt ?? payload.updatedAt ?? new Date(0).toISOString();

  return {
    source: 'meteora',
    poolAddress: payload.address ?? '',
    baseMint: payload.baseMint ?? '',
    quoteMint: payload.quoteMint ?? '',
    liquidityUsd: payload.liquidityUsd ?? 0,
    capturedAt,
    raw: payload.raw ?? payload
  };
}
