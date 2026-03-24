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

    return StrategyConfigSchema.parse(parse(raw));
  })();

  strategyConfigCache.set(path, pending);

  try {
    return await pending;
  } catch (error) {
    strategyConfigCache.delete(path);
    throw error;
  }
}
