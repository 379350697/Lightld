import type { LiveModeState } from './live-mode-store.ts';

type LiveModeStateReader = {
  read(): Promise<LiveModeState>;
};

export class KillSwitch {
  private readonly engaged: boolean;

  constructor(engaged: boolean) {
    this.engaged = engaged;
  }

  static async fromLiveModeStore(store: LiveModeStateReader) {
    const state = await store.read();

    return new KillSwitch(state.killSwitchEngaged);
  }

  allowsExecution() {
    return !this.engaged;
  }

  isEngaged() {
    return this.engaged;
  }
}
