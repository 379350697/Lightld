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
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
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
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  requestedPositionSol: number;
  confirmationStatus?: string;
  updatedAt: string;
  createdAt: string;
};

type HistoricalDecisionFallback = {
  tokenMint: string;
  tokenSymbol: string;
  action: string;
  recordedAt: string;
  entrySol?: number;
  lpCurrentValueSol?: number;
  lpUnclaimedFeeSol?: number;
  lpNetPnlPct?: number;
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
  openedAt: string | null;
  closedAt: string | null;
  investedSol: number | null;
  feeEarnedSol: number | null;
  feeEarnedPct: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  dprPct: number | null;
};

type ReconciledHistoricalAction = {
  lifecycleKey: string;
  tokenMint: string;
  tokenSymbol: string;
  action: string;
  amountSol: number;
  recordedAt: string;
  status: 'ok' | 'missing-local' | 'missing-chain';
  entrySol?: number;
  exitValueSol?: number;
  feeEarnedSol?: number;
  pnlPct?: number;
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
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
  tokenMint: string;
  action: string;
  recordedAt: string;
}) {
  if (input.submissionId && input.submissionId.length > 0) {
    return `submission:${input.submissionId}`;
  }

  if (input.chainPositionAddress && input.chainPositionAddress.length > 0) {
    return `chain-position:${input.chainPositionAddress}:${input.action}`;
  }

  if (input.positionId && input.positionId.length > 0) {
    return `position:${input.positionId}:${input.action}`;
  }

  if (input.openIntentId && input.openIntentId.length > 0) {
    return `intent:${input.openIntentId}:${input.action}`;
  }

  if (input.idempotencyKey && input.idempotencyKey.length > 0) {
    return `order:${input.idempotencyKey}`;
  }

  return `unmatched:${input.tokenMint}:${input.action}:${input.recordedAt}`;
}

function listHistoricalIdentityKeys(input: {
  submissionId?: string;
  idempotencyKey?: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
}) {
  const keys: string[] = [];
  if (input.submissionId && input.submissionId.length > 0) {
    keys.push(`submission:${input.submissionId}`);
  }
  if (input.chainPositionAddress && input.chainPositionAddress.length > 0) {
    keys.push(`chain-position:${input.chainPositionAddress}`);
  }
  if (input.positionId && input.positionId.length > 0) {
    keys.push(`position:${input.positionId}`);
  }
  if (input.openIntentId && input.openIntentId.length > 0) {
    keys.push(`intent:${input.openIntentId}`);
  }
  if (input.idempotencyKey && input.idempotencyKey.length > 0) {
    keys.push(`order:${input.idempotencyKey}`);
  }
  return keys;
}

