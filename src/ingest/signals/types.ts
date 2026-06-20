import type {
  AuxiliarySignalProviderName,
  AuxiliarySignalsConfig
} from '../../config/schema.ts';
import type { FetchImpl } from '../shared/http-client.ts';

export type AuxiliarySignalStatus = 'disabled' | 'available' | 'partial' | 'unavailable' | 'timeout';

export type AuxiliarySignalCandidate = {
  mint: string;
  symbol: string;
  chain?: string;
  address?: string;
  poolAddress?: string;
};

export type AuxiliarySignalProviderOptions = {
  fetchImpl?: FetchImpl;
  apiKey?: string;
  baseUrl?: string;
};

export type AuxiliarySignalProviderResult = {
  provider: AuxiliarySignalProviderName;
  status: AuxiliarySignalStatus;
  signalScore: number;
  dexscreenerBoostAmount?: number;
  dexscreenerHasProfile?: boolean;
  jupiterOrganicScore?: number;
  jupiterTrendingRank?: number;
  coingeckoTrendingRank?: number;
  birdeyeTrendingRank?: number;
  error?: string;
};

export type AuxiliarySignalProvider = {
  name: AuxiliarySignalProviderName;
  fetchSignal(
    candidate: AuxiliarySignalCandidate,
    options?: AuxiliarySignalProviderOptions
  ): Promise<AuxiliarySignalProviderResult>;
};

export type AuxiliarySignalFields = {
  auxSignalScore: number;
  dexscreenerBoostAmount: number;
  dexscreenerHasProfile: boolean;
  jupiterOrganicScore: number;
  jupiterTrendingRank: number;
  coingeckoTrendingRank: number;
  auxSignalStatus: AuxiliarySignalStatus;
};

export type AuxiliarySignalEnricherOptions = {
  config: AuxiliarySignalsConfig;
  fetchImpl?: FetchImpl;
  providers?: AuxiliarySignalProvider[];
  nowMs?: number;
  logger?: Pick<Console, 'warn' | 'log'>;
};

export const EMPTY_AUXILIARY_SIGNAL_FIELDS: AuxiliarySignalFields = {
  auxSignalScore: 0,
  dexscreenerBoostAmount: 0,
  dexscreenerHasProfile: false,
  jupiterOrganicScore: 0,
  jupiterTrendingRank: 0,
  coingeckoTrendingRank: 0,
  auxSignalStatus: 'disabled'
};
