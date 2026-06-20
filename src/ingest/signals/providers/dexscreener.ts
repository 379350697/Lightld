import {
  fetchSignalJson,
  isRecord,
  readNumber
} from '../provider-utils.ts';
import type {
  AuxiliarySignalCandidate,
  AuxiliarySignalProvider,
  AuxiliarySignalProviderOptions,
  AuxiliarySignalProviderResult
} from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.dexscreener.com';

export const dexscreenerSignalProvider: AuxiliarySignalProvider = {
  name: 'dexscreener',
  fetchSignal
};

async function fetchSignal(
  candidate: AuxiliarySignalCandidate,
  options: AuxiliarySignalProviderOptions = {}
): Promise<AuxiliarySignalProviderResult> {
  if (!candidate.mint) {
    return emptyResult('missing-mint');
  }

  try {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const pairs = await fetchSignalJson<unknown>(
      `${baseUrl}/token-pairs/v1/solana/${encodeURIComponent(candidate.mint)}`,
      { fetchImpl: options.fetchImpl }
    );

    if (!Array.isArray(pairs)) {
      return emptyResult('unexpected-response');
    }

    let boostAmount = 0;
    let hasProfile = false;

    for (const item of pairs) {
      if (!isRecord(item)) {
        continue;
      }

      const boosts = isRecord(item.boosts) ? item.boosts : {};
      boostAmount = Math.max(
        boostAmount,
        readNumber(boosts, ['active', 'amount', 'totalAmount'])
      );

      const info = isRecord(item.info) ? item.info : {};
      const socials = Array.isArray(info.socials) ? info.socials : [];
      const websites = Array.isArray(info.websites) ? info.websites : [];
      hasProfile = hasProfile || socials.length > 0 || websites.length > 0 || isRecord(item.info);
    }

    return {
      provider: 'dexscreener',
      status: 'available',
      signalScore: resolveDexscreenerScore({ boostAmount, hasProfile }),
      dexscreenerBoostAmount: boostAmount,
      dexscreenerHasProfile: hasProfile
    };
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error));
  }
}

function resolveDexscreenerScore(input: { boostAmount: number; hasProfile: boolean }) {
  const profileScore = input.hasProfile ? 5 : 0;
  const boostScore = input.boostAmount > 0
    ? Math.min(20, Math.log10(input.boostAmount + 1) * 8)
    : 0;

  return profileScore + boostScore;
}

function emptyResult(error: string): AuxiliarySignalProviderResult {
  return {
    provider: 'dexscreener',
    status: 'unavailable',
    signalScore: 0,
    dexscreenerBoostAmount: 0,
    dexscreenerHasProfile: false,
    error
  };
}
