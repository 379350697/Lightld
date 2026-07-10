import { parseQuarantineV1DatasetArgs, runQuarantineV1Dataset } from './quarantine-v1-dataset.ts';

async function main() {
  const result = await runQuarantineV1Dataset(parseQuarantineV1DatasetArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
