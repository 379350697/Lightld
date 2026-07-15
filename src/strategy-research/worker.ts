import {
  isJupiterNoRouteError,
  JupiterClient,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  type JupiterQuoteResponse
} from '../execution/solana/jupiter-client.ts';
import { StrategyResearchStore } from './store.ts';
import type { ResearchEpisode, ResearchMark, ResearchMarkStatus } from './types.ts';

export type EntryQuoteResult = {
  status: ResearchMarkStatus;
  targetTokenRaw?: string;
  doubleTokenRaw?: string;
  targetImpactBps?: number | null;
  doubleImpactBps?: number | null;
  detail?: string;
};

export interface ResearchMarkCollector {
  collectEntry(episode: ResearchEpisode): Promise<EntryQuoteResult>;
  collectMark(episode: ResearchEpisode, horizonMinutes: 15 | 60 | 240 | 1440): Promise<ResearchMark>;
}

export class JupiterResearchMarkCollector implements ResearchMarkCollector {
  private readonly client: JupiterClient;
  private readonly slippageBps: number;

  constructor(client: JupiterClient, slippageBps = 100) {
    this.client = client;
    this.slippageBps = slippageBps;
  }

  async collectEntry(episode: ResearchEpisode): Promise<EntryQuoteResult> {
    try {
      const [target, doubled] = await Promise.all([
        this.client.getQuote({
          inputMint: SOL_MINT,
          outputMint: episode.tokenMint,
          amount: String(Math.max(1, Math.round(episode.positionSol * LAMPORTS_PER_SOL))),
          slippageBps: this.slippageBps
        }),
        this.client.getQuote({
          inputMint: SOL_MINT,
          outputMint: episode.tokenMint,
          amount: String(Math.max(1, Math.round(episode.positionSol * 2 * LAMPORTS_PER_SOL))),
          slippageBps: this.slippageBps
        })
      ]);
      return {
        status: 'ok',
        targetTokenRaw: target.outAmount,
        doubleTokenRaw: doubled.outAmount,
        targetImpactBps: impactBps(target),
        doubleImpactBps: impactBps(doubled)
      };
    } catch (error) {
      return classifyQuoteFailure(error);
    }
  }

  async collectMark(episode: ResearchEpisode, horizonMinutes: 15 | 60 | 240 | 1440): Promise<ResearchMark> {
    const observedAt = new Date().toISOString();
    try {
      if (!episode.targetTokenRaw || !episode.doubleTokenRaw) throw new Error('entry quote is missing');
      const [target, doubled] = await Promise.all([
        this.client.getQuote({
          inputMint: episode.tokenMint,
          outputMint: SOL_MINT,
          amount: episode.targetTokenRaw,
          slippageBps: this.slippageBps
        }),
        this.client.getQuote({
          inputMint: episode.tokenMint,
          outputMint: SOL_MINT,
          amount: episode.doubleTokenRaw,
          slippageBps: this.slippageBps
        })
      ]);
      return {
        episodeId: episode.episodeId,
        horizonMinutes,
        observedAt,
        status: 'ok',
        targetRecoverySol: Number(target.outAmount) / LAMPORTS_PER_SOL,
        doubleRecoverySol: Number(doubled.outAmount) / LAMPORTS_PER_SOL,
        targetImpactBps: impactBps(target),
        doubleImpactBps: impactBps(doubled),
        detail: ''
      };
    } catch (error) {
      const failure = classifyQuoteFailure(error);
      return {
        episodeId: episode.episodeId,
        horizonMinutes,
        observedAt,
        status: failure.status,
        targetRecoverySol: null,
        doubleRecoverySol: null,
        targetImpactBps: null,
        doubleImpactBps: null,
        detail: failure.detail ?? ''
      };
    }
  }
}

export async function runResearchWorkerTick(input: {
  store: StrategyResearchStore;
  collector: ResearchMarkCollector;
  now?: Date;
  limit?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}) {
  const due = input.store.dueEpisodes(input.now ?? new Date(), input.limit ?? 100);
  let completed = 0;
  let unavailable = 0;
  for (const task of due) {
    try {
      if (task.horizonMinutes === 0) {
        const entry = await input.collector.collectEntry(task.episode);
        input.store.recordEntryQuote({ episodeId: task.episode.episodeId, ...entry });
        if (entry.status === 'unavailable') unavailable += 1;
      } else {
        const mark = await input.collector.collectMark(task.episode, task.horizonMinutes);
        input.store.recordMark(mark);
        if (mark.status === 'unavailable') unavailable += 1;
      }
      completed += 1;
    } catch (error) {
      unavailable += 1;
      input.logger?.warn(`[StrategyResearch] mark failed soft: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  input.store.recordWorkerStatus({
    heartbeatAt: (input.now ?? new Date()).toISOString(),
    status: unavailable > 0 ? 'degraded' : 'ok',
    due: due.length,
    completed,
    unavailable
  });
  input.store.checkpoint();
  input.logger?.log(`[StrategyResearch] due=${due.length} completed=${completed} unavailable=${unavailable}`);
  return { due: due.length, completed, unavailable };
}

export async function runResearchWorker(input: {
  store: StrategyResearchStore;
  collector: ResearchMarkCollector;
  intervalMs?: number;
  maxTicks?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn'>;
}) {
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let tick = 0;
  while (input.maxTicks === undefined || tick < input.maxTicks) {
    tick += 1;
    await runResearchWorkerTick(input);
    if (input.maxTicks === undefined || tick < input.maxTicks) await sleep(input.intervalMs ?? 60_000);
  }
}

function impactBps(quote: JupiterQuoteResponse) {
  const percent = Number(quote.priceImpactPct);
  return Number.isFinite(percent) ? percent * 100 : null;
}

function classifyQuoteFailure(error: unknown): EntryQuoteResult {
  if (isJupiterNoRouteError(error)) {
    return { status: 'no_route', detail: error.message };
  }
  return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
}
