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

function toLifecycleKey(row: ClosedPositionOrderSeedRow) {
  if (row.positionAddress.length > 0) {
    return `position:${row.positionAddress}`;
  }

  if (row.poolAddress.length > 0) {
    return `pool:${row.poolAddress}:${row.tokenMint}`;
  }

  return `token:${row.tokenMint}`;
}

export function buildClosedPositionOrderSeeds(rows: ClosedPositionOrderSeedRow[]) {
  const rowsByLifecycle = new Map<string, ClosedPositionOrderSeedRow[]>();

  for (const row of rows) {
    if ((row.action !== 'add-lp' && row.action !== 'withdraw-lp') || row.signature.length === 0) {
      continue;
    }

    const key = toLifecycleKey(row);
    const group = rowsByLifecycle.get(key) ?? [];
    group.push(row);
    rowsByLifecycle.set(key, group);
  }

  const seeds: ClosedPositionOrderSeed[] = [];

  for (const group of rowsByLifecycle.values()) {
    const ordered = [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const open = ordered.find((row) => row.action === 'add-lp');
    const close = [...ordered].reverse().find((row) => row.action === 'withdraw-lp');

    if (!open || !close) {
      continue;
    }

    seeds.push({
      tokenMint: open.tokenMint,
      tokenSymbol: open.tokenSymbol || close.tokenSymbol,
      poolAddress: open.poolAddress || close.poolAddress,
      positionAddress: open.positionAddress || close.positionAddress,
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
  };
  loadTokenPriceInSol: (seed: ClosedPositionOrderSeed) => Promise<number>;
  writer?: {
    writeClosedPositionSnapshots: (rows: ClosedPositionSnapshot[]) => Promise<void>;
  };
}) {
  const snapshots: ClosedPositionSnapshot[] = [];

  for (const seed of input.seeds) {
    const [openTransaction, closeTransaction, tokenPriceInSol] = await Promise.all([
      input.rpcClient.getTransaction(seed.openSignature),
      input.rpcClient.getTransaction(seed.closeSignature),
      input.loadTokenPriceInSol(seed)
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
        transaction: openTransaction as Parameters<typeof extractLifecycleEventsFromTransaction>[0]['transaction']
      }),
      ...extractLifecycleEventsFromTransaction({
        walletAddress: input.walletAddress,
        tokenMint: seed.tokenMint,
        tokenSymbol: seed.tokenSymbol,
        tokenPriceInSol,
        transaction: closeTransaction as Parameters<typeof extractLifecycleEventsFromTransaction>[0]['transaction']
      })
    ];

    const snapshot = reconstructClosedPositionSnapshot({
      walletAddress: input.walletAddress,
      tokenMint: seed.tokenMint,
      events
    });

    if (!snapshot) {
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
