import type { StrategyConfig } from '../config/schema.ts';
import { StrategyConfigSchema } from '../config/schema.ts';
import type { StrategyResearchSpec } from './types.ts';

const ALLOWED_PATHS = new Set([
  'hardGates.requireSolRoute',
  'hardGates.minLiquidityUsd',
  'hardGates.minPoolAgeMinutes',
  'hardGates.maxPoolAgeMinutes',
  'filters.minLiquidityUsd',
  'riskThresholds.maxPositionSol',
  'riskThresholds.takeProfitPct',
  'riskThresholds.stopLossPct',
  'lpConfig.enabled',
  'lpConfig.minBinStep',
  'lpConfig.minVolume24hUsd',
  'lpConfig.minFeeTvlRatio24h',
  'lpConfig.stopLossNetPnlPct',
  'lpConfig.takeProfitNetPnlPct',
  'lpConfig.maxImpermanentLossPct',
  'solRouteLimits.maxImpactBps',
  'entryEdge.enabled',
  'entryEdge.defaultAdverseSelectionBps',
  'entryEdge.defaultImpermanentLossBps',
  'entryEdge.defaultChainCostSol',
  'entryEdge.defaultCapitalChargeBps',
  'entryEdge.defaultSafetyMarginBps'
]);

export function validateResearchSpecPatches(spec: StrategyResearchSpec) {
  for (const variant of spec.variants) {
    for (const path of leafPaths(variant.parameterPatch)) {
      if (!ALLOWED_PATHS.has(path)) {
        throw new Error(`Strategy research patch path is not allowed: ${path}`);
      }
    }
  }
}

export function applyStrategyPatch(base: StrategyConfig, patch: Record<string, unknown>): StrategyConfig {
  return StrategyConfigSchema.parse(deepMerge(base, patch));
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isRecord(value) && isRecord(merged[key]) ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function leafPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(child) ? leafPaths(child, path) : [path];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
