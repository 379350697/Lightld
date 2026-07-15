import { join } from 'node:path';

import { buildStatusView, readMirrorStatus } from '../observability/mirror-query-service.ts';
import { refreshHealthReportFreshness } from '../runtime/health-report.ts';
import { RuntimeStateStore } from '../runtime/runtime-state-store.ts';
import { StrategyResearchStore } from '../strategy-research/store.ts';
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
  const persistedReport = await store.readHealthReport();

  if (!persistedReport) {
    throw new Error(`No runtime health report found under ${args.stateRootDir}`);
  }

  const report = refreshHealthReportFreshness(persistedReport);
  const mirrorPath = args.mirrorPath ?? report.mirror?.path;
  const view = await buildStatusView({
    fileState: async () => report,
    mirrorQuery: mirrorPath
      ? async () => readMirrorStatus(mirrorPath)
      : undefined
  });
  const research = await readResearchSummary(args.stateRootDir);

  process.stdout.write(args.json
    ? `${JSON.stringify({ ...view, research }, null, 2)}\n`
    : `${formatRuntimeStatus({ ...view, research })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function readResearchSummary(stateRootDir: string) {
  const store = new StrategyResearchStore(join(stateRootDir, 'research', 'research.sqlite'), true);
  try {
    await store.open();
    return store.status();
  } catch {
    return null;
  } finally {
    store.close();
  }
}
