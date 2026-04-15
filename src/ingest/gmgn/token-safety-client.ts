/**
 * GMGN Token Safety Client — calls the Python Scrapling script as a subprocess.
 *
 * Scoring system (max 120 pts):
 *   +20  Mint renounced
 *   +20  No Blacklist
 *   +20  LP Burned 100%
 *   +20  Top10 <= 15%  (+15 if 15-20%)
 *   +10  Insiders <= 5%  (+5 if 5-10%)
 *   +10  Dev = 0%
 *   +10  Phishing <= 5%  (+5 if 5-10%)
 *   +10  Bundler < 5%  (+5 if 5-10%)
 *
 * Hard gates (reject regardless of score):
 *   - Holders > 1000
 *   - GMGN whole-token 24h volume >= 500000 USD
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT_PATH = resolve(__dirname, '../../../scripts/gmgn-token-safety.py');
const PROJECT_VENV_PYTHON = resolve(__dirname, '../../../.venv/bin/python');
const PYTHON_BIN = process.env.GMGN_PYTHON_BIN ?? (existsSync(PROJECT_VENV_PYTHON) ? PROJECT_VENV_PYTHON : 'python');
const DEFAULT_TIMEOUT_MS = 15 * 60_000; // 15 minutes to safely wait for large batch 4s delays

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenSafetyResult = {
  mint: string;
  /** Passes hard gates (holders > 1000, GMGN whole-token 24h volume >= 500000 USD) */
  safe: boolean;
  /** Composite safety score 0-120 */
  safetyScore: number;
  /** Maximum possible score */
  maxScore: number;
  /** Per-item score breakdown */
  scoreBreakdown?: Record<string, number>;
  /** Reasons token was rejected (hard gate failures) */
  rejectReasons?: string[];
  // Raw metrics
  holders?: number;
  top10Pct?: number;
  insidersPct?: number;
  devPct?: number;
  phishingPct?: number;
  bundlerPct?: number;
  bluechipPct?: number;
  snipersPct?: number;
  rugPct?: number;
  volume24hUsd?: number;
  isMintRenounced?: boolean;
  noBlacklist?: boolean;
  isLpBurned?: boolean;
  error?: string;
};

export type TokenSafetyConfig = {
  /** Whether to skip safety check entirely (default: false) */
  disabled: boolean;
  /** Hard gate: minimum holder count (default: 1000) */
  minHolders: number;
  /** Hard gate: minimum bluechip holder % (default: 0.8) */
  minBluechipPct: number;
  /** Minimum total safety score to pass (default: 0 = any score accepted if hard gates pass) */
  minSafetyScore: number;
};

export const DEFAULT_SAFETY_CONFIG: TokenSafetyConfig = {
  disabled: false,
  minHolders: 1000,
  minBluechipPct: 0.8,
  minSafetyScore: 0,
};

// ---------------------------------------------------------------------------
// Filtering & Sorting
// ---------------------------------------------------------------------------

/**
 * Check if a token passes hard gates and minimum score threshold.
 */
export function isTokenSafe(
  result: TokenSafetyResult,
  config: TokenSafetyConfig = DEFAULT_SAFETY_CONFIG
): boolean {
  if (config.disabled) return true;
  if (result.error) return false;
  // Python script already evaluates hard gates → result.safe
  if (!result.safe) return false;
  // Additional min-score gate applied from config
  if (result.safetyScore < config.minSafetyScore) return false;
  return true;
}

/**
 * Sort safety results by safetyScore descending (highest-quality first).
 */
export function sortBySafetyScore(results: TokenSafetyResult[]): TokenSafetyResult[] {
  return [...results].sort((a, b) => b.safetyScore - a.safetyScore);
}

// ---------------------------------------------------------------------------
// Caching & Rate Limiting
// ---------------------------------------------------------------------------

type CachedSafetyResult = {
  result: TokenSafetyResult;
  cachedAt: number;
};

