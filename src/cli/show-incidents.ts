import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveEvolutionPaths } from '../evolution/paths.ts';
import { listRotatedJsonlPaths } from '../journals/jsonl-writer.ts';
import {
  classifyIncidentReason,
  type IncidentClassification,
  type IncidentKind
} from '../runtime/incident-taxonomy.ts';

type JsonRecord = Record<string, unknown>;

export type IncidentReportOptions = {
  strategyId?: string;
  journalRootDir?: string;
  stateRootDir?: string;
  sinceMs?: number;
  now?: Date;
};

export type IncidentGroupReport = {
  kind: IncidentKind;
  records: number;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  severity: 'warning' | 'error';
  sampleReason: string;
  rootCause: string;
  suggestedAction: string;
  tokenMints: string[];
  poolAddresses: string[];
};

export type TradingReport = {
  fillCount: number;
  fillsBySide: Record<string, number>;
  outcomeCount: number;
  outcomesByAction: Record<string, number>;
  outcomesByReason: Record<string, number>;
};

export type IncidentReport = {
  strategyId: string;
  since: string;
  until: string;
  incidentRecords: number;
  incidentOccurrences: number;
  invalidIncidentLines: number;
  incidentSourceFiles: number;
  fillSourceFiles: number;
  outcomeSourceFiles: number;
  groups: IncidentGroupReport[];
  trading: TradingReport;
};

type ReadJsonlResult = {
  records: JsonRecord[];
  invalidLines: number;
  sourceFiles: number;
};

function toStringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function toNumberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestampOf(record: JsonRecord) {
  return toStringValue(record.recordedAt)
    || toStringValue(record.updatedAt)
    || toStringValue(record.createdAt)
    || toStringValue(record.closedAt)
    || toStringValue(record.openedAt);
}

function isSince(record: JsonRecord, sinceMs: number) {
  const timestamp = Date.parse(timestampOf(record));
  return !Number.isNaN(timestamp) && timestamp >= sinceMs;
}

function increment(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function compactSet(values: Set<string>, maxEntries = 8) {
  return [...values].filter(Boolean).sort().slice(0, maxEntries);
}

async function resolveJsonlPaths(basePath: string) {
  const rotated = await listRotatedJsonlPaths(basePath);
  return rotated.length > 0 ? rotated : [basePath];
}

async function readJsonlRecords(basePath: string): Promise<ReadJsonlResult> {
  const paths = await resolveJsonlPaths(basePath);
  const records: JsonRecord[] = [];
  let invalidLines = 0;
  let sourceFiles = 0;

  for (const path of paths) {
    let content = '';
    try {
      content = await readFile(path, 'utf8');
      sourceFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          records.push(parsed as JsonRecord);
        } else {
          invalidLines += 1;
        }
      } catch {
        invalidLines += 1;
      }
    }
  }

  return { records, invalidLines, sourceFiles };
}

function resolveIncidentClassification(record: JsonRecord): IncidentClassification {
  const existingKind = toStringValue(record.kind) as IncidentKind;
  if (existingKind) {
    const reason = toStringValue(record.reason);
    const fallback = classifyIncidentReason(reason);
    return {
      kind: existingKind,
      rootCause: toStringValue(record.rootCause) || fallback.rootCause,
      suggestedAction: toStringValue(record.suggestedAction) || fallback.suggestedAction,
      severity: (toStringValue(record.severity) as 'warning' | 'error') || fallback.severity
    };
  }

  return classifyIncidentReason(toStringValue(record.reason));
}

