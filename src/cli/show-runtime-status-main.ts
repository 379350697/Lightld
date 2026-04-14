import { buildStatusView, readMirrorStatus } from '../observability/mirror-query-service.ts';
import { RuntimeStateStore } from '../runtime/runtime-state-store.ts';
import { formatRuntimeStatus } from './show-runtime-status.ts';

type ParsedArgs = {
  stateRootDir: string;
  mirrorPath?: string;
  json: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    stateRootDir: process.env.LIVE_STATE_DIR ?? 'state',
    json: false
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

  process.stdout.write(args.json
    ? `${JSON.stringify(view, null, 2)}\n`
    : `${formatRuntimeStatus(view)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
