export type LiveOrderIntent = ReturnType<
  typeof import('./order-intent-builder').buildOrderIntent
>;

export type SignedLiveOrderIntent = {
  intent: LiveOrderIntent;
  signerId: string;
  signedAt: string;
  signature: string;
};

export interface LiveSigner {
  sign(intent: LiveOrderIntent): Promise<SignedLiveOrderIntent>;
}

export class TestLiveSigner implements LiveSigner {
  private readonly signerId: string;

  constructor(signerId = 'test-live-signer') {
    this.signerId = signerId;
  }

  async sign(intent: LiveOrderIntent): Promise<SignedLiveOrderIntent> {
    const signedAt = new Date().toISOString();

    return {
      intent,
      signerId: this.signerId,
      signedAt,
      signature: `${this.signerId}:${intent.idempotencyKey}`
    };
  }
}
