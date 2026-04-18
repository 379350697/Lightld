type CashflowFill = {
  side: string;
  filledSol: number;
  recordedAt: string;
};

type CashflowOrderFallback = {
  action: string;
  requestedPositionSol: number;
  updatedAt: string;
  createdAt: string;
};

type DailyCashflowPoint = {
  date: string;
  cashflowSol: number;
};

type EquitySnapshot = {
  snapshotAt: string;
  walletSol: number | null;
  lpValueSol: number | null;
  unclaimedFeeSol: number | null;
  netWorthSol: number | null;
  openPositionCount: number | null;
};

type DailyEquityPoint = {
  date: string;
  netWorthSol: number;
};

export type DashboardCashflowMetrics = {
  metricType: 'realized_cashflow';
  totalCashflowSol: number;
  todayCashflowSol: number;
  monthCashflowSol: number;
  dailyCashflow: DailyCashflowPoint[];
  totalPnl: number;
  todayPnl: number;
  monthPnl: number;
  dailyPnl: Array<{ date: string; pnl: number }>;
};

export type DashboardEquityMetrics = {
  metricType: 'net_worth';
  latestNetWorthSol: number | null;
  latestWalletSol: number | null;
  latestLpValueSol: number | null;
  latestUnclaimedFeeSol: number | null;
  latestOpenPositionCount: number | null;
  dailyEquity: DailyEquityPoint[];
};

function startOfUtcDayString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcMonthString(date: Date) {
  return date.toISOString().slice(0, 7);
}

function toSignedCashflow(fill: CashflowFill) {
  if (fill.side === 'buy' || fill.side === 'add-lp') {
    return -fill.filledSol;
  }

  if (fill.side === 'sell' || fill.side === 'withdraw-lp' || fill.side === 'claim-fee') {
    return fill.filledSol;
  }

  return 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function buildCashflowMetrics(input: {
  fills: CashflowFill[];
  orderFallback?: CashflowOrderFallback[];
  now?: Date;
}): DashboardCashflowMetrics {
  const now = input.now ?? new Date();
  const today = startOfUtcDayString(now);
  const month = startOfUtcMonthString(now);

  let dailyCashflow: DailyCashflowPoint[] = [];
  let totalCashflowSol = 0;
  let todayCashflowSol = 0;
  let monthCashflowSol = 0;

  if (input.fills.length > 0) {
    const byDate = new Map<string, number>();

    for (const fill of input.fills) {
      const recordedDate = fill.recordedAt.slice(0, 10);
      const cashflow = toSignedCashflow(fill);

      byDate.set(recordedDate, (byDate.get(recordedDate) ?? 0) + cashflow);
    }

    dailyCashflow = Array.from(byDate.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, cashflowSol]) => ({ date, cashflowSol }));

    totalCashflowSol = sum(dailyCashflow.map((entry) => entry.cashflowSol));
    todayCashflowSol = sum(dailyCashflow.filter((entry) => entry.date >= today).map((entry) => entry.cashflowSol));
    monthCashflowSol = sum(dailyCashflow.filter((entry) => entry.date >= `${month}-01`).map((entry) => entry.cashflowSol));
  } else if ((input.orderFallback?.length ?? 0) > 0) {
    const byDate = new Map<string, number>();

    for (const order of input.orderFallback ?? []) {
      if (order.action !== 'add-lp' && order.action !== 'deploy') {
        continue;
      }

      const timestamp = order.updatedAt || order.createdAt;
      const date = timestamp.slice(0, 10);
      const cashflow = -order.requestedPositionSol;

      byDate.set(date, (byDate.get(date) ?? 0) + cashflow);
    }

    dailyCashflow = Array.from(byDate.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, cashflowSol]) => ({ date, cashflowSol }));

    totalCashflowSol = sum(dailyCashflow.map((entry) => entry.cashflowSol));
    todayCashflowSol = sum(dailyCashflow.filter((entry) => entry.date >= today).map((entry) => entry.cashflowSol));
    monthCashflowSol = sum(dailyCashflow.filter((entry) => entry.date >= `${month}-01`).map((entry) => entry.cashflowSol));
  }

  return {
    metricType: 'realized_cashflow',
    totalCashflowSol,
    todayCashflowSol,
    monthCashflowSol,
    dailyCashflow,
    totalPnl: totalCashflowSol,
    todayPnl: todayCashflowSol,
    monthPnl: monthCashflowSol,
    dailyPnl: dailyCashflow.map((entry) => ({
      date: entry.date,
      pnl: entry.cashflowSol
    }))
  };
}

export function buildEquityMetrics(input: {
  snapshots: EquitySnapshot[];
}): DashboardEquityMetrics {
  const latestByDate = new Map<string, EquitySnapshot>();

  for (const snapshot of input.snapshots) {
    if (typeof snapshot.netWorthSol !== 'number' || !Number.isFinite(snapshot.netWorthSol)) {
      continue;
    }

    const date = snapshot.snapshotAt.slice(0, 10);
    const existing = latestByDate.get(date);

    if (!existing || existing.snapshotAt.localeCompare(snapshot.snapshotAt) < 0) {
      latestByDate.set(date, snapshot);
    }
  }

  const orderedSnapshots = Array.from(latestByDate.values())
    .sort((left, right) => left.snapshotAt.localeCompare(right.snapshotAt));
  const latestSnapshot = orderedSnapshots[orderedSnapshots.length - 1];

  return {
    metricType: 'net_worth',
    latestNetWorthSol: latestSnapshot?.netWorthSol ?? null,
    latestWalletSol: latestSnapshot?.walletSol ?? null,
    latestLpValueSol: latestSnapshot?.lpValueSol ?? null,
    latestUnclaimedFeeSol: latestSnapshot?.unclaimedFeeSol ?? null,
    latestOpenPositionCount: latestSnapshot?.openPositionCount ?? null,
    dailyEquity: orderedSnapshots.map((snapshot) => ({
      date: snapshot.snapshotAt.slice(0, 10),
      netWorthSol: snapshot.netWorthSol ?? 0
    }))
  };
}
