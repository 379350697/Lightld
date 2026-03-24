import type { StrategyConfig } from '../config/schema.ts';
import type { LiveMode, LiveModeState } from './live-mode-store.ts';

type LiveModeStateReader = {
  read(): Promise<LiveModeState>;
};

type ResolveModeInput = {
  strategyId: string;
  liveConfig: StrategyConfig['live'];
};

export class LiveModeController {
  private readonly store: LiveModeStateReader;

  constructor(store: LiveModeStateReader) {
    this.store = store;
  }

  async resolveMode(input: ResolveModeInput): Promise<LiveMode> {
    const state = await this.store.read();

    if (state.killSwitchEngaged || state.globalMode === 'OFF') {
      return 'OFF';
    }

    if (
      state.globalMode === 'LIVE' &&
      input.liveConfig.enabled &&
      state.liveStrategies.includes(input.strategyId)
    ) {
      return 'LIVE';
    }

    return 'SHADOW';
  }
}
