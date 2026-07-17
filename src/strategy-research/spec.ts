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

const CANDIDATE_UNIVERSE_FLOOR_PATHS = [
  'filters.minLiquidityUsd',
  'lpConfig.minBinStep',
  'lpConfig.minVolume24hUsd',
  'lpConfig.minFeeTvlRatio24h'
] as const;

const CANDIDATE_UNIVERSE_GUIDANCE =
  'Set the baseline to the widest candidate filters, then compare only equal or stricter variants.';

export function validateResearchSpecPatches(spec: StrategyResearchSpec) {
  for (const variant of spec.variants) {
    const patchedPaths = new Set(leafPaths(variant.parameterPatch));
    for (const path of patchedPaths) {
      if (!ALLOWED_PATHS.has(path)) {
        throw new Error(`Strategy research patch path is not allowed: ${path}`);
      }
    }

    if (![...patchedPaths].some((path) =>
      path === 'lpConfig.enabled' || CANDIDATE_UNIVERSE_FLOOR_PATHS.includes(path as (typeof CANDIDATE_UNIVERSE_FLOOR_PATHS)[number])
    )) {
      continue;
    }
    if (!spec.baseConfig) {
      throw new Error(
        `Strategy research candidate-universe validation requires a locked baseConfig for variant "${variant.variantId}". ${CANDIDATE_UNIVERSE_GUIDANCE}`
      );
    }

    const requestedLpEnabled = nestedValue(variant.parameterPatch, 'lpConfig', 'enabled');
    if (patchedPaths.has('lpConfig.enabled') && !spec.baseConfig.lpConfig && requestedLpEnabled === true) {
      throwUniverseExpansion(variant.variantId, 'lpConfig.enabled', false, true);
    }

    const variantConfig = applyStrategyPatch(spec.baseConfig, variant.parameterPatch);
    if (patchedPaths.has('lpConfig.enabled') && variantConfig.lpConfig?.enabled !== spec.baseConfig.lpConfig?.enabled) {
      throwUniverseExpansion(
        variant.variantId,
        'lpConfig.enabled',
        spec.baseConfig.lpConfig?.enabled,
        variantConfig.lpConfig?.enabled
      );
    }

    for (const path of CANDIDATE_UNIVERSE_FLOOR_PATHS) {
      if (!patchedPaths.has(path)) continue;
      const baseline = numericPath(spec.baseConfig, path);
      const candidate = numericPath(variantConfig, path);
      if (candidate < baseline) {
        throwUniverseExpansion(variant.variantId, path, baseline, candidate);
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

function nestedValue(value: Record<string, unknown>, parent: string, child: string) {
  const nested = value[parent];
  return isRecord(nested) ? nested[child] : undefined;
}

function numericPath(config: StrategyConfig, path: (typeof CANDIDATE_UNIVERSE_FLOOR_PATHS)[number]) {
  switch (path) {
    case 'filters.minLiquidityUsd':
      return config.filters.minLiquidityUsd;
    case 'lpConfig.minBinStep':
      return config.lpConfig?.minBinStep ?? Number.POSITIVE_INFINITY;
    case 'lpConfig.minVolume24hUsd':
      return config.lpConfig?.minVolume24hUsd ?? Number.POSITIVE_INFINITY;
    case 'lpConfig.minFeeTvlRatio24h':
      return config.lpConfig?.minFeeTvlRatio24h ?? Number.POSITIVE_INFINITY;
  }
}

function throwUniverseExpansion(
  variantId: string,
  path: string,
  baseline: unknown,
  candidate: unknown
): never {
  throw new Error(
    `Strategy research variant "${variantId}" expands the baseline candidate universe at ${path} (${String(candidate)} vs baseline ${String(baseline)}). ${CANDIDATE_UNIVERSE_GUIDANCE}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
