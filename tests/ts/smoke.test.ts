import { describe, expect, it } from 'vitest';

import { recordMarketSnapshot, runLiveCycle, runLiveDaemon, runStrategyCycle } from '../../src/index';

describe('public api smoke', () => {
  it('exports the main operator functions', () => {
    expect(typeof recordMarketSnapshot).toBe('function');
    expect(typeof runLiveCycle).toBe('function');
    expect(typeof runLiveDaemon).toBe('function');
    expect(typeof runStrategyCycle).toBe('function');
  });
});
