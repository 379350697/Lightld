import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Keypair } from '@solana/web3.js';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../../runtime/atomic-file.ts';
import { validateIntentAllowlist } from '../../risk/instruction-allowlist.ts';
import { JupiterClient, LAMPORTS_PER_SOL, SOL_MINT } from './jupiter-client.ts';
import { SolanaRpcClient } from './solana-rpc-client.ts';
import { signSwapTransaction } from './solana-transaction-signer.ts';
import { MeteoraDlmmClient } from './meteora-dlmm-client.ts';
import {
  signedIntentIdempotencyFingerprint,
  verifySignedIntent
} from '../signed-intent-verifier.ts';
import type { LiveBroadcastResult } from '../live-broadcaster.ts';
import type { LiveConfirmationResult } from '../live-confirmation-provider.ts';
import { collectLiveQuote } from '../live-quote-service.ts';
import {
  hasExpectedBearerToken,
  readBody,
  writeJson,
  writeText
} from '../../shared/http-server.ts';

const BroadcastRequestSchema = z.object({
  intent: z.object({
    intent: z.object({
      strategyId: z.string().min(1),
      poolAddress: z.string().min(1),
      outputSol: z.number().finite().positive(),
      createdAt: z.string().min(1),
      idempotencyKey: z.string().min(1),
      side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).optional(),
      tokenMint: z.string().min(1).optional(),
      fullPositionExit: z.boolean().optional(),
      liquidateResidualTokenToSol: z.boolean().optional()
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

const BroadcastResultSchema = z.object({
  status: z.literal('submitted'),
  submissionId: z.string(),
  idempotencyKey: z.string(),
  confirmationSignature: z.string().optional(),
  submissionIds: z.array(z.string()).optional(),
  confirmationSignatures: z.array(z.string()).optional(),
  batchStatus: z.enum(['complete', 'partial']).optional(),
  reason: z.string().optional()
});

const SubmissionEntrySchema = z.object({
  idempotencyKey: z.string().min(1),
  signedIntentFingerprint: z.string().min(1),
  signedIntent: BroadcastRequestSchema.shape.intent,
  status: z.enum(['pending', 'submitted']).default('submitted'),
  result: BroadcastResultSchema.optional(),
  receivedAt: z.string().min(1),
  updatedAt: z.string().min(1).optional()
});

const SubmissionStoreSchema = z.object({
  submissions: z.array(SubmissionEntrySchema)
});

type SubmissionStore = z.infer<typeof SubmissionStoreSchema>;
type SignedBroadcastIntent = z.infer<typeof BroadcastRequestSchema>['intent'];

type SolanaExecutionServerOptions = {
  host: string;
  port: number;
  stateRootDir?: string;
  keypair: Keypair;
  rpcClient: SolanaRpcClient;
  jupiterClient: JupiterClient;
  dlmmClient?: MeteoraDlmmClient;
  authToken?: string;
  expectedSignerPublicKeys?: string[];
  maxOutputSol?: number;
  defaultSlippageBps?: number;
  jitoTipLamports?: number;
};

type BroadcastLogPayload = {
  event: 'solana-execution-broadcast';
  recordedAt: string;
  strategyId: string;
  idempotencyKey: string;
  side: string;
  poolAddress: string;
  tokenMint?: string;
  outputSol: number;
  result: 'submitted' | 'partial' | 'failed';
  acceptedSignatureCount: number;
  buildMs?: number;
  quoteMs?: number;
  swapBuildMs?: number;
  signMs?: number;
  blockhashMs?: number;
  sendTxMs: number[];
  totalMs: number;
  reason?: string;
};

const RESIDUAL_BALANCE_CHECK_ATTEMPTS = 6;
const RESIDUAL_BALANCE_CHECK_DELAY_MS = 2_000;
const WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS = 6;
const WITHDRAW_CONFIRMATION_WAIT_DELAY_MS = 2_000;
const RESIDUAL_TOKEN_SWEEP_PASSES = 3;
const RESIDUAL_TOKEN_MIN_SOL_VALUE = 0.1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findTokenLamportsWithRetry(
  rpcClient: SolanaRpcClient,
  walletPublicKey: string,
  tokenMint: string
) {
  let tokenLamports = 0;

  for (let attempt = 0; attempt < RESIDUAL_BALANCE_CHECK_ATTEMPTS; attempt += 1) {
    const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
    const tokenAccount = tokenAccounts.find(
      (account) => account.account.data.parsed.info.mint === tokenMint
    );
    tokenLamports = tokenAccount
      ? Number(tokenAccount.account.data.parsed.info.tokenAmount.amount)
      : 0;

    if (tokenLamports > 0) {
      return tokenLamports;
    }

    if (attempt < RESIDUAL_BALANCE_CHECK_ATTEMPTS - 1) {
      await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
    }
  }

  return tokenLamports;
}

async function waitForConfirmedSignatures(
  rpcClient: SolanaRpcClient,
  signatures: string[]
) {
  if (signatures.length === 0) {
    return true;
  }

  for (let attempt = 0; attempt < WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS; attempt += 1) {
    const statuses = await rpcClient.getSignatureStatuses(signatures);
    const allConfirmed = statuses.value.every(
      (status) =>
        status &&
        !status.err &&
        (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    );

    if (allConfirmed) {
      return true;
    }

    if (attempt < WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS - 1) {
      await sleep(WITHDRAW_CONFIRMATION_WAIT_DELAY_MS);
    }
  }

  return false;
}

async function resolveTokenCurrentValueSol(input: {
  jupiterClient: JupiterClient;
  mint: string;
  amountLamports: number;
  defaultSlippageBps: number;
}) {
  if (!Number.isFinite(input.amountLamports) || input.amountLamports <= 0) {
    return undefined;
  }

  const quoteResponse = await input.jupiterClient.getQuote(
    input.jupiterClient.buildSellQuoteParams(input.mint, input.amountLamports, input.defaultSlippageBps)
  );
  const outAmountLamports = Number(quoteResponse.outAmount ?? 0);
  const outAmountSol = outAmountLamports / LAMPORTS_PER_SOL;
  return Number.isFinite(outAmountSol) && outAmountSol >= 0 ? outAmountSol : undefined;
}

const ACCOUNT_STATE_TOKEN_VALUE_CACHE_TTL_MS = 5 * 60_000;
const ACCOUNT_STATE_TOKEN_VALUE_MAX_QUOTES_PER_REQUEST = 3;

type TokenValueCacheEntry = {
  currentValueSol?: number;
  updatedAt: number;
};

function readFreshTokenValueCache(
  cache: Map<string, TokenValueCacheEntry>,
  mint: string,
  now = Date.now()
) {
  const entry = cache.get(mint);
  if (!entry) {
    return undefined;
  }

  if (now - entry.updatedAt > ACCOUNT_STATE_TOKEN_VALUE_CACHE_TTL_MS) {
    return undefined;
  }

  return entry.currentValueSol;
}

function isRateLimitLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('429')
    || message.includes('rate-limited')
    || message.includes('no endpoint available');
}

async function liquidateResidualTokensToSol(input: {
  rpcClient: SolanaRpcClient;
  jupiterClient: JupiterClient;
  keypair: Keypair;
  walletPublicKey: string;
  defaultSlippageBps: number;
  jitoTipLamports?: number;
  sendTxMs: number[];
}) {
  const soldMints = new Set<string>();

  for (let pass = 0; pass < RESIDUAL_TOKEN_SWEEP_PASSES; pass += 1) {
    const tokenAccounts = await input.rpcClient.getTokenAccountsByOwner(input.walletPublicKey);
    const sellable = tokenAccounts
      .map((account) => ({
        mint: account.account.data.parsed.info.mint as string,
        amount: Number(account.account.data.parsed.info.tokenAmount.amount)
      }))
      .filter((token) => token.mint !== SOL_MINT && token.amount > 0 && !soldMints.has(token.mint));

    if (sellable.length === 0) {
      return false;
    }

    let soldAny = false;

    for (const token of sellable) {
      try {
        const quoteResponse = await input.jupiterClient.getQuote(
          input.jupiterClient.buildSellQuoteParams(token.mint, token.amount, input.defaultSlippageBps)
        );
        const outAmountLamports = Number(quoteResponse.outAmount ?? 0);
        const outAmountSol = outAmountLamports / LAMPORTS_PER_SOL;

        if (!Number.isFinite(outAmountSol) || outAmountSol < RESIDUAL_TOKEN_MIN_SOL_VALUE) {
          soldMints.add(token.mint);
          continue;
        }

        const swapResponse = await input.jupiterClient.getSwapTransaction(
          quoteResponse,
          input.walletPublicKey,
          { jitoTipLamports: input.jitoTipLamports }
        );
        const residualSignedBase64 = signSwapTransaction(
          swapResponse.swapTransaction,
          input.keypair
        );
        const residualSendStartedAt = Date.now();
        await input.rpcClient.sendRawTransaction(residualSignedBase64);
        input.sendTxMs.push(durationMs(residualSendStartedAt));
        soldMints.add(token.mint);
        soldAny = true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[Execution] Residual token liquidation skipped for ${token.mint}: ${reason}`);
      }
    }

    if (!soldAny) {
      return false;
    }

    await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
  }

  return true;
}

function durationMs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

function logBroadcastOutcome(payload: BroadcastLogPayload) {
  const line = JSON.stringify(payload);

  if (payload.result === 'failed') {
    console.error(line);
    return;
  }

  if (payload.result === 'partial') {
    console.warn(line);
    return;
  }

  console.info(line);
}

class SolanaExecutionStateStore {
  private readonly path: string | undefined;
  private memoryStore: SubmissionStore = { submissions: [] };

  constructor(rootDir: string | undefined) {
    this.path = rootDir ? join(rootDir, 'solana-execution-submissions.json') : undefined;
  }

  async read() {
    if (!this.path) {
      return this.memoryStore;
    }

    return (await readJsonIfExists(this.path, SubmissionStoreSchema)) ?? {
      submissions: []
    } satisfies SubmissionStore;
  }

  async write(store: SubmissionStore) {
    const parsed = SubmissionStoreSchema.parse(store);

    if (!this.path) {
      this.memoryStore = parsed;
      return;
    }

    await writeJsonAtomically(this.path, parsed);
  }
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
  const store = new SolanaExecutionStateStore(options.stateRootDir);
  const expectedSignerPublicKeys = options.expectedSignerPublicKeys ?? [];
  const idempotencyLocks = new Map<string, Promise<void>>();
  const tokenValueCache = new Map<string, TokenValueCacheEntry>();
  const toTransactionBatch = (txParams: unknown) => Array.isArray(txParams) ? txParams : [txParams];
  const buildSubmittedBroadcastResult = (input: {
    idempotencyKey: string;
    signatures: string[];
    batchStatus?: 'complete' | 'partial';
    reason?: string;
  }): LiveBroadcastResult => ({
    status: 'submitted',
    submissionId: input.signatures[input.signatures.length - 1] ?? '',
    idempotencyKey: input.idempotencyKey,
    confirmationSignature: input.signatures[input.signatures.length - 1],
    submissionIds: input.signatures,
    confirmationSignatures: input.signatures,
    batchStatus: input.batchStatus ?? 'complete',
    reason: input.reason
  });
  const withIdempotencyLock = async <T>(idempotencyKey: string, action: () => Promise<T>): Promise<T> => {
    const prior = idempotencyLocks.get(idempotencyKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prior.catch(() => undefined).then(() => current);
    idempotencyLocks.set(idempotencyKey, chained);

    await prior.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (idempotencyLocks.get(idempotencyKey) === chained) {
        idempotencyLocks.delete(idempotencyKey);
      }
    }
  };

  const reserveIdempotencySubmission = async (signedIntent: SignedBroadcastIntent) => {
    const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
    const idempotencyKey = signedIntent.intent.idempotencyKey;
    const snapshot = await store.read();
    const existing = snapshot.submissions.find(
      (submission) => submission.idempotencyKey === idempotencyKey
    );

    if (existing) {
      if (existing.signedIntentFingerprint !== signedIntentFingerprint) {
        return {
          status: 'conflict' as const
        };
      }

      if (existing.status === 'submitted' && existing.result) {
        return {
          status: 'replay' as const,
          result: existing.result
        };
      }

      return {
        status: 'pending' as const
      };
    }

    const now = new Date().toISOString();
    await store.write({
      submissions: [
        ...snapshot.submissions,
        {
          idempotencyKey,
          signedIntentFingerprint,
          signedIntent,
          status: 'pending',
          receivedAt: now,
          updatedAt: now
        }
      ]
    });

    return {
      status: 'reserved' as const
    };
  };

  const completeIdempotencySubmission = async (
    signedIntent: SignedBroadcastIntent,
    result: LiveBroadcastResult
  ) => {
    const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
    const idempotencyKey = signedIntent.intent.idempotencyKey;
    const snapshot = await store.read();
    const now = new Date().toISOString();
    const parsedResult = BroadcastResultSchema.parse(result);
    let replaced = false;
    const submissions = snapshot.submissions.map((submission) => {
      if (submission.idempotencyKey !== idempotencyKey) {
        return submission;
      }

      replaced = true;
      return {
        ...submission,
        signedIntentFingerprint,
        signedIntent,
        status: 'submitted' as const,
        result: parsedResult,
        updatedAt: now
      };
    });

    if (!replaced) {
      submissions.push({
        idempotencyKey,
        signedIntentFingerprint,
        signedIntent,
        status: 'submitted',
        result: parsedResult,
        receivedAt: now,
        updatedAt: now
      });
    }

    await store.write({ submissions });
  };

  const releaseIdempotencyReservation = async (signedIntent: SignedBroadcastIntent) => {
    const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
    const idempotencyKey = signedIntent.intent.idempotencyKey;
    const snapshot = await store.read();

    await store.write({
      submissions: snapshot.submissions.filter((submission) => !(
        submission.idempotencyKey === idempotencyKey
        && submission.signedIntentFingerprint === signedIntentFingerprint
        && submission.status === 'pending'
      ))
    });
  };

  const writeStoredBroadcastResult = async (
    response: ServerResponse,
    signedIntent: SignedBroadcastIntent,
    result: LiveBroadcastResult
  ) => {
    await completeIdempotencySubmission(signedIntent, result);
    writeJson(response, 200, result);
  };

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
            verifySignedIntent(payload.intent, expectedSignerPublicKeys);
            const intent = payload.intent.intent;
            const broadcastStartedAt = Date.now();

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

            await withIdempotencyLock(intent.idempotencyKey, async () => {
              const reservation = await reserveIdempotencySubmission(payload.intent);

              if (reservation.status === 'conflict') {
                writeJson(response, 409, {
                  error: 'idempotency key conflict',
                  detail: `Existing submission for ${intent.idempotencyKey} used a different signed intent`
                });
                return;
              }

              if (reservation.status === 'pending') {
                writeJson(response, 409, {
                  error: 'idempotency key pending',
                  detail: `Submission ${intent.idempotencyKey} is reserved but has no recorded result`
                });
                return;
              }

              if (reservation.status === 'replay') {
                writeJson(response, 200, reservation.result);
                return;
              }

            const side = intent.side ?? 'buy';
            const tokenMint = intent.tokenMint ?? intent.poolAddress;
            let buildMs: number | undefined;
            let quoteMs: number | undefined;
            let swapBuildMs: number | undefined;
            let signMs: number | undefined;
            let blockhashMs: number | undefined;
            const sendTxMs: number[] = [];
            let broadcastAttempted = false;

            try {
              let signedBase64: string;

              if (side === 'buy' || side === 'sell') {
                let quoteParams: import('./jupiter-client.ts').JupiterQuoteParams;

                if (side === 'buy') {
                  quoteParams = jupiterClient.buildBuyQuoteParams(tokenMint, intent.outputSol, defaultSlippageBps);
                } else {
                  if (!intent.fullPositionExit) {
                    throw new Error('Sell intent must explicitly declare fullPositionExit=true');
                  }

                  // Sell: query actual token balance and sell all
                  const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
                  const tokenAccount = tokenAccounts.find(
                    (a) => a.account.data.parsed.info.mint === tokenMint
                  );
                  if (!tokenAccount) {
                    throw new Error(`No token account found for mint ${tokenMint}`);
                  }
                  const tokenLamports = Number(tokenAccount.account.data.parsed.info.tokenAmount.amount);
                  if (tokenLamports <= 0) {
                    throw new Error(`Token balance is zero for mint ${tokenMint}`);
                  }
                  quoteParams = jupiterClient.buildSellQuoteParams(tokenMint, tokenLamports, defaultSlippageBps);
                }

                const quoteStartedAt = Date.now();
                const quoteResponse = await jupiterClient.getQuote(quoteParams);
                quoteMs = durationMs(quoteStartedAt);

                // Get swap transaction from Jupiter
                const swapBuildStartedAt = Date.now();
                const swapResponse = await jupiterClient.getSwapTransaction(
                  quoteResponse,
                  walletPublicKey,
                  { jitoTipLamports: options.jitoTipLamports }
                );
                swapBuildMs = durationMs(swapBuildStartedAt);

                // Sign the transaction with local keypair
                const signStartedAt = Date.now();
                signedBase64 = signSwapTransaction(
                  swapResponse.swapTransaction,
                  keypair
                );
                signMs = durationMs(signStartedAt);
              } else {
                if (!options.dlmmClient) {
                  throw new Error('DLMM client not configured');
                }

                let txBatch: any[] = [];
                let signers: Keypair[] = [keypair];

              if (side === 'add-lp') {
                const buildStartedAt = Date.now();
                const result = await options.dlmmClient.addLiquidityByStrategy(
                  keypair.publicKey,
                  intent.poolAddress,
                  intent.outputSol
                );
                buildMs = durationMs(buildStartedAt);
                txBatch = toTransactionBatch(result.transaction);
                if (result.newPositionKeypair) {
                  signers.push(result.newPositionKeypair);
                }
              } else if (side === 'withdraw-lp') {
                const buildStartedAt = Date.now();
                txBatch = toTransactionBatch(await options.dlmmClient.removeLiquidity(keypair.publicKey, intent.poolAddress));
                buildMs = durationMs(buildStartedAt);
              } else if (side === 'claim-fee') {
                const buildStartedAt = Date.now();
                txBatch = toTransactionBatch(await options.dlmmClient.claimFee(keypair.publicKey, intent.poolAddress));
                buildMs = durationMs(buildStartedAt);
              } else {
                throw new Error(`Unsupported side: ${side}`);
              }

              if (txBatch.length === 0) {
                throw new Error(`No Meteora transactions returned for side ${side}`);
              }

              const blockhashStartedAt = Date.now();
              const { value: blockhash } = await rpcClient.getLatestBlockhash();
              blockhashMs = durationMs(blockhashStartedAt);
              const txSignatures: string[] = [];

              for (const txParams of txBatch) {
                try {
                  txParams.recentBlockhash = blockhash.blockhash;
                  txParams.feePayer = keypair.publicKey;
                  txParams.sign(...signers);
                  signedBase64 = txParams.serialize().toString('base64');
                  const sendStartedAt = Date.now();
                  broadcastAttempted = true;
                  txSignatures.push(await rpcClient.sendRawTransaction(signedBase64));
                  sendTxMs.push(durationMs(sendStartedAt));
                } catch (error) {
                  if (txSignatures.length === 0) {
                    throw error;
                  }

                  options.dlmmClient.invalidatePositionSnapshots?.(keypair.publicKey);
                  const reason = error instanceof Error ? error.message : String(error);
                  logBroadcastOutcome({
                    event: 'solana-execution-broadcast',
                    recordedAt: new Date().toISOString(),
                    strategyId: intent.strategyId,
                    idempotencyKey: intent.idempotencyKey,
                    side,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint,
                    outputSol: intent.outputSol,
                    result: 'partial',
                    acceptedSignatureCount: txSignatures.length,
                    buildMs,
                    blockhashMs,
                    sendTxMs,
                    totalMs: durationMs(broadcastStartedAt),
                    reason
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    batchStatus: 'partial',
                    reason
                  }));
                  return;
                }
              }

              if (side === 'withdraw-lp' && intent.liquidateResidualTokenToSol && intent.tokenMint) {
                const withdrawConfirmed = await waitForConfirmedSignatures(rpcClient, txSignatures);

                if (withdrawConfirmed) {
                  const tokenLamports = await findTokenLamportsWithRetry(
                    rpcClient,
                    walletPublicKey,
                    intent.tokenMint
                  );

                  if (tokenLamports > 0) {
                    const residualQuoteStartedAt = Date.now();
                    const quoteResponse = await jupiterClient.getQuote(
                      jupiterClient.buildSellQuoteParams(intent.tokenMint, tokenLamports, defaultSlippageBps)
                    );
                    quoteMs = (quoteMs ?? 0) + durationMs(residualQuoteStartedAt);

                    const residualSwapBuildStartedAt = Date.now();
                    const swapResponse = await jupiterClient.getSwapTransaction(
                      quoteResponse,
                      walletPublicKey,
                      { jitoTipLamports: options.jitoTipLamports }
                    );
                    swapBuildMs = (swapBuildMs ?? 0) + durationMs(residualSwapBuildStartedAt);

                    const residualSignStartedAt = Date.now();
                    const residualSignedBase64 = signSwapTransaction(
                      swapResponse.swapTransaction,
                      keypair
                    );
                    signMs = (signMs ?? 0) + durationMs(residualSignStartedAt);

                    const residualSendStartedAt = Date.now();
                    broadcastAttempted = true;
                    txSignatures.push(await rpcClient.sendRawTransaction(residualSignedBase64));
                    sendTxMs.push(durationMs(residualSendStartedAt));
                  }

                  await liquidateResidualTokensToSol({
                    rpcClient,
                    jupiterClient,
                    keypair,
                    walletPublicKey,
                    defaultSlippageBps,
                    jitoTipLamports: options.jitoTipLamports,
                    sendTxMs
                  });
                }
              }

              options.dlmmClient.invalidatePositionSnapshots?.(keypair.publicKey);
              logBroadcastOutcome({
                event: 'solana-execution-broadcast',
                recordedAt: new Date().toISOString(),
                strategyId: intent.strategyId,
                idempotencyKey: intent.idempotencyKey,
                side,
                poolAddress: intent.poolAddress,
                tokenMint: intent.tokenMint,
                outputSol: intent.outputSol,
                result: 'submitted',
                acceptedSignatureCount: txSignatures.length,
                buildMs,
                blockhashMs,
                sendTxMs,
                totalMs: durationMs(broadcastStartedAt)
              });

              await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                idempotencyKey: intent.idempotencyKey,
                signatures: txSignatures
              }));
              return;
              }

              // Send to Solana RPC
              const sendStartedAt = Date.now();
              broadcastAttempted = true;
              const txSignature = await rpcClient.sendRawTransaction(signedBase64);
              sendTxMs.push(durationMs(sendStartedAt));
              logBroadcastOutcome({
                event: 'solana-execution-broadcast',
                recordedAt: new Date().toISOString(),
                strategyId: intent.strategyId,
                idempotencyKey: intent.idempotencyKey,
                side,
                poolAddress: intent.poolAddress,
                tokenMint: intent.tokenMint,
                outputSol: intent.outputSol,
                result: 'submitted',
                acceptedSignatureCount: 1,
                quoteMs,
                swapBuildMs,
                signMs,
                sendTxMs,
                totalMs: durationMs(broadcastStartedAt)
              });

              await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                idempotencyKey: intent.idempotencyKey,
                signatures: [txSignature]
              }));
              return;
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              if (!broadcastAttempted) {
                await releaseIdempotencyReservation(payload.intent);
              }

              logBroadcastOutcome({
                event: 'solana-execution-broadcast',
                recordedAt: new Date().toISOString(),
                strategyId: intent.strategyId,
                idempotencyKey: intent.idempotencyKey,
                side,
                poolAddress: intent.poolAddress,
                tokenMint: intent.tokenMint,
                outputSol: intent.outputSol,
                result: 'failed',
                acceptedSignatureCount: 0,
                buildMs,
                quoteMs,
                swapBuildMs,
                signMs,
                blockhashMs,
                sendTxMs,
                totalMs: durationMs(broadcastStartedAt),
                reason
              });
              throw error;
            }
            });
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

            let walletTokens: { mint: string; symbol: string; amount: number; currentValueSol?: number }[] = [];
            let walletLpPositions: Array<{
              poolAddress: string;
              positionAddress: string;
              mint: string;
              lowerBinId: number;
              upperBinId: number;
              activeBinId: number;
              binCount: number;
              fundedBinCount: number;
              solSide: 'tokenX' | 'tokenY';
              solDepletedBins: number;
              currentValueSol?: number;
              unclaimedFeeSol?: number;
              positionStatus: 'active' | 'residual' | 'empty';
              hasLiquidity: boolean;
              hasClaimableFees: boolean;
            }> = [];

            try {
              const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
              const now = Date.now();
              const walletTokenCandidates = tokenAccounts.map((account) => {
                const info = account.account.data.parsed.info;
                const amountLamports = Number(info.tokenAmount.amount ?? 0);
                return {
                  mint: info.mint,
                  symbol: '',
                  amount: info.tokenAmount.uiAmount ?? 0,
                  amountLamports,
                  currentValueSol: readFreshTokenValueCache(tokenValueCache, info.mint, now)
                };
              });

              const quoteCandidates = walletTokenCandidates
                .filter((token) => token.amountLamports > 0 && typeof token.currentValueSol !== 'number')
                .sort((left, right) => right.amountLamports - left.amountLamports)
                .slice(0, ACCOUNT_STATE_TOKEN_VALUE_MAX_QUOTES_PER_REQUEST);

              for (const token of quoteCandidates) {
                try {
                  token.currentValueSol = await resolveTokenCurrentValueSol({
                    jupiterClient,
                    mint: token.mint,
                    amountLamports: token.amountLamports,
                    defaultSlippageBps
                  });
                  tokenValueCache.set(token.mint, {
                    currentValueSol: token.currentValueSol,
                    updatedAt: Date.now()
                  });
                } catch (error) {
                  if (isRateLimitLikeError(error)) {
                    break;
                  }
                }
              }

              walletTokens = walletTokenCandidates.map(({ amountLamports: _amountLamports, ...token }) => token);
            } catch {
              // Token accounts query may fail on free RPC
            }

            try {
              if (options.dlmmClient) {
                walletLpPositions = (await options.dlmmClient.getPositionSnapshots(keypair.publicKey))
                  .filter((position) => position.positionStatus !== 'empty');
              }
            } catch {
              // Meteora positions query may fail on free RPC
            }

            writeJson(response, 200, {
              walletSol,
              journalSol: walletSol,
              walletLpPositions,
              journalLpPositions: walletLpPositions,
              walletTokens,
              journalTokens: walletTokens,
              fills: []
            });
            return;
          }

          // Quote — strategy-level exit quote (pure calculation, no external call)
          if (request.method === 'POST' && request.url === '/quote') {
            const body = await readBody(request);
            const payload = JSON.parse(body);
            const quote = await collectLiveQuote({
              expectedOutSol: payload.expectedOutSol ?? 0,
              slippageBps: payload.slippageBps ?? 50,
              routeExists: payload.routeExists ?? true
            });
            writeJson(response, 200, quote);
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
