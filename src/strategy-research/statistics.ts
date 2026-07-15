export type BootstrapResult = {
  mean: number;
  lower95: number;
  upper95: number;
  probabilityPositive: number;
  iterations: number;
};

export function pairedBlockBootstrap(values: number[], options: { seed?: number; iterations?: number; blockSize?: number } = {}): BootstrapResult {
  if (values.length === 0) {
    return { mean: 0, lower95: 0, upper95: 0, probabilityPositive: 0, iterations: 0 };
  }
  const iterations = options.iterations ?? 2_000;
  const blockSize = Math.max(1, Math.min(values.length, options.blockSize ?? Math.round(Math.sqrt(values.length))));
  const random = seededRandom(options.seed ?? 20260716);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    let count = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < blockSize && count < values.length; offset += 1) {
        sum += values[(start + offset) % values.length]!;
        count += 1;
      }
    }
    means.push(sum / values.length);
  }
  means.sort((left, right) => left - right);
  return {
    mean: average(values),
    lower95: percentile(means, 0.025),
    upper95: percentile(means, 0.975),
    probabilityPositive: means.filter((value) => value > 0).length / means.length,
    iterations
  };
}

export function summarizePnl(values: number[]) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    totalPnlSol: values.reduce((sum, value) => sum + value, 0),
    meanPnlSol: average(values),
    medianPnlSol: percentile(sorted, 0.5),
    winRate: values.length ? values.filter((value) => value > 0).length / values.length : 0,
    p05PnlSol: percentile(sorted, 0.05),
    maxDrawdownSol: maxDrawdown
  };
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]!;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