function buildIncidentGroups(records: JsonRecord[]): IncidentGroupReport[] {
  const groups = new Map<IncidentKind, {
    classification: IncidentClassification;
    records: number;
    occurrences: number;
    firstSeenAt: string;
    lastSeenAt: string;
    sampleReason: string;
    severity: 'warning' | 'error';
    tokenMints: Set<string>;
    poolAddresses: Set<string>;
  }>();

  for (const record of records) {
    const classification = resolveIncidentClassification(record);
    const timestamp = timestampOf(record);
    const existing = groups.get(classification.kind);
    const suppressedCount = toNumberValue(record.suppressedCount) ?? 0;
    const severity = (toStringValue(record.severity) as 'warning' | 'error') || classification.severity || 'warning';

    if (!existing) {
      groups.set(classification.kind, {
        classification,
        records: 1,
        occurrences: 1 + suppressedCount,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        sampleReason: toStringValue(record.reason),
        severity,
        tokenMints: new Set([toStringValue(record.tokenMint)]),
        poolAddresses: new Set([toStringValue(record.poolAddress)])
      });
      continue;
    }

    existing.records += 1;
    existing.occurrences += 1 + suppressedCount;
    if (timestamp && (!existing.firstSeenAt || timestamp < existing.firstSeenAt)) {
      existing.firstSeenAt = timestamp;
    }
    if (timestamp && (!existing.lastSeenAt || timestamp > existing.lastSeenAt)) {
      existing.lastSeenAt = timestamp;
    }
    if (severity === 'error') {
      existing.severity = 'error';
    }
    existing.tokenMints.add(toStringValue(record.tokenMint));
    existing.poolAddresses.add(toStringValue(record.poolAddress));
  }

  return [...groups.entries()]
    .map(([kind, group]) => ({
      kind,
      records: group.records,
      occurrences: group.occurrences,
      firstSeenAt: group.firstSeenAt,
      lastSeenAt: group.lastSeenAt,
      severity: group.severity,
      sampleReason: group.sampleReason,
      rootCause: group.classification.rootCause,
      suggestedAction: group.classification.suggestedAction,
      tokenMints: compactSet(group.tokenMints),
      poolAddresses: compactSet(group.poolAddresses)
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.kind.localeCompare(right.kind));
}

function buildTradingReport(input: {
  fills: JsonRecord[];
  outcomes: JsonRecord[];
}): TradingReport {
  const fillsBySide: Record<string, number> = {};
  const outcomesByAction: Record<string, number> = {};
  const outcomesByReason: Record<string, number> = {};

  for (const fill of input.fills) {
    increment(fillsBySide, toStringValue(fill.side) || 'unknown');
  }

  for (const outcome of input.outcomes) {
    increment(outcomesByAction, toStringValue(outcome.action) || 'unknown');
    increment(outcomesByReason, toStringValue(outcome.actualExitReason) || 'unknown');
  }

  return {
    fillCount: input.fills.length,
    fillsBySide,
    outcomeCount: input.outcomes.length,
    outcomesByAction,
    outcomesByReason
  };
}

export async function buildIncidentReport(options: IncidentReportOptions = {}): Promise<IncidentReport> {
  const strategyId = options.strategyId ?? 'new-token-v1';
  const journalRootDir = options.journalRootDir ?? 'tmp/journals';
  const stateRootDir = options.stateRootDir ?? 'state';
  const now = options.now ?? new Date();
  const sinceMs = now.getTime() - (options.sinceMs ?? 24 * 60 * 60 * 1000);

  const [incidents, fills, outcomes] = await Promise.all([
    readJsonlRecords(join(journalRootDir, `${strategyId}-live-incidents.jsonl`)),
    readJsonlRecords(join(journalRootDir, `${strategyId}-live-fills.jsonl`)),
    readJsonlRecords(resolveEvolutionPaths(strategyId as never, join(stateRootDir, 'evolution')).positionOutcomesPath)
  ]);
  const incidentRecords = incidents.records.filter((record) => isSince(record, sinceMs));
  const fillRecords = fills.records.filter((record) => isSince(record, sinceMs));
  const outcomeRecords = outcomes.records.filter((record) => isSince(record, sinceMs));
  const groups = buildIncidentGroups(incidentRecords);

  return {
    strategyId,
    since: new Date(sinceMs).toISOString(),
    until: now.toISOString(),
    incidentRecords: incidentRecords.length,
    incidentOccurrences: groups.reduce((sum, group) => sum + group.occurrences, 0),
    invalidIncidentLines: incidents.invalidLines,
    incidentSourceFiles: incidents.sourceFiles,
    fillSourceFiles: fills.sourceFiles,
    outcomeSourceFiles: outcomes.sourceFiles,
    groups,
    trading: buildTradingReport({
      fills: fillRecords,
      outcomes: outcomeRecords
    })
  };
}

function formatCountMap(map: Record<string, number>) {
  const entries = Object.entries(map).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return entries.length > 0
    ? entries.map(([key, count]) => `${key}=${count}`).join(', ')
    : 'none';
}

function formatList(values: string[]) {
  return values.length > 0 ? values.join(', ') : 'n/a';
}

export function formatIncidentReport(report: IncidentReport) {
  const lines = [
    '# Lightld Incident Report',
    '',
    `strategy=${report.strategyId}`,
    `window=${report.since}..${report.until}`,
    `incidentRecords=${report.incidentRecords}`,
    `incidentOccurrences=${report.incidentOccurrences}`,
    `invalidIncidentLines=${report.invalidIncidentLines}`,
    `incidentSourceFiles=${report.incidentSourceFiles}`,
    `fillSourceFiles=${report.fillSourceFiles}`,
    `outcomeSourceFiles=${report.outcomeSourceFiles}`,
    '',
    '## Trading',
    '',
    `fills=${report.trading.fillCount} (${formatCountMap(report.trading.fillsBySide)})`,
    `outcomes=${report.trading.outcomeCount} (${formatCountMap(report.trading.outcomesByAction)})`,
    `outcomeReasons=${formatCountMap(report.trading.outcomesByReason)}`,
    '',
    '## Incidents',
    ''
  ];

  if (report.groups.length === 0) {
    lines.push('No incidents in window.');
    return lines.join('\n');
  }

  lines.push('| kind | records | occurrences | severity | first | last | tokens | pools | action |');
  lines.push('| --- | ---: | ---: | --- | --- | --- | --- | --- | --- |');

  for (const group of report.groups) {
    lines.push([
      `| ${group.kind}`,
      String(group.records),
      String(group.occurrences),
      group.severity,
      group.firstSeenAt || 'n/a',
      group.lastSeenAt || 'n/a',
      formatList(group.tokenMints),
      formatList(group.poolAddresses),
      `${group.suggestedAction} |`
    ].join(' | '));
  }

  lines.push('', '## Samples', '');
  for (const group of report.groups.slice(0, 20)) {
    lines.push(`- ${group.kind}: ${group.sampleReason}`);
  }

  return lines.join('\n');
}

export function parseSinceDuration(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid --since value: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'm'
    ? 60_000
    : unit === 'h'
      ? 60 * 60_000
      : 24 * 60 * 60_000;

  return Math.floor(amount * multiplier);
}
