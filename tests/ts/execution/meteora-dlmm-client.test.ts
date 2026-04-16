import { createRequire } from 'node:module';

import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MeteoraDlmmClient, SOL_MINT } from '../../../src/execution/solana/meteora-dlmm-client';

const require = createRequire(import.meta.url);
const dlmmPkg = require('@meteora-ag/dlmm');

const originalCreate = dlmmPkg.create;
const originalGetAll = dlmmPkg.getAllLbPairPositionsByUser;

function makePoolAddress(seed: number) {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 255)).publicKey;
}

describe('MeteoraDlmmClient', () => {
  afterEach(() => {
    dlmmPkg.create = originalCreate;
    dlmmPkg.getAllLbPairPositionsByUser = originalGetAll;
    vi.restoreAllMocks();
  });

  it('rejects opening a new Meteora position when the pool already has one', async () => {
    const existingPosition = { publicKey: makePoolAddress(10) };
    const initializePositionAndAddLiquidityByStrategy = vi.fn();

    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: SOL_MINT },
      tokenY: { publicKey: makePoolAddress(30) },
      getActiveBin: async () => ({ binId: 120 }),
      getPositionsByUserAndLbPair: async () => ({
        activeBin: { binId: 120, price: '1' },
        userPositions: [existingPosition]
      }),
      initializePositionAndAddLiquidityByStrategy
    }));

    const client = new MeteoraDlmmClient({} as any);

    await expect(
      client.addLiquidityByStrategy(makePoolAddress(1), makePoolAddress(2).toBase58(), 0.1)
    ).rejects.toThrow(/Existing Meteora position already present/);

    expect(initializePositionAndAddLiquidityByStrategy).not.toHaveBeenCalled();
  });

  it('removes liquidity across every Meteora position in the pool', async () => {
    const positions = [
      { publicKey: makePoolAddress(40), positionData: { lowerBinId: 10, upperBinId: 20 } },
      { publicKey: makePoolAddress(50), positionData: { lowerBinId: 30, upperBinId: 40 } }
    ];
    const removeLiquidity = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'tx-1a' }, { id: 'tx-1b' }])
      .mockResolvedValueOnce({ id: 'tx-2' });

    dlmmPkg.create = vi.fn(async () => ({
      getPositionsByUserAndLbPair: async () => ({
        activeBin: { binId: 120, price: '1' },
        userPositions: positions
      }),
      removeLiquidity
    }));

    const client = new MeteoraDlmmClient({} as any);
    const transactions = await client.removeLiquidity(makePoolAddress(1), makePoolAddress(2).toBase58());

    expect(removeLiquidity).toHaveBeenCalledTimes(2);
    expect(removeLiquidity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        position: positions[0].publicKey,
        fromBinId: 10,
        toBinId: 20
      })
    );
    expect(removeLiquidity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        position: positions[1].publicKey,
        fromBinId: 30,
        toBinId: 40
      })
    );
    expect(transactions).toEqual([{ id: 'tx-1a' }, { id: 'tx-1b' }, { id: 'tx-2' }]);
  });

  it('claims fees across every Meteora position in the pool', async () => {
    const positions = [
      { publicKey: makePoolAddress(60), positionData: { feeX: { isZero: () => false }, feeY: { isZero: () => true } } },
      { publicKey: makePoolAddress(70), positionData: { feeX: { isZero: () => true }, feeY: { isZero: () => false } } }
    ];
    const claimAllSwapFee = vi.fn(async () => [{ id: 'claim-1' }, { id: 'claim-2' }]);

    dlmmPkg.create = vi.fn(async () => ({
      getPositionsByUserAndLbPair: async () => ({
        activeBin: { binId: 120, price: '1' },
        userPositions: positions
      }),
      claimAllSwapFee
    }));

    const client = new MeteoraDlmmClient({} as any);
    const transactions = await client.claimFee(makePoolAddress(1), makePoolAddress(2).toBase58());

    expect(claimAllSwapFee).toHaveBeenCalledWith({
      owner: expect.any(PublicKey),
      positions
    });
    expect(transactions).toEqual([{ id: 'claim-1' }, { id: 'claim-2' }]);
  });
});
