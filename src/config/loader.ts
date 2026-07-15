import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

import { StrategyConfigSchema, type StrategyConfig } from './schema.ts';

const strategyConfigCache = new Map<string, Promise<StrategyConfig>>();

export function clearStrategyConfigCache() {
  strategyConfigCache.clear();
}

export async function loadStrategyConfig(path: string): Promise<StrategyConfig> {
  const cached = strategyConfigCache.get(path);

  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const raw = await readFile(path, 'utf8');
    const parsed = StrategyConfigSchema.parse(parse(raw));

    validateStrategyExecutionCompatibility(parsed);

    return parsed;
  })();

  strategyConfigCache.set(path, pending);

  try {
    return await pending;
  } catch (error) {
    strategyConfigCache.delete(path);
    throw error;
  }
}

function validateStrategyExecutionCompatibility(config: StrategyConfig) {
  if (config.lpConfig?.rebalanceOnOutOfRange) {
    throw new Error(
      'lpRebalanceOnOutOfRange=true is not supported by the current live execution path'
    );
  }
}
