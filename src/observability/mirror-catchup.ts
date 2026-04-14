import { join } from 'node:path';

import type {
  FillMirrorEvent,
  IncidentMirrorEvent,
  MirrorEvent,
  OrderMirrorEvent
} from './mirror-events.ts';
import type { MirrorRuntime } from './mirror-runtime.ts';
import { MirrorCursorStore } from './mirror-cursor-store.ts';
import { readJsonLines } from '../journals/jsonl-writer.ts';

export function applyCatchupWindow<T>(input: {
  lines: Array<{ offset: number; value: T }>;
  lastOffset: number;
}) {
  return input.lines.filter((entry) => entry.offset > input.lastOffset);
}

export async function readJsonLinesWithOffsets<T>(path: string) {
  const values = await readJsonLines<T>(path);

  return values.map((value, index) => ({
    offset: index + 1,
    value
  }));
}

type CatchupInput = {
  strategyId: string;
  stateRootDir: string;
  journalRootDir: string;
  mirrorRuntime: MirrorRuntime;
  maxEvents?: number;
};

type JournalSpec = {
  key: string;
  path: string;
  toEvent: (value: unknown, strategyId: string, offset: number) => MirrorEvent | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return '';
}

function readNumber(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function toConfirmationStatus(value: string) {
  return value === 'submitted' || value === 'confirmed' || value === 'failed' || value === 'unknown'
    ? value
    : 'unknown';
}

function toFinality(value: string) {
  return value === 'processed'
    || value === 'confirmed'
    || value === 'finalized'
    || value === 'failed'
    || value === 'unknown'
    ? value
    : 'unknown';
}

function toOrderCatchupEvent(
  value: unknown,
  strategyId: string
): OrderMirrorEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const idempotencyKey = readString(value, ['idempotencyKey']);

  if (idempotencyKey.length === 0) {
    return null;
  }

  return {
    type: 'order',
    priority: 'low',
    payload: {
      idempotencyKey,
      cycleId: readString(value, ['cycleId']),
      strategyId: readString(value, ['strategyId']) || strategyId,
      submissionId: readString(value, ['submissionId']),
      confirmationSignature: readString(value, ['confirmationSignature']),
      poolAddress: readString(value, ['poolAddress']),
      tokenMint: readString(value, ['tokenMint']),
      tokenSymbol: readString(value, ['tokenSymbol']),
      action: 'unknown',
      requestedPositionSol: readNumber(value, ['requestedPositionSol', 'outputSol']),
      quotedOutputSol: readNumber(value, ['quotedOutputSol', 'outputSol']),
      broadcastStatus: 'pending',
      confirmationStatus: toConfirmationStatus(readString(value, ['confirmationStatus'])),
      finality: toFinality(readString(value, ['finality'])),
      createdAt: readString(value, ['createdAt', 'recordedAt']),
      updatedAt: readString(value, ['updatedAt', 'recordedAt', 'createdAt'])
    }
  };
}

function toFillCatchupEvent(
  value: unknown,
  _strategyId: string,
  offset: number
): FillMirrorEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const recordedAt = readString(value, ['recordedAt']);
  const submissionId = readString(value, ['submissionId']);

  if (recordedAt.length === 0 && submissionId.length === 0) {
    return null;
  }

  return {
    type: 'fill',
    priority: 'low',
    payload: {
      fillId: `${submissionId || 'fill'}:${recordedAt || offset}:${offset}`,
      submissionId,
      confirmationSignature: readString(value, ['confirmationSignature']),
      cycleId: readString(value, ['cycleId']),
      tokenMint: readString(value, ['tokenMint']),
      tokenSymbol: readString(value, ['tokenSymbol']),
      side: 'unknown',
      amount: readNumber(value, ['amount']),
      filledSol: readNumber(value, ['filledSol']),
      recordedAt: recordedAt || new Date(0).toISOString()
    }
  };
}

