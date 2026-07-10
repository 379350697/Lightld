import { z } from 'zod';

type TokenBalance = {
  mint: string;
  symbol?: string;
  amount: number;
};

type LpPosition = {
  poolAddress: string;
  positionAddress: string;
  mint: string;
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

function buildLpPositionMap(positions: LpPosition[] = []) {
  return new Map(
    positions.map((position) => [
      position.positionAddress,
      {
        poolAddress: position.poolAddress,
        mint: position.mint
      }
    ])
  );
}

export function reconcileLiveState(input: {
  walletSol: number;
  journalSol: number;
  walletTokens?: TokenBalance[];
  journalTokens?: TokenBalance[];
  walletLpPositions?: LpPosition[];
  journalLpPositions?: LpPosition[];
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
  const walletLpPositions = buildLpPositionMap(input.walletLpPositions);
  const journalLpPositions = buildLpPositionMap(input.journalLpPositions);
  const lpPositionAddresses = new Set([
    ...walletLpPositions.keys(),
    ...journalLpPositions.keys()
  ]);
  const lpPositionDeltas = Array.from(lpPositionAddresses)
    .map((positionAddress) => {
      const wallet = walletLpPositions.get(positionAddress);
      const journal = journalLpPositions.get(positionAddress);

      return {
        positionAddress,
        mint: wallet?.mint ?? journal?.mint ?? '',
        walletPresent: Boolean(wallet),
        journalPresent: Boolean(journal),
        poolAddress: wallet?.poolAddress ?? journal?.poolAddress ?? ''
      };
    })
    .filter((delta) => delta.walletPresent !== delta.journalPresent);
  const ok = deltaSol === 0 && tokenDeltas.length === 0 && lpPositionDeltas.length === 0;

  return {
    ok,
    deltaSol,
    tokenDeltas,
    lpPositionDeltas,
    reason: ok ? ('matched' as const) : ('balance-mismatch' as const)
  };
}

const RawIntegerStringSchema = z.string().regex(/^-?\d+$/);

const ReconciliationTokenBalanceV2Schema = z.object({
  asset: z.string().min(1),
  amountRaw: RawIntegerStringSchema
});

const ReconciliationLpPositionV2Schema = z.object({
  positionAddress: z.string().min(1),
  poolAddress: z.string().min(1),
  mint: z.string().min(1)
});

const ReconciliationSnapshotV2BaseSchema = z.object({
  sourceId: z.string().min(1),
  quality: z.enum(['healthy', 'partial', 'degraded', 'unavailable']),
  finality: z.enum(['confirmed', 'finalized', 'mixed', 'unknown']),
  observedAt: z.string().datetime({ offset: true }),
  solLamports: RawIntegerStringSchema,
  tokenBalances: ReconciliationTokenBalanceV2Schema.array(),
  lpPositions: ReconciliationLpPositionV2Schema.array()
});

export const IndependentReconciliationInputV2Schema = z.object({
  chain: ReconciliationSnapshotV2BaseSchema.extend({
    sourceKind: z.literal('chain-observation')
  }),
  ledger: ReconciliationSnapshotV2BaseSchema.extend({
    sourceKind: z.literal('ledger-event-replay')
  }),
  runtime: ReconciliationSnapshotV2BaseSchema.extend({
    sourceKind: z.literal('runtime-projection')
  })
});

type ReconciliationSnapshotV2 = z.infer<typeof ReconciliationSnapshotV2BaseSchema> & {
  sourceKind: 'chain-observation' | 'ledger-event-replay' | 'runtime-projection';
};

function duplicateKey<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = key(value);
    if (seen.has(candidate)) return candidate;
    seen.add(candidate);
  }
  return null;
}

