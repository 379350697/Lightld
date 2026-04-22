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

type HistoricalFill = {
  tokenMint: string;
  tokenSymbol: string;
  side: string;
  submissionId?: string;
  filledSol: number;
  recordedAt: string;
  confirmationStatus?: string;
};

type HistoricalOrderFallback = {
  tokenMint: string;
  tokenSymbol: string;
  action: string;
  submissionId?: string;
  idempotencyKey?: string;
  requestedPositionSol: number;
  confirmationStatus?: string;
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

export type DashboardHistoricalActivityEntry = {
  tokenMint: string;
  tokenSymbol: string;
  action: string;
  amountSol: number;
  recordedAt: string;
  source: 'matched' | 'error';
  confirmationStatus: string;
};

type ReconciledHistoricalAction = {
  tokenMint: string;
  tokenSymbol: string;
  action: string;
  amountSol: number;
  recordedAt: string;
  status: 'ok' | 'missing-local' | 'missing-chain';
};

type HistoricalLifecycle = {
  tokenMint: string;
  tokenSymbol: string;
  openAction?: ReconciledHistoricalAction;
  closeAction?: ReconciledHistoricalAction;
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

function sortByRecordedAtDesc<T extends { recordedAt: string }>(rows: T[]) {
  return [...rows].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
}

function toHistoricalMatchKey(input: {
  submissionId?: string;
  idempotencyKey?: string;
  tokenMint: string;
  action: string;
  recordedAt: string;
}) {
  if (input.submissionId && input.submissionId.length > 0) {
    return `submission:${input.submissionId}`;
  }

  if (input.idempotencyKey && input.idempotencyKey.length > 0) {
    return `order:${input.idempotencyKey}`;
  }

  return `unmatched:${input.tokenMint}:${input.action}:${input.recordedAt}`;
}

function isHistoricalOpenAction(action: string) {
  return action === 'add-lp' || action === 'deploy' || action === 'rebalance-lp';
}

function isHistoricalCloseAction(action: string) {
  return action === 'withdraw-lp';
}

function isSupportedHistoricalAction(action: string) {
  return isHistoricalOpenAction(action) || isHistoricalCloseAction(action);
}

function toRecordedAtMillis(recordedAt: string) {
  const parsed = Date.parse(recordedAt);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function pickNearestOrderMatch(input: {
  fill: HistoricalFill;
  orders: HistoricalOrderFallback[];
  usedOrderKeys: Set<string>;
  maxDistanceMs?: number;
}) {
  const fillRecordedAtMs = toRecordedAtMillis(input.fill.recordedAt);
  const maxDistanceMs = input.maxDistanceMs ?? 30_000;
  let bestMatch: HistoricalOrderFallback | null = null;
  let bestDistanceMs = Number.POSITIVE_INFINITY;
  let bestAmountDelta = Number.POSITIVE_INFINITY;
  const fillAmountSol = input.fill.filledSol > 0 ? input.fill.filledSol : Number.NaN;

  for (const order of input.orders) {
    const orderKey = toHistoricalMatchKey({
      submissionId: order.submissionId,
      idempotencyKey: order.idempotencyKey,
      tokenMint: order.tokenMint,
      action: order.action,
      recordedAt: order.updatedAt || order.createdAt
    });

    if (input.usedOrderKeys.has(orderKey)) {
      continue;
    }

    if (order.tokenMint !== input.fill.tokenMint || !isSupportedHistoricalAction(order.action)) {
      continue;
    }

    if (isSupportedHistoricalAction(input.fill.side) && input.fill.side !== order.action) {
      continue;
    }

    const orderRecordedAtMs = toRecordedAtMillis(order.updatedAt || order.createdAt);
    if (!Number.isFinite(fillRecordedAtMs) || !Number.isFinite(orderRecordedAtMs)) {
      continue;
    }

    const distanceMs = Math.abs(fillRecordedAtMs - orderRecordedAtMs);
    if (distanceMs > maxDistanceMs) {
      continue;
    }

    const amountDelta = Number.isFinite(fillAmountSol)
      ? Math.abs(fillAmountSol - order.requestedPositionSol)
      : Number.POSITIVE_INFINITY;
    const isBetterAmountMatch = amountDelta < bestAmountDelta;
    const isSameAmountMatchButCloser = amountDelta === bestAmountDelta && distanceMs < bestDistanceMs;

    if (!isBetterAmountMatch && !isSameAmountMatchButCloser && distanceMs >= bestDistanceMs) {
      continue;
    }

    bestMatch = order;
    bestDistanceMs = distanceMs;
    bestAmountDelta = amountDelta;
  }

  return bestMatch;
}

function buildLifecycleEntry(lifecycle: HistoricalLifecycle): DashboardHistoricalActivityEntry | null {
  const openAction = lifecycle.openAction;
  const closeAction = lifecycle.closeAction;

  if (!openAction && !closeAction) {
    return null;
  }

  if (
    openAction
    && !closeAction
    && openAction.status === 'ok'
  ) {
    return null;
  }

  const recordedAt = closeAction?.recordedAt ?? openAction?.recordedAt ?? '';
  const amountSol = openAction?.amountSol ?? closeAction?.amountSol ?? 0;
  const tokenMint = lifecycle.tokenMint;
  const tokenSymbol = lifecycle.tokenSymbol;

  if (
    openAction
    && closeAction
    && openAction.status === 'ok'
    && closeAction.status === 'ok'
  ) {
    return {
      tokenMint,
      tokenSymbol,
      action: `${openAction.action} -> ${closeAction.action}`,
      amountSol,
      recordedAt,
      source: 'matched',
      confirmationStatus: 'ok'
    };
  }

  const errorStatus = closeAction && closeAction.status !== 'ok'
    ? closeAction.status
    : openAction && openAction.status !== 'ok'
      ? openAction?.status
      : 'missing-close';
  const action = openAction && closeAction
    ? `${openAction.action} -> ${closeAction.action}`
    : openAction?.action ?? closeAction?.action ?? 'unknown';

  return {
    tokenMint,
    tokenSymbol,
    action,
    amountSol,
    recordedAt,
    source: 'error',
    confirmationStatus: errorStatus
  };
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

export function buildHistoricalActivity(input: {
  fills: HistoricalFill[];
  orderFallback?: HistoricalOrderFallback[];
  limit?: number;
}): DashboardHistoricalActivityEntry[] {
  const fills = input.fills
    .filter((fill) =>
      fill.recordedAt
      && (fill.submissionId?.length || fill.side.length > 0)
    );

  const orders = (input.orderFallback ?? [])
    .filter((order) =>
      (order.action === 'add-lp'
        || order.action === 'deploy'
        || order.action === 'withdraw-lp'
        || order.action === 'rebalance-lp')
      && Number.isFinite(order.requestedPositionSol)
      && order.requestedPositionSol > 0
    );

  const localByKey = new Map<string, HistoricalOrderFallback>();
  for (const order of orders) {
    localByKey.set(toHistoricalMatchKey({
      submissionId: order.submissionId,
      idempotencyKey: order.idempotencyKey,
      tokenMint: order.tokenMint,
      action: order.action,
      recordedAt: order.updatedAt || order.createdAt
    }), order);
  }

  const chainByKey = new Map<string, HistoricalFill[]>();
  for (const fill of fills) {
    const key = toHistoricalMatchKey({
      submissionId: fill.submissionId,
      tokenMint: fill.tokenMint,
      action: fill.side,
      recordedAt: fill.recordedAt
    });
    const existing = chainByKey.get(key) ?? [];
    existing.push(fill);
    chainByKey.set(key, existing);
  }

  const reconciledActions: ReconciledHistoricalAction[] = [];
  const usedOrderKeys = new Set<string>();

  for (const [key, chainEntries] of chainByKey.entries()) {
    for (const fill of chainEntries) {
      const directOrder = localByKey.get(key);
      const fallbackOrder = directOrder ?? pickNearestOrderMatch({
        fill,
        orders,
        usedOrderKeys
      });
      const matchedOrder = fallbackOrder ?? null;
      const matchedOrderKey = matchedOrder
        ? toHistoricalMatchKey({
            submissionId: matchedOrder.submissionId,
            idempotencyKey: matchedOrder.idempotencyKey,
            tokenMint: matchedOrder.tokenMint,
            action: matchedOrder.action,
            recordedAt: matchedOrder.updatedAt || matchedOrder.createdAt
          })
        : '';
      const action = isSupportedHistoricalAction(fill.side)
        ? fill.side
        : matchedOrder?.action ?? '';

      if (matchedOrder && matchedOrderKey.length > 0) {
        usedOrderKeys.add(matchedOrderKey);
      }

      if (
        fill.tokenMint.length === 0
        || action.length === 0
        || !isSupportedHistoricalAction(action)
      ) {
        continue;
      }

      reconciledActions.push({
        tokenMint: fill.tokenMint,
        tokenSymbol: fill.tokenSymbol || matchedOrder?.tokenSymbol || '',
        action,
        amountSol: fill.filledSol > 0 ? fill.filledSol : matchedOrder?.requestedPositionSol ?? 0,
        recordedAt: [fill.recordedAt, matchedOrder?.updatedAt ?? matchedOrder?.createdAt ?? '']
          .sort((left, right) => right.localeCompare(left))[0] ?? '',
        status: matchedOrder ? 'ok' : 'missing-local'
      });
    }
  }

  for (const [key, order] of localByKey.entries()) {
    if (usedOrderKeys.has(key) || !isSupportedHistoricalAction(order.action)) {
      continue;
    }

    reconciledActions.push({
      tokenMint: order.tokenMint,
      tokenSymbol: order.tokenSymbol,
      action: order.action,
      amountSol: order.requestedPositionSol,
      recordedAt: order.updatedAt || order.createdAt,
      status: 'missing-chain'
    });
  }

  reconciledActions.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));

  const lifecycles: HistoricalLifecycle[] = [];
  const currentLifecycleByToken = new Map<string, HistoricalLifecycle>();

  for (const action of reconciledActions) {
    const tokenKey = action.tokenMint;
    const current = currentLifecycleByToken.get(tokenKey);

    if (isHistoricalOpenAction(action.action)) {
      if (current) {
        lifecycles.push(current);
      }

      currentLifecycleByToken.set(tokenKey, {
        tokenMint: action.tokenMint,
        tokenSymbol: action.tokenSymbol,
        openAction: action
      });
      continue;
    }

    if (isHistoricalCloseAction(action.action)) {
      if (current) {
        current.closeAction = action;
        lifecycles.push(current);
        currentLifecycleByToken.delete(tokenKey);
      } else {
        lifecycles.push({
          tokenMint: action.tokenMint,
          tokenSymbol: action.tokenSymbol,
          closeAction: action
        });
      }
    }
  }

  for (const lifecycle of currentLifecycleByToken.values()) {
    lifecycles.push(lifecycle);
  }

  return sortByRecordedAtDesc(
    lifecycles
      .map((lifecycle) => buildLifecycleEntry(lifecycle))
      .filter((entry): entry is DashboardHistoricalActivityEntry => entry !== null)
  ).slice(0, input.limit ?? 20);
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
