import { createHash, createPublicKey, verify as verifyBuffer } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { readJsonIfExists, writeJsonAtomically } from '../runtime/atomic-file.ts';
import { validateIntentAllowlist } from '../risk/instruction-allowlist.ts';
import type { LiveBroadcastResult } from './live-broadcaster.ts';
import type { LiveConfirmationResult } from './live-confirmation-provider.ts';
import type { SignedLiveOrderIntent } from './live-signer.ts';
import type { LiveAccountState } from '../runtime/live-account-provider.ts';
import { decodeBase58 } from '../shared/base58.ts';
import { stableStringify } from '../shared/canonical-json.ts';
import {
  hasExpectedBearerToken,
  readBody,
  writeJson,
  writeText
} from '../shared/http-server.ts';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const SignedIntentSchema = z.object({
  intent: z.object({
    strategyId: z.string().min(1),
    poolAddress: z.string().min(1),
    outputSol: z.number().finite().positive(),
    createdAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
    side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).default('buy'),
    tokenMint: z.string().default(''),
    fullPositionExit: z.boolean().default(false)
  }),
  signerId: z.string().min(1),
  signedAt: z.string().min(1),
  signature: z.string().min(1)
});

const ConfirmationRequestSchema = z.object({
  submissionId: z.string().min(1),
  confirmationSignature: z.string().optional()
});

const AccountStateSchema = z.object({
  walletSol: z.number().finite(),
  journalSol: z.number().finite(),
  walletLpPositions: z.array(z.object({
    poolAddress: z.string(),
    positionAddress: z.string(),
    mint: z.string()
  })).optional(),
  journalLpPositions: z.array(z.object({
    poolAddress: z.string(),
    positionAddress: z.string(),
    mint: z.string()
  })).optional(),
  walletTokens: z.array(z.object({
    mint: z.string(),
    symbol: z.string().optional(),
    amount: z.number().finite()
  })).optional(),
  journalTokens: z.array(z.object({
    mint: z.string(),
    symbol: z.string().optional(),
    amount: z.number().finite()
  })).optional(),
  fills: z.array(z.object({
    submissionId: z.string().optional(),
    confirmationSignature: z.string().optional(),
    mint: z.string(),
    symbol: z.string().optional(),
    side: z.union([
      z.literal('buy'),
      z.literal('sell'),
      z.literal('add-lp'),
      z.literal('withdraw-lp'),
      z.literal('claim-fee'),
      z.literal('rebalance-lp')
    ]),
    amount: z.number().finite(),
    recordedAt: z.string().min(1)
  })).optional()
});

const SubmissionStoreSchema = z.object({
  submissions: z.array(z.object({
    submissionId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    confirmationSignature: z.string().min(1),
    signerId: z.string().min(1),
    receivedAt: z.string().min(1),
    signedIntent: SignedIntentSchema
  }))
});

type SubmissionStore = z.infer<typeof SubmissionStoreSchema>;

type LocalLiveExecutionServerOptions = {
  host: string;
  port: number;
  stateRootDir: string;
  accountStatePath?: string;
  authToken?: string;
  expectedSignerPublicKeys?: string[];
  autoFinalizeAfterMs?: number;
  maxOutputSol?: number;
};

function createPublicKeyFromBase58(value: string) {
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

function hashValue(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

class LocalExecutionStateStore {
  private readonly path: string;

  constructor(rootDir: string) {
    this.path = join(rootDir, 'local-live-execution.json');
  }

  async read() {
    return (await readJsonIfExists(this.path, SubmissionStoreSchema)) ?? {
      submissions: []
    } satisfies SubmissionStore;
  }

  async write(store: SubmissionStore) {
    await writeJsonAtomically(this.path, SubmissionStoreSchema.parse(store));
  }
}

async function readAccountState(path: string | undefined): Promise<LiveAccountState> {
  if (!path) {
    return {
      walletSol: 0,
      journalSol: 0,
      walletLpPositions: [],
      journalLpPositions: [],
      walletTokens: [],
      journalTokens: [],
      fills: []
    };
  }

  try {
    const raw = await readFile(path, 'utf8');
    return AccountStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        walletSol: 0,
        journalSol: 0,
        walletLpPositions: [],
        journalLpPositions: [],
        walletTokens: [],
        journalTokens: [],
        fills: []
      };
    }

    throw error;
  }
}

