import { describe, expect, it } from 'vitest';

import { HttpLiveConfirmationProvider } from '../../../src/execution/http-live-confirmation-provider';

describe('HttpLiveConfirmationProvider', () => {
  it('reads finalized confirmation state from an external http service', async () => {
    const provider = new HttpLiveConfirmationProvider({
      url: 'https://confirm.example/api',
      fetchImpl: async (_input, init) => {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          'content-type': 'application/json'
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          submissionId: 'sub-1',
          confirmationSignature: 'tx-1'
        });

        return new Response(
          JSON.stringify({
            submissionId: 'sub-1',
            confirmationSignature: 'tx-1',
            status: 'confirmed',
            finality: 'finalized',
            checkedAt: '2026-03-22T00:00:03.000Z'
          }),
          { status: 200 }
        );
      }
    });

    await expect(
      provider.poll({
        submissionId: 'sub-1',
        confirmationSignature: 'tx-1'
      })
    ).resolves.toEqual({
      submissionId: 'sub-1',
      confirmationSignature: 'tx-1',
      status: 'confirmed',
      finality: 'finalized',
      checkedAt: '2026-03-22T00:00:03.000Z'
    });
  });
});
