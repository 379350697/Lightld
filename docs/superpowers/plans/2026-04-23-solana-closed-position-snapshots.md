# Solana Closed Position Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct closed LP lifecycle truth from Solana chain data for the live wallet and make dashboard history prefer that truth over local estimates.

**Architecture:** Add a small Solana history reader plus a lifecycle reconstructor that produces `closed_position_snapshots` records in SQLite. Keep dashboard history logic simple: when a chain snapshot exists, use it; when it does not, do not present local estimates as exact truth.

**Tech Stack:** TypeScript, Solana RPC, SQLite mirror, Vitest, existing dashboard server.

---

### Task 1: Add Solana RPC History Primitives

**Files:**
- Modify: `src/execution/solana/solana-rpc-client.ts`
- Test: `tests/ts/execution/solana-rpc-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('requests signatures for an address with a limit', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: [{ signature: 'sig-1', slot: 1, blockTime: 1_700_000_000 }]
  }), { status: 200 }));

  const client = new SolanaRpcClient({ rpcUrl: 'https://rpc.test', fetchImpl });
  const result = await client.getSignaturesForAddress('wallet-1', { limit: 5 });

  expect(result[0]?.signature).toBe('sig-1');
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://rpc.test',
    expect.objectContaining({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: ['wallet-1', { limit: 5 }]
      })
    })
  );
});

it('requests parsed transactions for a signature', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { slot: 10, blockTime: 1_700_000_000, meta: {}, transaction: { signatures: ['sig-1'] } }
  }), { status: 200 }));

  const client = new SolanaRpcClient({ rpcUrl: 'https://rpc.test', fetchImpl });
  const result = await client.getTransaction('sig-1');

  expect(result?.transaction.signatures[0]).toBe('sig-1');
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://rpc.test',
    expect.objectContaining({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: ['sig-1', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
      })
    })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/execution/solana-rpc-client.test.ts`
Expected: FAIL because `getSignaturesForAddress` and `getTransaction` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
async getSignaturesForAddress(
  address: string,
  options: { before?: string; until?: string; limit?: number } = {}
): Promise<Array<{ signature: string; slot: number; blockTime: number | null }>> {
  return this.call('getSignaturesForAddress', [address, options]);
}

