import { stat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

import { loadStrategyConfig } from '../config/loader.ts';
import { loadEvolutionEvidence } from '../evolution/evidence-loader.ts';
import { analyzeStrategyResearch, renderResearchMarkdown } from '../strategy-research/analyzer.ts';
import { validateResearchSpecPatches } from '../strategy-research/spec.ts';
import { StrategyResearchStore } from '../strategy-research/store.ts';
import { StrategyResearchSpecSchema } from '../strategy-research/types.ts';

export type StrategyResearchCliResult = { exitCode: number; output: string };

export async function runStrategyResearchCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<StrategyResearchCliResult> {
  const command = argv[0];
  const stateRoot = value(argv, '--state-root-dir') ?? environment.LIVE_STATE_DIR ?? 'state';
  const researchRoot = join(stateRoot, 'research');
  const databasePath = join(researchRoot, 'research.sqlite');
  const store = new StrategyResearchStore(databasePath);
  await store.open();
  try {
    if (command === 'start') {
      const specPath = required(argv, '--spec');
      const parsedSpec = StrategyResearchSpecSchema.parse(parse(await readFile(specPath, 'utf8')));
      const spec = {
        ...parsedSpec,
        baseConfig: parsedSpec.baseConfig ?? await loadStrategyConfig(`src/config/strategies/${parsedSpec.strategyId}.yaml`)
      };
      validateResearchSpecPatches(spec);
      store.startExperiment(spec);
      return json({ command, status: 'active', experimentId: spec.experimentId, databasePath });
    }
    if (command === 'stop') {
      const changed = store.stopExperiment();
      return json({ command, status: changed ? 'stopped' : 'no-active-experiment' });
    }
    if (command === 'status') {
      const fileSizes = Object.fromEntries(await Promise.all([
        ['database', databasePath],
        ['wal', `${databasePath}-wal`],
        ['shm', `${databasePath}-shm`]
      ].map(async ([name, path]) => [name, await stat(path).then((entry) => entry.size).catch(() => 0)]))) as Record<string, number>;
      const databaseBytes = Object.values(fileSizes).reduce((sum, value) => sum + Number(value), 0);
      return json({ command, ...store.status(), databasePath, databaseBytes, fileSizes });
    }
    if (command === 'analyze') {
      const spec = resolveSpec(store, argv);
      const evidence = await loadEvolutionEvidence({ strategyId: spec.strategyId, stateRootDir: stateRoot });
      store.syncPaperOutcomes(spec.experimentId, evidence.outcomes);
      const report = analyzeStrategyResearch(store, spec);
      const reportsRoot = join(researchRoot, 'reports');
      await mkdir(reportsRoot, { recursive: true });
      const jsonPath = join(reportsRoot, `${report.reportId}.json`);
      const markdownPath = join(reportsRoot, `${report.reportId}.md`);
      await Promise.all([
        writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
        writeFile(markdownPath, renderResearchMarkdown(report), 'utf8')
      ]);
      if (report.patchDraft) {
        await writeFile(join(reportsRoot, `${report.reportId}.patch.json`), `${JSON.stringify(report.patchDraft, null, 2)}\n`, 'utf8');
      }
      return json({ command, report, jsonPath, markdownPath }, report.status === 'reject' ? 2 : 0);
    }
    if (command === 'export') {
      const format = value(argv, '--format') ?? 'csv';
      if (format !== 'csv') throw new Error('Only --format csv is supported');
      const spec = resolveSpec(store, argv);
      const rows = store.exportRows(spec.experimentId);
      const outputPath = value(argv, '--output') ?? join(researchRoot, `${spec.experimentId}.csv`);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, toCsv(rows), 'utf8');
      return json({ command, experimentId: spec.experimentId, rowCount: rows.length, outputPath });
    }
    throw new Error('Expected command: start, status, analyze, stop, or export');
  } finally {
    store.close();
  }
}

function resolveSpec(store: StrategyResearchStore, argv: string[]) {
  const experimentId = value(argv, '--experiment-id');
  const spec = experimentId
    ? store.experiment(experimentId)
    : store.activeExperiment() ?? store.latestExperiment()?.spec ?? null;
  if (!spec) throw new Error(experimentId ? `Unknown experiment ${experimentId}` : 'No strategy research experiment');
  return spec;
}

function value(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv: string[], name: string) {
  const found = value(argv, name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

function json(value: unknown, exitCode = 0): StrategyResearchCliResult {
  return { exitCode, output: `${JSON.stringify(value, null, 2)}\n` };
}

function toCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const escape = (input: unknown) => {
    const text = input === null || input === undefined ? '' : String(input);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${headers.join(',')}\n${rows.map((row) => headers.map((header) => escape(row[header])).join(',')).join('\n')}\n`;
}
