import { createPublicKey, verify as verifyBuffer } from 'node:crypto';

import { decodeBase58 } from '../shared/base58.ts';
import { stableStringify } from '../shared/canonical-json.ts';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type VerifiableSignedIntent = {
  intent: unknown;
  signerId: string;
  signature: string;
};

export function createPublicKeyFromBase58(value: string) {
  const raw = Buffer.from(decodeBase58(value));

  if (raw.length !== 32) {
    throw new Error(`Expected a 32-byte signer public key, received ${raw.length}`);
  }

  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  });
}

export function verifySignedIntent(
  signedIntent: VerifiableSignedIntent,
  expectedSignerPublicKeys: string[] = []
) {
  if (expectedSignerPublicKeys.length > 0 && !expectedSignerPublicKeys.includes(signedIntent.signerId)) {
    throw new Error(`Signer ${signedIntent.signerId} is not in the allowed signer list`);
  }

  const publicKey = createPublicKeyFromBase58(signedIntent.signerId);
  const verified = verifyBuffer(
    null,
    Buffer.from(stableStringify(signedIntent.intent), 'utf8'),
    publicKey,
    Buffer.from(signedIntent.signature, 'base64')
  );

  if (!verified) {
    throw new Error('Signed intent verification failed');
  }
}

export function signedIntentIdempotencyFingerprint(signedIntent: VerifiableSignedIntent) {
  return stableStringify({
    intent: signedIntent.intent,
    signerId: signedIntent.signerId,
    signature: signedIntent.signature
  });
}
