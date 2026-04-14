import { createPrivateKey, createPublicKey, sign as signBuffer, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { SignedLiveOrderIntent } from './live-signer.ts';
import type { LiveOrderIntent, LiveSigner } from './live-signer.ts';
import { encodeBase58 } from '../shared/base58.ts';
import { stableStringify } from '../shared/canonical-json.ts';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type LocalLiveSignerOptions = {
  keypairPath: string;
  expectedPublicKey?: string;
  signerId?: string;
};

type LocalSignerMaterial = {
  privateKey: KeyObject;
  publicKey: string;
  signerId: string;
};

function createPrivateKeyFromSeed(seed: Uint8Array) {
  if (seed.length !== 32) {
    throw new Error(`Expected a 32-byte Ed25519 seed, received ${seed.length}`);
  }

  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8'
  });
}

function extractPublicKeyBytes(privateKey: KeyObject) {
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki'
  });
  const raw = Buffer.from(spki);

  if (raw.subarray(0, ED25519_SPKI_PREFIX.length).compare(ED25519_SPKI_PREFIX) !== 0) {
    throw new Error('Unsupported Ed25519 public key format');
  }

  return raw.subarray(ED25519_SPKI_PREFIX.length);
}

function parseSolanaSecretKeyFile(raw: string) {
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) {
    throw new Error('Expected a Solana keypair JSON array');
  }

  const bytes = Uint8Array.from(parsed);

  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error(`Expected a 32-byte or 64-byte Solana secret key, received ${bytes.length}`);
  }

  return bytes;
}

async function loadLocalSignerMaterial(options: LocalLiveSignerOptions): Promise<LocalSignerMaterial> {
  const raw = (await readFile(options.keypairPath, 'utf8')).trim();
  const privateKey = raw.startsWith('[')
    ? createPrivateKeyFromSeed(parseSolanaSecretKeyFile(raw).subarray(0, 32))
    : createPrivateKey(raw);
  const publicKey = encodeBase58(extractPublicKeyBytes(privateKey));

  if (options.expectedPublicKey && options.expectedPublicKey !== publicKey) {
    throw new Error(
      `Signer keypair public key ${publicKey} does not match expected public key ${options.expectedPublicKey}`
    );
  }

  return {
    privateKey,
    publicKey,
    signerId: options.signerId ?? publicKey
  };
}

export class LocalLiveSigner implements LiveSigner {
  private readonly options: LocalLiveSignerOptions;
  private materialPromise?: Promise<LocalSignerMaterial>;

  constructor(options: LocalLiveSignerOptions) {
    this.options = options;
  }

  async describe() {
    const material = await this.loadMaterial();

    return {
      publicKey: material.publicKey,
      signerId: material.signerId
    };
  }

  async sign(intent: LiveOrderIntent): Promise<SignedLiveOrderIntent> {
    const material = await this.loadMaterial();
    const payload = stableStringify(intent);
    const signature = signBuffer(null, Buffer.from(payload, 'utf8'), material.privateKey).toString('base64');

    return {
      intent,
      signerId: material.signerId,
      signedAt: new Date().toISOString(),
      signature
    };
  }

  private loadMaterial() {
    this.materialPromise ??= loadLocalSignerMaterial(this.options);
    return this.materialPromise;
  }
}
