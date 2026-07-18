/**
 * GMGN Token Safety Client — calls the Python Scrapling script as a subprocess.
 *
 * Safety scoring system (max 120 pts):
 *   +20  Mint renounced
 *   +20  No Blacklist
 *   +20  LP Burned 100%
 *   +20  Top10 <= 15%  (+15 if 15-20%)
 *   +10  Insiders <= 5%  (+5 if 5-10%)
 *   +10  Dev = 0%
 *   +10  Phishing <= 5%  (+5 if 5-10%)
 *   +10  Bundler < 5%  (+5 if 5-10%)
 *
 * Hard gates (reject regardless of safety score):
 *   - Holders > 1000
 *   - GMGN whole-token 24h volume >= 500000 USD
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT_PATH = resolve(__dirname, '../../../scripts/gmgn-token-safety.py');
const PROJECT_VENV_PYTHON = process.platform === 'win32'
  ? resolve(__dirname, '../../../.venv/Scripts/python.exe')
  : resolve(__dirname, '../../../.venv/bin/python');
const PYTHON_BIN = process.env.GMGN_PYTHON_BIN ?? (existsSync(PROJECT_VENV_PYTHON) ? PROJECT_VENV_PYTHON : 'python');
const GMGN_SAFETY_URL = process.env.GMGN_SAFETY_URL;
const MAX_SCRIPT_TIMEOUT_MS = 6 * 60_000;
const BASE_SCRIPT_TIMEOUT_MS = 30_000;
const PER_MINT_SCRIPT_TIMEOUT_MS = 45_000;
const BETWEEN_MINT_DELAY_BUFFER_MS = 5_000;

export function resolveGmgnSafetyTimeoutMs(mintCount: number) {
  const numericMintCount = Number.isFinite(mintCount) ? mintCount : 0;
  const boundedMintCount = Math.max(0, Math.floor(numericMintCount));
  const delayBufferMs = Math.max(0, boundedMintCount - 1) * BETWEEN_MINT_DELAY_BUFFER_MS;
  const timeoutMs = BASE_SCRIPT_TIMEOUT_MS + (boundedMintCount * PER_MINT_SCRIPT_TIMEOUT_MS) + delayBufferMs;
  return Math.min(MAX_SCRIPT_TIMEOUT_MS, Math.max(BASE_SCRIPT_TIMEOUT_MS, timeoutMs));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenSafetyResult = {
  mint: string;
  /** Passes hard gates (holders > 1000, GMGN whole-token 24h volume >= 500000 USD) */
  safe: boolean;
  /** Composite safety score (0-120) */
  safetyScore: number;
  /** Maximum possible safety score */
  maxScore: number;
  /** Per-item safety score breakdown */
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
  /** Optional hard gate: minimum bluechip holder % (default: 0; enable only when the source reports it reliably) */
  minBluechipPct: number;
  /** Minimum total safety score to pass (default: 0 = any safety score accepted if hard gates pass) */
  minSafetyScore: number;
};

export const DEFAULT_SAFETY_CONFIG: TokenSafetyConfig = {
  disabled: false,
  minHolders: 1000,
  // GMGN's checker treats bluechip as a score bonus, not a hard gate. Its
  // page can omit the field, so requiring it here would turn a safe result
  // into a false rejection.
  minBluechipPct: 0,
  minSafetyScore: 0,
};

// ---------------------------------------------------------------------------
// Filtering & Sorting
// ---------------------------------------------------------------------------

/**
 * Check if a token passes hard gates and the configured minimum safety score threshold.
 */