export const GMGN_SAFETY_DEFERRED_ERROR = 'fetch_skipped:max_batch_size_zero';

const safetyCache = new Map<string, CachedSafetyResult>();
// Keep safety data for 24 hours to minimize repetitive GMGN requests
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Fallback if maxBatchSize isn't passed (we now pass 50 or 0 from ingest)
const DEFAULT_MAX_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch token safety data for a batch of mints by calling the Python script.
 * Integrates caching and burst limits. Only maxBatchSize uncached tokens
 * are fetched per call; others are skipped and will be checked in future cycles.
 */
export async function fetchTokenSafetyBatch(
  mints: string[],
  options: { timeoutMs?: number; pythonBin?: string; maxBatchSize?: number } = {}
): Promise<TokenSafetyResult[]> {
  if (mints.length === 0) return [];

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pythonBin = options.pythonBin ?? PYTHON_BIN;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

  const finalResults: TokenSafetyResult[] = [];
  const uncachedMints: string[] = [];

  const now = Date.now();
  for (const mint of mints) {
    const cached = safetyCache.get(mint);
    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      finalResults.push(cached.result);
    } else {
      if (!uncachedMints.includes(mint)) {
        uncachedMints.push(mint);
      }
    }
  }

  // Pre-condition risk control: limit fetches to maxBatchSize
  const mintsToFetch = uncachedMints.slice(0, maxBatchSize);

  if (uncachedMints.length === 0) {
    console.log(`[GmgnSafety] All ${mints.length} mints loaded from cache.`);
    return finalResults;
  }

  if (mintsToFetch.length === 0) {
    console.warn(
      `[GmgnSafety] Deferred ${uncachedMints.length} uncached mints because maxBatchSize=0; returning cached results only.`
    );
    return [
      ...finalResults,
      ...uncachedMints.map((mint) => ({
        mint,
        safe: false,
        safetyScore: 0,
        maxScore: 120,
        error: GMGN_SAFETY_DEFERRED_ERROR
      }))
    ];
  }

  console.log(`[GmgnSafety] Requesting ${mintsToFetch.length} new mints from GMGN (${uncachedMints.length - mintsToFetch.length} omitted this cycle to avoid rate limits).`);

  return new Promise((resolve, reject) => {
    const child = execFile(
      pythonBin,
      [SCRIPT_PATH, '--stdin'],
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      },
      (error, stdout, stderr) => {
        if (stderr && stderr.trim().length > 0) {
          console.warn(`[GmgnSafety] Python stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          console.error(`[GmgnSafety] Script error: ${error.message}`);
          resolve([
            ...finalResults,
            ...mintsToFetch.map((mint) => ({
              mint,
              safe: false,
              safetyScore: 0,
              maxScore: 120,
              error: `script_error: ${error.message}`,
            }))
          ]);
          return;
        }

        try {
          const results = JSON.parse(stdout) as TokenSafetyResult[];
          
          for (const res of results) {
            // Cache successful queries
            if (!res.error || res.error === 'empty_page') {
              safetyCache.set(res.mint, { result: res, cachedAt: Date.now() });
            }
            finalResults.push(res);
          }
          
          resolve(finalResults);
        } catch (parseError) {
          console.error(`[GmgnSafety] JSON parse error: ${stdout.slice(0, 300)}`);
          resolve([
            ...finalResults,
            ...mintsToFetch.map((mint) => ({
              mint,
              safe: false,
              safetyScore: 0,
              maxScore: 120,
              error: 'json_parse_failed',
            }))
          ]);
        }
      }
    );

    child.stdin?.write(JSON.stringify(mintsToFetch));
    child.stdin?.end();
  });
}

/**
 * Fetch safety data for a single mint.
 */
export async function fetchTokenSafety(mint: string): Promise<TokenSafetyResult> {
  const results = await fetchTokenSafetyBatch([mint]);
  return results[0] ?? { mint, safe: false, safetyScore: 0, maxScore: 120, error: 'no_result' };
}
