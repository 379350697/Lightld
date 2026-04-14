import { rm } from 'node:fs/promises';

import { beforeEach, describe, expect, it } from 'vitest';

import { NewTokenPoolStore } from '../../../src/runtime/new-token-pool';

describe('NewTokenPoolStore', () => {
  const path = 'tmp/tests/new-token-pool/store.json';

  beforeEach(async () => {
    await rm('tmp/tests/new-token-pool', { recursive: true, force: true });
  });

  it('persists newly seen tokens and deduplicates by mint', () => {
    const store = new NewTokenPoolStore(path);

    store.upsertToken({ tokenMint: 'mint-1', source: 'PumpPortal', seenAt: '2026-03-22T00:00:00.000Z' });
    store.upsertToken({ tokenMint: 'mint-1', source: 'PumpPortal', tokenSymbol: 'SAFE', seenAt: '2026-03-22T00:10:00.000Z' });

    const all = store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].tokenMint).toBe('mint-1');
    expect(all[0].tokenSymbol).toBe('SAFE');
    expect(all[0].status).toBe('pending');
  });

  it('marks promoted tokens and excludes them from active set', () => {
    const store = new NewTokenPoolStore(path);
    store.upsertToken({ tokenMint: 'mint-2', source: 'PumpPortal' });

    expect(store.getActiveTokens()).toHaveLength(1);
    store.markPromoted('mint-2');
    expect(store.getActiveTokens()).toHaveLength(0);
  });
});
