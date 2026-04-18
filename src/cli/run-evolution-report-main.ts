import { parseRunEvolutionReportArgs, runEvolutionReport } from './run-evolution-report.ts';

async function main() {
  const args = parseRunEvolutionReportArgs(process.argv.slice(2));
  const result = await runEvolutionReport(args);

  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
