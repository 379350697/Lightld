import { createHmac } from 'node:crypto';

import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import { JupiterNoRouteError, SOL_MINT } from '../../../src/execution/solana/jupiter-client';
import {
  JupiterV2SwapProvider,
  JupiterV1SwapProvider,
  MeteoraDirectSwapProvider,
  OkxSwapProvider,
  RaydiumSwapProvider,
  SwapProviderChain,
  type SwapExecutionProvider
} from '../../../src/execution/solana/swap-providers';

function buildSerializedV0TransactionBase64(payer = Keypair.generate().publicKey) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: []
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  return Buffer.from(transaction.serialize()).toString('base64');
}

function buildRequest(overrides: Partial<Parameters<SwapExecutionProvider['quoteExactIn']>[0]> = {}) {
  return {
    inputMint: 'token-mint',
    outputMint: SOL_MINT,
    amountLamports: '12345',
    walletPublicKey: Keypair.generate().publicKey.toBase58(),
    poolAddress: 'pool-1',
    slippageBps: 100,
    ...overrides
  };
}

describe('swap provider chain', () => {
  it('skips non-matching Meteora direct swaps without blocking later providers', async () => {
    const fallback: SwapExecutionProvider = {
      name: 'jupiter-v1',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => ({
        providerName: 'jupiter-v1' as const,
        outAmountLamports: '900',
        minOutAmountLamports: '850'
      })),
      executeExactIn: vi.fn(async () => ({
        providerName: 'jupiter-v1' as const,
        outAmountLamports: '900',
        minOutAmountLamports: '850',
        signature: 'sig-1'
      }))
    };
    const dlmmClient = {
      swapTokenToSol: vi.fn(async () => {
        throw new Error('pool does not contain token mint');
      })
    };
    const chain = new SwapProviderChain([
      new MeteoraDirectSwapProvider(dlmmClient as any),
      fallback
    ]);

    const result = await chain.quoteExactIn(buildRequest());

    expect(result.providerName).toBe('jupiter-v1');
    expect(result.providerAttempts).toMatchObject([
      { providerName: 'meteora-dlmm-direct', status: 'skipped' },
      { providerName: 'jupiter-v1', status: 'succeeded' }
    ]);
    expect(fallback.quoteExactIn).toHaveBeenCalledTimes(1);
  });

  it('skips balance-dependent providers for synthetic valuation quotes', async () => {
    const fallback: SwapExecutionProvider = {
      name: 'jupiter-v2',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => ({
        providerName: 'jupiter-v2' as const,
        outAmountLamports: '900',
        minOutAmountLamports: '850'
      })),
      executeExactIn: vi.fn()
    };
    const dlmmClient = {
      swapTokenToSol: vi.fn(async () => {
        throw new Error('should not be called');
      })
    };
    const chain = new SwapProviderChain([
      new MeteoraDirectSwapProvider(dlmmClient as any),
      fallback
    ]);

    const result = await chain.quoteExactIn(buildRequest({
      skipBalanceDependentProviders: true
    }));

    expect(result.providerName).toBe('jupiter-v2');
    expect(result.providerAttempts).toMatchObject([
      {
        providerName: 'meteora-dlmm-direct',
        status: 'skipped',
        reason: 'balance-dependent-provider-skipped-for-valuation'
      },
      { providerName: 'jupiter-v2', status: 'succeeded' }
    ]);
    expect(dlmmClient.swapTokenToSol).not.toHaveBeenCalled();
  });

  it('cools down Meteora direct simulation failures before retrying later quotes', async () => {
    let now = 0;
    const fallback: SwapExecutionProvider = {
      name: 'jupiter-v2',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => ({
        providerName: 'jupiter-v2' as const,
        outAmountLamports: '900'
      })),
      executeExactIn: vi.fn()
    };
    const dlmmClient = {
      swapTokenToSol: vi.fn(async () => {
        throw new Error('Transaction simulation failed: custom program error: 0x1 insufficient funds');
      })
    };
    const chain = new SwapProviderChain([
      new MeteoraDirectSwapProvider(dlmmClient as any),
      fallback
    ], {
      cooldownMs: 1_000,
      nowMs: () => now
    });

    await expect(chain.quoteExactIn(buildRequest())).resolves.toMatchObject({
      providerName: 'jupiter-v2'
    });
    await expect(chain.quoteExactIn(buildRequest())).resolves.toMatchObject({
      providerName: 'jupiter-v2',
      providerAttempts: [
        expect.objectContaining({ providerName: 'meteora-dlmm-direct', status: 'skipped' }),
        expect.objectContaining({ providerName: 'jupiter-v2', status: 'succeeded' })
      ]
    });

    expect(dlmmClient.swapTokenToSol).toHaveBeenCalledTimes(1);
    now = 1_001;
    await chain.quoteExactIn(buildRequest());
    expect(dlmmClient.swapTokenToSol).toHaveBeenCalledTimes(2);
  });

  it('cools down a rate-limited provider and continues to the next provider', async () => {
    let now = 0;
    const hotProvider: SwapExecutionProvider = {
      name: 'jupiter-v2',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => {
        throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
      }),
      executeExactIn: vi.fn()
    };
    const fallback: SwapExecutionProvider = {
      name: 'raydium',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => ({
        providerName: 'raydium' as const,
        outAmountLamports: '900'
      })),
      executeExactIn: vi.fn()
    };
    const chain = new SwapProviderChain([hotProvider, fallback], {
      cooldownMs: 1_000,
      nowMs: () => now
    });

    await expect(chain.quoteExactIn(buildRequest())).resolves.toMatchObject({
      providerName: 'raydium'
    });
    await expect(chain.quoteExactIn(buildRequest())).resolves.toMatchObject({
      providerName: 'raydium',
      providerAttempts: [
        expect.objectContaining({ providerName: 'jupiter-v2', status: 'skipped' }),
        expect.objectContaining({ providerName: 'raydium', status: 'succeeded' })
      ]
    });

    expect(hotProvider.quoteExactIn).toHaveBeenCalledTimes(1);
    now = 1_001;
    await chain.quoteExactIn(buildRequest());
    expect(hotProvider.quoteExactIn).toHaveBeenCalledTimes(2);
  });

  it('negative-caches no-route failures per provider and route', async () => {
    let now = 0;
    const noRouteProvider: SwapExecutionProvider = {
      name: 'jupiter-v2',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => {
        throw new JupiterNoRouteError('NO_ROUTES_FOUND', 'NO_ROUTES_FOUND');
      }),
      executeExactIn: vi.fn()
    };
    const fallback: SwapExecutionProvider = {
      name: 'jupiter-v1',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => ({
        providerName: 'jupiter-v1' as const,
        outAmountLamports: '900'
      })),
      executeExactIn: vi.fn()
    };
    const chain = new SwapProviderChain([noRouteProvider, fallback], {
      noRouteTtlMs: 5_000,
      nowMs: () => now
    });

    await chain.quoteExactIn(buildRequest());
    await chain.quoteExactIn(buildRequest());
    expect(noRouteProvider.quoteExactIn).toHaveBeenCalledTimes(1);

    now = 5_001;
    await chain.quoteExactIn(buildRequest());
    expect(noRouteProvider.quoteExactIn).toHaveBeenCalledTimes(2);
  });

  it('does not fall back after a provider reaches local transaction submission', async () => {
    const keypair = Keypair.generate();
    const fallback: SwapExecutionProvider = {
      name: 'raydium',
      enabled: () => true,
      quoteExactIn: vi.fn(),
      executeExactIn: vi.fn(async () => ({
        providerName: 'raydium' as const,
        outAmountLamports: '900',
        signature: 'fallback-sig'
      }))
    };
    const chain = new SwapProviderChain([
      new JupiterV1SwapProvider({
        getQuote: vi.fn(async () => ({
          inputMint: 'token-mint',
          outputMint: SOL_MINT,
          inAmount: '12345',
          outAmount: '900',
          otherAmountThreshold: '850',
          swapMode: 'ExactIn',
          slippageBps: 100,
          priceImpactPct: '0',
          routePlan: []
        })),
        getSwapTransaction: vi.fn(async () => ({
          swapTransaction: buildSerializedV0TransactionBase64(keypair.publicKey),
          lastValidBlockHeight: 1
        }))
      } as any),
      fallback
    ]);

    await expect(
      chain.executeExactIn(
        buildRequest({ walletPublicKey: keypair.publicKey.toBase58() }),
        {
          keypair,
          rpcClient: {} as any,
          sendRawTransaction: vi.fn(async () => {
            throw new Error('accepted signature never became visible');
          })
        }
      )
    ).rejects.toThrow('swap-provider-chain-execute-failed');

    expect(fallback.executeExactIn).not.toHaveBeenCalled();
  });

  it('continues to the next provider when preflight rejects before broadcast', async () => {
    const keypair = Keypair.generate();
    const fallback: SwapExecutionProvider = {
      name: 'raydium',
      enabled: () => true,
      quoteExactIn: vi.fn(),
      executeExactIn: vi.fn(async () => ({
        providerName: 'raydium' as const,
        outAmountLamports: '900',
        signature: 'fallback-sig'
      }))
    };
    const chain = new SwapProviderChain([
      new JupiterV1SwapProvider({
        getQuote: vi.fn(async () => ({
          inputMint: 'token-mint',
          outputMint: SOL_MINT,
          inAmount: '12345',
          outAmount: '900',
          otherAmountThreshold: '850',
          swapMode: 'ExactIn',
          slippageBps: 100,
          priceImpactPct: '0',
          routePlan: []
        })),
        getSwapTransaction: vi.fn(async () => ({
          swapTransaction: buildSerializedV0TransactionBase64(keypair.publicKey),
          lastValidBlockHeight: 1
        }))
      } as any),
      fallback
    ]);

    const result = await chain.executeExactIn(
      buildRequest({ walletPublicKey: keypair.publicKey.toBase58() }),
      {
        keypair,
        rpcClient: {} as any,
        sendRawTransaction: vi.fn(async () => {
          throw new Error('Solana RPC sendTransaction error: Transaction simulation failed: custom program error: 0x1773');
        })
      }
    );

    expect(result).toMatchObject({
      providerName: 'raydium',
      signature: 'fallback-sig',
      providerAttempts: [
        expect.objectContaining({
          providerName: 'jupiter-v1',
          status: 'failed'
        }),
        expect.objectContaining({
          providerName: 'raydium',
          status: 'succeeded'
        })
      ]
    });
    expect(fallback.executeExactIn).toHaveBeenCalledTimes(1);
  });
});

