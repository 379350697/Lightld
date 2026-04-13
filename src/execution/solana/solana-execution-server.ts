import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Keypair } from '@solana/web3.js';

import { z } from 'zod';

import { validateIntentAllowlist } from '../../risk/instruction-allowlist.ts';
import { JupiterClient, LAMPORTS_PER_SOL, SOL_MINT } from './jupiter-client.ts';
import { SolanaRpcClient } from './solana-rpc-client.ts';
import { signSwapTransaction } from './solana-transaction-signer.ts';
import { MeteoraDlmmClient } from './meteora-dlmm-client.ts';
import type { LiveBroadcastResult } from '../live-broadcaster.ts';
import type { LiveConfirmationResult } from '../live-confirmation-provider.ts';

const BroadcastRequestSchema = z.object({
  intent: z.object({
    intent: z.object({
      strategyId: z.string().min(1),
      poolAddress: z.string().min(1),
      outputSol: z.number().finite().positive(),
      createdAt: z.string().min(1),
      idempotencyKey: z.string().min(1),
      side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).optional(),
      tokenMint: z.string().min(1).optional()
    }),
    signerId: z.string().min(1),
    signedAt: z.string().min(1),
    signature: z.string().min(1)
  })
});

const ConfirmationRequestSchema = z.object({
  submissionId: z.string().min(1),
  confirmationSignature: z.string().optional()
});

type SolanaExecutionServerOptions = {
  host: string;
  port: number;
  keypair: Keypair;
  rpcClient: SolanaRpcClient;
  jupiterClient: JupiterClient;
  dlmmClient?: MeteoraDlmmClient;
  authToken?: string;
  maxOutputSol?: number;
  defaultSlippageBps?: number;
  jitoTipLamports?: number;
};

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(`${message}\n`);
}

