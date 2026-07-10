import { quarantineLegacyEvolutionDataset } from '../evolution/dataset-status.ts';
import type { EvolutionStrategyId } from '../evolution/types.ts';

export type QuarantineV1DatasetArgs = {
  strategyId: EvolutionStrategyId;
  stateRootDir: string;
  evolutionRootDir?: string;
};

export function parseQuarantineV1DatasetArgs(argv: string[]): QuarantineV1DatasetArgs {
  const parsed: QuarantineV1DatasetArgs = {
    strategyId: 'new-token-v1',
    stateRootDir: 'state'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--strategy' && (next === 'new-token-v1' || next === 'large-pool-v1')) {
      parsed.strategyId = next;
      index += 1;
      continue;
    }

    if (current === '--state-root-dir' && next) {
      parsed.stateRootDir = next;
      index += 1;
      continue;
    }

    if (current === '--evolution-root-dir' && next) {
      parsed.evolutionRootDir = next;
      index += 1;
    }
  }

  return parsed;
}

export async function runQuarantineV1Dataset(args: QuarantineV1DatasetArgs) {
  return quarantineLegacyEvolutionDataset(args);
}
