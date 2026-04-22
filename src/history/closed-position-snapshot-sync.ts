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
    if (row.action !== 'add-lp' && row.action !== 'withdraw-lp') {
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
    if (address.length === 0) {
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
