import { PumpPortalClient } from '../ingest/pumpportal/websocket-client.ts';
import { DexScreenerClient } from '../ingest/dexscreener/client.ts';
import { JupiterTokensClient } from '../ingest/jupiter-tokens/client.ts';
import { SignalStore } from '../runtime/signal-store.ts';
import { NewTokenPoolStore } from '../runtime/new-token-pool.ts';

export type ScannerConfig = {
  minTvlUsd: number;
  minVol24hUsd: number;
  minMarketCapUsd: number;
  maxPoolAgeMs: number;
  requireJupiterVerification: boolean;
  minOrganicScore?: number;
  pollIntervalMs: number;
};

type Candidate = {
  mint: string;
  discoveredAt: number;
  status: 'new' | 'fetching_market' | 'fetching_quality' | 'resolved';
  dexRetries: number;
};

export class TokenScannerDaemon {
  private readonly pumpClient = new PumpPortalClient();
  private readonly dexClient = new DexScreenerClient();
  private readonly jupClient = new JupiterTokensClient();
  private readonly signalStore = new SignalStore();
  private readonly newTokenPool = new NewTokenPoolStore();

  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private readonly candidates = new Map<string, Candidate>();
  private readonly config: ScannerConfig;

  constructor(config: ScannerConfig) {
    this.config = config;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[Scanner] Starting multi-source scanner daemon...');
    
    // Subscribe to PumpPortal stream
    this.pumpClient.onTokenEvent = (event) => {
      this.newTokenPool.upsertToken({
        tokenMint: event.mint,
        source: 'PumpPortal',
        seenAt: new Date().toISOString()
      });
      this.addCandidate(event.mint);
    };
    this.pumpClient.connect();

    // Start background processor
    void this.processLoop();
  }

  public stop() {
    this.isRunning = false;
    this.pumpClient.disconnect();
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }

  private addCandidate(mint: string) {
    if (!this.candidates.has(mint) && this.candidates.size < 5000) {
      this.candidates.set(mint, {
        mint,
        discoveredAt: Date.now(),
        status: 'new',
        dexRetries: 0
      });
    }
  }

  private async processLoop() {
    if (!this.isRunning) return;

    try {
      await this.runBatchCycle();
      this.pruneStaleCandidates();
    } catch (err) {
      console.error('[Scanner] Loop error:', (err as Error).message);
    } finally {
      if (this.isRunning) {
        this.loopTimer = setTimeout(() => this.processLoop(), this.config.pollIntervalMs);
      }
    }
  }

  private async runBatchCycle() {
    for (const token of this.newTokenPool.getActiveTokens()) {
      this.addCandidate(token.tokenMint);
    }

    const batch: Candidate[] = [];
    for (const cand of this.candidates.values()) {
      if (cand.status === 'new') {
        batch.push(cand);
        if (batch.length >= 30) break;
      }
    }

    if (batch.length === 0) return;

    // Mark as fetching
    batch.forEach(c => c.status = 'fetching_market');

    // 2. Fetch market data
    const mints = batch.map(c => c.mint);
    console.log(`[Scanner] Batch analyzing ${mints.length} candidates on DexScreener...`);
    const dexResults = await this.dexClient.getTokensData(mints);

    const passedMarket = new Map<string, import('../ingest/dexscreener/client.ts').DexScreenerPair>();

    for (const c of batch) {
      const pair = dexResults.find(p => p.baseToken?.address === c.mint);
      
      if (!pair) {
        // No pair yet (hasn't hit DexScreener). Retry a few times, then drop.
        c.dexRetries += 1;
        if (c.dexRetries > 20) { // Keep trying for a while
           c.status = 'resolved';
        } else {
           c.status = 'new'; // retry later
        }
        continue;
      }

      const tvl = pair.liquidity?.usd ?? 0;
      const vol24 = pair.volume?.h24 ?? 0;
      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      const createdAt = pair.pairCreatedAt ?? 0;
      const ageMs = createdAt > 0 ? Date.now() - createdAt : 0;

      this.newTokenPool.upsertToken({
        tokenMint: c.mint,
        source: 'PumpPortal',
        tokenSymbol: pair.baseToken?.symbol,
        pairAddress: pair.pairAddress,
        seenAt: new Date().toISOString()
      });

      if (createdAt > 0 && ageMs > this.config.maxPoolAgeMs) {
        c.status = 'resolved';
        continue;
      }

      if (
        tvl < this.config.minTvlUsd || 
        vol24 < this.config.minVol24hUsd || 
        mcap < this.config.minMarketCapUsd
      ) {
        c.status = 'new';
      } else {
        c.status = 'fetching_quality';
        passedMarket.set(c.mint, pair);
      }
    }

    // 3. Sequential Jupiter Quality Check (to respect 1 RPS limit)
    for (const [mint, pair] of passedMarket.entries()) {
      if (!this.isRunning) break;
      
      console.log(`[Scanner] Token ${mint} passed market check (TVL: $${pair.liquidity?.usd}). Checking quality metrics...`);
      
      // Artificial delay to respect Jupiter free rate limit (0.5 - 1 RPS)
      await new Promise(r => setTimeout(r, 1200));

      const jupInfo = await this.jupClient.getTokenInfo(mint);
      
      let passedJup = true;

      // Organic/Verification rules
      if (this.config.requireJupiterVerification && jupInfo) {
         passedJup = this.jupClient.isVerified(jupInfo);
      }
      
      // Custom organic score if it exists
      if (this.config.minOrganicScore && jupInfo?.metrics?.organicScore !== undefined) {
         if (jupInfo.metrics.organicScore < this.config.minOrganicScore) {
           passedJup = false;
         }
      }

      const cand = this.candidates.get(mint);
      if (cand) cand.status = 'resolved';

      if (passedJup) {
        console.log(`[Scanner] 🚀 SIGNAL FOUND: ${mint} (${pair.baseToken?.symbol})`);
        this.newTokenPool.markPromoted(mint);

        this.signalStore.pushSignal({
          tokenMint: mint,
          tokenSymbol: pair.baseToken?.symbol ?? 'UNKNOWN',
          pairAddress: pair.pairAddress,
          source: 'PumpPortal->Dex->Jup',
          discoveredAt: new Date().toISOString(),
          metrics: {
            tvl: pair.liquidity?.usd ?? 0,
            volume24h: pair.volume?.h24 ?? 0,
            rugpullScore: 0, // Mock fallback as Jup handles quality
            bluechipPercent: jupInfo?.metrics?.organicScore ?? 0, 
            sniperPercent: 0
          }
        });
      } else {
        console.log(`[Scanner] Rejected ${mint} on Jupiter quality checks.`);
      }
    }
  }

  private pruneStaleCandidates() {
    const now = Date.now();
    for (const [mint, c] of this.candidates.entries()) {
      if (c.status === 'resolved' || (now - c.discoveredAt > 10 * 60 * 1000)) {
        this.candidates.delete(mint);
      }
    }
  }
}
