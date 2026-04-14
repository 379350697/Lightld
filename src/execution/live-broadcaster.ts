import { classifyBroadcastFailure } from './broadcast-failures.ts';
import type { SignedLiveOrderIntent } from './live-signer.ts';

export type LiveBroadcastResult =
  | {
      status: 'submitted';
      submissionId: string;
      idempotencyKey: string;
      confirmationSignature?: string;
    }
  | {
      status: 'failed';
      reason: string;
      retryable: boolean;
      idempotencyKey: string;
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
      submissionId: `${intent.signerId}:${intent.intent.idempotencyKey}`,
      idempotencyKey: intent.intent.idempotencyKey
    };
  }
}
