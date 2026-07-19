import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Keypair } from '@solana/web3.js';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../../runtime/atomic-file.ts';
import { validateIntentAllowlist } from '../../risk/instruction-allowlist.ts';
import { JupiterClient, LAMPORTS_PER_SOL, SOL_MINT } from './jupiter-client.ts';
import { SolanaRpcClient } from './solana-rpc-client.ts';
import { MeteoraDlmmClient, type MeteoraLpPositionSnapshot } from './meteora-dlmm-client.ts';
import {
  createDefaultSwapProviderChain,
  describeSwapProviderAttempts,
  SwapProviderChain,
  type SwapProviderAttempt
} from './swap-providers.ts';
import {
  createDefaultValuationProviderChain,
  type ValuationProviderChain,
  type ValuationTrust
} from './valuation-providers.ts';
import {
  signedIntentIdempotencyFingerprint,
  verifySignedIntent
} from '../signed-intent-verifier.ts';
import {
  LiveOrderIntentSchema,
  PersistedLiveOrderIntentSchema
} from '../live-order-intent-schema.ts';
import type { LiveBroadcastResult } from '../live-broadcaster.ts';
import type { LiveConfirmationResult } from '../live-confirmation-provider.ts';
import { collectLiveQuote } from '../live-quote-service.ts';
import {
  hasExpectedBearerToken,
  readBody,
  writeJson,
  writeText
} from '../../shared/http-server.ts';
import { reconstructOpenPositionEntryEvidence } from '../../history/solana-closed-position-reconstructor.ts';
import { encodeBase58 } from '../../shared/base58.ts';

const BroadcastRequestSchema = z.object({
  intent: z.object({
    intent: LiveOrderIntentSchema,
    signerId: z.string().min(1),
    signedAt: z.string().min(1),
    signature: z.string().min(1)
  })
});

const ConfirmationRequestSchema = z.object({
  submissionId: z.string().min(1),
  confirmationSignature: z.string().optional()
});

const LpEntryEvidenceRequestSchema = z.object({
  walletAddress: z.string().optional(),
  tokenMint: z.string().min(1),
  poolAddress: z.string().optional(),
  chainPositionAddress: z.string().optional(),
  openedAtHint: z.string().optional(),
  orderSignature: z.string().optional()
});

function accountStateUnavailablePayload(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    error: 'account-state unavailable',
    reason
  };
}

const BroadcastResultSchema = z.object({
  status: z.literal('submitted'),
  submissionId: z.string(),
  idempotencyKey: z.string(),
  confirmationSignature: z.string().optional(),
  submissionIds: z.array(z.string()).optional(),
  confirmationSignatures: z.array(z.string()).optional(),
  batchStatus: z.enum(['complete', 'partial']).optional(),
  reason: z.string().optional(),
  mainExecutionStatus: z.enum(['submitted', 'confirmed']).optional(),
  residualSweepStatus: z.enum(['complete', 'incomplete', 'dust_ignored']).optional(),
  residualUnsoldMints: z.array(z.string()).optional(),
  residualUnsoldAmountsRaw: z.record(z.string(), z.string().regex(/^\d+$/)).optional(),
  residualIgnoredMints: z.array(z.string()).optional(),
  residualFailureReasons: z.array(z.string()).optional(),
  residualEstimatedValueSol: z.number().finite().nonnegative().optional(),
  openIntentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  chainPositionAddress: z.string().min(1).optional(),
  rebuildAttemptCount: z.number().int().nonnegative().optional(),
  activeBinIdAtBuild: z.number().int().optional(),
  lowerBinIdAtBuild: z.number().int().optional(),
  upperBinIdAtBuild: z.number().int().optional(),
  binSlippageBps: z.number().finite().nonnegative().optional()
});

const SubmissionBroadcastEvidenceSchema = z.object({
  transactionHash: z.string().regex(/^[0-9a-f]{64}$/),
  transactionSignature: z.string().min(1).optional(),
  rpcAcceptedSignature: z.string().min(1).optional(),
  sendStartedAt: z.string().min(1),
  rpcAcceptedAt: z.string().min(1).optional()
});

const SubmissionEntrySchema = z.object({
  idempotencyKey: z.string().min(1),
  signedIntentFingerprint: z.string().min(1),
  signedIntent: z.object({
    intent: PersistedLiveOrderIntentSchema,
    signerId: z.string().min(1),
    signedAt: z.string().min(1),
    signature: z.string().min(1)
  }),
  status: z.enum(['pending', 'submitted']).default('submitted'),
  // Pending entries written before the recoverable state machine deliberately
  // have no phase. They are treated as outcome-unknown and remain fail-closed.
  // Only a reservation from an earlier execution-server instance that never
  // crossed `broadcast_started` is safe to resume after restart.
  phase: z.enum(['reserved', 'broadcast_started']).optional(),
  reservationOwnerId: z.string().min(1).optional(),
  broadcastEvidence: z.array(SubmissionBroadcastEvidenceSchema).optional(),
  result: BroadcastResultSchema.optional(),
  receivedAt: z.string().min(1),
  updatedAt: z.string().min(1).optional()
});

const SubmissionStoreSchema = z.object({
  submissions: z.array(SubmissionEntrySchema)
});