function toHistoricalLifecycleKey(input: {
  tokenMint: string;
  openIntentId?: string;
  positionId?: string;
  chainPositionAddress?: string;
}) {
  if (input.chainPositionAddress && input.chainPositionAddress.length > 0) {
    return `chain-position:${input.chainPositionAddress}`;
  }
  if (input.positionId && input.positionId.length > 0) {
    return `position:${input.positionId}`;
  }
  if (input.openIntentId && input.openIntentId.length > 0) {
    return `intent:${input.openIntentId}`;
  }
  return `token:${input.tokenMint}`;
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

function buildHistoricalTokenSymbolMap(input: {
  fills: HistoricalFill[];
  orders: HistoricalOrderFallback[];
  decisions: HistoricalDecisionFallback[];
}) {
  const symbols = new Map<string, string>();

  const collect = (tokenMint: string, tokenSymbol: string) => {
    if (tokenMint.length === 0 || tokenSymbol.length === 0 || symbols.has(tokenMint)) {
      return;
    }
    symbols.set(tokenMint, tokenSymbol);
  };

  for (const fill of input.fills) {
    collect(fill.tokenMint, fill.tokenSymbol);
  }

  for (const decision of input.decisions) {
    collect(decision.tokenMint, decision.tokenSymbol);
  }

  for (const order of input.orders) {
    collect(order.tokenMint, order.tokenSymbol);
  }

  return symbols;
}

function resolveHistoricalTokenSymbol(
  tokenMint: string,
  preferredSymbol: string | undefined,
  symbolMap: Map<string, string>
) {
  if (preferredSymbol && preferredSymbol.length > 0) {
    return preferredSymbol;
  }

  return symbolMap.get(tokenMint) ?? '';
}

function findDecisionFallback(input: {
  tokenMint: string;
  action: string;
  recordedAt: string;
  decisions: HistoricalDecisionFallback[];
  maxDistanceMs?: number;
}) {
  const targetRecordedAtMs = toRecordedAtMillis(input.recordedAt);
  const maxDistanceMs = input.maxDistanceMs ?? 120_000;
  let bestMatch: HistoricalDecisionFallback | null = null;
  let bestDistanceMs = Number.POSITIVE_INFINITY;

  for (const decision of input.decisions) {
    if (decision.tokenMint !== input.tokenMint || decision.action !== input.action) {
      continue;
    }

    const decisionRecordedAtMs = toRecordedAtMillis(decision.recordedAt);
    if (!Number.isFinite(targetRecordedAtMs) || !Number.isFinite(decisionRecordedAtMs)) {
      continue;
    }

    const distanceMs = Math.abs(targetRecordedAtMs - decisionRecordedAtMs);
    if (distanceMs > maxDistanceMs || distanceMs >= bestDistanceMs) {
      continue;
    }

    bestMatch = decision;
    bestDistanceMs = distanceMs;
  }

  return bestMatch;
}

function isStrongHistoricalMatchAllowed(fill: HistoricalFill, order: HistoricalOrderFallback) {
  if (fill.tokenMint.length > 0 && order.tokenMint.length > 0 && fill.tokenMint !== order.tokenMint) {
    return false;
  }

  if (!isHistoricalOpenAction(order.action)) {
    return true;
  }

  const fillRecordedAtMs = toRecordedAtMillis(fill.recordedAt);
  const orderRecordedAtMs = toRecordedAtMillis(order.updatedAt || order.createdAt);

  if (!Number.isFinite(fillRecordedAtMs) || !Number.isFinite(orderRecordedAtMs)) {
    return false;
  }

  return Math.abs(fillRecordedAtMs - orderRecordedAtMs) <= 180_000;
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

function findDirectOrderMatch(input: {
  fill: HistoricalFill;
  ordersByIdentity: Map<string, HistoricalOrderFallback[]>;
  usedOrderKeys: Set<string>;
}) {
  const identityKeys = listHistoricalIdentityKeys({
    submissionId: input.fill.submissionId,
    openIntentId: input.fill.openIntentId,
    positionId: input.fill.positionId,
    chainPositionAddress: input.fill.chainPositionAddress
  });

  let bestMatch: HistoricalOrderFallback | null = null;
  let bestDistanceMs = Number.POSITIVE_INFINITY;
  const fillRecordedAtMs = toRecordedAtMillis(input.fill.recordedAt);

  for (const key of identityKeys) {
    const matches = input.ordersByIdentity.get(key) ?? [];
    for (const match of matches) {
      if (!isStrongHistoricalMatchAllowed(input.fill, match)) {
        continue;
      }

      const orderKey = toHistoricalMatchKey({
        submissionId: match.submissionId,
        idempotencyKey: match.idempotencyKey,
        tokenMint: match.tokenMint,
        action: match.action,
        recordedAt: match.updatedAt || match.createdAt
      });

      if (input.usedOrderKeys.has(orderKey)) {
        continue;
      }

      if (isSupportedHistoricalAction(input.fill.side) && input.fill.side !== match.action) {
        continue;
      }

      const orderRecordedAtMs = toRecordedAtMillis(match.updatedAt || match.createdAt);
      const distanceMs = Number.isFinite(fillRecordedAtMs) && Number.isFinite(orderRecordedAtMs)
        ? Math.abs(fillRecordedAtMs - orderRecordedAtMs)
        : Number.POSITIVE_INFINITY;

      if (distanceMs < bestDistanceMs) {
        bestMatch = match;
        bestDistanceMs = distanceMs;
      }
    }
  }

  if (bestMatch) {
    return bestMatch;
  }

  for (const key of identityKeys) {
    const matches = input.ordersByIdentity.get(key) ?? [];
    if (matches.length === 0) {
      continue;
    }
    for (const match of matches) {
      if (!isStrongHistoricalMatchAllowed(input.fill, match)) {
        continue;
      }

      const orderKey = toHistoricalMatchKey({
        submissionId: match.submissionId,
        idempotencyKey: match.idempotencyKey,
        tokenMint: match.tokenMint,
        action: match.action,
        recordedAt: match.updatedAt || match.createdAt
      });
      if (!input.usedOrderKeys.has(orderKey)) {
        return match;
      }
    }
  }

  return null;
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
  const investedSol = openAction?.entrySol ?? openAction?.amountSol ?? closeAction?.entrySol ?? null;
  const feeEarnedSol = closeAction?.feeEarnedSol ?? openAction?.feeEarnedSol ?? null;
  const feeEarnedPct = typeof investedSol === 'number' && investedSol > 0 && typeof feeEarnedSol === 'number'
    ? (feeEarnedSol / investedSol) * 100
    : null;
  const totalExitValueSol = closeAction?.exitValueSol ?? closeAction?.amountSol ?? null;
  const pnlSol = typeof investedSol === 'number' && typeof totalExitValueSol === 'number'
    ? totalExitValueSol - investedSol
    : typeof investedSol === 'number' && investedSol > 0 && typeof closeAction?.pnlPct === 'number'
      ? investedSol * (closeAction.pnlPct / 100)
      : null;
  const pnlPct = typeof investedSol === 'number' && investedSol > 0 && typeof pnlSol === 'number'
    ? (pnlSol / investedSol) * 100
    : typeof closeAction?.pnlPct === 'number'
      ? closeAction.pnlPct
      : null;

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
      confirmationStatus: 'ok',
      openedAt: openAction.recordedAt,
      closedAt: closeAction.recordedAt,
      investedSol,
      feeEarnedSol,
      feeEarnedPct,
      pnlSol,
      pnlPct,
      dprPct: pnlPct
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
    confirmationStatus: errorStatus,
    openedAt: openAction?.recordedAt ?? null,
    closedAt: closeAction?.recordedAt ?? null,
    investedSol,
    feeEarnedSol,
    feeEarnedPct,
    pnlSol,
    pnlPct,
    dprPct: pnlPct
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
  decisionFallback?: HistoricalDecisionFallback[];
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
  const decisions = input.decisionFallback ?? [];
  const tokenSymbolMap = buildHistoricalTokenSymbolMap({
    fills,
    orders,
    decisions
  });

  const localByKey = new Map<string, HistoricalOrderFallback>();
  const ordersByIdentity = new Map<string, HistoricalOrderFallback[]>();
  for (const order of orders) {
    const orderKey = toHistoricalMatchKey({
      submissionId: order.submissionId,
      idempotencyKey: order.idempotencyKey,
      tokenMint: order.tokenMint,
      action: order.action,
      recordedAt: order.updatedAt || order.createdAt
    });
    localByKey.set(orderKey, order);

    for (const identityKey of listHistoricalIdentityKeys({
      submissionId: order.submissionId,
      idempotencyKey: order.idempotencyKey,
      openIntentId: order.openIntentId,
      positionId: order.positionId,
      chainPositionAddress: order.chainPositionAddress
    })) {
      const matches = ordersByIdentity.get(identityKey) ?? [];
      matches.push(order);
      ordersByIdentity.set(identityKey, matches);
    }
  }

  const chainByKey = new Map<string, HistoricalFill[]>();
  for (const fill of fills) {
    const key = toHistoricalMatchKey({
      submissionId: fill.submissionId,
      openIntentId: fill.openIntentId,
      positionId: fill.positionId,
      chainPositionAddress: fill.chainPositionAddress,
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
      const keyedOrder = localByKey.get(key);
      const directOrder = keyedOrder && isStrongHistoricalMatchAllowed(fill, keyedOrder)
        ? keyedOrder
        : findDirectOrderMatch({
            fill,
            ordersByIdentity,
            usedOrderKeys
          });
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
        lifecycleKey: toHistoricalLifecycleKey({
          tokenMint: fill.tokenMint,
          openIntentId: fill.openIntentId ?? matchedOrder?.openIntentId,
          positionId: fill.positionId ?? matchedOrder?.positionId,
          chainPositionAddress: fill.chainPositionAddress ?? matchedOrder?.chainPositionAddress
        }),
        tokenMint: fill.tokenMint,
        tokenSymbol: resolveHistoricalTokenSymbol(fill.tokenMint, fill.tokenSymbol || matchedOrder?.tokenSymbol || '', tokenSymbolMap),
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

    const decision = findDecisionFallback({
      tokenMint: order.tokenMint,
      action: order.action,
      recordedAt: order.updatedAt || order.createdAt,
      decisions
    });

    reconciledActions.push({
      lifecycleKey: `token:${order.tokenMint}`,
      tokenMint: order.tokenMint,
      tokenSymbol: resolveHistoricalTokenSymbol(order.tokenMint, order.tokenSymbol || decision?.tokenSymbol || '', tokenSymbolMap),
      action: order.action,
      amountSol: order.requestedPositionSol,
      recordedAt: order.updatedAt || order.createdAt,
      status: 'missing-chain',
      entrySol: typeof decision?.entrySol === 'number' && decision.entrySol > 0
        ? decision.entrySol
        : undefined,
      exitValueSol: typeof decision?.lpCurrentValueSol === 'number'
        ? decision.lpCurrentValueSol + (decision.lpUnclaimedFeeSol ?? 0)
        : undefined,
      feeEarnedSol: typeof decision?.lpUnclaimedFeeSol === 'number' ? decision.lpUnclaimedFeeSol : undefined,
      pnlPct: typeof decision?.lpNetPnlPct === 'number' ? decision.lpNetPnlPct : undefined
    });
  }

  reconciledActions.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));

  const lifecycles: HistoricalLifecycle[] = [];
  const currentLifecycleByKey = new Map<string, HistoricalLifecycle>();

  for (const action of reconciledActions) {
    const current = currentLifecycleByKey.get(action.lifecycleKey);

    if (isHistoricalOpenAction(action.action)) {
      if (current) {
        lifecycles.push(current);
      }

      currentLifecycleByKey.set(action.lifecycleKey, {
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
        currentLifecycleByKey.delete(action.lifecycleKey);
      } else {
        lifecycles.push({
          tokenMint: action.tokenMint,
          tokenSymbol: action.tokenSymbol,
          closeAction: action
        });
      }
    }
  }

  for (const lifecycle of currentLifecycleByKey.values()) {
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
