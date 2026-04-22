import { describe, expect, it } from 'vitest';

import {
  extractLifecycleEventsFromTransaction,
  reconstructClosedPositionSnapshot,
  type SolanaClosedPositionLifecycleEvent
} from '../../../src/history/solana-closed-position-reconstructor';

function buildEvent(
  overrides: Partial<SolanaClosedPositionLifecycleEvent>
): SolanaClosedPositionLifecycleEvent {
  return {
    signature: 'sig-1',
    recordedAt: '2026-04-22T14:39:45.589Z',
    kind: 'withdraw',
    walletAddress: 'wallet-1',
    tokenMint: 'mint-earth',
    tokenSymbol: 'earthcoin',
    poolAddress: 'pool-1',
    positionAddress: 'position-1',
    solAmount: 0,
    tokenAmount: 0,
    tokenValueSol: 0,
    ...overrides
  };
}

describe('reconstructClosedPositionSnapshot', () => {
  it('extracts open, withdraw, and claim-fee events from parsed Solana transactions', () => {
    const walletAddress = 'wallet-1';
    const tokenMint = 'mint-earth';
    const tokenPriceInSol = 0.00000107745;

    const openEvents = extractLifecycleEventsFromTransaction({
      walletAddress,
      tokenMint,
      tokenSymbol: 'earthcoin',
      tokenPriceInSol,
      transaction: {
        blockTime: 1_777_777_777,
        transaction: {
          signatures: ['sig-open'],
          message: {
            instructions: [
              {
                program: 'system',
                parsed: {
                  type: 'transfer',
                  info: {
                    source: walletAddress,
                    lamports: 50_000_000
                  }
                }
              },
              {
                program: 'meteora',
                parsed: {
                  info: {
                    pool: 'pool-1',
                    position: 'position-1'
                  }
                }
              }
            ]
          }
        },
        meta: {
          logMessages: [
            'Program log: Instruction: AddLiquidityByStrategy2'
          ]
        }
      }
    });

    expect(openEvents).toEqual([
      {
        signature: 'sig-open',
        recordedAt: '2026-05-03T03:09:37.000Z',
        kind: 'open',
        walletAddress,
        tokenMint,
        tokenSymbol: 'earthcoin',
        poolAddress: 'pool-1',
        positionAddress: 'position-1',
        solAmount: 0.05,
        tokenAmount: 0,
        tokenValueSol: 0
      }
    ]);

    const closeEvents = extractLifecycleEventsFromTransaction({
      walletAddress,
      tokenMint,
      tokenSymbol: 'earthcoin',
      tokenPriceInSol,
      transaction: {
        blockTime: 1_777_777_877,
        transaction: {
          signatures: ['sig-close'],
          message: {
            instructions: [
              { program: 'spl-associated-token-account', parsed: { type: 'create' } },
              {
                program: 'meteora',
                parsed: {
                  info: {
                    pool: 'pool-1',
                    position: 'position-1'
                  }
                }
              },
              {
                program: 'meteora',
                parsed: {
                  info: {
                    pool: 'pool-1',
                    position: 'position-1'
                  }
                }
              }
            ]
          }
        },
        meta: {
          logMessages: [
            'Program log: Instruction: RemoveLiquidityByRange2',
            'Program log: Instruction: ClaimFee2'
          ],
          innerInstructions: [
            {
              index: 1,
              instructions: [
                {
                  program: 'spl-token',
                  parsed: {
                    type: 'transferChecked',
                    info: {
                      mint: tokenMint,
                      tokenAmount: {
                        uiAmount: 33102.757743
                      }
                    }
                  }
                }
              ]
            },
            {
              index: 2,
              instructions: [
                {
                  program: 'spl-token',
                  parsed: {
                    type: 'transferChecked',
                    info: {
                      mint: tokenMint,
                      tokenAmount: {
                        uiAmount: 3387.359479
                      }
                    }
                  }
                },
                {
                  program: 'spl-token',
                  parsed: {
                    type: 'transferChecked',
                    info: {
                      mint: 'So11111111111111111111111111111111111111112',
                      tokenAmount: {
                        uiAmount: 0.001827296
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    });

    expect(closeEvents).toHaveLength(2);
    expect(closeEvents[0]).toMatchObject({
      signature: 'sig-close',
      kind: 'withdraw',
      poolAddress: 'pool-1',
      positionAddress: 'position-1',
      solAmount: 0,
      tokenAmount: 33102.757743
    });
    expect(closeEvents[0]?.tokenValueSol).toBeCloseTo(0.03566656633019535);
    expect(closeEvents[1]).toMatchObject({
      signature: 'sig-close',
      kind: 'claim-fee',
      poolAddress: 'pool-1',
      positionAddress: 'position-1',
      solAmount: 0.001827296,
      tokenAmount: 3387.359479
    });
    expect(closeEvents[1]?.tokenValueSol).toBeCloseTo(0.00364971047064855);
  });

  it('reconstructs a closed LP lifecycle from open, fee, and withdraw events', () => {
    const result = reconstructClosedPositionSnapshot({
      walletAddress: 'wallet-1',
      tokenMint: 'mint-earth',
      events: [
        buildEvent({
          signature: 'open-1',
          recordedAt: '2026-04-22T13:07:07.421Z',
          kind: 'open',
          solAmount: 0.05,
          tokenAmount: 0,
          tokenValueSol: 0
        }),
        buildEvent({
          signature: 'fee-1',
          recordedAt: '2026-04-22T14:00:00.000Z',
          kind: 'claim-fee',
          solAmount: 0.0018,
          tokenAmount: 3390,
          tokenValueSol: 0.0032
        }),
        buildEvent({
          signature: 'close-1',
          recordedAt: '2026-04-22T14:39:45.589Z',
          kind: 'withdraw',
          solAmount: 0,
          tokenAmount: 33100,
          tokenValueSol: 0.0316
        })
      ]
    });

    expect(result).toMatchObject({
      walletAddress: 'wallet-1',
      tokenMint: 'mint-earth',
      tokenSymbol: 'earthcoin',
      poolAddress: 'pool-1',
      positionAddress: 'position-1',
      openedAt: '2026-04-22T13:07:07.421Z',
      closedAt: '2026-04-22T14:39:45.589Z',
      depositSol: 0.05,
      depositTokenAmount: 0,
      withdrawSol: 0,
      withdrawTokenAmount: 33100,
      withdrawTokenValueSol: 0.0316,
      feeSol: 0.0018,
      feeTokenAmount: 3390,
      feeTokenValueSol: 0.0032,
      source: 'solana-chain',
      confidence: 'exact'
    });
    expect(result?.pnlSol).toBeCloseTo(-0.0134);
  });

  it('returns null when the lifecycle is missing either open or withdraw truth', () => {
    expect(reconstructClosedPositionSnapshot({
      walletAddress: 'wallet-1',
      tokenMint: 'mint-earth',
      events: [buildEvent({ kind: 'claim-fee' })]
    })).toBeNull();
  });
});
