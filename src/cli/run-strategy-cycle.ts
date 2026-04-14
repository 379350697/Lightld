import { recordMarketSnapshot } from './record-market-snapshot.ts';
import { runLiveCycle, type LiveCycleInput } from '../runtime/live-cycle.ts';

export async function runStrategyCycle(input: LiveCycleInput) {
  const marketSnapshot = await recordMarketSnapshot(input.context);

  return runLiveCycle({
    ...input,
    context: marketSnapshot.context
  });
}
