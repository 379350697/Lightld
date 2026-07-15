import { runStrategyResearchCli } from './run-strategy-research.ts';

runStrategyResearchCli(process.argv.slice(2)).then((result) => {
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
