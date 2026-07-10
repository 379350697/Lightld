import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { LocalLiveSigner } from './local-live-signer.ts';
import {
  LiveOrderIntentSchema,
  validateLiveOrderIntentBoundary,
  type ExecutionMode
} from './live-order-intent-schema.ts';
import { validateIntentAllowlist } from '../risk/instruction-allowlist.ts';
import {
  hasExpectedBearerToken,
  readBody,
  writeJson,
  writeText
} from '../shared/http-server.ts';

const SignIntentRequestSchema = z.object({
  intent: LiveOrderIntentSchema
});

type LocalLiveSignerServerOptions = {
  host: string;
  port: number;
  executionMode?: ExecutionMode;
  keypairPath: string;
  expectedPublicKey?: string;
  signerId?: string;
  authToken?: string;
  maxOutputSol?: number;
  now?: () => Date;
};

export function createLocalLiveSignerServer(options: LocalLiveSignerServerOptions) {
  const signer = new LocalLiveSigner({
    keypairPath: options.keypairPath,
    expectedPublicKey: options.expectedPublicKey,
    signerId: options.signerId
  });
  let server: Server | undefined;
  let origin = '';
  const executionMode = options.executionMode ?? 'live';

  return {
    get origin() {
      return origin;
    },
    async start() {
      if (server) {
        return;
      }

      await signer.describe();
      server = createServer(async (request, response) => {
        try {
          if (request.method === 'GET' && request.url === '/health') {
            writeJson(response, 200, {
              status: 'ok',
              ...(await signer.describe())
            });
            return;
          }

          if (request.method === 'POST' && request.url === '/sign') {
            if (!hasExpectedBearerToken(request, options.authToken)) {
              writeText(response, 401, 'unauthorized');
              return;
            }

            const body = await readBody(request);
            const payload = SignIntentRequestSchema.parse(JSON.parse(body));
            const validatedIntent = validateLiveOrderIntentBoundary(payload.intent, {
              mode: executionMode,
              stage: 'sign',
              now: options.now?.() ?? new Date()
            });

            if (options.maxOutputSol !== undefined) {
              const allowlistResult = validateIntentAllowlist(
                validatedIntent,
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

            const signed = await signer.sign(validatedIntent);

            writeJson(response, 200, {
              intent: signed.intent,
              signerId: signed.signerId,
              signedAt: signed.signedAt,
              signature: signed.signature
            });
            return;
          }

          writeText(response, 404, 'not-found');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(response, 400, {
            error: message
          });
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, options.host, () => resolve());
      });

      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Unable to determine local signer server address');
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
