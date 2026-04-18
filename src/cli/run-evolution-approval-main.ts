import { parseRunEvolutionApprovalArgs, runEvolutionApproval } from './run-evolution-approval.ts';

async function main() {
  const args = parseRunEvolutionApprovalArgs(process.argv.slice(2));
  const result = await runEvolutionApproval(args);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