export function isTokenSafe(
  result: TokenSafetyResult,
  config: TokenSafetyConfig = DEFAULT_SAFETY_CONFIG
): boolean {
  if (config.disabled) return true;
  if (result.error) return false;
  // Python script already evaluates hard gates → result.safe
  if (!result.safe) return false;
  if (
    config.minHolders > 0 &&
    (typeof result.holders !== 'number' || !Number.isFinite(result.holders) || result.holders < config.minHolders)
  ) return false;
  if (
    config.minBluechipPct > 0 &&
    (typeof result.bluechipPct !== 'number' || !Number.isFinite(result.bluechipPct) || result.bluechipPct < config.minBluechipPct)
  ) return false;
  // Additional minimum safety score gate applied from config
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
const MAX_CACHE_ENTRIES = 5_000;
// Fallback if maxBatchSize isn't passed (we now pass 50 or 0 from ingest)
const DEFAULT_MAX_BATCH_SIZE = 50;

export type TokenSafetyCacheSweepResult = {
  expiredDeleted: number;
  evictedDeleted: number;
  remainingEntries: number;
};

export function sweepTokenSafetyCache(options: {
  now?: Date;
  ttlMs?: number;
  maxEntries?: number;
} = {}): TokenSafetyCacheSweepResult {
  const nowMs = (options.now ?? new Date()).getTime();
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  let expiredDeleted = 0;
  let evictedDeleted = 0;

  for (const [mint, cached] of safetyCache.entries()) {
    if (nowMs - cached.cachedAt <= ttlMs) {
      continue;
    }

    safetyCache.delete(mint);
    expiredDeleted += 1;
  }

  if (safetyCache.size > maxEntries) {
    const oldestEntries = [...safetyCache.entries()]
      .sort((left, right) => left[1].cachedAt - right[1].cachedAt);

    for (const [mint] of oldestEntries) {
      if (safetyCache.size <= maxEntries) {
        break;
      }

      safetyCache.delete(mint);
      evictedDeleted += 1;
    }
  }

  return {
    expiredDeleted,
    evictedDeleted,
    remainingEntries: safetyCache.size
  };
}

export function getTokenSafetyCacheSize() {
  return safetyCache.size;
}

export function clearTokenSafetyCacheForTests() {
  safetyCache.clear();
}

export function primeTokenSafetyCacheForTests(
  mint: string,
  result: TokenSafetyResult,
  cachedAt: Date
) {
  safetyCache.set(mint, {
    result,
    cachedAt: cachedAt.getTime()
  });
}

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
  options: { timeoutMs?: number; pythonBin?: string; maxBatchSize?: number; safetyUrl?: string } = {}
): Promise<TokenSafetyResult[]> {
  if (mints.length === 0) return [];

  const configuredTimeoutMs = options.timeoutMs;
  const pythonBin = options.pythonBin ?? PYTHON_BIN;
  const safetyUrl = options.safetyUrl ?? GMGN_SAFETY_URL;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

  const finalResults: TokenSafetyResult[] = [];
  const uncachedMints: string[] = [];

  const now = Date.now();
  sweepTokenSafetyCache({
    now: new Date(now),
    ttlMs: CACHE_TTL_MS,
    maxEntries: MAX_CACHE_ENTRIES
  });
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
  const deferredMints = uncachedMints.slice(mintsToFetch.length);
  const timeoutMs = configuredTimeoutMs ?? resolveGmgnSafetyTimeoutMs(mintsToFetch.length);
  const buildDeferredResults = () => deferredMints.map((mint) => ({
    mint,
    safe: false,
    safetyScore: 0,
    maxScore: 120,
    error: GMGN_SAFETY_DEFERRED_ERROR
  }));

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

  if (safetyUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();

      const response = await fetch(safetyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mints: mintsToFetch }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`http ${response.status}`);
      }

      const results = await response.json() as TokenSafetyResult[];
      for (const res of results) {
        if (!res.error || res.error === "empty_page") {
          safetyCache.set(res.mint, { result: res, cachedAt: Date.now() });
        }
        finalResults.push(res);
      }

      return [
        ...finalResults,
        ...buildDeferredResults()
      ];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[GmgnSafety] HTTP service error: ${reason}`);
      return [
        ...finalResults,
        ...mintsToFetch.map((mint) => ({
          mint,
          safe: false,
          safetyScore: 0,
          maxScore: 120,
          error: `service_error: ${reason}`
        })),
        ...buildDeferredResults()
      ];
    }
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let completed = false;
    let childPid: number | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout;

    const useDetachedChild = process.platform !== "win32";
    const terminateProcess = (signal: NodeJS.Signals) => {
      if (typeof childPid !== "number") {
        return;
      }

      try {
        process.kill(useDetachedChild ? -childPid : childPid, signal);
      } catch {
        try {
          process.kill(childPid, signal);
        } catch {
          // Process already exited.
        }
      }
    };

    const finish = (error?: Error) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeoutTimer);
      if (!timedOut && sigkillTimer) {
        clearTimeout(sigkillTimer);
      }

      if (stderr && stderr.trim().length > 0) {
        console.warn(`[GmgnSafety] Python stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        const reason = timedOut ? `timeout after ${timeoutMs}ms` : error.message;
        console.error(`[GmgnSafety] Script error: ${reason}`);
        resolve([
          ...finalResults,
          ...mintsToFetch.map((mint) => ({
            mint,
            safe: false,
            safetyScore: 0,
            maxScore: 120,
            error: `script_error: ${reason}`,
          })),
          ...buildDeferredResults()
        ]);
        return;
      }

      try {
        const results = JSON.parse(stdout) as TokenSafetyResult[];

        for (const res of results) {
          // Cache successful queries
          if (!res.error || res.error === "empty_page") {
            safetyCache.set(res.mint, { result: res, cachedAt: Date.now() });
          }
          finalResults.push(res);
        }

        resolve([
          ...finalResults,
          ...buildDeferredResults()
        ]);
      } catch (parseError) {
        console.error(`[GmgnSafety] JSON parse error: ${stdout.slice(0, 300)}`);
        resolve([
          ...finalResults,
          ...mintsToFetch.map((mint) => ({
            mint,
            safe: false,
            safetyScore: 0,
            maxScore: 120,
            error: "json_parse_failed",
          })),
          ...buildDeferredResults()
        ]);
      }
    };

    const maxBufferBytes = 10 * 1024 * 1024;
    const appendOutput = (streamName: "stdout" | "stderr", chunk: Buffer | string) => {
      if (completed) {
        return;
      }

      if (streamName === "stdout") {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > maxBufferBytes) {
          terminateProcess("SIGTERM");
          finish(new Error("stdout maxBuffer exceeded"));
        }
        return;
      }

      stderr += String(chunk);
      if (Buffer.byteLength(stderr) > maxBufferBytes) {
          terminateProcess("SIGTERM");
        finish(new Error("stderr maxBuffer exceeded"));
      }
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcess("SIGTERM");
      sigkillTimer = setTimeout(() => terminateProcess("SIGKILL"), 2_000);
      sigkillTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const spawnCommand = /\.m?js$/i.test(pythonBin) ? process.execPath : pythonBin;
    const spawnArgs = spawnCommand === process.execPath
      ? [pythonBin, SCRIPT_PATH, "--stdin"]
      : [SCRIPT_PATH, "--stdin"];
    const child = spawn(
      spawnCommand,
      spawnArgs,
      {
        detached: useDetachedChild,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        },
      }
    );
    childPid = child.pid;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`timeout after ${timeoutMs}ms`));
        return;
      }

      if (code === 0) {
        finish();
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      finish(new Error(reason));
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(mintsToFetch));
  });
}

/**
 * Fetch safety data for a single mint.
 */
export async function fetchTokenSafety(mint: string): Promise<TokenSafetyResult> {
  const results = await fetchTokenSafetyBatch([mint]);
  return results[0] ?? { mint, safe: false, safetyScore: 0, maxScore: 120, error: 'no_result' };
}
