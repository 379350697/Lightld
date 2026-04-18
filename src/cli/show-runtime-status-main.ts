import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveEvolutionPaths } from '../evolution/index.ts';
import { buildStatusView, readMirrorStatus } from '../observability/mirror-query-service.ts';
import { RuntimeStateStore } from '../runtime/runtime-state-store.ts';
import { formatRuntimeStatus } from './show-runtime-status.ts';

type ParsedArgs = {
  stateRootDir: string;
  mirrorPath?: string;
  json: boolean;
  strategyId: 'new-token-v1' | 'large-pool-v1';
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    json: false,
    strategyId: process.env.LIVE_STRATEGY_ID === 'large-pool-v1' ? 'large-pool-v1' : 'new-token-v1'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--state-root-dir' && next) {
      parsed.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--mirror-path' && next) {
      parsed.mirrorPath = next;
      index += 1;
      continue;
    }

    if (current === '--json') {
      parsed.json = true;
      continue;
    }

    if (current === '--strategy' && next && (next === 'new-token-v1' || next === 'large-pool-v1')) {
      parsed.strategyId = next;
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new RuntimeStateStore(args.stateRootDir);
  const report = await store.readHealthReport();

  if (!report) {
    throw new Error(`No runtime health report found under ${args.stateRootDir}`);
  }

  const mirrorPath = args.mirrorPath ?? report.mirror?.path;
  const view = await buildStatusView({
    fileState: async () => report,
    mirrorQuery: mirrorPath
      ? async () => readMirrorStatus(mirrorPath)
      : undefined
  });
  const evolution = await readEvolutionSummary(args.stateRootDir, args.strategyId);

  process.stdout.write(args.json
    ? `${JSON.stringify({ ...view, evolution }, null, 2)}\n`
    : `${formatRuntimeStatus({ ...view, evolution })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function readEvolutionSummary(
  stateRootDir: string,
  strategyId: 'new-token-v1' | 'large-pool-v1'
) {
  const paths = resolveEvolutionPaths(strategyId, join(stateRootDir, 'evolution'));
  const [proposalCatalog, approvalQueue, outcomeLedger, evidenceSnapshot] = await Promise.all([
    readJsonIfExists<Array<unknown>>(paths.proposalCatalogPath),
    readJsonIfExists<Array<unknown>>(paths.approvalQueuePath),
    readJsonlCount(paths.outcomeLedgerPath),
    readJsonIfExists<{ timeWindowLabel?: string }>(paths.evidenceSnapshotPath)
  ]);

  return {
    proposalCount: proposalCatalog?.length ?? 0,
    approvalQueueCount: approvalQueue?.length ?? 0,
    outcomeReviewCount: outcomeLedger,
    latestEvidenceWindow: evidenceSnapshot?.timeWindowLabel ?? 'none'
  };
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readJsonlCount(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}
