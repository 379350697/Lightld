import { join } from 'node:path';
import { LiveOrderJournal } from '../journals/live-order-journal.ts';
import { LiveFillJournal } from '../journals/live-fill-journal.ts';
import type { OrderMirrorPayload, FillMirrorPayload } from '../observability/mirror-events.ts';
import { existsSync } from 'node:fs';

export type PortfolioSummary = {
  strategyId: string;
  totalPositions: number;
  totalWinRate: number;
  totalNetProfitSol: number;
  feesClaimedSol: number;
  impermanentLossSol: number;
};

export type PositionDetail = {
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  status: 'open' | 'closed';
  pnlSol: number;
  feesClaimedSol: number;
  impermanentLossSol: number;
  openedAt: string;
  closedAt?: string;
};

export class PortfolioAnalyzer {
  private readonly strategyId: string;
  private readonly journalRootDir: string;

  constructor(strategyId: string, journalRootDir: string = join('tmp', 'journals')) {
    this.strategyId = strategyId;
    this.journalRootDir = journalRootDir;
  }

  async getStats(): Promise<{ summary: PortfolioSummary; positions: PositionDetail[] }> {
    const ordersPath = join(this.journalRootDir, `${this.strategyId}-live-orders.jsonl`);
    const fillsPath = join(this.journalRootDir, `${this.strategyId}-live-fills.jsonl`);

    if (!existsSync(ordersPath) || !existsSync(fillsPath)) {
      return {
        summary: {
          strategyId: this.strategyId,
          totalPositions: 0,
          totalWinRate: 0,
          totalNetProfitSol: 0,
          feesClaimedSol: 0,
          impermanentLossSol: 0
        },
        positions: []
      };
    }

    const orderJournal = new LiveOrderJournal<OrderMirrorPayload>(ordersPath);
    const fillJournal = new LiveFillJournal<FillMirrorPayload>(fillsPath);

    const allOrders = await orderJournal.readAll();
    const allFills = await fillJournal.readAll();

    // Grouping by poolAddress
    const positionsMap = new Map<string, PositionDetail>();

    let totalFeesClaimedSol = 0;
    let totalImpermanentLossSol = 0;
    let totalNetProfitSol = 0;
    
    let totalClosed = 0;
    let totalWins = 0;

    for (const order of allOrders) {
      if (!positionsMap.has(order.poolAddress)) {
        positionsMap.set(order.poolAddress, {
          poolAddress: order.poolAddress,
          tokenMint: order.tokenMint,
          tokenSymbol: order.tokenSymbol,
          status: 'open',
          pnlSol: 0,
          feesClaimedSol: 0,
          impermanentLossSol: 0,
          openedAt: order.createdAt
        });
      }
      
      const pos = positionsMap.get(order.poolAddress)!;
      
      // Update close status if we fully withdrew or fully exited
      if (order.action === 'withdraw-lp' || order.action === 'dca-out') {
        pos.status = 'closed';
        pos.closedAt = order.createdAt;
      }
    }

    // Process fills to accurately gauge PnL
    for (const fill of allFills) {
      // Find matching order logic (in a real scenario, we'd link submissionId to order)
      const order = allOrders.find(o => o.submissionId === fill.submissionId);
      if (!order) continue;
      
      const pos = positionsMap.get(order.poolAddress);
      if (!pos) continue;

      if (order.action === 'deploy' || order.action === 'add-lp') {
        // Cost basis
        pos.pnlSol -= fill.filledSol;
      } else if (order.action === 'dca-out' || order.action === 'withdraw-lp') {
        // Revenue
        pos.pnlSol += fill.filledSol;
        // Determine IL roughly by subtracting total fees claimed from Net PnL (simplistic logic)
        pos.impermanentLossSol = pos.pnlSol - pos.feesClaimedSol;
      } else if (order.action === 'claim-fee') {
        pos.feesClaimedSol += fill.filledSol;
        pos.pnlSol += fill.filledSol; // It adds to Net PnL
      }
    }

    // Aggregate summary
    for (const pos of positionsMap.values()) {
      totalFeesClaimedSol += pos.feesClaimedSol;
      totalImpermanentLossSol += pos.impermanentLossSol;
      totalNetProfitSol += pos.pnlSol;

      if (pos.status === 'closed') {
        totalClosed++;
        if (pos.pnlSol > 0) {
          totalWins++;
        }
      }
    }

    const summary: PortfolioSummary = {
      strategyId: this.strategyId,
      totalPositions: positionsMap.size,
      totalWinRate: totalClosed > 0 ? (totalWins / totalClosed) * 100 : 0,
      totalNetProfitSol,
      feesClaimedSol: totalFeesClaimedSol,
      impermanentLossSol: totalImpermanentLossSol
    };

    return { summary, positions: Array.from(positionsMap.values()) };
  }
}
