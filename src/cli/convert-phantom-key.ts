/**
 * Convert a Phantom-exported Base58 private key to Solana CLI JSON keypair format.
 *
 * Usage:
 *   node --experimental-strip-types src/cli/convert-phantom-key.ts <base58-private-key> <output-path>
 *
 * Example:
 *   node --experimental-strip-types src/cli/convert-phantom-key.ts "4wBqpZ..." ./burner.json
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) {
    return new Uint8Array(0);
  }

  const bytes = [0];

  for (const character of value) {
    const alphabetIndex = BASE58_ALPHABET.indexOf(character);

    if (alphabetIndex < 0) {
      throw new Error(`Invalid base58 character "${character}"`);
    }

    let carry = alphabetIndex;

    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const character of value) {
    if (character !== BASE58_ALPHABET[0]) {
      break;
    }

    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  const digits = [0];

  for (const value of bytes) {
    let carry = value;

    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let output = '';

  for (const value of bytes) {
    if (value !== 0) {
      break;
    }

    output += BASE58_ALPHABET[0];
  }

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += BASE58_ALPHABET[digits[index]];
  }

  return output;
}

function main() {
  const args = process.argv.slice(2);
  const base58Key = args[0];
  const outputPath = args[1] ?? 'burner.json';

  if (!base58Key) {
    process.stderr.write(
      'Usage: node --experimental-strip-types src/cli/convert-phantom-key.ts <base58-private-key> [output-path]\n'
    );
    process.exitCode = 1;
    return;
  }

  const keyBytes = decodeBase58(base58Key);

  if (keyBytes.length !== 64) {
    process.stderr.write(
      `Error: Expected a 64-byte keypair, but got ${keyBytes.length} bytes.\n` +
      'Make sure you are exporting the full private key from Phantom.\n'
    );
    process.exitCode = 1;
    return;
  }

  // The public key is the last 32 bytes of the 64-byte keypair
  const publicKeyBytes = keyBytes.slice(32);
  const publicKeyBase58 = encodeBase58(publicKeyBytes);

  const jsonArray = JSON.stringify(Array.from(keyBytes));

  const { writeFileSync } = require('node:fs');
  writeFileSync(outputPath, jsonArray + '\n', { mode: 0o600 });

  process.stdout.write(`✅ Keypair saved to: ${outputPath}\n`);
  process.stdout.write(`📍 Public key: ${publicKeyBase58}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Next steps:\n`);
  process.stdout.write(`  1. Transfer a small amount of SOL from Phantom main wallet to: ${publicKeyBase58}\n`);
  process.stdout.write(`  2. Set environment variables:\n`);
  process.stdout.write(`     export LIVE_LOCAL_SIGNER_KEYPAIR_PATH="${outputPath}"\n`);
  process.stdout.write(`     export LIVE_LOCAL_SIGNER_EXPECTED_PUBLIC_KEY="${publicKeyBase58}"\n`);
  process.stdout.write(`  3. Start the signer: npm run run:signer\n`);
}

main();