describe('JupiterV2SwapProvider', () => {
  it('orders, signs, and executes a Jupiter V2 exact-in swap', async () => {
    const keypair = Keypair.generate();
    const transactionBase64 = buildSerializedV0TransactionBase64(keypair.publicKey);
    const getOrderV2 = vi.fn(async () => ({
      requestId: 'request-1',
      inputMint: SOL_MINT,
      outputMint: 'token-mint',
      inAmount: '1000',
      outAmount: '900',
      otherAmountThreshold: '850',
      swapMode: 'ExactIn',
      slippageBps: 100,
      swapType: 'aggregator',
      priceImpactPct: '0',
      routePlan: [],
      swapTransaction: transactionBase64,
      lastValidBlockHeight: 123
    }));
    const executeOrderV2 = vi.fn(async () => ({
      status: 'Success',
      signature: 'jupiter-v2-sig'
    }));
    const provider = new JupiterV2SwapProvider({
      getOrderV2,
      executeOrderV2
    } as any);

    const result = await provider.executeExactIn(
      buildRequest({
        inputMint: SOL_MINT,
        outputMint: 'token-mint',
        walletPublicKey: keypair.publicKey.toBase58()
      }),
      {
        keypair,
        rpcClient: {} as any,
        sendRawTransaction: vi.fn()
      }
    );

    expect(result).toMatchObject({
      providerName: 'jupiter-v2',
      signature: 'jupiter-v2-sig',
      outAmountLamports: '900',
      minOutAmountLamports: '850'
    });
    expect(executeOrderV2).toHaveBeenCalledWith({
      requestId: 'request-1',
      signedTransaction: expect.any(String)
    });
  });
});

