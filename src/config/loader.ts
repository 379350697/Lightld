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
    const parsed = applyRuntimeOverrides(StrategyConfigSchema.parse(parse(raw)));

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

function parsePositiveNumberEnv(name: string) {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function applyRuntimeOverrides(config: StrategyConfig): StrategyConfig {
  if (!config.lpConfig) {
    return config;
  }

  const stopLossNetPnlPct = parsePositiveNumberEnv('LIVE_LP_STOP_LOSS_NET_PNL_PCT');
  const takeProfitNetPnlPct = parsePositiveNumberEnv('LIVE_LP_TAKE_PROFIT_NET_PNL_PCT');
  if (typeof stopLossNetPnlPct !== 'number' && typeof takeProfitNetPnlPct !== 'number') {
    return config;
  }

  return {
    ...config,
    lpConfig: {
      ...config.lpConfig,
      stopLossNetPnlPct: stopLossNetPnlPct ?? config.lpConfig.stopLossNetPnlPct,
      takeProfitNetPnlPct: takeProfitNetPnlPct ?? config.lpConfig.takeProfitNetPnlPct
    }
  };
}

function validateStrategyExecutionCompatibility(config: StrategyConfig) {
  if (config.lpConfig?.rebalanceOnOutOfRange) {
    throw new Error(
      'lpRebalanceOnOutOfRange=true is not supported by the current live execution path'
    );
  }
}
