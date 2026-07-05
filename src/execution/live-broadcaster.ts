import { classifyBroadcastFailure } from './broadcast-failures.ts';
import type { SignedLiveOrderIntent } from './live-signer.ts';

export type LiveBroadcastResult =
  | {
      status: 'submitted';
      submissionId: string;
      idempotencyKey: string;
      confirmationSignature?: string;
      submissionIds?: string[];
      confirmationSignatures?: string[];
      batchStatus?: 'complete' | 'partial';
      reason?: string;
      mainExecutionStatus?: 'submitted' | 'confirmed';
      residualSweepStatus?: 'complete' | 'incomplete' | 'dust_ignored';
      residualUnsoldMints?: string[];
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
    }
  | {
      status: 'failed';
      reason: string;
      retryable: boolean;
      idempotencyKey: string;
      executionFailureKind?: string;
      executionFailureOperation?: string;
      rebuildAttemptCount?: number;
      activeBinIdAtBuild?: number;
      lowerBinIdAtBuild?: number;
      upperBinIdAtBuild?: number;
      binSlippageBps?: number;
      targetCooldownMs?: number;
    };

export interface LiveBroadcaster {
  broadcast(intent: SignedLiveOrderIntent): Promise<LiveBroadcastResult>;
}

export class TestLiveBroadcaster implements LiveBroadcaster {
  private readonly failure?: Error;

  constructor(failure?: Error) {
    this.failure = failure;
  }

  async broadcast(intent: SignedLiveOrderIntent): Promise<LiveBroadcastResult> {
    if (this.failure) {
      const failure = classifyBroadcastFailure(this.failure);

      return {
        status: 'failed',
        reason: failure.reason,
        retryable: failure.retryable,
        idempotencyKey: intent.intent.idempotencyKey
      };
    }

    return {
      status: 'submitted',
      submissionId: intent.intent.idempotencyKey,
      idempotencyKey: intent.intent.idempotencyKey
    };
  }
}