async getTransaction(signature: string): Promise<any | null> {
  return this.call('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/execution/solana-rpc-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/ts/execution/solana-rpc-client.test.ts src/execution/solana/solana-rpc-client.ts
git commit -m "Add Solana RPC history methods"
```

### Task 2: Reconstruct One Closed LP Lifecycle From Chain Data

**Files:**
- Create: `src/history/solana-closed-position-reconstructor.ts`
- Test: `tests/ts/history/solana-closed-position-reconstructor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('reconstructs a closed LP lifecycle from add, claim-fee, and withdraw transactions', async () => {
  const reconstructor = createSolanaClosedPositionReconstructor();

  const result = reconstructor.reconstructFromTransactions({
    walletAddress: 'wallet-1',
    tokenMint: 'mint-earth',
    transactions: [
      makeOpenTx({ signature: 'open-1', solSpent: 0.05, tokenSpent: 0 }),
      makeClaimFeeTx({ signature: 'fee-1', feeSol: 0.0018, feeToken: 3390 }),
      makeWithdrawTx({ signature: 'close-1', withdrawSol: 0, withdrawToken: 33100, poolPriceInSol: 0.00009547 })
    ]
  });

  expect(result).toMatchObject({
    tokenMint: 'mint-earth',
    depositSol: 0.05,
    feeSol: 0.0018,
    feeTokenAmount: 3390,
    withdrawSol: 0,
    withdrawTokenAmount: 33100
  });
  expect(result?.pnlSol).toBeCloseTo((33100 * 0.00009547) + 0.0018 + (3390 * 0.00009547) - 0.05);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/history/solana-closed-position-reconstructor.test.ts`
Expected: FAIL because the reconstructor does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export type ClosedPositionSnapshot = {
  walletAddress: string;
  tokenMint: string;
  poolAddress: string;
  positionAddress: string;
  openedAt: string;
  closedAt: string;
  depositSol: number;
  depositTokenAmount: number;
  withdrawSol: number;
  withdrawTokenAmount: number;
  feeSol: number;
  feeTokenAmount: number;
  pnlSol: number;
  source: 'solana-chain';
  confidence: 'exact' | 'partial';
};

export function createSolanaClosedPositionReconstructor() {
  return {
    reconstructFromTransactions(input: { walletAddress: string; tokenMint: string; transactions: any[] }): ClosedPositionSnapshot | null {
      // minimal implementation: sum open, withdraw, claim-fee token/SOL deltas and compute pnlSol
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/history/solana-closed-position-reconstructor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/ts/history/solana-closed-position-reconstructor.test.ts src/history/solana-closed-position-reconstructor.ts
git commit -m "Add Solana closed position reconstructor"
```

### Task 3: Persist Closed Position Snapshots In SQLite

**Files:**
- Modify: `src/observability/sqlite-mirror-schema.ts`
- Modify: `src/observability/sqlite-mirror-writer.ts`
- Test: `tests/ts/observability/sqlite-mirror-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('creates and upserts closed_position_snapshots rows', async () => {
  const writer = new SqliteMirrorWriter(dbPath);

  await writer.writeClosedPositionSnapshots([{
    walletAddress: 'wallet-1',
    tokenMint: 'mint-earth',
    poolAddress: 'pool-1',
    positionAddress: 'pos-1',
    openedAt: '2026-04-22T13:07:07.421Z',
    closedAt: '2026-04-22T14:39:45.589Z',
    depositSol: 0.05,
    depositTokenAmount: 0,
    withdrawSol: 0,
    withdrawTokenAmount: 33100,
    feeSol: 0.0018,
    feeTokenAmount: 3390,
    pnlSol: -0.0079,
    source: 'solana-chain',
    confidence: 'exact'
  }]);

  expect(await writer.countRows('closed_position_snapshots')).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/observability/sqlite-mirror-writer.test.ts`
Expected: FAIL because the table and writer method do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
CREATE TABLE IF NOT EXISTS closed_position_snapshots (...);

writeClosedPositionSnapshots(rows: ClosedPositionSnapshot[]) {
  // insert or replace by wallet + token + closed_at + position_address
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/observability/sqlite-mirror-writer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/ts/observability/sqlite-mirror-writer.test.ts src/observability/sqlite-mirror-schema.ts src/observability/sqlite-mirror-writer.ts
git commit -m "Persist Solana closed position snapshots"
```

### Task 4: Surface Chain Truth In Dashboard History

**Files:**
- Modify: `src/dashboard/dashboard-server.ts`
- Modify: `src/dashboard/dashboard-metrics.ts`
- Test: `tests/ts/dashboard/dashboard-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('prefers closed_position_snapshots over local estimated LP history', () => {
  const result = buildHistoricalActivity({
    fills: [],
    orderFallback: [],
    decisionFallback: [],
    chainSnapshots: [{
      tokenMint: 'mint-earth',
      tokenSymbol: 'earthcoin',
      openedAt: '2026-04-22T13:07:07.421Z',
      closedAt: '2026-04-22T14:39:45.589Z',
      depositSol: 0.05,
      withdrawSol: 0,
      withdrawTokenAmount: 33100,
      feeSol: 0.0018,
      feeTokenAmount: 3390,
      pnlSol: -0.0079,
      source: 'solana-chain',
      confidence: 'exact'
    }]
  });

  expect(result[0]).toMatchObject({
    tokenMint: 'mint-earth',
    source: 'matched',
    confirmationStatus: 'ok',
    investedSol: 0.05,
    pnlSol: -0.0079
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/dashboard/dashboard-metrics.test.ts`
Expected: FAIL because dashboard history does not accept chain snapshots yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard-server.ts
const closedSnapshots = await queryAll(...from closed_position_snapshots...);

// dashboard-metrics.ts
if (input.chainSnapshots?.length) {
  // map snapshots directly into historical entries before local estimate fallback
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ts/dashboard/dashboard-metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/ts/dashboard/dashboard-metrics.test.ts src/dashboard/dashboard-server.ts src/dashboard/dashboard-metrics.ts
git commit -m "Prefer Solana chain truth in dashboard history"
```

### Task 5: Verify Earthcoin End To End

**Files:**
- Modify: `src/history/solana-closed-position-reconstructor.ts`
- Optional helper: `scripts/`

- [ ] **Step 1: Run the focused test suite**

Run:
```bash
npm test -- tests/ts/execution/solana-rpc-client.test.ts tests/ts/history/solana-closed-position-reconstructor.test.ts tests/ts/observability/sqlite-mirror-writer.test.ts tests/ts/dashboard/dashboard-metrics.test.ts
```
Expected: PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Deploy and verify cloud history**

Run:
```bash
git push origin main
```

Then verify on cloud:
```bash
curl -fsSL http://127.0.0.1:8899/api/history?page=1&pageSize=10
```

Expected:
- `earthcoin` row comes from `solana-chain`
- `pnlSol` no longer depends on `decision fallback`

- [ ] **Step 4: Commit final integration if needed**

```bash
git add .
git commit -m "Reconstruct closed LP history from Solana chain data"
```
