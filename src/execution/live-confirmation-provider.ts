import type { ConfirmationStatus } from './confirmation-tracker.ts';

export type ConfirmationFinality =
  | 'processed'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'unknown';

export type LiveConfirmationPollInput = {
  submissionId: string;
  confirmationSignature?: string;
};

export type LiveConfirmationResult = {
  submissionId: string;
  confirmationSignature?: string;
  status: ConfirmationStatus;
  finality: ConfirmationFinality;
  checkedAt: string;
  reason?: string;
};

export interface LiveConfirmationProvider {
  poll(input: LiveConfirmationPollInput): Promise<LiveConfirmationResult>;
}