const PaperDryRunPositionSchema = z.object({
  poolAddress: z.string().min(1),
  positionAddress: z.string().min(1),
  chainPositionAddress: z.string().min(1),
  positionId: z.string().min(1).optional(),
  openIntentId: z.string().min(1).optional(),
  mint: z.string().min(1),
  entrySol: z.number().finite().positive().optional(),
  activeBinIdAtOpen: z.number().int().optional(),
  activeBinId: z.number().int().optional(),
  lowerBinId: z.number().int().optional(),
  upperBinId: z.number().int().optional(),
  binSlippageBps: z.number().finite().nonnegative().optional(),
  solSide: z.enum(['tokenX', 'tokenY']).optional(),
  currentValueSol: z.number().finite().nonnegative(),
  valuationStatus: z.enum(['ready', 'unavailable', 'stale', 'invalid']).optional(),
  valuationReason: z.string().optional(),
  valuationSource: z.string().optional(),
  openedAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const PaperDryRunTokenSchema = z.object({
  strategyId: z.string().min(1),
  poolAddress: z.string().min(1),
  mint: z.string().min(1),
  openIntentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  amountRaw: z.string().regex(/^\d+$/),
  entrySol: z.number().finite().nonnegative(),
  maxSlippageBps: z.number().int().nonnegative().optional(),
  maxImpactBps: z.number().int().nonnegative().optional(),
  currentValueSol: z.number().finite().nonnegative().optional(),
  valuationStatus: z.enum(['ready', 'unavailable', 'stale', 'invalid']).optional(),
  valuationReason: z.string().optional(),
  lastValuationAt: z.string().min(1).optional(),
  openedAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const PaperDryRunStateSchema = z.object({
  version: z.literal(1),
  walletSolDelta: z.number().finite().default(0),
  positions: z.array(PaperDryRunPositionSchema),
  // Optional-on-disk via default so paper state written before spot overlays
  // remains readable without a migration.
  tokens: z.array(PaperDryRunTokenSchema).default([]),
  appliedSwapKeys: z.array(z.string().min(1)).default([])
});

type SubmissionStore = z.infer<typeof SubmissionStoreSchema>;
type SignedBroadcastIntent = z.infer<typeof BroadcastRequestSchema>['intent'];
type PaperDryRunState = z.infer<typeof PaperDryRunStateSchema>;
type PaperDryRunPosition = z.infer<typeof PaperDryRunPositionSchema>;
type PaperDryRunToken = z.infer<typeof PaperDryRunTokenSchema>;

type SolanaExecutionServerOptions = {
  host: string;
  port: number;
  stateRootDir?: string;
  keypair: Keypair;
  rpcClient: SolanaRpcClient;
  jupiterClient: JupiterClient;
  dlmmClient?: MeteoraDlmmClient;
  swapProviderChain?: SwapProviderChain;
  valuationProviderChain?: ValuationProviderChain;
  authToken?: string;
  expectedSignerPublicKeys?: string[];
  maxOutputSol?: number;
  defaultSlippageBps?: number;
  residualTokenMinValueSol?: number;
  residualTokenDustMaxUiAmount?: number;
  jitoTipLamports?: number;
  dryRun?: boolean;
  /**
   * When set in dry-run mode, paper capital is fully virtual and does not
   * borrow the signer's real SOL balance or require a balance-backed RPC
   * simulation. Omit it to retain balance-backed dry-run behaviour.
   */
  paperStartingSol?: number;
  dryRunAddLpRebuildOnBinSlippage?: boolean;
  dryRunAddLpRebuildMaxAttempts?: number;
  addLpBinSlippageCooldownMs?: number;
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
  swapProvider?: string;
  swapProviderAttempts?: string;
  dryRun?: boolean;
  executionFailureKind?: string;
  executionFailureOperation?: string;
  rebuildAttemptCount?: number;
  activeBinIdAtBuild?: number;
  lowerBinIdAtBuild?: number;
  upperBinIdAtBuild?: number;
  binSlippageBps?: number;
};

const RESIDUAL_BALANCE_CHECK_DELAY_MS = 2_000;
const WITHDRAW_CONFIRMATION_WAIT_ATTEMPTS = 6;
const WITHDRAW_CONFIRMATION_WAIT_DELAY_MS = 2_000;
const RESIDUAL_TOKEN_SWEEP_PASSES = 3;
const RESIDUAL_TOKEN_DISCOVERY_PASSES = 6;
const RESIDUAL_TOKEN_MIN_SOL_VALUE = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeLamportsAmount(amount: number | string | bigint | undefined) {
  if (typeof amount === 'bigint') {
    return amount > 0n ? amount.toString() : undefined;
  }

  if (typeof amount === 'string') {
    return /^\d+$/.test(amount) && BigInt(amount) > 0n ? amount : undefined;
  }

  if (typeof amount === 'number') {
    return Number.isFinite(amount) && amount > 0 ? String(Math.floor(amount)) : undefined;
  }

  return undefined;
}

function isZeroLamportsAmount(amount: string | number | undefined) {
  if (typeof amount === 'string') {
    return /^\d+$/.test(amount) && BigInt(amount) === 0n;
  }

  return typeof amount === 'number' && Number.isFinite(amount) && amount === 0;
}

function looksLikeBase58Address(value: string | undefined) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value);
}

async function resolveLpEntryEvidence(input: {
  rpcClient: SolanaRpcClient;
  walletAddress: string;
  tokenMint: string;
  poolAddress?: string;
  chainPositionAddress?: string;
  openedAtHint?: string;
  orderSignature?: string;
}) {
  const signatures = new Set<string>();

  if (looksLikeBase58Address(input.orderSignature)) {
    signatures.add(input.orderSignature!);
  }

  for (const address of [input.chainPositionAddress, input.poolAddress]) {
    if (!looksLikeBase58Address(address)) {
      continue;
    }

    const candidates = await input.rpcClient.getSignaturesForAddress(address!, { limit: 20 });
    const targetMs = input.openedAtHint ? Date.parse(input.openedAtHint) : Number.NaN;
    const ordered = [...candidates].sort((left, right) => {
      if (!Number.isFinite(targetMs)) {
        return (right.blockTime ?? 0) - (left.blockTime ?? 0);
      }

      const leftMs = typeof left.blockTime === 'number' ? left.blockTime * 1000 : Number.POSITIVE_INFINITY;
      const rightMs = typeof right.blockTime === 'number' ? right.blockTime * 1000 : Number.POSITIVE_INFINITY;
      return Math.abs(leftMs - targetMs) - Math.abs(rightMs - targetMs);
    });

    for (const candidate of ordered) {
      signatures.add(candidate.signature);
    }
  }

  const matches = [];
  for (const signature of signatures) {
    const transaction = await input.rpcClient.getTransaction(signature);
    if (!transaction) {
      continue;
    }

    const evidence = reconstructOpenPositionEntryEvidence({
      walletAddress: input.walletAddress,
      tokenMint: input.tokenMint,
      tokenSymbol: '',
      poolAddress: input.poolAddress,
      positionAddress: input.chainPositionAddress,
      transaction: transaction as Parameters<typeof reconstructOpenPositionEntryEvidence>[0]['transaction']
    });

    if (evidence) {
      matches.push(evidence);
    }
  }

  if (matches.length === 0) {
    return { status: 'not_found' as const, reason: 'lp-entry-evidence-not-found' };
  }

  const exactMatches = matches.filter((match) =>
    (!input.chainPositionAddress || match.positionAddress === input.chainPositionAddress)
    && (!input.poolAddress || match.poolAddress === input.poolAddress)
  );
  const selectedMatches = exactMatches.length > 0 ? exactMatches : matches;

  if (selectedMatches.length > 1) {
    return { status: 'ambiguous' as const, reason: 'entry-reconstruction-ambiguous' };
  }

  const evidence = selectedMatches[0];
  return {
    status: 'trusted' as const,
    entrySol: evidence.entrySol,
    openedAt: evidence.openedAt,
    signature: evidence.signature,
    source: 'reconstructed_chain' as const,
    poolAddress: evidence.poolAddress,
    chainPositionAddress: evidence.positionAddress
  };
}

async function resolveTokenCurrentValueSol(input: {
  swapProviderChain: SwapProviderChain;
  walletPublicKey: string;
  mint: string;
  amountLamports: number | string | bigint;
  defaultSlippageBps: number;
  maxImpactBps?: number;
  poolAddress?: string;
  skipBalanceDependentProviders?: boolean;
}) {
  const quoteAmount = normalizeLamportsAmount(input.amountLamports);
  if (!quoteAmount) {
    return undefined;
  }

  const quoteResponse = await input.swapProviderChain.quoteExactIn({
    inputMint: input.mint,
    outputMint: SOL_MINT,
    amountLamports: quoteAmount,
    walletPublicKey: input.walletPublicKey,
    poolAddress: input.poolAddress,
    slippageBps: input.defaultSlippageBps,
    maxImpactBps: input.maxImpactBps,
    skipBalanceDependentProviders: input.skipBalanceDependentProviders
  });
  const outAmountLamports = Number(quoteResponse.outAmountLamports ?? 0);
  const outAmountSol = outAmountLamports / LAMPORTS_PER_SOL;
  return Number.isFinite(outAmountSol) && outAmountSol >= 0 ? outAmountSol : undefined;
}

type AccountStateLpPosition = MeteoraLpPositionSnapshot & {
  chainPositionAddress?: string;
  positionId?: string;
  openIntentId?: string;
  withdrawTokenValueSol?: number;
  exitQuoteValueSol?: number;
  marketValueSol?: number;
  displayValueSol?: number;
  valuationTrust?: ValuationTrust;
  lastValuationAt?: string;
};

function readExecutionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type ExecutionFailureMetadata = {
  executionFailureKind?: string;
  executionFailureOperation?: string;
  retryable?: boolean;
};

class StructuredExecutionError extends Error {
  readonly executionFailureKind?: string;
  readonly executionFailureOperation?: string;
  readonly retryable: boolean;

  constructor(message: string, metadata: ExecutionFailureMetadata = {}) {
    super(message);
    this.name = 'StructuredExecutionError';
    this.executionFailureKind = metadata.executionFailureKind;
    this.executionFailureOperation = metadata.executionFailureOperation;
    this.retryable = metadata.retryable ?? true;
  }
}

function getExecutionFailureMetadata(error: unknown): ExecutionFailureMetadata {
  if (error instanceof StructuredExecutionError) {
    return {
      executionFailureKind: error.executionFailureKind,
      executionFailureOperation: error.executionFailureOperation,
      retryable: error.retryable
    };
  }

  return {};
}

function isBareFetchFailure(error: unknown) {
  return error instanceof Error && error.message.trim().toLowerCase() === 'fetch failed';
}

function isDlmmBinSlippageMessage(message: string) {
  return /ExceededBinSlippageTolerance|custom program error:\s*0x1774|\"Custom\":6004|Custom.*6004/i.test(message);
}

function classifyOperationError(error: unknown, operation: string) {
  if (error instanceof StructuredExecutionError) {
    return error;
  }

  const message = readExecutionErrorMessage(error);
  if (isBareFetchFailure(error)) {
    return new StructuredExecutionError(`${operation}-fetch-failed: ${message}`, {
      executionFailureKind: 'fetch_failed',
      executionFailureOperation: operation,
      retryable: true
    });
  }

  if (isDlmmBinSlippageMessage(message)) {
    return new StructuredExecutionError(`${operation}-dlmm-bin-slippage: ${message}`, {
      executionFailureKind: 'dlmm_bin_slippage',
      executionFailureOperation: operation,
      retryable: true
    });
  }

  return error;
}

function hasPoolPriceFallbackValue(position: MeteoraLpPositionSnapshot) {
  return typeof position.currentValueSol === 'number'
    && Number.isFinite(position.currentValueSol)
    && position.currentValueSol >= 0
    && typeof position.valuationSource === 'string'
    && position.valuationSource.includes('dlmm-active-bin-price-fallback');
}

function nonnegativeFinite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mergeValuationTrust(current: ValuationTrust, next: ValuationTrust): ValuationTrust {
  if (current === 'fallback_display' || next === 'fallback_display') {
    return 'fallback_display';
  }

  if (current === 'market_price' || next === 'market_price') {
    return 'market_price';
  }

  return 'exit_quote';
}

const LP_VALUATION_DUST_VALUE_SOL = 0.000001;

function isDustValuationValueSol(valueSol: unknown) {
  return typeof valueSol === 'number'
    && Number.isFinite(valueSol)
    && valueSol >= 0
    && valueSol <= LP_VALUATION_DUST_VALUE_SOL;
}

function markPoolPriceFallbackUntrusted(position: MeteoraLpPositionSnapshot, reason: string): AccountStateLpPosition {
  return {
    ...position,
    valuationStatus: 'stale',
    valuationReason: reason,
    valuationCompleteness: 'untrusted',
    valuationSource: position.valuationSource ?? 'meteora-withdraw-simulation+dlmm-active-bin-price-fallback'
  };
}

function markLpValuationUnavailable(
  position: MeteoraLpPositionSnapshot,
  valuationSource: string,
  reason: string
): AccountStateLpPosition {
  if (hasPoolPriceFallbackValue(position)) {
    return markPoolPriceFallbackUntrusted(position, reason);
  }

  return {
    ...position,
    currentValueSol: undefined,
    liquidityValueSol: undefined,
    lpTotalValueSol: undefined,
    valuationStatus: 'unavailable',
    valuationReason: reason,
    valuationCompleteness: 'incomplete',
    valuationSource
  };
}

async function enrichLpExitValues(input: {
  positions: MeteoraLpPositionSnapshot[];
  valuationProviderChain: ValuationProviderChain;
  walletPublicKey: string;
  defaultSlippageBps: number;
  maxImpactBps?: number;
}): Promise<AccountStateLpPosition[]> {
  return Promise.all(input.positions.map(async (position) => {
    const withdrawSolAmount = nonnegativeFinite(position.withdrawSolAmount);
    const withdrawTokenAmountLamports = nonnegativeFinite(position.withdrawTokenAmountLamports);
    const withdrawTokenAmountRaw = typeof position.withdrawTokenAmountRaw === 'string'
      ? position.withdrawTokenAmountRaw
      : typeof withdrawTokenAmountLamports === 'number'
        ? String(Math.floor(withdrawTokenAmountLamports))
        : undefined;
    const unclaimedFeeSolAmount = nonnegativeFinite(position.unclaimedFeeSolAmount)
      ?? (position.hasClaimableFees === false ? 0 : undefined);
    const unclaimedFeeTokenAmountLamports = nonnegativeFinite(position.unclaimedFeeTokenAmountLamports);
    const unclaimedFeeTokenAmountRaw = typeof position.unclaimedFeeTokenAmountRaw === 'string'
      ? position.unclaimedFeeTokenAmountRaw
      : typeof unclaimedFeeTokenAmountLamports === 'number'
        ? String(Math.floor(unclaimedFeeTokenAmountLamports))
        : '0';
    const claimedFeeValueSol = nonnegativeFinite(position.claimedFeeValueSol) ?? 0;
    const recoverableRentSol = nonnegativeFinite(position.recoverableRentSol) ?? 0;
    const valuationSource = position.valuationSource ?? 'meteora-withdraw-simulation';

    if (typeof withdrawSolAmount !== 'number' || !withdrawTokenAmountRaw) {
      return markLpValuationUnavailable(position, valuationSource, position.valuationReason ?? 'missing-withdraw-simulation');
    }

    if (typeof unclaimedFeeSolAmount !== 'number') {
      return markLpValuationUnavailable(position, valuationSource, 'missing-unclaimed-fee-sol-amount');
    }

    try {
      let withdrawTokenValueSol = 0;
      let unclaimedFeeTokenValueSol = 0;
      let valuationTrust: ValuationTrust = 'exit_quote';
      const valuationSources = ['meteora-withdraw-simulation'];
      let hasMarketValuation = false;

      if (!isZeroLamportsAmount(withdrawTokenAmountRaw)) {
        if (!position.withdrawTokenMint) {
          return markLpValuationUnavailable(position, valuationSource, 'missing-withdraw-token-mint');
        }

        const quotedWithdrawTokenValueSol = await input.valuationProviderChain.quoteTokenToSol({
          inputMint: position.withdrawTokenMint,
          amountLamports: withdrawTokenAmountRaw,
          tokenDecimals: position.withdrawTokenDecimals,
          poolAddress: position.poolAddress,
          slippageBps: input.defaultSlippageBps,
          fallbackDisplayValueSol: position.withdrawTokenValueSol
        });

        if (typeof quotedWithdrawTokenValueSol.valueSol !== 'number') {
          return markLpValuationUnavailable(position, valuationSource, 'withdraw-token-quote-unavailable');
        }

        withdrawTokenValueSol = quotedWithdrawTokenValueSol.valueSol;
        const withdrawTokenQuoteIsDust = isDustValuationValueSol(quotedWithdrawTokenValueSol.valueSol);
        if (quotedWithdrawTokenValueSol.trust === 'exit_quote' || !withdrawTokenQuoteIsDust) {
          valuationTrust = mergeValuationTrust(valuationTrust, quotedWithdrawTokenValueSol.trust);
          hasMarketValuation ||= quotedWithdrawTokenValueSol.trust === 'market_price';
        }
        valuationSources.push((withdrawTokenQuoteIsDust ? 'token-dust-' : '') + quotedWithdrawTokenValueSol.source);
      }

      if (!isZeroLamportsAmount(unclaimedFeeTokenAmountRaw)) {
        const feeTokenMint = position.unclaimedFeeTokenMint ?? position.withdrawTokenMint;
        if (!feeTokenMint) {
          return markLpValuationUnavailable(position, valuationSource, 'missing-unclaimed-fee-token-mint');
        }

        const quotedFeeTokenValueSol = await input.valuationProviderChain.quoteTokenToSol({
          inputMint: feeTokenMint,
          amountLamports: unclaimedFeeTokenAmountRaw,
          tokenDecimals: position.unclaimedFeeTokenDecimals ?? position.withdrawTokenDecimals,
          poolAddress: position.poolAddress,
          slippageBps: input.defaultSlippageBps,
          fallbackDisplayValueSol: position.unclaimedFeeTokenValueSol
        });

        if (typeof quotedFeeTokenValueSol.valueSol !== 'number') {
          return markLpValuationUnavailable(position, valuationSource, 'unclaimed-fee-token-quote-unavailable');
        }

        unclaimedFeeTokenValueSol = quotedFeeTokenValueSol.valueSol;
        const feeTokenQuoteIsDust = isDustValuationValueSol(quotedFeeTokenValueSol.valueSol);
        if (quotedFeeTokenValueSol.trust === 'exit_quote' || !feeTokenQuoteIsDust) {
          valuationTrust = mergeValuationTrust(valuationTrust, quotedFeeTokenValueSol.trust);
          hasMarketValuation ||= quotedFeeTokenValueSol.trust === 'market_price';
        }
        valuationSources.push((feeTokenQuoteIsDust ? 'fee-dust-' : 'fee-') + quotedFeeTokenValueSol.source);
      }

      const liquidityValueSol = withdrawSolAmount + withdrawTokenValueSol;
      const unclaimedFeeValueSol = unclaimedFeeSolAmount + unclaimedFeeTokenValueSol;
      const lpTotalValueSol = liquidityValueSol + unclaimedFeeValueSol + claimedFeeValueSol + recoverableRentSol;
      const rentSourceSuffix = recoverableRentSol > 0 && !valuationSource.includes('position-account-rent')
        ? '+position-account-rent'
        : '';
      const valuationStatus = valuationTrust === 'exit_quote' ? 'ready' : 'stale';
      const valuationCompleteness = valuationTrust === 'exit_quote' ? 'complete' : 'untrusted';
      const fullValuationSource = valuationSources.join('+') + rentSourceSuffix;

      return {
        ...position,
        currentValueSol: lpTotalValueSol,
        liquidityValueSol,
        withdrawTokenValueSol,
        unclaimedFeeSolAmount,
        unclaimedFeeTokenAmountRaw,
        unclaimedFeeTokenMint: position.unclaimedFeeTokenMint ?? position.withdrawTokenMint,
        unclaimedFeeTokenValueSol,
        unclaimedFeeValueSol,
        claimedFeeValueSol,
        recoverableRentSol,
        lpTotalValueSol,
        exitQuoteValueSol: valuationTrust === 'exit_quote' ? lpTotalValueSol : undefined,
        marketValueSol: hasMarketValuation ? lpTotalValueSol : undefined,
        displayValueSol: lpTotalValueSol,
        valuationTrust,
        valuationStatus,
        valuationReason: valuationTrust === 'exit_quote' ? '' : `valuation-not-exit-quote:${fullValuationSource}`,
        valuationCompleteness,
        valuationSource: fullValuationSource
      };
    } catch (error) {
      return markLpValuationUnavailable(position, valuationSource, 'withdraw-token-quote-failed:' + readExecutionErrorMessage(error));
    }
  }));
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

type ResidualTokenSweepResult = {
  unsoldMints: string[];
  unsoldAmountsRaw: Record<string, string>;
  ignoredMints: string[];
  failureReasons: string[];
  ignoredReasons: string[];
};

async function liquidateResidualTokensToSol(input: {
  rpcClient: SolanaRpcClient;
  swapProviderChain: SwapProviderChain;
  keypair: Keypair;
  walletPublicKey: string;
  defaultSlippageBps: number;
  maxImpactBps?: number;
  jitoTipLamports?: number;
  sendRawTransaction: (signedTransactionBase64: string) => Promise<string>;
  sendTxMs: number[];
  acceptedSignatures?: string[];
  excludedMints?: string[];
  poolAddressByMint?: Map<string, string>;
  preExistingAmountRawByMint?: Map<string, string>;
  residualTokenMinValueSol: number;
  residualTokenDustMaxUiAmount: number;
}): Promise<ResidualTokenSweepResult> {
  const soldMints = new Set<string>(input.excludedMints ?? []);
  const ignoredMints = new Set<string>();
  const failureReasonByMint = new Map<string, string>();
  const ignoredReasonByMint = new Map<string, string>();
  const expectedMints = Array.from(input.poolAddressByMint?.keys() ?? []);
  const expectedMintSet = new Set(expectedMints);

  type SellableResidualToken = {
    mint: string;
    amountRaw: string;
    uiAmount?: number;
    ownershipBlockedReason?: string;
  };

  const listSellableTokens = async () => {
    const tokenAccounts = await input.rpcClient.getTokenAccountsByOwner(input.walletPublicKey);
    const totals = new Map<string, { amountRaw: bigint; uiAmount?: number }>();

    for (const account of tokenAccounts) {
      const info = account.account.data.parsed.info;
      const mint = String(info.mint ?? '');
      if (!mint || mint === SOL_MINT || !expectedMintSet.has(mint)) {
        continue;
      }

      const raw = String(info.tokenAmount.amount ?? '0');
      if (!/^\d+$/.test(raw)) {
        continue;
      }
      const existing = totals.get(mint) ?? { amountRaw: 0n };
      existing.amountRaw += BigInt(raw);
      if (typeof info.tokenAmount.uiAmount === 'number' && Number.isFinite(info.tokenAmount.uiAmount)) {
        existing.uiAmount = (existing.uiAmount ?? 0) + info.tokenAmount.uiAmount;
      }
      totals.set(mint, existing);
    }

    return Array.from(totals.entries()).flatMap<SellableResidualToken>(([mint, total]) => {
      if (soldMints.has(mint) || ignoredMints.has(mint)) {
        return [];
      }

      const preExistingRaw = input.preExistingAmountRawByMint?.get(mint);
      if (preExistingRaw === undefined || !/^\d+$/.test(preExistingRaw)) {
        return total.amountRaw > 0n ? [{
          mint,
          amountRaw: total.amountRaw.toString(),
          uiAmount: total.uiAmount,
          ownershipBlockedReason: `${mint}: missing pre-exit token balance; refusing to sell wallet-owned balance`
        } satisfies SellableResidualToken] : [];
      }

      const preExisting = BigInt(preExistingRaw);
      const ownedResidual = total.amountRaw > preExisting ? total.amountRaw - preExisting : 0n;
      if (ownedResidual <= 0n) {
        return [];
      }

      const ownedUiAmount = typeof total.uiAmount === 'number' && total.amountRaw > 0n
        ? total.uiAmount * (Number(ownedResidual) / Number(total.amountRaw))
        : undefined;
      return [{
        mint,
        amountRaw: ownedResidual.toString(),
        uiAmount: Number.isFinite(ownedUiAmount) ? ownedUiAmount : undefined
      } satisfies SellableResidualToken];
    });
  };

  const classifyUnsoldResidual = async (token: SellableResidualToken) => {
    const poolAddress = input.poolAddressByMint?.get(token.mint);

    try {
      const valueSol = await resolveTokenCurrentValueSol({
        swapProviderChain: input.swapProviderChain,
        walletPublicKey: input.walletPublicKey,
        mint: token.mint,
        amountLamports: token.amountRaw,
        defaultSlippageBps: input.defaultSlippageBps,
        maxImpactBps: input.maxImpactBps,
        poolAddress,
        skipBalanceDependentProviders: true
      });
      if (typeof valueSol === 'number' && Number.isFinite(valueSol)) {
        if (valueSol < input.residualTokenMinValueSol) {
          return {
            ignored: true,
            reason: `${token.mint}: residual_dust_ignored:value-sol=${valueSol}`
          };
        }

        return { ignored: false };
      }
    } catch {
      // Fall through to the tiny-token dust guard. If the amount is not tiny,
      // keep the residual actionable because the value is unknown.
    }

    if (
      typeof token.uiAmount === 'number' &&
      Number.isFinite(token.uiAmount) &&
      token.uiAmount <= input.residualTokenDustMaxUiAmount
    ) {
      return {
        ignored: true,
        reason: `${token.mint}: residual_dust_ignored:ui-amount=${token.uiAmount}`
      };
    }

    return { ignored: false };
  };

  const buildResult = async (sellable: SellableResidualToken[]): Promise<ResidualTokenSweepResult> => {
    for (const token of sellable) {
      if (soldMints.has(token.mint) || ignoredMints.has(token.mint)) {
        continue;
      }

      const classification = await classifyUnsoldResidual(token);
      if (classification.ignored) {
        ignoredMints.add(token.mint);
        if (classification.reason) {
          ignoredReasonByMint.set(token.mint, classification.reason);
        }
      }
    }

    const unsoldMints = Array.from(new Set(
      sellable
        .filter((token) => !soldMints.has(token.mint) && !ignoredMints.has(token.mint))
        .map((token) => token.mint)
    ));
    const ignoredMintList = Array.from(ignoredMints);

    return {
      unsoldMints,
      unsoldAmountsRaw: Object.fromEntries(
        sellable
          .filter((token) => unsoldMints.includes(token.mint))
          .map((token) => [token.mint, token.amountRaw])
      ),
      ignoredMints: ignoredMintList,
      failureReasons: unsoldMints
        .map((mint) => failureReasonByMint.get(mint))
        .filter((reason): reason is string => typeof reason === 'string'),
      ignoredReasons: ignoredMintList
        .map((mint) => ignoredReasonByMint.get(mint))
        .filter((reason): reason is string => typeof reason === 'string')
    };
  };

  const maxPasses = expectedMints.length > 0
    ? Math.max(RESIDUAL_TOKEN_SWEEP_PASSES, RESIDUAL_TOKEN_DISCOVERY_PASSES)
    : RESIDUAL_TOKEN_SWEEP_PASSES;
  const isWaitingForExpectedMint = (sellable: { mint: string }[]) => expectedMints.some((mint) =>
    !soldMints.has(mint) && !sellable.some((token) => token.mint === mint)
  );

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const sellable = await listSellableTokens();

    if (sellable.length === 0) {
      if (isWaitingForExpectedMint(sellable) && pass < maxPasses - 1) {
        await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
        continue;
      }

      return {
        unsoldMints: [],
        unsoldAmountsRaw: {},
        ignoredMints: Array.from(ignoredMints),
        failureReasons: [],
        ignoredReasons: Array.from(ignoredReasonByMint.values())
      };
    }

    let soldAny = false;

    for (const token of sellable) {
      const poolAddress = input.poolAddressByMint?.get(token.mint);

      if (token.ownershipBlockedReason) {
        failureReasonByMint.set(token.mint, token.ownershipBlockedReason);
        continue;
      }

      try {
        const swapResponse = await input.swapProviderChain.executeExactIn(
          {
            inputMint: token.mint,
            outputMint: SOL_MINT,
            amountLamports: token.amountRaw,
            walletPublicKey: input.walletPublicKey,
            poolAddress,
            slippageBps: input.defaultSlippageBps,
            maxImpactBps: input.maxImpactBps,
            jitoTipLamports: input.jitoTipLamports
          },
          {
            keypair: input.keypair,
            rpcClient: input.rpcClient,
            sendRawTransaction: async (signedTransactionBase64) => {
              const residualSendStartedAt = Date.now();
              const signature = await input.sendRawTransaction(signedTransactionBase64);
              input.sendTxMs.push(durationMs(residualSendStartedAt));
              return signature;
            }
          }
        );
        const outAmountSol = Number(swapResponse.outAmountLamports ?? 0) / LAMPORTS_PER_SOL;
        if (Number.isFinite(outAmountSol) && outAmountSol <= RESIDUAL_TOKEN_MIN_SOL_VALUE) {
          console.warn(`[Execution] Residual token liquidation returned zero SOL value for ${token.mint}`);
        }
        const signature = swapResponse.signature;
        input.acceptedSignatures?.push(signature);
        soldMints.add(token.mint);
        failureReasonByMint.delete(token.mint);
        soldAny = true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failureReasonByMint.set(
          token.mint,
          `${token.mint}: ${reason}`
        );
        console.warn(`[Execution] Residual token liquidation skipped for ${token.mint}: ${reason}`);
      }
    }

    if (!soldAny) {
      if (isWaitingForExpectedMint(sellable) && pass < maxPasses - 1) {
        await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
        continue;
      }

      return await buildResult(sellable);
    }

    await sleep(RESIDUAL_BALANCE_CHECK_DELAY_MS);
  }

  return await buildResult(await listSellableTokens());
}

function durationMs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

function extractPrimarySolanaTransactionSignature(signedTransactionBase64: string) {
  const transaction = Buffer.from(signedTransactionBase64, 'base64');
  if (transaction.length < 65) {
    return undefined;
  }

  // A serialized Solana transaction starts with a shortvec signature count,
  // followed by 64-byte Ed25519 signatures. This prefix is shared by legacy
  // and versioned transactions, so the transaction id is available before the
  // RPC call and can be durably recorded at the broadcast boundary.
  let signatureCount = 0;
  let shift = 0;
  let offset = 0;
  let shortvecComplete = false;
  while (offset < transaction.length && offset < 3) {
    const byte = transaction[offset];
    signatureCount |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      shortvecComplete = true;
      break;
    }
    shift += 7;
  }

  if (
    !shortvecComplete
    || signatureCount < 1
    || offset + signatureCount * 64 > transaction.length
  ) {
    return undefined;
  }

  const signature = transaction.subarray(offset, offset + 64);
  if (signature.every((byte) => byte === 0)) {
    return undefined;
  }
  return encodeBase58(signature);
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

class PaperDryRunStateStore {
  private readonly path: string | undefined;
  private memoryStore: PaperDryRunState = {
    version: 1,
    walletSolDelta: 0,
    positions: [],
    tokens: [],
    appliedSwapKeys: []
  };

  constructor(rootDir: string | undefined) {
    this.path = rootDir ? join(rootDir, 'paper-dry-run-state.json') : undefined;
  }

  async read(): Promise<PaperDryRunState> {
    if (!this.path) {
      return this.memoryStore;
    }

    return (await readJsonIfExists(this.path, PaperDryRunStateSchema)) ?? {
      version: 1,
      walletSolDelta: 0,
      positions: [],
      tokens: [],
      appliedSwapKeys: []
    };
  }

  async write(store: PaperDryRunState) {
    const parsed = PaperDryRunStateSchema.parse(store);

    if (!this.path) {
      this.memoryStore = parsed;
      return;
    }

    await writeJsonAtomically(this.path, parsed);
  }

  async upsertOpenPosition(position: PaperDryRunPosition) {
    const store = await this.read();
    const positions = store.positions.filter((entry) =>
      entry.chainPositionAddress !== position.chainPositionAddress
      && (!position.openIntentId || entry.openIntentId !== position.openIntentId)
    );
    positions.push(position);
    const entrySol = typeof position.entrySol === 'number' && position.entrySol > 0
      ? position.entrySol
      : position.currentValueSol;
    await this.write({
      ...store,
      walletSolDelta: store.walletSolDelta - entrySol,
      positions
    });
  }

  async closePosition(input: {
    chainPositionAddress?: string;
    positionId?: string;
    poolAddress: string;
    tokenMint?: string;
  }) {
    const store = await this.read();
    const samePoolAndMint = (position: PaperDryRunPosition) =>
      position.poolAddress === input.poolAddress
      && (!input.tokenMint || position.mint === input.tokenMint);
    // The on-chain position address is the strongest LP identity. Recovery can
    // legitimately normalize `positionId` to that address while an older paper
    // overlay still carries the original logical pool:mint id. Requiring both
    // values to agree strands the exact position. Keep this fail-closed by also
    // requiring the signed pool/mint, and only consult positionId when no chain
    // address was supplied.
    let identityMatch: PaperDryRunPosition | undefined;
    if (input.chainPositionAddress) {
      const chainMatches = store.positions.filter((position) =>
        position.chainPositionAddress === input.chainPositionAddress
        && samePoolAndMint(position)
      );
      if (chainMatches.length === 1) {
        const chainMatch = chainMatches[0];
        const positionIdConflictsWithAnotherOverlay = Boolean(
          input.positionId
          && store.positions.some((position) =>
            position !== chainMatch && position.positionId === input.positionId
          )
        );
        if (!positionIdConflictsWithAnotherOverlay) {
          identityMatch = chainMatch;
        }
      }
    } else if (input.positionId) {
      const positionIdMatches = store.positions.filter((position) =>
        position.positionId === input.positionId
        && samePoolAndMint(position)
      );
      if (positionIdMatches.length === 1) {
        identityMatch = positionIdMatches[0];
      }
    }
    const hasExplicitIdentity = Boolean(input.chainPositionAddress || input.positionId);
    const poolMintCandidates = store.positions.filter((position) =>
      samePoolAndMint(position)
    );
    // Once the caller has a lifecycle identity, falling back to pool+mint can
    // close a different position after stale recovery state. The fallback is
    // only safe for legacy callers that have no identity at all.
    const match = hasExplicitIdentity
      ? identityMatch
      : (poolMintCandidates.length === 1 ? poolMintCandidates[0] : undefined);

    if (!match) {
      return undefined;
    }

    await this.write({
      ...store,
      // A dry-run LP never exists on chain, so the active-bin shadow value is
      // display-only and must not be booked as realised paper PnL.  Cost-after
      // economics are produced by the strategy-research marks instead.
      walletSolDelta: store.walletSolDelta + (match.entrySol ?? match.currentValueSol),
      positions: store.positions.filter((position) => position.chainPositionAddress !== match.chainPositionAddress)
    });

    return match;
  }

  async readSellableToken(input: {
    mint: string;
    poolAddress: string;
    openIntentId?: string;
    positionId?: string;
  }) {
    const store = await this.read();
    const matches = this.matchTokens(store.tokens, input);
    const amountRaw = matches.reduce((total, token) => total + BigInt(token.amountRaw), 0n);
    return {
      amountRaw,
      matches
    };
  }

  async applyTokenBuy(input: {
    idempotencyKey: string;
    strategyId: string;
    poolAddress: string;
    mint: string;
    openIntentId?: string;
    positionId?: string;
    amountRaw: string;
    inputSol: number;
    maxSlippageBps?: number;
    maxImpactBps?: number;
    recordedAt: string;
  }) {
    if (!/^\d+$/.test(input.amountRaw) || BigInt(input.amountRaw) <= 0n) {
      throw new Error(`Paper buy quote returned invalid token amount ${input.amountRaw}`);
    }

    const store = await this.read();
    if (store.appliedSwapKeys.includes(input.idempotencyKey)) {
      return store.tokens.find((token) =>
        token.strategyId === input.strategyId
        && token.poolAddress === input.poolAddress
        && token.mint === input.mint
        && token.openIntentId === input.openIntentId
        && token.positionId === input.positionId
      );
    }
    const matchingIndex = store.tokens.findIndex((token) =>
      token.strategyId === input.strategyId
      && token.poolAddress === input.poolAddress
      && token.mint === input.mint
      && token.openIntentId === input.openIntentId
      && token.positionId === input.positionId
    );
    const tokens = [...store.tokens];
    const prior = matchingIndex >= 0 ? tokens[matchingIndex] : undefined;
    const token: PaperDryRunToken = {
      strategyId: input.strategyId,
      poolAddress: input.poolAddress,
      mint: input.mint,
      openIntentId: input.openIntentId,
      positionId: input.positionId,
      amountRaw: ((prior ? BigInt(prior.amountRaw) : 0n) + BigInt(input.amountRaw)).toString(),
      entrySol: (prior?.entrySol ?? 0) + input.inputSol,
      maxSlippageBps: input.maxSlippageBps ?? prior?.maxSlippageBps,
      maxImpactBps: input.maxImpactBps ?? prior?.maxImpactBps,
      // A fresh reverse quote is required before this is treated as a current
      // paper value. The entry cost is not an executable exit value.
      valuationStatus: 'stale',
      valuationReason: 'paper-sell-quote-pending',
      openedAt: prior?.openedAt ?? input.recordedAt,
      updatedAt: input.recordedAt
    };
    if (matchingIndex >= 0) {
      tokens[matchingIndex] = token;
    } else {
      tokens.push(token);
    }

    await this.write({
      ...store,
      walletSolDelta: store.walletSolDelta - input.inputSol,
      tokens,
      appliedSwapKeys: [...store.appliedSwapKeys, input.idempotencyKey]
    });
    return token;
  }

  async applyTokenSell(input: {
    idempotencyKey: string;
    mint: string;
    poolAddress: string;
    openIntentId?: string;
    positionId?: string;
    amountRaw: string;
    outputSol: number;
    recordedAt: string;
  }) {
    if (!/^\d+$/.test(input.amountRaw) || BigInt(input.amountRaw) <= 0n) {
      throw new Error(`Paper sell amount is invalid: ${input.amountRaw}`);
    }

    const store = await this.read();
    if (store.appliedSwapKeys.includes(input.idempotencyKey)) {
      return;
    }
    const matches = this.matchTokens(store.tokens, input);
    const availableRaw = matches.reduce((total, token) => total + BigInt(token.amountRaw), 0n);
    let remaining = BigInt(input.amountRaw);
    if (availableRaw < remaining) {
      throw new Error(
        `Paper token balance changed before sell for mint ${input.mint}: requested=${remaining} available=${availableRaw}`
      );
    }

    const matchSet = new Set(matches);
    const tokens: PaperDryRunToken[] = [];
    for (const token of store.tokens) {
      if (!matchSet.has(token) || remaining <= 0n) {
        tokens.push(token);
        continue;
      }

      const tokenRaw = BigInt(token.amountRaw);
      const consumed = tokenRaw < remaining ? tokenRaw : remaining;
      remaining -= consumed;
      const leftover = tokenRaw - consumed;
      if (leftover > 0n) {
        const retainedRatio = Number(leftover) / Number(tokenRaw);
        tokens.push({
          ...token,
          amountRaw: leftover.toString(),
          entrySol: Number.isFinite(retainedRatio) ? token.entrySol * retainedRatio : token.entrySol,
          currentValueSol: undefined,
          valuationStatus: 'stale',
          valuationReason: 'paper-partial-sell-requote-pending',
          lastValuationAt: undefined,
          updatedAt: input.recordedAt
        });
      }
    }

    await this.write({
      ...store,
      walletSolDelta: store.walletSolDelta + input.outputSol,
      tokens,
      appliedSwapKeys: [...store.appliedSwapKeys, input.idempotencyKey]
    });
  }

  private matchTokens(tokens: PaperDryRunToken[], input: {
    mint: string;
    poolAddress: string;
    openIntentId?: string;
    positionId?: string;
  }) {
    const mintPoolMatches = tokens.filter((token) =>
      token.mint === input.mint
      && (!input.poolAddress || token.poolAddress === input.poolAddress)
    );
    if (input.positionId) {
      return mintPoolMatches.filter((token) => token.positionId === input.positionId);
    }
    if (input.openIntentId) {
      return mintPoolMatches.filter((token) => token.openIntentId === input.openIntentId);
    }
    return mintPoolMatches;
  }
}

class UnknownBroadcastOutcomeError extends StructuredExecutionError {
  constructor(error: unknown) {
    const message = readExecutionErrorMessage(error);
    super(`rpc-send-outcome-unknown: ${message}`, {
      executionFailureKind: 'broadcast_outcome_unknown',
      executionFailureOperation: 'rpc-send',
      retryable: false
    });
    this.name = 'UnknownBroadcastOutcomeError';
  }
}

function isDefiniteRpcSendRejection(error: unknown) {
  const message = readExecutionErrorMessage(error);
  return /Solana RPC sendTransaction error:/i.test(message)
    || /Solana transaction failed pre-confirmation:/i.test(message)
    || /Transaction simulation failed/i.test(message)
    || /signature verification (?:failed|failure)/i.test(message)
    || /blockhash not found/i.test(message)
    || /Solana RPC sendTransaction failed: (?:400|401|403|404|422)\b/i.test(message);
}

export function createSolanaExecutionServer(options: SolanaExecutionServerOptions) {
  const {
    keypair,
    rpcClient,
    jupiterClient,
    defaultSlippageBps = 100,
    dryRun = false
  } = options;
  const paperStartingSol = typeof options.paperStartingSol === 'number'
    && Number.isFinite(options.paperStartingSol)
    && options.paperStartingSol >= 0
    ? options.paperStartingSol
    : undefined;
  const hasVirtualPaperBalance = dryRun && typeof paperStartingSol === 'number';
  const dryRunAddLpRebuildOnBinSlippage = options.dryRunAddLpRebuildOnBinSlippage ?? true;
  const dryRunAddLpRebuildMaxAttempts = options.dryRunAddLpRebuildMaxAttempts ?? 1;
  const addLpBinSlippageCooldownMs = options.addLpBinSlippageCooldownMs ?? 300_000;
  const walletPublicKey = keypair.publicKey.toBase58();
  let server: Server | undefined;
  let origin = '';
  const store = new SolanaExecutionStateStore(options.stateRootDir);
  const paperDryRunStore = new PaperDryRunStateStore(options.stateRootDir);
  const expectedSignerPublicKeys = options.expectedSignerPublicKeys ?? [];
  const executionInstanceId = randomUUID();
  const idempotencyLocks = new Map<string, Promise<void>>();
  let submissionStoreMutationTail = Promise.resolve();
  const withSubmissionStoreMutation = async <T>(action: () => Promise<T>): Promise<T> => {
    const prior = submissionStoreMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    submissionStoreMutationTail = prior.catch(() => undefined).then(() => current);
    await prior.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
    }
  };
  const tokenValueCache = new Map<string, TokenValueCacheEntry>();
  const swapProviderChain = options.swapProviderChain ?? createDefaultSwapProviderChain({
    providerOrder: ['meteora-direct', 'jupiter-v1'],
    jupiterClient,
    dlmmClient: options.dlmmClient
  });
  const valuationProviderChain = options.valuationProviderChain ?? createDefaultValuationProviderChain({
    providerOrder: ['meteora-dlmm-quote-only', 'dlmm-active-bin-display-fallback'],
    dlmmClient: options.dlmmClient
  });
  const residualTokenMinValueSol = options.residualTokenMinValueSol ?? 0.1;
  const residualTokenDustMaxUiAmount = options.residualTokenDustMaxUiAmount ?? 0.00001;
  const toTransactionBatch = (txParams: unknown) => Array.isArray(txParams) ? txParams : [txParams];
  const buildSubmittedBroadcastResult = (input: {
    idempotencyKey: string;
    signatures: string[];
    batchStatus?: 'complete' | 'partial';
    reason?: string;
    mainExecutionStatus?: 'submitted' | 'confirmed';
    residualSweepStatus?: 'complete' | 'incomplete' | 'dust_ignored';
    residualUnsoldMints?: string[];
    residualUnsoldAmountsRaw?: Record<string, string>;
    residualIgnoredMints?: string[];
    residualFailureReasons?: string[];
    residualEstimatedValueSol?: number;
    openIntentId?: string;
    positionId?: string;
    chainPositionAddress?: string;
    rebuildAttemptCount?: number;
    activeBinIdAtBuild?: number;
    lowerBinIdAtBuild?: number;
    upperBinIdAtBuild?: number;
    binSlippageBps?: number;
  }): LiveBroadcastResult => ({
    status: 'submitted',
    submissionId: input.signatures[input.signatures.length - 1] ?? '',
    idempotencyKey: input.idempotencyKey,
    confirmationSignature: input.signatures[input.signatures.length - 1],
    submissionIds: input.signatures,
    confirmationSignatures: input.signatures,
    batchStatus: input.batchStatus ?? 'complete',
    reason: input.reason,
    mainExecutionStatus: input.mainExecutionStatus,
    residualSweepStatus: input.residualSweepStatus,
    residualUnsoldMints: input.residualUnsoldMints,
    residualUnsoldAmountsRaw: input.residualUnsoldAmountsRaw,
    residualIgnoredMints: input.residualIgnoredMints,
    residualFailureReasons: input.residualFailureReasons,
    residualEstimatedValueSol: input.residualEstimatedValueSol,
    openIntentId: input.openIntentId,
    positionId: input.positionId,
    chainPositionAddress: input.chainPositionAddress,
    rebuildAttemptCount: input.rebuildAttemptCount,
    activeBinIdAtBuild: input.activeBinIdAtBuild,
    lowerBinIdAtBuild: input.lowerBinIdAtBuild,
    upperBinIdAtBuild: input.upperBinIdAtBuild,
    binSlippageBps: input.binSlippageBps
  });
  const buildFailedBroadcastResult = (input: {
    idempotencyKey: string;
    reason: string;
    retryable?: boolean;
    executionFailureKind?: string;
    executionFailureOperation?: string;
    rebuildAttemptCount?: number;
    activeBinIdAtBuild?: number;
    lowerBinIdAtBuild?: number;
    upperBinIdAtBuild?: number;
    binSlippageBps?: number;
    targetCooldownMs?: number;
  }): LiveBroadcastResult => ({
    status: 'failed',
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    retryable: input.retryable ?? true,
    executionFailureKind: input.executionFailureKind,
    executionFailureOperation: input.executionFailureOperation,
    rebuildAttemptCount: input.rebuildAttemptCount,
    activeBinIdAtBuild: input.activeBinIdAtBuild,
    lowerBinIdAtBuild: input.lowerBinIdAtBuild,
    upperBinIdAtBuild: input.upperBinIdAtBuild,
    binSlippageBps: input.binSlippageBps,
    targetCooldownMs: input.targetCooldownMs
  });
  const buildDryRunSignature = (signedTransactionBase64: string) => {
    const digest = createHash('sha512')
      .update('lightld-paper-dry-run-v1')
      .update(signedTransactionBase64)
      .digest();
    return encodeBase58(digest);
  };
  const buildDryRunAddress = (seed: string) => {
    const digest = createHash('sha256')
      .update('lightld-paper-position-v1')
      .update(seed)
      .digest();
    return encodeBase58(digest);
  };
  const computePaperPositionValueSol = (input: {
    entrySol: number;
    activeBinIdAtOpen?: number;
    lowerBinId?: number;
    upperBinId?: number;
    currentActiveBinId: number;
    solSide?: 'tokenX' | 'tokenY';
  }) => {
    if (!Number.isFinite(input.entrySol) || input.entrySol <= 0) {
      return undefined;
    }
    if (
      typeof input.activeBinIdAtOpen !== 'number' ||
      typeof input.lowerBinId !== 'number' ||
      typeof input.upperBinId !== 'number' ||
      typeof input.solSide !== 'string'
    ) {
      return input.entrySol;
    }

    const width = Math.max(1, input.upperBinId - input.lowerBinId);
    const openOffset = input.solSide === 'tokenX'
      ? input.activeBinIdAtOpen - input.lowerBinId
      : input.upperBinId - input.activeBinIdAtOpen;
    const currentOffset = input.solSide === 'tokenX'
      ? input.currentActiveBinId - input.lowerBinId
      : input.upperBinId - input.currentActiveBinId;
    const deltaBins = currentOffset - openOffset;
    const drift = deltaBins / width;
    const boundedDrift = Math.max(-1.5, Math.min(1.5, drift));
    const value = input.entrySol * (1 + boundedDrift * 0.18);
    return Math.max(0, Math.round(value * 1_000_000_000) / 1_000_000_000);
  };
  const inferSolSideFromBuildRange = (input: {
    activeBinIdAtBuild?: number;
    lowerBinIdAtBuild?: number;
    upperBinIdAtBuild?: number;
  }): 'tokenX' | 'tokenY' | undefined => {
    if (
      typeof input.activeBinIdAtBuild !== 'number' ||
      typeof input.lowerBinIdAtBuild !== 'number' ||
      typeof input.upperBinIdAtBuild !== 'number'
    ) {
      return undefined;
    }

    if (input.activeBinIdAtBuild === input.lowerBinIdAtBuild) {
      return 'tokenX';
    }
    if (input.activeBinIdAtBuild === input.upperBinIdAtBuild) {
      return 'tokenY';
    }
    return undefined;
  };
  const backfillPaperPositionOpenEvidence = (
    position: PaperDryRunPosition,
    submissions: SubmissionStore
  ): PaperDryRunPosition => {
    if (
      typeof position.entrySol === 'number' &&
      typeof position.activeBinIdAtOpen === 'number' &&
      typeof position.lowerBinId === 'number' &&
      typeof position.upperBinId === 'number' &&
      position.solSide
    ) {
      return position;
    }

    const match = submissions.submissions.find((entry) => {
      const intent = entry.signedIntent.intent;
      const result = entry.result;
      if (intent.side !== 'add-lp' || result?.status !== 'submitted') {
        return false;
      }

      return (result.chainPositionAddress && result.chainPositionAddress === position.chainPositionAddress)
        || (intent.openIntentId && intent.openIntentId === position.openIntentId)
        || (intent.positionId && intent.positionId === position.positionId);
    });

    if (!match?.result) {
      return position;
    }

    const result = match.result;
    const inferredSolSide = inferSolSideFromBuildRange({
      activeBinIdAtBuild: result.activeBinIdAtBuild,
      lowerBinIdAtBuild: result.lowerBinIdAtBuild,
      upperBinIdAtBuild: result.upperBinIdAtBuild
    });

    return {
      ...position,
      entrySol: position.entrySol ?? match.signedIntent.intent.outputSol,
      activeBinIdAtOpen: position.activeBinIdAtOpen ?? result.activeBinIdAtBuild,
      activeBinId: position.activeBinId ?? result.activeBinIdAtBuild,
      lowerBinId: position.lowerBinId ?? result.lowerBinIdAtBuild,
      upperBinId: position.upperBinId ?? result.upperBinIdAtBuild,
      binSlippageBps: position.binSlippageBps ?? result.binSlippageBps,
      solSide: position.solSide ?? inferredSolSide
    };
  };
  const revaluePaperDryRunState = async (paperState: PaperDryRunState): Promise<PaperDryRunState> => {
    if (
      !dryRun ||
      !options.dlmmClient ||
      typeof options.dlmmClient.getPoolPriceSnapshot !== 'function' ||
      paperState.positions.length === 0
    ) {
      return paperState;
    }

    let changed = false;
    const updatedPositions: PaperDryRunPosition[] = [];
    const submissions = await store.read();
    for (const position of paperState.positions) {
      const positionWithEvidence = backfillPaperPositionOpenEvidence(position, submissions);
      if (
        typeof positionWithEvidence.entrySol !== 'number' ||
        typeof positionWithEvidence.activeBinIdAtOpen !== 'number' ||
        typeof positionWithEvidence.lowerBinId !== 'number' ||
        typeof positionWithEvidence.upperBinId !== 'number' ||
        !positionWithEvidence.solSide
      ) {
        const next = {
          ...positionWithEvidence,
          valuationStatus: 'unavailable' as const,
          valuationReason: 'paper-open-bin-evidence-missing',
          valuationSource: 'paper-dry-run-overlay',
          updatedAt: new Date().toISOString()
        };
        changed = changed
          || JSON.stringify(next) !== JSON.stringify(position);
        updatedPositions.push(next);
        continue;
      }

      try {
        const pool = await options.dlmmClient.getPoolPriceSnapshot(positionWithEvidence.poolAddress);
        const currentValueSol = computePaperPositionValueSol({
          entrySol: positionWithEvidence.entrySol,
          activeBinIdAtOpen: positionWithEvidence.activeBinIdAtOpen,
          lowerBinId: positionWithEvidence.lowerBinId,
          upperBinId: positionWithEvidence.upperBinId,
          currentActiveBinId: pool.activeBinId,
          solSide: positionWithEvidence.solSide
        }) ?? positionWithEvidence.currentValueSol;
        const next = {
          ...positionWithEvidence,
          activeBinId: pool.activeBinId,
          currentValueSol,
          valuationStatus: 'ready' as const,
          valuationReason: '',
          valuationSource: 'paper-shadow-dlmm-active-bin-modeled',
          updatedAt: new Date().toISOString()
        };
        changed = changed
          || JSON.stringify(positionWithEvidence) !== JSON.stringify(position)
          || next.currentValueSol !== position.currentValueSol
          || next.activeBinId !== position.activeBinId
          || next.valuationSource !== position.valuationSource
          || next.solSide !== position.solSide;
        updatedPositions.push(next);
      } catch (error) {
        const next = {
          ...positionWithEvidence,
          valuationStatus: 'unavailable' as const,
          valuationReason: error instanceof Error ? error.message : String(error),
          valuationSource: position.valuationSource ?? 'paper-shadow-dlmm-active-bin-modeled',
          updatedAt: new Date().toISOString()
        };
        changed = changed
          || next.valuationStatus !== position.valuationStatus
          || next.valuationReason !== position.valuationReason
          || next.valuationSource !== position.valuationSource;
        updatedPositions.push(next);
      }
    }

    const nextStore = { ...paperState, positions: updatedPositions };
    if (changed) {
      await paperDryRunStore.write(nextStore);
    }
    return nextStore;
  };
  const revaluePaperDryRunTokens = async (paperState: PaperDryRunState): Promise<PaperDryRunState> => {
    if (!dryRun || paperState.tokens.length === 0) {
      return paperState;
    }

    const now = Date.now();
    let remainingQuoteBudget = ACCOUNT_STATE_TOKEN_VALUE_MAX_QUOTES_PER_REQUEST;
    let changed = false;
    const tokens: PaperDryRunToken[] = [];
    for (const token of paperState.tokens) {
      const lastValuationMs = token.lastValuationAt ? Date.parse(token.lastValuationAt) : Number.NaN;
      if (
        Number.isFinite(lastValuationMs)
        && now - lastValuationMs <= ACCOUNT_STATE_TOKEN_VALUE_CACHE_TTL_MS
      ) {
        tokens.push(token);
        continue;
      }
      if (remainingQuoteBudget <= 0) {
        tokens.push(token);
        continue;
      }
      remainingQuoteBudget -= 1;

      const valuedAt = new Date().toISOString();
      try {
        const currentValueSol = await resolveTokenCurrentValueSol({
          swapProviderChain,
          walletPublicKey,
          mint: token.mint,
          amountLamports: token.amountRaw,
          defaultSlippageBps: token.maxSlippageBps ?? defaultSlippageBps,
          maxImpactBps: token.maxImpactBps,
          poolAddress: token.poolAddress,
          skipBalanceDependentProviders: true
        });
        if (typeof currentValueSol !== 'number') {
          throw new Error('paper sell quote did not include a valid SOL output amount');
        }
        tokens.push({
          ...token,
          currentValueSol,
          valuationStatus: 'ready',
          valuationReason: '',
          lastValuationAt: valuedAt,
          updatedAt: valuedAt
        });
      } catch (error) {
        tokens.push({
          ...token,
          currentValueSol: undefined,
          valuationStatus: 'unavailable',
          valuationReason: error instanceof Error ? error.message : String(error),
          lastValuationAt: valuedAt,
          updatedAt: valuedAt
        });
      }
      changed = true;
    }

    if (!changed) {
      return paperState;
    }
    const nextStore = { ...paperState, tokens };
    await paperDryRunStore.write(nextStore);
    return nextStore;
  };
  const computePaperSolDepletedBins = (position: PaperDryRunPosition) => {
    if (
      typeof position.lowerBinId !== 'number' ||
      typeof position.upperBinId !== 'number' ||
      typeof position.activeBinId !== 'number'
    ) {
      return 0;
    }

    if (position.solSide === 'tokenX') {
      return Math.max(0, Math.min(position.upperBinId - position.lowerBinId + 1, position.activeBinId - position.lowerBinId));
    }

    return Math.max(0, Math.min(position.upperBinId - position.lowerBinId + 1, position.upperBinId - position.activeBinId));
  };
  const toPaperLpPosition = (position: PaperDryRunPosition): AccountStateLpPosition => ({
    poolAddress: position.poolAddress,
    positionAddress: position.positionAddress,
    chainPositionAddress: position.chainPositionAddress,
    positionId: position.positionId,
    openIntentId: position.openIntentId,
    mint: position.mint,
    lowerBinId: position.lowerBinId ?? 0,
    upperBinId: position.upperBinId ?? 68,
    activeBinId: position.activeBinId ?? position.activeBinIdAtOpen ?? 34,
    binCount: typeof position.lowerBinId === 'number' && typeof position.upperBinId === 'number'
      ? Math.max(0, position.upperBinId - position.lowerBinId + 1)
      : 69,
    fundedBinCount: 69,
    solSide: position.solSide ?? 'tokenX',
    solDepletedBins: computePaperSolDepletedBins(position),
    currentValueSol: position.currentValueSol,
    displayValueSol: position.currentValueSol,
    // The position was intentionally not created on chain, therefore this is
    // not an executable withdraw quote and must never drive TP/SL decisions.
    valuationTrust: 'fallback_display',
    valuationCompleteness: 'untrusted',
    positionStatus: 'active',
    hasLiquidity: true,
    hasClaimableFees: false,
    valuationStatus: position.valuationStatus ?? 'ready',
    valuationReason: position.valuationReason ?? '',
    valuationSource: position.valuationSource ?? 'paper-dry-run-overlay',
    lastValuationAt: position.updatedAt
  });
  const toPaperWalletToken = (token: PaperDryRunToken) => {
    const amountLamports = Number(token.amountRaw);
    return {
      mint: token.mint,
      symbol: '',
      // The overlay cannot infer SPL decimals from a transaction that was not
      // submitted. Presence and ownership use amountRaw; amount is therefore a
      // positive display fallback only.
      amount: Number.isFinite(amountLamports) ? amountLamports : 1,
      amountLamports: Number.isSafeInteger(amountLamports) ? amountLamports : undefined,
      amountRaw: token.amountRaw,
      currentValueSol: token.currentValueSol,
      valuationStatus: token.valuationStatus,
      valuationReason: token.valuationReason,
      valuationSource: 'paper-executable-sell-quote',
      lastValuationAt: token.lastValuationAt,
      poolAddress: token.poolAddress,
      openIntentId: token.openIntentId,
      positionId: token.positionId
    };
  };
  const simulateDryRunRawTransaction = async (signedTransactionBase64: string) => {
    const simulator = rpcClient as SolanaRpcClient & {
      simulateRawTransaction?: (
        base64Transaction: string
      ) => Promise<{ value: { err: unknown | null; logs?: string[] | null } }>;
    };

    if (typeof simulator.simulateRawTransaction !== 'function') {
      throw new Error('Solana dry-run simulation unavailable: rpcClient.simulateRawTransaction is not configured');
    }

    let result: { value: { err: unknown | null; logs?: string[] | null } };
    try {
      result = await simulator.simulateRawTransaction(signedTransactionBase64);
    } catch (error) {
      throw classifyOperationError(error, 'rpc-simulate');
    }
    if (result.value.err) {
      const logs = Array.isArray(result.value.logs) ? result.value.logs.filter(Boolean) : [];
      const logSuffix = logs.length > 0 ? `; simulationLogs=${logs.slice(-12).join(' | ')}` : '';
      const rawReason = `Solana dry-run simulation failed: ${JSON.stringify(result.value.err)}${logSuffix}`;
      if (isDlmmBinSlippageMessage(rawReason)) {
        throw new StructuredExecutionError(`rpc-simulate-dlmm-bin-slippage: ${rawReason}`, {
          executionFailureKind: 'dlmm_bin_slippage',
          executionFailureOperation: 'rpc-simulate',
          retryable: true
        });
      }
      throw new Error(rawReason);
    }

    return buildDryRunSignature(signedTransactionBase64);
  };
  const submitRawTransaction = async (
    signedIntent: SignedBroadcastIntent,
    signedTransactionBase64: string
  ) => {
    if (dryRun) {
      if (hasVirtualPaperBalance) {
        return buildDryRunSignature(signedTransactionBase64);
      }
      return simulateDryRunRawTransaction(signedTransactionBase64);
    }

    // Persist the signed transaction identity before invoking sendTransaction.
    // Therefore a prior-instance `reserved` record proves the send boundary
    // was never crossed, while `broadcast_started` is always fail-closed and
    // carries the signature needed for confirmation/reconciliation.
    const evidence = await markIdempotencyBroadcastStarted(signedIntent, signedTransactionBase64);

    const visibilitySender = rpcClient as SolanaRpcClient & {
      sendRawTransactionAndWaitForVisibility?: (
        base64Transaction: string
      ) => Promise<{ signature: string }>;
    };

    if (typeof visibilitySender.sendRawTransactionAndWaitForVisibility === 'function') {
      try {
        const signature = (await visibilitySender.sendRawTransactionAndWaitForVisibility(signedTransactionBase64)).signature;
        try {
          await markIdempotencyBroadcastAccepted(signedIntent, evidence.transactionHash, signature);
        } catch (error) {
          throw new UnknownBroadcastOutcomeError(error);
        }
        return signature;
      } catch (error) {
        const classified = classifyOperationError(error, 'rpc-send');
        if (isDefiniteRpcSendRejection(classified)) {
          throw classified;
        }
        // A timeout/transport failure after sendTransaction started does not
        // prove that the cluster rejected the signed transaction. Keep the
        // execution idempotency reservation pending so the daemon cannot build
        // a fresh transaction and accidentally perform the economic action
        // twice.
        throw new UnknownBroadcastOutcomeError(classified);
      }
    }

    try {
      const signature = await rpcClient.sendRawTransaction(signedTransactionBase64);
      try {
        await markIdempotencyBroadcastAccepted(signedIntent, evidence.transactionHash, signature);
      } catch (error) {
        throw new UnknownBroadcastOutcomeError(error);
      }
      return signature;
    } catch (error) {
      const classified = classifyOperationError(error, 'rpc-send');
      if (isDefiniteRpcSendRejection(classified)) {
        throw classified;
      }
      throw new UnknownBroadcastOutcomeError(classified);
    }
  };
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
    return withSubmissionStoreMutation(async () => {
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

        if (
          existing.status === 'pending'
          && existing.phase === 'reserved'
          && existing.reservationOwnerId
          && existing.reservationOwnerId !== executionInstanceId
        ) {
          const now = new Date().toISOString();
          await store.write({
            submissions: snapshot.submissions.map((submission) =>
              submission.idempotencyKey === idempotencyKey
                ? {
                    ...submission,
                    reservationOwnerId: executionInstanceId,
                    updatedAt: now
                  }
                : submission
            )
          });
          return {
            status: 'reserved' as const,
            recovered: true as const
          };
        }

        return {
          status: 'pending' as const,
          phase: existing.phase,
          broadcastEvidence: existing.broadcastEvidence ?? []
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
            phase: 'reserved',
            reservationOwnerId: executionInstanceId,
            broadcastEvidence: [],
            receivedAt: now,
            updatedAt: now
          }
        ]
      });

      return {
        status: 'reserved' as const
      };
    });
  };

  const markIdempotencyBroadcastStarted = async (
    signedIntent: SignedBroadcastIntent,
    signedTransactionBase64: string
  ) => {
    const transactionHash = createHash('sha256')
      .update(Buffer.from(signedTransactionBase64, 'base64'))
      .digest('hex');
    const transactionSignature = extractPrimarySolanaTransactionSignature(signedTransactionBase64);

    await withSubmissionStoreMutation(async () => {
      const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
      const idempotencyKey = signedIntent.intent.idempotencyKey;
      const snapshot = await store.read();
      const existing = snapshot.submissions.find(
        (submission) => submission.idempotencyKey === idempotencyKey
      );
      if (
        !existing
        || existing.status !== 'pending'
        || existing.signedIntentFingerprint !== signedIntentFingerprint
        || existing.reservationOwnerId !== executionInstanceId
      ) {
        throw new Error(`Cannot persist broadcast boundary for unowned reservation ${idempotencyKey}`);
      }

      const now = new Date().toISOString();
      const evidence = existing.broadcastEvidence ?? [];
      const alreadyRecorded = evidence.some((entry) => entry.transactionHash === transactionHash);
      await store.write({
        submissions: snapshot.submissions.map((submission) =>
          submission.idempotencyKey === idempotencyKey
            ? {
                ...submission,
                phase: 'broadcast_started' as const,
                broadcastEvidence: alreadyRecorded
                  ? evidence
                  : [
                      ...evidence,
                      {
                        transactionHash,
                        transactionSignature,
                        sendStartedAt: now
                      }
                    ],
                updatedAt: now
              }
            : submission
        )
      });
    });

    return { transactionHash, transactionSignature };
  };

  const markIdempotencyBroadcastAccepted = async (
    signedIntent: SignedBroadcastIntent,
    transactionHash: string,
    rpcAcceptedSignature: string
  ) => {
    await withSubmissionStoreMutation(async () => {
      const signedIntentFingerprint = signedIntentIdempotencyFingerprint(signedIntent);
      const idempotencyKey = signedIntent.intent.idempotencyKey;
      const snapshot = await store.read();
      const existing = snapshot.submissions.find(
        (submission) => submission.idempotencyKey === idempotencyKey
      );
      if (
        !existing
        || existing.status !== 'pending'
        || existing.signedIntentFingerprint !== signedIntentFingerprint
        || existing.reservationOwnerId !== executionInstanceId
      ) {
        throw new Error(`Cannot persist accepted broadcast for unowned reservation ${idempotencyKey}`);
      }

      const evidence = existing.broadcastEvidence ?? [];
      const matched = evidence.some((entry) => entry.transactionHash === transactionHash);
      if (!matched) {
        throw new Error(`Cannot persist accepted broadcast without send evidence for ${idempotencyKey}`);
      }
      const now = new Date().toISOString();
      await store.write({
        submissions: snapshot.submissions.map((submission) =>
          submission.idempotencyKey === idempotencyKey
            ? {
                ...submission,
                phase: 'broadcast_started' as const,
                broadcastEvidence: evidence.map((entry) =>
                  entry.transactionHash === transactionHash
                    ? {
                        ...entry,
                        rpcAcceptedSignature,
                        rpcAcceptedAt: now
                      }
                    : entry
                ),
                updatedAt: now
              }
            : submission
        )
      });
    });
  };

  const completeIdempotencySubmission = async (
    signedIntent: SignedBroadcastIntent,
    result: LiveBroadcastResult
  ) => {
    await withSubmissionStoreMutation(async () => {
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
    });
  };

  const releaseIdempotencyReservation = async (signedIntent: SignedBroadcastIntent) => {
    await withSubmissionStoreMutation(async () => {
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
              solBalance,
              dryRun
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

            const requiredExecutionPolicy = dryRun ? 'simulate-only' : 'broadcast';
            if (intent.executionPolicy !== requiredExecutionPolicy) {
              writeJson(response, 409, {
                error: 'execution policy mismatch',
                detail: `Signed intent requires ${intent.executionPolicy ?? 'missing'} but this service is ${requiredExecutionPolicy}`
              });
              return;
            }

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
                const recoverableSignatures = reservation.broadcastEvidence
                  .map((evidence) => evidence.rpcAcceptedSignature ?? evidence.transactionSignature)
                  .filter((signature): signature is string => Boolean(signature));
                if (recoverableSignatures.length > 0) {
                  // Do not rebroadcast an outcome-unknown signed transaction.
                  // Return its durable transaction id so the caller can move
                  // into the normal confirmation path instead of being stuck
                  // behind an opaque 409 forever. The pending store entry is
                  // deliberately retained until a later result is proven.
                  writeJson(response, 200, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: [...new Set(recoverableSignatures)],
                    batchStatus: 'partial',
                    reason: 'broadcast-outcome-unknown',
                    openIntentId: intent.openIntentId,
                    positionId: intent.positionId,
                    chainPositionAddress: intent.chainPositionAddress
                  }));
                  return;
                }
                writeJson(response, 409, {
                  error: 'idempotency key pending',
                  detail: `Submission ${intent.idempotencyKey} crossed an unknown or legacy boundary without a queryable transaction signature`,
                  phase: reservation.phase ?? 'legacy_unknown',
                  broadcastEvidence: reservation.broadcastEvidence
                });
                return;
              }

              if (reservation.status === 'replay') {
                writeJson(response, 200, reservation.result);
                return;
              }

            const side = intent.side ?? 'buy';
            const lifecycleResultIdentity = {
              openIntentId: intent.openIntentId,
              positionId: intent.positionId,
              chainPositionAddress: intent.chainPositionAddress
            };
            const tokenMint = intent.tokenMint || intent.poolAddress;
            let buildMs: number | undefined;
            let quoteMs: number | undefined;
            let swapBuildMs: number | undefined;
            let signMs: number | undefined;
            let blockhashMs: number | undefined;
            const sendTxMs: number[] = [];
            let visibleBroadcastRecorded = false;
            let swapProviderName: string | undefined;
            let swapProviderAttempts: SwapProviderAttempt[] | undefined;
            let builtChainPositionAddress: string | undefined;
            let rebuildAttemptCount = 0;
            let activeBinIdAtBuild: number | undefined;
            let lowerBinIdAtBuild: number | undefined;
            let upperBinIdAtBuild: number | undefined;
            let binSlippageBps: number | undefined;
            let solSideAtBuild: 'tokenX' | 'tokenY' | undefined;
            const resolveAddLpPositionAddress = (result: any) => {
              const returnedAddress = typeof result?.positionAddress === 'string' && result.positionAddress.trim().length > 0
                ? result.positionAddress.trim()
                : undefined;
              const signerAddress = result?.newPositionKeypair?.publicKey?.toBase58?.();

              if (returnedAddress && signerAddress && returnedAddress !== signerAddress) {
                throw new StructuredExecutionError(
                  `DLMM add-liquidity position identity mismatch: returned ${returnedAddress}, signer ${signerAddress}`,
                  {
                    executionFailureKind: 'dlmm_position_identity_mismatch',
                    executionFailureOperation: 'dlmm-build',
                    retryable: false
                  }
                );
              }

              const builtAddress = returnedAddress ?? signerAddress;
              if (
                intent.chainPositionAddress
                && builtAddress
                && intent.chainPositionAddress !== builtAddress
              ) {
                throw new StructuredExecutionError(
                  `DLMM add-liquidity position identity mismatch: intent ${intent.chainPositionAddress}, built ${builtAddress}`,
                  {
                    executionFailureKind: 'dlmm_position_identity_mismatch',
                    executionFailureOperation: 'dlmm-build',
                    retryable: false
                  }
                );
              }

              const resolvedAddress = builtAddress ?? intent.chainPositionAddress;
              if (resolvedAddress) {
                return resolvedAddress;
              }
              if (dryRun) {
                return buildDryRunAddress(`${intent.idempotencyKey}:${intent.poolAddress}:${tokenMint}`);
              }

              throw new StructuredExecutionError(
                'DLMM add-liquidity build did not return the chain position address',
                {
                  executionFailureKind: 'dlmm_position_identity_missing',
                  executionFailureOperation: 'dlmm-build',
                  retryable: false
                }
              );
            };

            try {
              let signedBase64 = '';

              if (side === 'buy' || side === 'sell') {
                let inputMint: string;
                let outputMint: string;
                let amountLamports: string;

                if (side === 'buy') {
                  inputMint = SOL_MINT;
                  outputMint = tokenMint;
                  amountLamports = String(Math.floor(intent.outputSol * LAMPORTS_PER_SOL));
                } else {
                  if (!intent.fullPositionExit) {
                    throw new Error('Sell intent must explicitly declare fullPositionExit=true');
                  }

                  let availableRaw: bigint;
                  if (dryRun) {
                    // Paper is a strategy-owned overlay. Never let a simulated
                    // exit discover or consume an unrelated real-wallet token.
                    const paperInventory = await paperDryRunStore.readSellableToken({
                      mint: tokenMint,
                      poolAddress: intent.poolAddress,
                      openIntentId: intent.openIntentId,
                      positionId: intent.positionId
                    });
                    availableRaw = paperInventory.amountRaw;
                    if (availableRaw <= 0n) {
                      throw new StructuredExecutionError(
                        `No paper token overlay found for mint ${tokenMint} in pool ${intent.poolAddress}`,
                        {
                          executionFailureKind: 'paper_inventory_missing',
                          executionFailureOperation: 'paper-sell-ownership',
                          retryable: false
                        }
                      );
                    }
                  } else {
                    // Live sells only the amount explicitly owned by this
                    // strategy when supplied. This branch is intentionally
                    // unchanged by the paper overlay.
                    const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
                    const matchingAccounts = tokenAccounts.filter(
                      (account) => account.account.data.parsed.info.mint === tokenMint
                    );
                    if (matchingAccounts.length === 0) {
                      throw new Error(`No token account found for mint ${tokenMint}`);
                    }
                    availableRaw = matchingAccounts.reduce((total, account) => {
                      const raw = String(account.account.data.parsed.info.tokenAmount.amount ?? '0');
                      if (!/^\d+$/.test(raw)) {
                        throw new Error(`Invalid token balance for mint ${tokenMint}`);
                      }
                      return total + BigInt(raw);
                    }, 0n);
                    if (availableRaw <= 0n) {
                      throw new Error(`Token balance is zero for mint ${tokenMint}`);
                    }
                  }

                  const requestedRaw = intent.inputAmountRaw ? BigInt(intent.inputAmountRaw) : availableRaw;
                  if (requestedRaw > availableRaw) {
                    throw new StructuredExecutionError(
                      `Requested token amount exceeds ${dryRun ? 'paper overlay' : 'wallet'} balance for mint ${tokenMint}: requested=${requestedRaw} available=${availableRaw}`,
                      dryRun
                        ? {
                            executionFailureKind: 'paper_inventory_insufficient',
                            executionFailureOperation: 'paper-sell-ownership',
                            retryable: false
                          }
                        : {}
                    );
                  }

                  inputMint = tokenMint;
                  outputMint = SOL_MINT;
                  amountLamports = requestedRaw.toString();
                }

                const swapStartedAt = Date.now();
                const swapRequest = {
                  inputMint,
                  outputMint,
                  amountLamports,
                  walletPublicKey,
                  poolAddress: intent.poolAddress || undefined,
                  slippageBps: intent.maxSlippageBps ?? defaultSlippageBps,
                  maxImpactBps: intent.maxImpactBps,
                  jitoTipLamports: options.jitoTipLamports,
                  skipBalanceDependentProviders: dryRun && side === 'sell'
                };
                // A paper buy can build, sign and simulate the exact live
                // transaction because its input SOL exists on chain. After
                // that buy is deliberately not broadcast, the synthetic token
                // cannot be used to simulate a later sell against the real
                // wallet. Use the exact same executable quote/risk checks for
                // that sell and settle only the paper overlay.
                const paperQuoteOnlySell = dryRun && side === 'sell';
                const swapResult = paperQuoteOnlySell
                  ? await swapProviderChain.quoteExactIn(swapRequest)
                  : await swapProviderChain.executeExactIn(
                      swapRequest,
                      {
                        keypair,
                        rpcClient,
                        sendRawTransaction: async (signedTransactionBase64) => {
                          const sendStartedAt = Date.now();
                          const signature = await submitRawTransaction(payload.intent, signedTransactionBase64);
                          if (!dryRun) {
                            visibleBroadcastRecorded = true;
                          }
                          sendTxMs.push(durationMs(sendStartedAt));
                          return signature;
                        }
                      }
                    );
                swapBuildMs = durationMs(swapStartedAt);
                swapProviderName = swapResult.providerName;
                swapProviderAttempts = swapResult.providerAttempts;
                if (!dryRun) {
                  visibleBroadcastRecorded = true;
                }

                let submissionSignature = 'signature' in swapResult && typeof swapResult.signature === 'string'
                  ? swapResult.signature
                  : '';
                const paperExecutionReason = side === 'sell'
                  ? 'paper-dry-run-quoted-shadow-settlement'
                  : 'paper-dry-run-simulated';
                if (dryRun) {
                  if (!/^\d+$/.test(swapResult.outAmountLamports) || BigInt(swapResult.outAmountLamports) <= 0n) {
                    throw new Error(`Paper ${side} quote returned invalid output amount ${swapResult.outAmountLamports}`);
                  }
                  const recordedAt = new Date().toISOString();
                  if (side === 'buy') {
                    await paperDryRunStore.applyTokenBuy({
                      idempotencyKey: intent.idempotencyKey,
                      strategyId: intent.strategyId,
                      poolAddress: intent.poolAddress,
                      mint: tokenMint,
                      openIntentId: intent.openIntentId,
                      positionId: intent.positionId,
                      amountRaw: swapResult.outAmountLamports,
                      inputSol: Number(BigInt(amountLamports)) / LAMPORTS_PER_SOL,
                      maxSlippageBps: intent.maxSlippageBps ?? defaultSlippageBps,
                      maxImpactBps: intent.maxImpactBps,
                      recordedAt
                    });
                  } else {
                    await paperDryRunStore.applyTokenSell({
                      idempotencyKey: intent.idempotencyKey,
                      mint: tokenMint,
                      poolAddress: intent.poolAddress,
                      openIntentId: intent.openIntentId,
                      positionId: intent.positionId,
                      amountRaw: amountLamports,
                      outputSol: Number(BigInt(swapResult.outAmountLamports)) / LAMPORTS_PER_SOL,
                      recordedAt
                    });
                  }
                  const signatureSeed = Buffer.from(
                    `${intent.idempotencyKey}:${side}:${tokenMint}:${amountLamports}`,
                    'utf8'
                  ).toString('base64');
                  submissionSignature = buildDryRunSignature(signatureSeed);
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
                  result: 'submitted',
                  acceptedSignatureCount: 1,
                  quoteMs,
                  swapBuildMs,
                  signMs,
                  sendTxMs,
                  totalMs: durationMs(broadcastStartedAt),
                  swapProvider: swapProviderName,
                  swapProviderAttempts: describeSwapProviderAttempts(swapProviderAttempts),
                  reason: dryRun ? paperExecutionReason : undefined,
                  dryRun
                });

                await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                  idempotencyKey: intent.idempotencyKey,
                  signatures: [submissionSignature],
                  reason: dryRun ? paperExecutionReason : undefined,
                  mainExecutionStatus: dryRun ? 'confirmed' : undefined,
                  ...lifecycleResultIdentity
                }));
                return;
              } else {
                if (dryRun && side === 'withdraw-lp') {
                  await revaluePaperDryRunState(await paperDryRunStore.read());
                  const closed = await paperDryRunStore.closePosition({
                    chainPositionAddress: intent.chainPositionAddress,
                    positionId: intent.positionId,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint
                  });
                  if (!closed) {
                    throw new StructuredExecutionError(
                      `No paper LP overlay matched withdraw identity for pool ${intent.poolAddress}`,
                      {
                        executionFailureKind: 'paper_lp_inventory_missing',
                        executionFailureOperation: 'paper-withdraw-ownership',
                        retryable: false
                      }
                    );
                  }
                  const dryRunChainPositionAddress = intent.chainPositionAddress ?? closed.chainPositionAddress;
                  const reason = 'paper-dry-run-shadow-close';
                  const signatureSeed = Buffer.from(
                    `${intent.idempotencyKey}:${side}:${dryRunChainPositionAddress ?? intent.poolAddress}`,
                    'utf8'
                  ).toString('base64');
                  const signature = buildDryRunSignature(signatureSeed);

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
                    sendTxMs: [],
                    totalMs: durationMs(broadcastStartedAt),
                    reason,
                    dryRun
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: [signature],
                    batchStatus: 'complete',
                    reason,
                    mainExecutionStatus: 'confirmed',
                    ...lifecycleResultIdentity,
                    chainPositionAddress: dryRunChainPositionAddress
                  }));
                  return;
                }

                if (!options.dlmmClient) {
                  throw new Error('DLMM client not configured');
                }

                let txBatch: any[] = [];
                let signers: Keypair[] = [keypair];

              if (side === 'add-lp') {
                const buildStartedAt = Date.now();
                let result: any;
                try {
                  result = await options.dlmmClient.addLiquidityByStrategy(
                    keypair.publicKey,
                    intent.poolAddress,
                    intent.outputSol,
                    undefined,
                    {
                      allowDuplicatePosition: false,
                      slippageBps: intent.maxSlippageBps
                    }
                  );
                } catch (error) {
                  throw classifyOperationError(error, 'dlmm-build');
                }
                buildMs = durationMs(buildStartedAt);
                txBatch = toTransactionBatch(result.transaction);
                activeBinIdAtBuild = typeof result.activeBinId === 'number' ? result.activeBinId : activeBinIdAtBuild;
                lowerBinIdAtBuild = typeof result.lowerBinId === 'number' ? result.lowerBinId : lowerBinIdAtBuild;
                upperBinIdAtBuild = typeof result.upperBinId === 'number' ? result.upperBinId : upperBinIdAtBuild;
                binSlippageBps = typeof result.binSlippageBps === 'number' ? result.binSlippageBps : binSlippageBps;
                solSideAtBuild = result.solSide === 'tokenX' || result.solSide === 'tokenY' ? result.solSide : solSideAtBuild;
                if (result.newPositionKeypair) {
                  signers.push(result.newPositionKeypair);
                }
                builtChainPositionAddress = resolveAddLpPositionAddress(result);
              } else if (side === 'withdraw-lp') {
                const buildStartedAt = Date.now();
                txBatch = toTransactionBatch(await options.dlmmClient.removeLiquidity(
                  keypair.publicKey,
                  intent.poolAddress,
                  intent.chainPositionAddress
                ));
                buildMs = durationMs(buildStartedAt);
              } else if (side === 'claim-fee') {
                const buildStartedAt = Date.now();
                txBatch = toTransactionBatch(await options.dlmmClient.claimFee(
                  keypair.publicKey,
                  intent.poolAddress,
                  intent.chainPositionAddress
                ));
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

              for (let txIndex = 0; txIndex < txBatch.length; txIndex += 1) {
                const txParams = txBatch[txIndex];
                try {
                  txParams.recentBlockhash = blockhash.blockhash;
                  txParams.feePayer = keypair.publicKey;
                  txParams.sign(...signers);
                  signedBase64 = txParams.serialize().toString('base64');
                  const sendStartedAt = Date.now();
                  txSignatures.push(await submitRawTransaction(payload.intent, signedBase64));
                  // A successful paper simulation is not a chain-visible
                  // submission.  In particular, an earlier transaction in a
                  // dry-run batch must not strand the idempotency key when a
                  // later transaction fails simulation.
                  if (!dryRun) {
                    visibleBroadcastRecorded = true;
                  }
                  sendTxMs.push(durationMs(sendStartedAt));
                } catch (error) {
                  const failureMetadata = getExecutionFailureMetadata(error);
                  const canRebuildAddLp = side === 'add-lp'
                    && dryRunAddLpRebuildOnBinSlippage
                    && failureMetadata.executionFailureKind === 'dlmm_bin_slippage'
                    && rebuildAttemptCount < dryRunAddLpRebuildMaxAttempts
                    && txSignatures.length === 0;
                  if (canRebuildAddLp) {
                    rebuildAttemptCount += 1;
                    const rebuildStartedAt = Date.now();
                    let rebuilt: any;
                    try {
                      rebuilt = await options.dlmmClient.addLiquidityByStrategy(
                        keypair.publicKey,
                        intent.poolAddress,
                        intent.outputSol,
                        undefined,
                        {
                          allowDuplicatePosition: false,
                          slippageBps: intent.maxSlippageBps
                        }
                      );
                    } catch (buildError) {
                      throw classifyOperationError(buildError, 'dlmm-build');
                    }
                    buildMs = (buildMs ?? 0) + durationMs(rebuildStartedAt);
                    txBatch = toTransactionBatch(rebuilt.transaction);
                    signers = [keypair];
                    if (rebuilt.newPositionKeypair) {
                      signers.push(rebuilt.newPositionKeypair);
                    }
                    builtChainPositionAddress = resolveAddLpPositionAddress(rebuilt);
                    activeBinIdAtBuild = typeof rebuilt.activeBinId === 'number' ? rebuilt.activeBinId : activeBinIdAtBuild;
                    lowerBinIdAtBuild = typeof rebuilt.lowerBinId === 'number' ? rebuilt.lowerBinId : lowerBinIdAtBuild;
                    upperBinIdAtBuild = typeof rebuilt.upperBinId === 'number' ? rebuilt.upperBinId : upperBinIdAtBuild;
                    binSlippageBps = typeof rebuilt.binSlippageBps === 'number' ? rebuilt.binSlippageBps : binSlippageBps;
                    solSideAtBuild = rebuilt.solSide === 'tokenX' || rebuilt.solSide === 'tokenY' ? rebuilt.solSide : solSideAtBuild;
                    txIndex = -1;
                    continue;
                  }

                  if (dryRun || txSignatures.length === 0) {
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
                    reason,
                    dryRun
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    batchStatus: 'partial',
                    reason,
                    ...lifecycleResultIdentity,
                    ...(side === 'add-lp'
                      ? { chainPositionAddress: builtChainPositionAddress }
                      : {})
                  }));
                  return;
                }
              }

              if (dryRun) {
                const reason = side === 'withdraw-lp'
                  ? 'paper-dry-run-shadow-close'
                  : 'paper-dry-run-simulated';
                let dryRunChainPositionAddress = intent.chainPositionAddress;
                if (side === 'add-lp') {
                  dryRunChainPositionAddress = builtChainPositionAddress
                    ?? buildDryRunAddress(`${intent.idempotencyKey}:${intent.poolAddress}:${tokenMint}`);
                  await paperDryRunStore.upsertOpenPosition({
                    poolAddress: intent.poolAddress,
                    positionAddress: dryRunChainPositionAddress,
                    chainPositionAddress: dryRunChainPositionAddress,
                    positionId: intent.positionId,
                    openIntentId: intent.openIntentId,
                    mint: tokenMint,
                    entrySol: intent.outputSol,
                    activeBinIdAtOpen: activeBinIdAtBuild,
                    activeBinId: activeBinIdAtBuild,
                    lowerBinId: lowerBinIdAtBuild,
                    upperBinId: upperBinIdAtBuild,
                    binSlippageBps,
                    solSide: solSideAtBuild,
                    currentValueSol: intent.outputSol,
                    valuationStatus: 'ready',
                    valuationReason: '',
                    valuationSource: 'paper-dry-run-overlay',
                    openedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                  });
                } else if (side === 'withdraw-lp') {
                  await revaluePaperDryRunState(await paperDryRunStore.read());
                  const closed = await paperDryRunStore.closePosition({
                    chainPositionAddress: intent.chainPositionAddress,
                    positionId: intent.positionId,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint
                  });
                  dryRunChainPositionAddress = intent.chainPositionAddress ?? closed?.chainPositionAddress;
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
                  totalMs: durationMs(broadcastStartedAt),
                  reason,
                  dryRun,
                  rebuildAttemptCount,
                  activeBinIdAtBuild,
                  lowerBinIdAtBuild,
                  upperBinIdAtBuild,
                  binSlippageBps
                });

                await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                  idempotencyKey: intent.idempotencyKey,
                  signatures: txSignatures,
                  batchStatus: 'complete',
                  reason,
                  mainExecutionStatus: 'confirmed',
                  residualSweepStatus: (side === 'withdraw-lp' || side === 'claim-fee') && intent.liquidateResidualTokenToSol
                    ? 'complete'
                    : undefined,
                  ...lifecycleResultIdentity,
                  chainPositionAddress: dryRunChainPositionAddress,
                  rebuildAttemptCount,
                  activeBinIdAtBuild,
                  lowerBinIdAtBuild,
                  upperBinIdAtBuild,
                  binSlippageBps
                }));
                return;
              }

              if ((side === 'withdraw-lp' || side === 'claim-fee') && intent.liquidateResidualTokenToSol && intent.tokenMint) {
                const meteoraConfirmed = await waitForConfirmedSignatures(rpcClient, [...txSignatures]);

                if (!meteoraConfirmed) {
                  const reason = side + ' confirmation not visible before residual token liquidation';
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
                    reason,
                    ...lifecycleResultIdentity
                  }));
                  return;
                }

                const residualSweep = await liquidateResidualTokensToSol({
                  rpcClient,
                  swapProviderChain,
                  keypair,
                  walletPublicKey,
                  defaultSlippageBps: intent.maxSlippageBps ?? defaultSlippageBps,
                  maxImpactBps: intent.maxImpactBps,
                  jitoTipLamports: options.jitoTipLamports,
                  sendRawTransaction: (signedTransactionBase64) =>
                    submitRawTransaction(payload.intent, signedTransactionBase64),
                  sendTxMs,
                  acceptedSignatures: txSignatures,
                  poolAddressByMint: new Map([[intent.tokenMint, intent.poolAddress]]),
                  preExistingAmountRawByMint: typeof intent.preExitTokenAmountRaw === 'string'
                    ? new Map([[intent.tokenMint, intent.preExitTokenAmountRaw]])
                    : undefined,
                  residualTokenMinValueSol,
                  residualTokenDustMaxUiAmount
                });

                if (residualSweep.unsoldMints.length > 0) {
                  const reason = 'residual token sweep incomplete: '
                    + residualSweep.unsoldMints.join(',')
                    + (residualSweep.failureReasons.length > 0 ? ` (${residualSweep.failureReasons.join('; ')})` : '');

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
                    quoteMs,
                    swapBuildMs,
                    signMs,
                    blockhashMs,
                    sendTxMs,
                    totalMs: durationMs(broadcastStartedAt),
                    reason
                  });

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    batchStatus: 'complete',
                    reason,
                    mainExecutionStatus: 'confirmed',
                    residualSweepStatus: 'incomplete',
                    residualUnsoldMints: residualSweep.unsoldMints,
                    residualUnsoldAmountsRaw: residualSweep.unsoldAmountsRaw,
                    residualIgnoredMints: residualSweep.ignoredMints,
                    residualFailureReasons: residualSweep.failureReasons,
                    ...lifecycleResultIdentity
                  }));
                  return;
                }

                if (residualSweep.ignoredMints.length > 0) {
                  const reason = 'residual_dust_ignored: '
                    + residualSweep.ignoredMints.join(',')
                    + (residualSweep.ignoredReasons.length > 0 ? ` (${residualSweep.ignoredReasons.join('; ')})` : '');

                  console.info(JSON.stringify({
                    event: 'solana-execution-residual-sweep',
                    recordedAt: new Date().toISOString(),
                    strategyId: intent.strategyId,
                    idempotencyKey: intent.idempotencyKey,
                    side,
                    poolAddress: intent.poolAddress,
                    tokenMint: intent.tokenMint,
                    result: 'dust_ignored',
                    ignoredMints: residualSweep.ignoredMints,
                    reason
                  }));

                  await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                    idempotencyKey: intent.idempotencyKey,
                    signatures: txSignatures,
                    mainExecutionStatus: 'confirmed',
                    reason,
                    residualSweepStatus: 'dust_ignored',
                    residualIgnoredMints: residualSweep.ignoredMints,
                    residualFailureReasons: residualSweep.ignoredReasons,
                    ...lifecycleResultIdentity
                  }));
                  return;
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
                totalMs: durationMs(broadcastStartedAt),
                dryRun
              });

              await writeStoredBroadcastResult(response, payload.intent, buildSubmittedBroadcastResult({
                idempotencyKey: intent.idempotencyKey,
                signatures: txSignatures,
                mainExecutionStatus: (side === 'withdraw-lp' || side === 'claim-fee')
                  && intent.liquidateResidualTokenToSol
                  && Boolean(intent.tokenMint)
                    ? 'confirmed'
                    : undefined,
                residualSweepStatus: (side === 'withdraw-lp' || side === 'claim-fee')
                  && intent.liquidateResidualTokenToSol
                  && Boolean(intent.tokenMint)
                    ? 'complete'
                    : undefined,
                ...lifecycleResultIdentity,
                ...(side === 'add-lp'
                  ? { chainPositionAddress: builtChainPositionAddress }
                  : {})
              }));
              return;
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              const failureMetadata = getExecutionFailureMetadata(error);

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
                reason,
                swapProvider: swapProviderName,
                swapProviderAttempts: describeSwapProviderAttempts(swapProviderAttempts),
                dryRun,
                executionFailureKind: failureMetadata.executionFailureKind,
                executionFailureOperation: failureMetadata.executionFailureOperation,
                rebuildAttemptCount,
                activeBinIdAtBuild,
                lowerBinIdAtBuild,
                upperBinIdAtBuild,
                binSlippageBps
              });

              if (
                !visibleBroadcastRecorded
                && failureMetadata.executionFailureKind !== 'broadcast_outcome_unknown'
              ) {
                await releaseIdempotencyReservation(payload.intent);
                writeJson(response, 200, buildFailedBroadcastResult({
                  idempotencyKey: intent.idempotencyKey,
                  reason,
                  retryable: failureMetadata.retryable ?? true,
                  executionFailureKind: failureMetadata.executionFailureKind,
                  executionFailureOperation: failureMetadata.executionFailureOperation,
                  rebuildAttemptCount,
                  activeBinIdAtBuild,
                  lowerBinIdAtBuild,
                  upperBinIdAtBuild,
                  binSlippageBps,
                  targetCooldownMs: failureMetadata.executionFailureKind === 'dlmm_bin_slippage'
                    ? addLpBinSlippageCooldownMs
                    : undefined
                }));
                return;
              }

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
              const statuses = await rpcClient.getSignatureStatusesAcrossReadEndpoints([signature]);
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

          if (request.method === 'POST' && request.url === '/lp-entry-evidence') {
            const body = await readBody(request);
            const payload = LpEntryEvidenceRequestSchema.parse(JSON.parse(body));
            const evidence = await resolveLpEntryEvidence({
              rpcClient,
              walletAddress: payload.walletAddress || walletPublicKey,
              tokenMint: payload.tokenMint,
              poolAddress: payload.poolAddress,
              chainPositionAddress: payload.chainPositionAddress,
              openedAtHint: payload.openedAtHint,
              orderSignature: payload.orderSignature
            });
            writeJson(response, 200, evidence);
            return;
          }

          // Account state — query wallet SOL and token balances from RPC
          if (request.method === 'GET' && request.url === '/account-state') {
            if (dryRun) {
              let baseWalletSol: number;
              if (hasVirtualPaperBalance) {
                baseWalletSol = paperStartingSol;
              } else {
                try {
                  // The legacy dry-run mode deliberately mirrors the signer
                  // balance. An explicitly configured paper balance never
                  // reads or consumes real-wallet capital.
                  baseWalletSol = (await rpcClient.getBalance(walletPublicKey)) / LAMPORTS_PER_SOL;
                } catch (error) {
                  writeJson(response, 503, accountStateUnavailablePayload(error));
                  return;
                }
              }
              const paperState = await revaluePaperDryRunTokens(
                await revaluePaperDryRunState(await paperDryRunStore.read())
              );
              const walletSol = baseWalletSol + paperState.walletSolDelta;
              const walletLpPositions = paperState.positions.map(toPaperLpPosition);
              const walletTokens = paperState.tokens.map(toPaperWalletToken);
              writeJson(response, 200, {
                observedAt: new Date().toISOString(),
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

            let lamports: number;
            try {
              lamports = await rpcClient.getBalance(walletPublicKey);
            } catch (error) {
              writeJson(response, 503, accountStateUnavailablePayload(error));
              return;
            }
            let walletSol = lamports / LAMPORTS_PER_SOL;

            let walletTokens: {
              mint: string;
              symbol: string;
              amount: number;
              amountLamports: number;
              amountRaw: string;
              currentValueSol?: number;
            }[] = [];
            let walletLpPositions: AccountStateLpPosition[] = [];

            try {
              const tokenAccounts = await rpcClient.getTokenAccountsByOwner(walletPublicKey);
              const now = Date.now();
              const walletTokenCandidates = tokenAccounts.map((account) => {
                const info = account.account.data.parsed.info;
                const amountRaw = String(info.tokenAmount.amount ?? '0');
                const amountLamports = Number(amountRaw);
                return {
                  mint: info.mint,
                  symbol: '',
                  amount: info.tokenAmount.uiAmount ?? 0,
                  amountLamports,
                  amountRaw,
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
                    swapProviderChain,
                    walletPublicKey,
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

              walletTokens = walletTokenCandidates;
            } catch (error) {
              writeJson(response, 503, accountStateUnavailablePayload(error));
              return;
            }

            try {
              if (options.dlmmClient) {
                const dlmmPositions = (await options.dlmmClient.getPositionSnapshots(keypair.publicKey))
                  .filter((position) => position.positionStatus !== 'empty');
                walletLpPositions = await enrichLpExitValues({
                  positions: dlmmPositions,
                  valuationProviderChain,
                  walletPublicKey,
                  defaultSlippageBps
                });
              }
            } catch (error) {
              writeJson(response, 503, accountStateUnavailablePayload(error));
              return;
            }

            writeJson(response, 200, {
              observedAt: new Date().toISOString(),
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
          if (error instanceof UnknownBroadcastOutcomeError) {
            writeJson(response, 503, {
              error: 'broadcast outcome unknown',
              detail: message
            });
            return;
          }
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
