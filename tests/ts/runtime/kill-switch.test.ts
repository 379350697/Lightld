import { describe, expect, it } from 'vitest';

import { KillSwitch } from '../../../src/runtime/kill-switch';

describe('KillSwitch', () => {
  it('blocks execution when engaged', () => {
    const killSwitch = new KillSwitch(true);

    expect(killSwitch.allowsExecution()).toBe(false);
    expect(killSwitch.isEngaged()).toBe(true);
  });
});
