const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase58(value: string): Uint8Array {
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

export function encodeBase58(bytes: Uint8Array): string {
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
