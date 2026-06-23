import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  buildIncidentReport,
  formatIncidentReport,
  parseSinceDuration
} from './show-incidents.ts';

type CliArgs = {
  strategyId: string;
  journalRootDir: string;
  stateRootDir: string;
  sinceMs: number;
  output?: string;
  json: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    strategyId: 'new-token-v1',
    journalRootDir: 'tmp/journals',
    stateRootDir: 'state',
    sinceMs: 24 * 60 * 60_000,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === '--strategy') {
      args.strategyId = next();
    } else if (arg === '--journal-root-dir') {
      args.journalRootDir = next();
    } else if (arg === '--state-root-dir') {
      args.stateRootDir = next();
    } else if (arg === '--since') {
      args.sinceMs = parseSinceDuration(next());
    } else if (arg === '--output') {
      args.output = next();
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildIncidentReport({
    strategyId: args.strategyId,
    journalRootDir: args.journalRootDir,
    stateRootDir: args.stateRootDir,
    sinceMs: args.sinceMs
  });
  const output = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatIncidentReport(report)}\n`;

  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, output, 'utf8');
  }

  process.stdout.write(output);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