function toIncidentCatchupEvent(
  value: unknown,
  _strategyId: string,
  offset: number
): IncidentMirrorEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const recordedAt = readString(value, ['recordedAt']);
  const reason = readString(value, ['reason']);

  if (reason.length === 0) {
    return null;
  }

  return {
    type: 'incident',
    priority: 'low',
    payload: {
      incidentId: `${readString(value, ['cycleId']) || 'incident'}:${offset}`,
      cycleId: readString(value, ['cycleId']),
      stage: readString(value, ['stage']),
      severity: readString(value, ['severity']) === 'error' ? 'error' : 'warning',
      reason,
      runtimeMode: readString(value, ['runtimeMode']) as IncidentMirrorEvent['payload']['runtimeMode'] || 'healthy',
      submissionId: readString(value, ['submissionId']),
      tokenMint: readString(value, ['tokenMint']),
      tokenSymbol: readString(value, ['tokenSymbol']),
      recordedAt: recordedAt || new Date(0).toISOString()
    }
  };
}

function buildJournalSpecs(strategyId: string, journalRootDir: string): JournalSpec[] {
  return [
    {
      key: `${strategyId}-live-orders`,
      path: join(journalRootDir, `${strategyId}-live-orders.jsonl`),
      toEvent: (value, currentStrategyId) => toOrderCatchupEvent(value, currentStrategyId)
    },
    {
      key: `${strategyId}-live-fills`,
      path: join(journalRootDir, `${strategyId}-live-fills.jsonl`),
      toEvent: (value, currentStrategyId, offset) => toFillCatchupEvent(value, currentStrategyId, offset)
    },
    {
      key: `${strategyId}-live-incidents`,
      path: join(journalRootDir, `${strategyId}-live-incidents.jsonl`),
      toEvent: (value, currentStrategyId, offset) => toIncidentCatchupEvent(value, currentStrategyId, offset)
    }
  ];
}

function canRunCatchup(snapshot: ReturnType<MirrorRuntime['snapshot']>) {
  if (!snapshot.enabled || snapshot.state !== 'healthy') {
    return false;
  }

  return snapshot.queueDepth < Math.floor(snapshot.queueCapacity / 2);
}

export async function enqueueMirrorCatchupFromJournals(input: CatchupInput) {
  const snapshot = input.mirrorRuntime.snapshot();

  if (!canRunCatchup(snapshot)) {
    return 0;
  }

  const remainingCapacity = Math.max(0, snapshot.queueCapacity - snapshot.queueDepth);
  const eventBudget = Math.min(input.maxEvents ?? remainingCapacity, remainingCapacity);

  if (eventBudget <= 0) {
    return 0;
  }

  const cursorStore = new MirrorCursorStore(input.stateRootDir);
  const cursorSnapshot = await cursorStore.read();
  const nextOffsets = {
    ...cursorSnapshot.offsets
  };
  let processed = 0;
  let updated = false;

  for (const journal of buildJournalSpecs(input.strategyId, input.journalRootDir)) {
    if (processed >= eventBudget) {
      break;
    }

    const lines = await readJsonLinesWithOffsets<unknown>(journal.path);
    const lastOffset = cursorSnapshot.offsets[journal.key] ?? 0;
    const unseen = applyCatchupWindow({
      lines,
      lastOffset
    });
    let latestProcessedOffset = lastOffset;

    for (const line of unseen) {
      if (processed >= eventBudget) {
        break;
      }

      const event = journal.toEvent(line.value, input.strategyId, line.offset);

      if (!event) {
        latestProcessedOffset = line.offset;
        updated = true;
        continue;
      }

      input.mirrorRuntime.enqueue(event);
      latestProcessedOffset = line.offset;
      processed += 1;
      updated = true;
    }

    if (latestProcessedOffset !== lastOffset) {
      nextOffsets[journal.key] = latestProcessedOffset;
    }
  }

  if (updated) {
    await cursorStore.write({
      offsets: nextOffsets
    });
  }

  return processed;
}