function compareIndependentSnapshots(left: ReconciliationSnapshotV2, right: ReconciliationSnapshotV2) {
  const solDeltaLamports = (BigInt(left.solLamports) - BigInt(right.solLamports)).toString();
  const leftAssets = new Map(left.tokenBalances.map((entry) => [entry.asset, BigInt(entry.amountRaw)]));
  const rightAssets = new Map(right.tokenBalances.map((entry) => [entry.asset, BigInt(entry.amountRaw)]));
  const assetDeltas = [...new Set([...leftAssets.keys(), ...rightAssets.keys()])]
    .sort()
    .map((asset) => ({
      asset,
      deltaRaw: ((leftAssets.get(asset) ?? 0n) - (rightAssets.get(asset) ?? 0n)).toString()
    }))
    .filter((entry) => entry.deltaRaw !== '0');

  const leftPositions = new Map(left.lpPositions.map((entry) => [entry.positionAddress, entry]));
  const rightPositions = new Map(right.lpPositions.map((entry) => [entry.positionAddress, entry]));
  const lpPositionDeltas = [...new Set([...leftPositions.keys(), ...rightPositions.keys()])]
    .sort()
    .flatMap((positionAddress) => {
      const leftPosition = leftPositions.get(positionAddress);
      const rightPosition = rightPositions.get(positionAddress);
      if (
        leftPosition
        && rightPosition
        && leftPosition.poolAddress === rightPosition.poolAddress
        && leftPosition.mint === rightPosition.mint
      ) {
        return [];
      }
      return [{
        positionAddress,
        leftPresent: Boolean(leftPosition),
        rightPresent: Boolean(rightPosition),
        leftPoolAddress: leftPosition?.poolAddress,
        rightPoolAddress: rightPosition?.poolAddress,
        leftMint: leftPosition?.mint,
        rightMint: rightPosition?.mint
      }];
    });

  return {
    ok: solDeltaLamports === '0' && assetDeltas.length === 0 && lpPositionDeltas.length === 0,
    solDeltaLamports,
    assetDeltas,
    lpPositionDeltas
  };
}

/**
 * Reconciles three independently produced projections. The source contract is
 * intentionally explicit so an account-state response cannot be copied into a
 * second field and presented as independent journal evidence.
 */
export function reconcileIndependentLiveStateV2(
  input: z.input<typeof IndependentReconciliationInputV2Schema>
) {
  const parsedResult = IndependentReconciliationInputV2Schema.safeParse(input);
  if (!parsedResult.success) {
    return {
      ok: false as const,
      allowNewOpens: false as const,
      status: 'degraded' as const,
      reason: 'source-invalid' as const,
      issues: parsedResult.error.issues
    };
  }
  const parsed = parsedResult.data;
  const sources = [parsed.chain, parsed.ledger, parsed.runtime];
  const sourceQuality = {
    chain: parsed.chain.quality,
    ledger: parsed.ledger.quality,
    runtime: parsed.runtime.quality
  };
  const chainVsLedger = compareIndependentSnapshots(parsed.chain, parsed.ledger);
  const ledgerVsRuntime = compareIndependentSnapshots(parsed.ledger, parsed.runtime);
  const duplicateSourceId = duplicateKey(sources, (source) => source.sourceId);
  const duplicateAsset = sources
    .map((source) => ({
      sourceId: source.sourceId,
      asset: duplicateKey(source.tokenBalances, (entry) => entry.asset)
    }))
    .find((entry) => entry.asset);
  const duplicatePosition = sources
    .map((source) => ({
      sourceId: source.sourceId,
      positionAddress: duplicateKey(source.lpPositions, (entry) => entry.positionAddress)
    }))
    .find((entry) => entry.positionAddress);

  const common = {
    sourceQuality,
    chainVsLedger,
    ledgerVsRuntime
  };

  if (duplicateSourceId) {
    return {
      ...common,
      ok: false as const,
      allowNewOpens: false as const,
      status: 'degraded' as const,
      reason: 'source-not-independent' as const,
      duplicateSourceId
    };
  }
  if (duplicateAsset || duplicatePosition) {
    return {
      ...common,
      ok: false as const,
      allowNewOpens: false as const,
      status: 'degraded' as const,
      reason: 'source-invalid' as const,
      duplicateAsset,
      duplicatePosition
    };
  }
  if (parsed.chain.finality !== 'finalized') {
    return {
      ...common,
      ok: false as const,
      allowNewOpens: false as const,
      status: 'partial' as const,
      reason: 'chain-not-finalized' as const
    };
  }
  if (sources.some((source) => source.quality === 'degraded' || source.quality === 'unavailable')) {
    return {
      ...common,
      ok: false as const,
      allowNewOpens: false as const,
      status: 'degraded' as const,
      reason: 'source-degraded' as const
    };
  }
  if (sources.some((source) => source.quality === 'partial')) {
    return {
      ...common,
      ok: false as const,
      allowNewOpens: false as const,
      status: 'partial' as const,
      reason: 'source-partial' as const
    };
  }
  if (!chainVsLedger.ok || !ledgerVsRuntime.ok) {
    return {
      ...common,
      ok: false as const,
      allowNewOpens: false as const,
      status: 'mismatch' as const,
      reason: 'balance-mismatch' as const
    };
  }

  return {
    ...common,
    ok: true as const,
    allowNewOpens: true as const,
    status: 'matched' as const,
    reason: 'matched' as const
  };
}