function verifySignedIntent(
  signedIntent: SignedLiveOrderIntent,
  expectedSignerPublicKeys: string[]
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

function toBroadcastResult(submission: SubmissionStore['submissions'][number]): LiveBroadcastResult {
  return {
    status: 'submitted',
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    confirmationSignature: submission.confirmationSignature
  };
}

function toConfirmationResult(
  submission: SubmissionStore['submissions'][number] | undefined,
  autoFinalizeAfterMs: number
): LiveConfirmationResult {
  const checkedAt = new Date().toISOString();

  if (!submission) {
    return {
      submissionId: 'unknown',
      status: 'unknown',
      finality: 'unknown',
      checkedAt,
      reason: 'submission-not-found'
    };
  }

  const ageMs = Date.now() - Date.parse(submission.receivedAt);
  const finalized = ageMs >= autoFinalizeAfterMs;

  return {
    submissionId: submission.submissionId,
    confirmationSignature: submission.confirmationSignature,
    status: finalized ? 'confirmed' : 'submitted',
    finality: finalized ? 'finalized' : 'processed',
    checkedAt
  };
}

export function createLocalLiveExecutionServer(options: LocalLiveExecutionServerOptions) {
  const store = new LocalExecutionStateStore(options.stateRootDir);
  const expectedSignerPublicKeys = options.expectedSignerPublicKeys ?? [];
  const autoFinalizeAfterMs = options.autoFinalizeAfterMs ?? 5_000;
  let server: Server | undefined;
  let origin = '';

  return {
    get origin() {
      return origin;
    },
    async start() {
      if (server) {
        return;
      }

      server = createServer(async (request, response) => {
        try {
          if (request.method === 'GET' && request.url === '/health') {
            const snapshot = await store.read();
            writeJson(response, 200, {
              status: 'ok',
              submissionCount: snapshot.submissions.length
            });
            return;
          }

          if (!hasExpectedBearerToken(request, options.authToken)) {
            writeText(response, 401, 'unauthorized');
            return;
          }

          if (request.method === 'POST' && request.url === '/broadcast') {
            const body = await readBody(request);
            const payload = z.object({ intent: SignedIntentSchema }).parse(JSON.parse(body));
            verifySignedIntent(payload.intent, expectedSignerPublicKeys);

            if (options.maxOutputSol !== undefined) {
              const allowlistResult = validateIntentAllowlist(
                payload.intent.intent,
                { maxOutputSol: options.maxOutputSol }
              );

              if (!allowlistResult.allowed) {
                writeJson(response, 403, {
                  error: allowlistResult.reason,
                  detail: allowlistResult.detail
                });
                return;
              }
            }

            const snapshot = await store.read();
            const existing = snapshot.submissions.find(
              (submission) => submission.idempotencyKey === payload.intent.intent.idempotencyKey
            );

            if (existing) {
              writeJson(response, 200, toBroadcastResult(existing));
              return;
            }

            const hash = hashValue(`${payload.intent.signature}:${payload.intent.intent.idempotencyKey}`);
            const receivedAt = new Date().toISOString();
            const submission = {
              submissionId: `local-submission-${hash.slice(0, 16)}`,
              idempotencyKey: payload.intent.intent.idempotencyKey,
              confirmationSignature: `local-confirmation-${hash.slice(16, 32)}`,
              signerId: payload.intent.signerId,
              receivedAt,
              signedIntent: payload.intent
            } satisfies SubmissionStore['submissions'][number];

            await store.write({
              submissions: [...snapshot.submissions, submission]
            });

            writeJson(response, 200, toBroadcastResult(submission));
            return;
          }

          if (request.method === 'POST' && request.url === '/confirmation') {
            const body = await readBody(request);
            const payload = ConfirmationRequestSchema.parse(JSON.parse(body));
            const snapshot = await store.read();
            const submission = snapshot.submissions.find((entry) =>
              entry.submissionId === payload.submissionId
              || (!!payload.confirmationSignature && entry.confirmationSignature === payload.confirmationSignature)
            );

            writeJson(response, 200, toConfirmationResult(submission, autoFinalizeAfterMs));
            return;
          }

          if (request.method === 'GET' && request.url === '/account-state') {
            writeJson(response, 200, await readAccountState(options.accountStatePath));
            return;
          }

          writeText(response, 404, 'not-found');
        } catch (error) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, options.host, () => resolve());
      });

      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Unable to determine local execution server address');
      }

      origin = `http://${options.host}:${address.port}`;
    },
    async stop() {
      if (!server) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      server = undefined;
      origin = '';
    }
  };
}
