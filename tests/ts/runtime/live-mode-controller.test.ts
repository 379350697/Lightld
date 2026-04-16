import { describe, expect, it } from 'vitest';

import { LiveModeController } from '../../../src/runtime/live-mode-controller';

describe('LiveModeController', () => {
  it('returns LIVE for an enabled strategy when global live mode is armed', async () => {
    const controller = new LiveModeController({
      read: async () => ({
        globalMode: 'LIVE',
        liveStrategies: ['new-token-v1'],
        killSwitchEngaged: false
      })
    });

    await expect(
      controller.resolveMode({
        strategyId: 'new-token-v1',
        liveConfig: {
          enabled: true,
          maxLivePositionSol: 0.25,
          autoFlattenRequired: true,
          minDeployScore: 70,
          maxHoldHours: 10,
          requireMintAuthorityRevoked: false
        }
      })
    ).resolves.toBe('LIVE');
  });

  it('returns OFF when the kill switch is engaged', async () => {
    const controller = new LiveModeController({
      read: async () => ({
        globalMode: 'LIVE',
        liveStrategies: ['new-token-v1'],
        killSwitchEngaged: true
      })
    });

    await expect(
      controller.resolveMode({
        strategyId: 'new-token-v1',
        liveConfig: {
          enabled: true,
          maxLivePositionSol: 0.25,
          autoFlattenRequired: true,
          minDeployScore: 70,
          maxHoldHours: 10,
          requireMintAuthorityRevoked: false
        }
      })
    ).resolves.toBe('OFF');
  });
});
