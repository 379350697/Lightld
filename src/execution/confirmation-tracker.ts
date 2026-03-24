export type ConfirmationStatus = 'submitted' | 'confirmed' | 'failed' | 'unknown';

type TrackConfirmationInput = {
  submissionId?: string;
  confirmationSignature?: string;
  failureReason?: string;
};

export function trackConfirmation(input: TrackConfirmationInput) {
  if (input.failureReason) {
    return {
      status: 'failed' as const,
      reason: input.failureReason,
      submissionId: input.submissionId
    };
  }

  if (input.submissionId) {
    return {
      status: 'submitted' as const,
      submissionId: input.submissionId
    };
  }

  return {
    status: 'unknown' as const
  };
}
