import type { HealthReport } from '../runtime/state-types.ts';
import { SqliteMirrorWriter } from './sqlite-mirror-writer.ts';

export type MirrorStatusExtras = {
  recentIncidents: Array<{
    incidentId: string;
    cycleId: string;
    stage: string;
    severity: 'warning' | 'error';
    reason: string;
    runtimeMode: string;
    recordedAt: string;
  }>;
  recentOrders: Array<{
    idempotencyKey: string;
    submissionId: string;
    tokenSymbol: string;
    confirmationStatus: string;
    finality: string;
    updatedAt: string;
  }>;
};

export type MirrorResearchExtras = {
  recentCandidateScans: Array<{
    scanId: string;
    capturedAt: string;
    strategyId: string;
    selectedTokenMint: string;
    selectedPoolAddress: string;
    blockedReason: string;
    candidateCount: number;
  }>;
  recentWatchlistSnapshots: Array<{
    watchId: string;
    trackedSince: string;
    strategyId: string;
    tokenMint: string;
    tokenSymbol: string;
    poolAddress: string;
    observationAt: string;
    windowLabel: string;
    currentValueSol: number | null;
    unclaimedFeeSol: number | null;
    hasInventory: boolean;
    hasLpPosition: boolean;
    sourceReason: string;
  }>;
};

export type RuntimeStatusView = HealthReport & MirrorStatusExtras;

export async function readMirrorStatus(path: string): Promise<MirrorStatusExtras> {
  const writer = new SqliteMirrorWriter({ path });
  await writer.open();

  try {
    return {
      recentIncidents: await writer.readRecentIncidents(5),
      recentOrders: await writer.readRecentOrders(5)
    };
  } finally {
    await writer.close();
  }
}

export async function readMirrorResearch(path: string): Promise<MirrorResearchExtras> {
  const writer = new SqliteMirrorWriter({ path });
  await writer.open();

  try {
    return {
      recentCandidateScans: await writer.readRecentCandidateScans(10),
      recentWatchlistSnapshots: await writer.readRecentWatchlistSnapshots(10)
    };
  } finally {
    await writer.close();
  }
}

export async function buildStatusView<T extends object>(input: {
  fileState: () => Promise<T>;
  mirrorQuery?: () => Promise<Partial<MirrorStatusExtras>>;
}): Promise<T & MirrorStatusExtras> {
  const base = await input.fileState();

  try {
    const mirror = input.mirrorQuery
      ? await input.mirrorQuery()
      : {};

    return {
      ...base,
      recentIncidents: mirror.recentIncidents ?? [],
      recentOrders: mirror.recentOrders ?? []
    };
  } catch {
    return {
      ...base,
      recentIncidents: [],
      recentOrders: []
    };
  }
}