describe('RaydiumSwapProvider', () => {
  it('computes, signs, and submits Raydium swap-base-in transactions', async () => {
    const keypair = Keypair.generate();
    const requests: Array<{ url: string; body?: unknown }> = [];
    const transactionBase64 = buildSerializedV0TransactionBase64(keypair.publicKey);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });

      if (url.includes('/compute/swap-base-in')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            outputAmount: '900',
            otherAmountThreshold: '850',
            priceImpactPct: 0
          }
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        success: true,
        data: [{ transaction: transactionBase64 }]
      }), { status: 200 });
    });
    const sendRawTransaction = vi.fn(async () => 'raydium-sig');
    const provider = new RaydiumSwapProvider({
      apiUrl: 'https://raydium.example',
      fetchImpl
    });

    const result = await provider.executeExactIn(
      buildRequest({ walletPublicKey: keypair.publicKey.toBase58() }),
      {
        keypair,
        rpcClient: {} as any,
        sendRawTransaction
      }
    );

    expect(result).toMatchObject({
      providerName: 'raydium',
      signature: 'raydium-sig',
      outAmountLamports: '900',
      minOutAmountLamports: '850'
    });
    expect(requests[0].url).toContain('/compute/swap-base-in');
    expect(requests[1].url).toContain('/transaction/swap-base-in');
    expect(requests[1].body).toMatchObject({
      wallet: keypair.publicKey.toBase58(),
      txVersion: 'V0',
      wrapSol: false,
      unwrapSol: true
    });
    expect(sendRawTransaction).toHaveBeenCalledWith(expect.any(String));
  });

  it('refuses Raydium multi-transaction responses before sending anything', async () => {
    const keypair = Keypair.generate();
    const transactionBase64 = buildSerializedV0TransactionBase64(keypair.publicKey);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/compute/swap-base-in')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            outputAmount: '900',
            otherAmountThreshold: '850'
          }
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        success: true,
        data: [
          { transaction: transactionBase64 },
          { transaction: transactionBase64 }
        ]
      }), { status: 200 });
    });
    const sendRawTransaction = vi.fn(async () => 'raydium-sig');
    const provider = new RaydiumSwapProvider({
      apiUrl: 'https://raydium.example',
      fetchImpl
    });

    await expect(
      provider.executeExactIn(
        buildRequest({ walletPublicKey: keypair.publicKey.toBase58() }),
        {
          keypair,
          rpcClient: {} as any,
          sendRawTransaction
        }
      )
    ).rejects.toThrow('refusing partial multi-transaction submission');

    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe('OkxSwapProvider', () => {
  it('is disabled unless all OKX credentials are present', async () => {
    const fallback: SwapExecutionProvider = {
      name: 'jupiter-v1',
      enabled: () => true,
      quoteExactIn: vi.fn(async () => ({
        providerName: 'jupiter-v1' as const,
        outAmountLamports: '900'
      })),
      executeExactIn: vi.fn()
    };
    const chain = new SwapProviderChain([
      new OkxSwapProvider({ apiKey: 'key-only' }),
      fallback
    ]);

    const result = await chain.quoteExactIn(buildRequest());

    expect(result.providerName).toBe('jupiter-v1');
    expect(result.providerAttempts).toMatchObject([
      { providerName: 'okx', status: 'skipped', reason: 'okx-credentials-missing' },
      { providerName: 'jupiter-v1', status: 'succeeded' }
    ]);
  });

  it('signs OKX requests and builds Solana instructions for execution', async () => {
    const keypair = Keypair.generate();
    const recipient = Keypair.generate();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string>;
      const requestPath = `${url.pathname}${url.search}`;
      const expectedSignature = createHmac('sha256', 'secret')
        .update(`${headers['OK-ACCESS-TIMESTAMP']}GET${requestPath}`)
        .digest('base64');

      expect(headers).toMatchObject({
        'OK-ACCESS-KEY': 'api-key',
        'OK-ACCESS-PASSPHRASE': 'passphrase',
        'OK-ACCESS-SIGN': expectedSignature
      });
      expect(url.searchParams.get('chainIndex')).toBe('501');
      expect(url.searchParams.get('fromTokenAddress')).toBe('token-mint');
      expect(url.searchParams.get('toTokenAddress')).toBe('11111111111111111111111111111111');

      return new Response(JSON.stringify({
        code: '0',
        data: {
          addressLookupTableAccount: [],
          instructionLists: [
            {
              programId: '11111111111111111111111111111111',
              accounts: [
                {
                  pubkey: keypair.publicKey.toBase58(),
                  isSigner: true,
                  isWritable: true
                },
                {
                  pubkey: recipient.publicKey.toBase58(),
                  isSigner: false,
                  isWritable: true
                }
              ],
              data: ''
            }
          ],
          routerResult: {
            toTokenAmount: '900',
            priceImpactPercent: '0'
          },
          tx: {
            minReceiveAmount: '850'
          }
        }
      }), { status: 200 });
    });
    const sendRawTransaction = vi.fn(async () => 'okx-sig');
    const provider = new OkxSwapProvider({
      apiUrl: 'https://okx.example',
      apiKey: 'api-key',
      secretKey: 'secret',
      passphrase: 'passphrase',
      fetchImpl
    });

    const result = await provider.executeExactIn(
      buildRequest({
        walletPublicKey: keypair.publicKey.toBase58(),
        outputMint: SOL_MINT
      }),
      {
        keypair,
        rpcClient: {
          getLatestBlockhash: async () => ({
            value: {
              blockhash: '11111111111111111111111111111111',
              lastValidBlockHeight: 1
            }
          }),
          getAddressLookupTable: vi.fn()
        } as any,
        sendRawTransaction
      }
    );

    expect(result).toMatchObject({
      providerName: 'okx',
      signature: 'okx-sig',
      outAmountLamports: '900',
      minOutAmountLamports: '850'
    });
    expect(sendRawTransaction).toHaveBeenCalledWith(expect.any(String));
  });
});
