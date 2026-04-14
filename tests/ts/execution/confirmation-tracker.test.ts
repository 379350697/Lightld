import { describe, expect, it } from 'vitest';

import { trackConfirmation } from '../../../src/execution/confirmation-tracker';

describe('trackConfirmation', () => {
  it('returns submitted when a submission has been accepted for confirmation polling', () => {
    expect(
      trackConfirmation({
        submissionId: 'sub-1',
        confirmationSignature: 'tx-sig-1'
      })
    ).toEqual({
      status: 'submitted',
      submissionId: 'sub-1'
    });
  });

  it('returns submitted when only the submission id exists', () => {
    expect(
      trackConfirmation({
        submissionId: 'sub-1'
      })
    ).toEqual({
      status: 'submitted',
      submissionId: 'sub-1'
    });
  });
});