function hasExpectedBearerToken(request: IncomingMessage, authToken: string | undefined) {
  if (!authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${authToken}`;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function createSolanaExecutionServer(options: SolanaExecutionServerOptions) {
  const {
    keypair,
    rpcClient,
    jupiterClient,
    defaultSlippageBps = 100
  } = options;
  const walletPublicKey = keypair.publicKey.toBase58();
  let server: Server | undefined;
  let origin = '';

  return {
    get origin() {
      return origin;
    },
    async start() {
      if (server) {
        return;
      }

      server = createServer(async (request, response) => {
        try {
          // Health check
          if (request.method === 'GET' && request.url === '/health') {
            let solBalance = 0;

            try {
              const lamports = await rpcClient.getBalance(walletPublicKey);
              solBalance = lamports / LAMPORTS_PER_SOL;
            } catch {
              // Non-fatal for health check
            }

            writeJson(response, 200, {
              status: 'ok',
              wallet: walletPublicKey,
              solBalance
            });
            return;
          }

          if (!hasExpectedBearerToken(request, options.authToken)) {
            writeText(response, 401, 'unauthorized');
            return;
          }

          // Broadcast — receive intent, build Jupiter swap, sign, send to Solana
          if (request.method === 'POST' && request.url === '/broadcast') {
            const body = await readBody(request);
            const payload = BroadcastRequestSchema.parse(JSON.parse(body));
            const intent = payload.intent.intent;

            // Allowlist check
            if (options.maxOutputSol !== undefined) {
              const allowlistResult = validateIntentAllowlist(intent, {
                maxOutputSol: options.maxOutputSol
              });

              if (!allowlistResult.allowed) {
                writeJson(response, 403, {
                  error: allowlistResult.reason,
                  detail: allowlistResult.detail
                });
                return;
              }
            }

            const side = intent.side ?? 'buy';
            const tokenMint = intent.tokenMint ?? intent.poolAddress;

            let signedBase64: string;

            if (side === 'buy' || side === 'sell') {
              // Get Jupiter quote
              const quoteParams = side === 'buy'
                ? jupiterClient.buildBuyQuoteParams(tokenMint, intent.outputSol, defaultSlippageBps)
                : jupiterClient.buildSellQuoteParams(tokenMint, intent.outputSol, defaultSlippageBps);

              const quoteResponse = await jupiterClient.getQuote(quoteParams);

              // Get swap transaction from Jupiter
              const swapResponse = await jupiterClient.getSwapTransaction(
                quoteResponse,
                walletPublicKey,
                { jitoTipLamports: options.jitoTipLamports }
              );

              // Sign the transaction with local keypair
              signedBase64 = signSwapTransaction(
                swapResponse.swapTransaction,
                keypair
              );
            } else {
              if (!options.dlmmClient) {
                throw new Error('DLMM client not configured');
              }

              let txParams: any;

              let signers: Keypair[] = [keypair];

              if (side === 'add-lp') {
                const result = await options.dlmmClient.addLiquidityByStrategy(
                  keypair.publicKey,
                  intent.poolAddress,
                  intent.outputSol
                );
                txParams = Array.isArray(result.transaction) ? result.transaction[0] : result.transaction;
                if (result.newPositionKeypair) {
                  signers.push(result.newPositionKeypair);
                }
              } else if (side === 'withdraw-lp') {
                txParams = await options.dlmmClient.removeLiquidity(keypair.publicKey, intent.poolAddress);
              } else if (side === 'claim-fee') {
                txParams = await options.dlmmClient.claimFee(keypair.publicKey, intent.poolAddress);
              } else {
                throw new Error(`Unsupported side: ${side}`);
              }

              if (Array.isArray(txParams)) {
                txParams = txParams[0]; // just take first
              }

              const { value: blockhash } = await rpcClient.getLatestBlockhash();
              txParams.recentBlockhash = blockhash.blockhash;
              txParams.feePayer = keypair.publicKey;
              txParams.sign(...signers); 
              signedBase64 = txParams.serialize().toString('base64');
            }

            // Send to Solana RPC
            const txSignature = await rpcClient.sendRawTransaction(signedBase64);

            const result: LiveBroadcastResult = {
              status: 'submitted',
              submissionId: txSignature,
              idempotencyKey: intent.idempotencyKey,
              confirmationSignature: txSignature
            };

            writeJson(response, 200, result);
            return;
          }

          // Confirmation — poll Solana RPC for transaction status
          if (request.method === 'POST' && request.url === '/confirmation') {
            const body = await readBody(request);
            const payload = ConfirmationRequestSchema.parse(JSON.parse(body));
            const signature = payload.confirmationSignature ?? payload.submissionId;

            try {
              const statuses = await rpcClient.getSignatureStatuses([signature]);
              const status = statuses.value[0];
              const checkedAt = new Date().toISOString();

              if (!status) {
                const result: LiveConfirmationResult = {
                  submissionId: payload.submissionId,
                  confirmationSignature: signature,
                  status: 'submitted',
                  finality: 'unknown',
                  checkedAt
                };
                writeJson(response, 200, result);
                return;
              }

              if (status.err) {
                const result: LiveConfirmationResult = {
                  submissionId: payload.submissionId,
                  confirmationSignature: signature,
                  status: 'failed',
                  finality: 'failed',
                  checkedAt,
                  reason: JSON.stringify(status.err)
                };
                writeJson(response, 200, result);
                return;
              }

              const finality = status.confirmationStatus ?? 'unknown';
              const isConfirmed = finality === 'confirmed' || finality === 'finalized';
              const result: LiveConfirmationResult = {
                submissionId: payload.submissionId,
                confirmationSignature: signature,
                status: isConfirmed ? 'confirmed' : 'submitted',
                finality: finality as LiveConfirmationResult['finality'],
                checkedAt
              };
              writeJson(response, 200, result);
            } catch (error) {
              const result: LiveConfirmationResult = {
                submissionId: payload.submissionId,
                confirmationSignature: signature,
                status: 'unknown',
                finality: 'unknown',
                checkedAt: new Date().toISOString(),
                reason: error instanceof Error ? error.message : String(error)
              };
              writeJson(response, 200, result);
            }
            return;
          }

          // Account state — query wallet SOL and token balances from RPC
          if (request.method === 'GET' && request.url === '/account-state') {
            const lamports = await rpcClient.getBalance(walletPublicKey);
            const walletSol = lamports / LAMPORTS_PER_SOL;

            let walletTokens: { mint: string; symbol: string; amount: number }[] = [];

            try {
              const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
              walletTokens = tokenAccounts.map((account) => {
                const info = account.account.data.parsed.info;
                return {
                  mint: info.mint,
                  symbol: '',
                  amount: info.tokenAmount.uiAmount ?? 0
                };
              });
            } catch {
              // Token accounts query may fail on free RPC
            }

            writeJson(response, 200, {
              walletSol,
              journalSol: walletSol,
              walletTokens,
              journalTokens: walletTokens,
              fills: []
            });
            return;
          }

          writeText(response, 404, 'not-found');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(response, 400, { error: message });
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, options.host, () => resolve());
      });

      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Unable to determine Solana execution server address');
      }

      origin = `http://${options.host}:${address.port}`;
    },
    async stop() {
      if (!server) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      server = undefined;
      origin = '';
    }
  };
}
