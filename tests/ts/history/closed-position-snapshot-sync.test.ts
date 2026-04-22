import { describe, expect, it, vi } from 'vitest';

import {
  buildClosedPositionOrderSeeds,
  syncClosedPositionSnapshots
} from '../../../src/history/closed-position-snapshot-sync';

describe('buildClosedPositionOrderSeeds', () => {
  it('pairs one open and one close order into a closed lifecycle seed', () => {
    const seeds = buildClosedPositionOrderSeeds([
      {
        tokenMint: 'mint-earth',
        tokenSymbol: 'earthcoin',
        poolAddress: 'pool-1',
        positionAddress: 'position-1',
        action: 'add-lp',
        createdAt: '2026-04-22T13:07:01.000Z',
        signature: 'sig-open'
      },
      {
        tokenMint: 'mint-earth',
        tokenSymbol: 'earthcoin',
        poolAddress: 'pool-1',
        positionAddress: 'position-1',
        action: 'withdraw-lp',
        createdAt: '2026-04-22T14:39:45.000Z',
        signature: 'sig-close'
      }
    ]);

    expect(seeds).toEqual([
      {
        tokenMint: 'mint-earth',
        tokenSymbol: 'earthcoin',
        poolAddress: 'pool-1',
        positionAddress: 'position-1',
        openedAt: '2026-04-22T13:07:01.000Z',
        closedAt: '2026-04-22T14:39:45.000Z',
        openSignature: 'sig-open',
        closeSignature: 'sig-close'
      }
    ]);
  });
});

describe('syncClosedPositionSnapshots', () => {
  it('reconstructs and writes closed position snapshots from Solana transactions', async () => {
    const snapshotsWritten: unknown[] = [];
    const result = await syncClosedPositionSnapshots({
      walletAddress: 'wallet-1',
      seeds: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          poolAddress: 'pool-1',
          positionAddress: 'position-1',
          openedAt: '2026-04-22T13:07:01.000Z',
          closedAt: '2026-04-22T14:39:45.000Z',
          openSignature: 'sig-open',
          closeSignature: 'sig-close'
        }
      ],
      rpcClient: {
        getTransaction: vi.fn(async (signature: string) => {
          if (signature === 'sig-open') {
            return {
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
                          source: 'wallet-1',
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
            };
          }

          return {
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
                          mint: 'mint-earth',
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
                          mint: 'mint-earth',
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
          };
        })
      },
      loadTokenPriceInSol: vi.fn(async () => 0.00000107745),
      writer: {
        writeClosedPositionSnapshots: vi.fn(async (rows) => {
          snapshotsWritten.push(...rows);
        })
      }
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenMint: 'mint-earth',
      tokenSymbol: 'earthcoin',
      poolAddress: 'pool-1',
      positionAddress: 'position-1',
      depositSol: 0.05,
      withdrawSol: 0,
      withdrawTokenAmount: 33102.757743,
      feeSol: 0.001827296,
      feeTokenAmount: 3387.359479,
      source: 'solana-chain',
      confidence: 'exact'
    });
    expect(result[0]?.withdrawTokenValueSol).toBeCloseTo(0.03566656633019535);
    expect(result[0]?.feeTokenValueSol).toBeCloseTo(0.00364971047064855);
    expect(result[0]?.pnlSol).toBeCloseTo(-0.008856427199156103);
    expect(snapshotsWritten).toHaveLength(1);
  });

  it('backfills missing open and close signatures from address history when orders lost them', async () => {
    const getTransaction = vi.fn(async (signature: string) => {
      if (signature === 'sig-open') {
        return {
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
                      source: 'wallet-1',
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
        };
      }

      if (signature === 'sig-close') {
        return {
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
                        mint: 'mint-earth',
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
                        mint: 'mint-earth',
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
        };
      }

      return {
        blockTime: 1_777_777_800,
        transaction: {
          signatures: [signature],
          message: {
            instructions: [
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
            'Program log: Instruction: ClosePositionIfEmpty'
          ]
        }
      };
    });

    const result = await syncClosedPositionSnapshots({
      walletAddress: 'wallet-1',
      seeds: [
        {
          tokenMint: 'mint-earth',
          tokenSymbol: 'earthcoin',
          poolAddress: 'pool-1',
          positionAddress: 'position-1',
          openedAt: '2026-04-22T13:07:01.000Z',
          closedAt: '2026-04-22T14:39:45.000Z',
          openSignature: '',
          closeSignature: ''
        }
      ],
      rpcClient: {
        getSignaturesForAddress: vi.fn(async (address: string) => {
          if (address === 'position-1') {
            return [
              { signature: 'sig-close', slot: 2, blockTime: 1_777_777_877 },
              { signature: 'sig-open', slot: 1, blockTime: 1_777_777_777 }
            ];
          }

          return [
            { signature: 'sig-open', slot: 1, blockTime: 1_777_777_777 }
          ];
        }),
        getTransaction
      },
      loadTokenPriceInSol: vi.fn(async () => 0.00000107745)
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.positionAddress).toBe('position-1');
    expect(getTransaction).toHaveBeenCalledWith('sig-open');
    expect(getTransaction).toHaveBeenCalledWith('sig-close');
  });
});
