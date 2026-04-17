import { createRequire } from 'node:module';

import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RpcEndpointRegistry } from '../../../src/execution/rpc-endpoint-registry';
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

  it('repairs a matching existing Meteora position instead of initializing a duplicate', async () => {
    const existingPosition = {
      publicKey: makePoolAddress(10),
      positionData: {
        lowerBinId: 120,
        upperBinId: 188,
        positionBinData: []
      }
    };
    const initializePositionAndAddLiquidityByStrategy = vi.fn();
    const addLiquidityByStrategy = vi.fn(async () => [{ id: 'repair-tx-1' }, { id: 'repair-tx-2' }]);

    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: SOL_MINT },
      tokenY: { publicKey: makePoolAddress(30) },
      getActiveBin: async () => ({ binId: 120 }),
      getPositionsByUserAndLbPair: async () => ({
        activeBin: { binId: 120, price: '1' },
        userPositions: [existingPosition]
      }),
      initializePositionAndAddLiquidityByStrategy,
      addLiquidityByStrategy
    }));

    const client = new MeteoraDlmmClient({} as any);

    await expect(
      client.addLiquidityByStrategy(makePoolAddress(1), makePoolAddress(2).toBase58(), 0.1)
    ).resolves.toMatchObject({
      transaction: [{ id: 'repair-tx-1' }, { id: 'repair-tx-2' }],
      newPositionKeypair: undefined
    });

    expect(initializePositionAndAddLiquidityByStrategy).not.toHaveBeenCalled();
    expect(addLiquidityByStrategy).toHaveBeenCalledWith(expect.objectContaining({
      positionPubKey: existingPosition.publicKey,
      strategy: expect.objectContaining({
        minBinId: 120,
        maxBinId: 188,
        singleSidedX: true
      })
    }));
  });

  it('initializes a single-sided SOL position across 69 bins on the SOL side when SOL is token Y', async () => {
    const initializePositionAndAddLiquidityByStrategy = vi.fn(async () => ({ id: 'init-tx' }));

    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: makePoolAddress(31) },
      tokenY: { publicKey: SOL_MINT },
      getActiveBin: async () => ({ binId: 120 }),
      getPositionsByUserAndLbPair: async () => ({
        activeBin: { binId: 120, price: '1' },
        userPositions: []
      }),
      initializePositionAndAddLiquidityByStrategy
    }));

    const client = new MeteoraDlmmClient({} as any);

    await client.addLiquidityByStrategy(makePoolAddress(1), makePoolAddress(2).toBase58(), 0.1);

    expect(initializePositionAndAddLiquidityByStrategy).toHaveBeenCalledWith(expect.objectContaining({
      strategy: expect.objectContaining({
        minBinId: 52,
        maxBinId: 120,
        singleSidedX: false
      })
    }));
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

  it('returns rich LP snapshots and marks empty positions separately from funded ones', async () => {
    const poolAddress = makePoolAddress(80).toBase58();
    const fundedPosition = {
      publicKey: makePoolAddress(81),
      positionData: {
        lowerBinId: 100,
        upperBinId: 168,
        feeX: { isZero: () => false },
        feeY: { isZero: () => true },
        positionBinData: [
          { binId: 100, positionXAmount: '10', positionYAmount: '0' },
          { binId: 101, positionXAmount: '0', positionYAmount: '5' }
        ]
      }
    };
    const emptyPosition = {
      publicKey: makePoolAddress(82),
      positionData: {
        lowerBinId: 200,
        upperBinId: 268,
        feeX: { isZero: () => true },
        feeY: { isZero: () => true },
        positionBinData: []
      }
    };

    dlmmPkg.getAllLbPairPositionsByUser = vi.fn(async () => new Map([
      [poolAddress, { lbPairPositionsData: [{ publicKey: fundedPosition.publicKey }, { publicKey: emptyPosition.publicKey }] }]
    ]));
    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: SOL_MINT },
      tokenY: { publicKey: makePoolAddress(90) },
      getPositionsByUserAndLbPair: async () => ({
        activeBin: { binId: 120, price: '1' },
        userPositions: [fundedPosition, emptyPosition]
      })
    }));

    const client = new MeteoraDlmmClient({} as any);
    const snapshots = await client.getPositionSnapshots(makePoolAddress(1));

    expect(snapshots).toEqual([
      expect.objectContaining({
        poolAddress,
        positionAddress: fundedPosition.publicKey.toBase58(),
        lowerBinId: 100,
        upperBinId: 168,
        binCount: 69,
        fundedBinCount: 2,
        hasLiquidity: true,
        hasClaimableFees: true
      }),
      expect.objectContaining({
        poolAddress,
        positionAddress: emptyPosition.publicKey.toBase58(),
        lowerBinId: 200,
        upperBinId: 268,
        binCount: 69,
        fundedBinCount: 0,
        hasLiquidity: false,
        hasClaimableFees: false
      })
    ]);
  });

  it('falls back to later DLMM connections when the first rpc is rate limited', async () => {
    const poolAddress = makePoolAddress(110).toBase58();
    const calls: string[] = [];
    const registry = new RpcEndpointRegistry({ maxWaitMs: 0 });
    registry.registerMany([
      { url: 'primary', kind: 'dlmm', maxConcurrency: 1 },
      { url: 'secondary', kind: 'dlmm', maxConcurrency: 1 }
    ]);

    dlmmPkg.getAllLbPairPositionsByUser = vi.fn(async (connection: { label: string }) => {
      calls.push(connection.label);
      if (connection.label === 'primary') {
        throw new Error('429 Too Many Requests');
      }

      return new Map([[poolAddress, { lbPairPositionsData: [] }]]);
    });

    const client = new MeteoraDlmmClient([
      { label: 'primary' } as any,
      { label: 'secondary' } as any
    ], {
      endpointRegistry: registry
    });

    await expect(client.getPositions(makePoolAddress(1))).resolves.toEqual(
      new Map([[poolAddress, { lbPairPositionsData: [] }]])
    );
    expect(calls).toEqual(['primary', 'secondary']);
  });

  it('reuses cached position snapshots for the same wallet within the ttl window', async () => {
    const wallet = makePoolAddress(120);
    const poolAddress = makePoolAddress(121).toBase58();
    const getAll = vi.fn(async () => new Map([
      [poolAddress, { lbPairPositionsData: [{ publicKey: makePoolAddress(122) }] }]
    ]));
    const getPositionsByUserAndLbPair = vi.fn(async () => ({
      activeBin: { binId: 120, price: '1' },
      userPositions: [{
        publicKey: makePoolAddress(122),
        positionData: {
          lowerBinId: 100,
          upperBinId: 168,
          feeX: { isZero: () => true },
          feeY: { isZero: () => true },
          positionBinData: [{ positionXAmount: '1', positionYAmount: '0' }]
        }
      }]
    }));

    dlmmPkg.getAllLbPairPositionsByUser = getAll;
    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: SOL_MINT },
      tokenY: { publicKey: makePoolAddress(123) },
      getPositionsByUserAndLbPair
    }));

    const client = new MeteoraDlmmClient({} as any, {
      positionSnapshotTtlMs: 15_000,
      nowMs: () => 1_000
    });

    const first = await client.getPositionSnapshots(wallet);
    const second = await client.getPositionSnapshots(wallet);

    expect(second).toEqual(first);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getPositionsByUserAndLbPair).toHaveBeenCalledTimes(1);
  });

  it('deduplicates in-flight position snapshot reads for the same wallet', async () => {
    const wallet = makePoolAddress(130);
    const poolAddress = makePoolAddress(131).toBase58();
    let resolveGetAll: ((value: Map<string, unknown>) => void) | undefined;
    const getAll = vi.fn(() =>
      new Promise<Map<string, unknown>>((resolve) => {
        resolveGetAll = resolve;
      })
    );
    const getPositionsByUserAndLbPair = vi.fn(async () => ({
      activeBin: { binId: 120, price: '1' },
      userPositions: [{
        publicKey: makePoolAddress(132),
        positionData: {
          lowerBinId: 100,
          upperBinId: 168,
          feeX: { isZero: () => true },
          feeY: { isZero: () => true },
          positionBinData: [{ positionXAmount: '1', positionYAmount: '0' }]
        }
      }]
    }));

    dlmmPkg.getAllLbPairPositionsByUser = getAll;
    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: SOL_MINT },
      tokenY: { publicKey: makePoolAddress(133) },
      getPositionsByUserAndLbPair
    }));

    const client = new MeteoraDlmmClient({} as any, {
      positionSnapshotTtlMs: 15_000,
      nowMs: () => 1_000
    });

    const firstPromise = client.getPositionSnapshots(wallet);
    const secondPromise = client.getPositionSnapshots(wallet);

    expect(getAll).toHaveBeenCalledTimes(1);

    resolveGetAll?.(new Map([
      [poolAddress, { lbPairPositionsData: [{ publicKey: makePoolAddress(132) }] }]
    ]));

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second).toEqual(first);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getPositionsByUserAndLbPair).toHaveBeenCalledTimes(1);
  });

  it('falls back to the most recent cached snapshots when a refresh fails after the ttl expires', async () => {
    const wallet = makePoolAddress(140);
    const poolAddress = makePoolAddress(141).toBase58();
    const getAll = vi.fn(async () => new Map([
      [poolAddress, { lbPairPositionsData: [{ publicKey: makePoolAddress(142) }] }]
    ]));
    const getPositionsByUserAndLbPair = vi.fn(async () => ({
      activeBin: { binId: 120, price: '1' },
      userPositions: [{
        publicKey: makePoolAddress(142),
        positionData: {
          lowerBinId: 100,
          upperBinId: 168,
          feeX: { isZero: () => true },
          feeY: { isZero: () => true },
          positionBinData: [{ positionXAmount: '1', positionYAmount: '0' }]
        }
      }]
    }));

    dlmmPkg.getAllLbPairPositionsByUser = getAll;
    dlmmPkg.create = vi.fn(async () => ({
      tokenX: { publicKey: SOL_MINT },
      tokenY: { publicKey: makePoolAddress(143) },
      getPositionsByUserAndLbPair
    }));

    let now = 1_000;
    const client = new MeteoraDlmmClient({} as any, {
      positionSnapshotTtlMs: 15_000,
      nowMs: () => now
    });

    const first = await client.getPositionSnapshots(wallet);

    now = 20_000;
    getAll.mockRejectedValueOnce(new Error('rpc timeout'));

    const second = await client.getPositionSnapshots(wallet);

    expect(second).toEqual(first);
    expect(getAll).toHaveBeenCalledTimes(2);
  });
});
