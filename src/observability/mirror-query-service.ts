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
