const SOLANA_SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

export function isSolanaTransactionSignature(value: string | undefined): value is string {
  return typeof value === 'string' && SOLANA_SIGNATURE_REGEX.test(value);
}
