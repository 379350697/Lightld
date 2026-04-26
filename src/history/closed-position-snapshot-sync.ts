import type { ClosedPositionSnapshot } from './solana-closed-position-reconstructor.ts';
import {
  extractLifecycleEventsFromTransaction,
  reconstructClosedPositionSnapshot
} from './solana-closed-position-reconstructor.ts';

export type ClosedPositionOrderSeedRow = {
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  positionAddress: string;
  action: string;
  createdAt: string;
  signature: string;
};

export type ClosedPositionOrderSeed = {
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  positionAddress: string;
  openedAt: string;
  closedAt: string;
  openSignature: string;
  closeSignature: string;
};

type AddressSignatureInfo = {
  signature: string;
  slot: number;
  blockTime: number | null;
};

function looksLikeBase58Address(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function buildRowIdentity(row: ClosedPositionOrderSeedRow) {
  return [
    row.action,
    row.tokenMint,
    row.poolAddress,
    row.positionAddress,
    row.createdAt
  ].join('|');
}

function buildLifecycleDedupKey(row: ClosedPositionOrderSeedRow) {
  if (looksLikeBase58Address(row.positionAddress)) {
    return `${row.action}|position|${row.positionAddress}`;
  }

  return `${row.action}|pool-token|${row.poolAddress}|${row.tokenMint}`;
}

function dedupeLifecycleRows(rows: ClosedPositionOrderSeedRow[]) {
  const deduped = new Map<string, ClosedPositionOrderSeedRow>();

  for (const row of rows) {
    const dedupKey = buildLifecycleDedupKey(row);
    const existing = deduped.get(dedupKey);

    if (!existing) {
      deduped.set(dedupKey, row);
      continue;
    }

    if (row.action === 'withdraw-lp') {
      if (existing.createdAt.localeCompare(row.createdAt) < 0) {
        deduped.set(dedupKey, row);
      }
      continue;
    }

    if (existing.createdAt.localeCompare(row.createdAt) > 0) {
      deduped.set(dedupKey, row);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function rowsCanShareLifecycle(open: ClosedPositionOrderSeedRow, close: ClosedPositionOrderSeedRow) {
  if (open.tokenMint !== close.tokenMint) {
    return false;
  }

  if (open.poolAddress.length > 0 && close.poolAddress.length > 0 && open.poolAddress !== close.poolAddress) {
    return false;
  }

  if (
    open.positionAddress.length > 0
    && close.positionAddress.length > 0
    && open.positionAddress !== close.positionAddress
  ) {
    return false;
  }

  return open.createdAt.localeCompare(close.createdAt) <= 0;
}

export function buildClosedPositionOrderSeeds(rows: ClosedPositionOrderSeedRow[]) {
  const dedupedRows = dedupeLifecycleRows(rows);
  const opens = dedupedRows
    .filter((row) => row.action === 'add-lp')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const closes = dedupedRows
    .filter((row) => row.action === 'withdraw-lp')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const usedSeedKeys = new Set<string>();
  const usedOpenIndexes = new Set<number>();
  const seeds: ClosedPositionOrderSeed[] = [];

  for (const close of closes) {
    let matchedOpenIndex = -1;

    for (let index = opens.length - 1; index >= 0; index -= 1) {
      if (usedOpenIndexes.has(index) || !rowsCanShareLifecycle(opens[index], close)) {
        continue;
      }

      matchedOpenIndex = index;
      break;
    }

    if (matchedOpenIndex < 0) {
      continue;
    }

    const open = opens[matchedOpenIndex];
    const seedKey = `${buildRowIdentity(open)}=>${buildRowIdentity(close)}`;

    if (usedSeedKeys.has(seedKey)) {
      continue;
    }

    usedOpenIndexes.add(matchedOpenIndex);
    usedSeedKeys.add(seedKey);
    seeds.push({
      tokenMint: open.tokenMint,
      tokenSymbol: open.tokenSymbol || close.tokenSymbol,
      poolAddress: open.poolAddress || close.poolAddress,
      positionAddress: looksLikeBase58Address(open.positionAddress)
        ? open.positionAddress
        : close.positionAddress,
      openedAt: open.createdAt,
      closedAt: close.createdAt,
      openSignature: open.signature,
      closeSignature: close.signature
    });
  }

  return seeds.sort((left, right) => right.closedAt.localeCompare(left.closedAt));
}

export async function syncClosedPositionSnapshots(input: {
  walletAddress: string;
  seeds: ClosedPositionOrderSeed[];
  rpcClient: {
    getTransaction: (signature: string) => Promise<unknown | null>;
    getSignaturesForAddress?: (address: string, options?: { limit?: number }) => Promise<AddressSignatureInfo[]>;
  };
  loadTokenPriceInSol: (seed: ClosedPositionOrderSeed) => Promise<number>;
  writer?: {
    writeClosedPositionSnapshots: (rows: ClosedPositionSnapshot[]) => Promise<void>;
  };
}) {
  const snapshots: ClosedPositionSnapshot[] = [];

  for (const seed of input.seeds) {
    const [openSignature, closeSignature, tokenPriceInSol] = await Promise.all([
      seed.openSignature.length > 0
        ? Promise.resolve(seed.openSignature)
        : resolveLifecycleSignature({
            rpcClient: input.rpcClient,
            addressCandidates: [seed.positionAddress, seed.poolAddress],
            targetAt: seed.openedAt,
            instructionName: 'AddLiquidityByStrategy2'
          }),
      seed.closeSignature.length > 0
        ? Promise.resolve(seed.closeSignature)
        : resolveLifecycleSignature({
            rpcClient: input.rpcClient,
            addressCandidates: [seed.positionAddress, seed.poolAddress],
            targetAt: seed.closedAt,
            instructionName: 'RemoveLiquidityByRange2'
          }),
      input.loadTokenPriceInSol(seed)
    ]);

    const [openTransaction, closeTransaction] = await Promise.all([
      openSignature ? input.rpcClient.getTransaction(openSignature) : Promise.resolve(null),
      closeSignature ? input.rpcClient.getTransaction(closeSignature) : Promise.resolve(null)
    ]);

    if (!openTransaction || !closeTransaction) {
      continue;
    }

    const events = [
      ...extractLifecycleEventsFromTransaction({
        walletAddress: input.walletAddress,
        tokenMint: seed.tokenMint,
        tokenSymbol: seed.tokenSymbol,
        tokenPriceInSol,
        poolAddress: seed.poolAddress,
        positionAddress: seed.positionAddress,
        transaction: openTransaction as Parameters<typeof extractLifecycleEventsFromTransaction>[0]['transaction']
      }),
      ...extractLifecycleEventsFromTransaction({
        walletAddress: input.walletAddress,
        tokenMint: seed.tokenMint,
        tokenSymbol: seed.tokenSymbol,
        tokenPriceInSol,
        poolAddress: seed.poolAddress,
        positionAddress: seed.positionAddress,
        transaction: closeTransaction as Parameters<typeof extractLifecycleEventsFromTransaction>[0]['transaction']
      })
    ];

    const snapshot = reconstructClosedPositionSnapshot({
      walletAddress: input.walletAddress,
      tokenMint: seed.tokenMint,
      events
    });

    if (
      !snapshot
      || snapshot.depositSol <= 0
      || snapshot.openedAt.localeCompare(snapshot.closedAt) >= 0
    ) {
      continue;
    }

    snapshots.push({
      ...snapshot,
      tokenSymbol: snapshot.tokenSymbol || seed.tokenSymbol,
      poolAddress: snapshot.poolAddress || seed.poolAddress,
      positionAddress: snapshot.positionAddress || seed.positionAddress,
      confidence: tokenPriceInSol > 0 ? snapshot.confidence : 'partial'
    });
  }

  if (input.writer && snapshots.length > 0) {
    await input.writer.writeClosedPositionSnapshots(snapshots);
  }

  return snapshots;
}

async function resolveLifecycleSignature(input: {
  rpcClient: {
    getSignaturesForAddress?: (address: string, options?: { limit?: number }) => Promise<AddressSignatureInfo[]>;
    getTransaction: (signature: string) => Promise<unknown | null>;
  };
  addressCandidates: string[];
  targetAt: string;
  instructionName: 'AddLiquidityByStrategy2' | 'RemoveLiquidityByRange2';
}) {
  if (!input.rpcClient.getSignaturesForAddress) {
    return '';
  }

  const targetMillis = Date.parse(input.targetAt);
  if (!Number.isFinite(targetMillis)) {
    return '';
  }

  for (const address of input.addressCandidates) {
    if (address.length === 0 || !looksLikeBase58Address(address)) {
      continue;
    }

    const signatures = await input.rpcClient.getSignaturesForAddress(address, { limit: 20 });
    const ordered = [...signatures].sort((left, right) => {
      const leftMillis = typeof left.blockTime === 'number' ? left.blockTime * 1000 : Number.POSITIVE_INFINITY;
      const rightMillis = typeof right.blockTime === 'number' ? right.blockTime * 1000 : Number.POSITIVE_INFINITY;
      return Math.abs(leftMillis - targetMillis) - Math.abs(rightMillis - targetMillis);
    });

    for (const candidate of ordered) {
      const transaction = await input.rpcClient.getTransaction(candidate.signature) as {
        meta?: { logMessages?: string[] };
      } | null;

      if (transaction?.meta?.logMessages?.some((message) => message.includes(`Instruction: ${input.instructionName}`))) {
        return candidate.signature;
      }
    }
  }

  return '';
}
