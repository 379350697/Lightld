import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { LocalLiveSigner } from './local-live-signer.ts';
import { validateIntentAllowlist } from '../risk/instruction-allowlist.ts';
import {
  hasExpectedBearerToken,
  readBody,
  writeJson,
  writeText
} from '../shared/http-server.ts';

const SignIntentRequestSchema = z.object({
  intent: z.object({
    strategyId: z.string().min(1),
    poolAddress: z.string().min(1),
    outputSol: z.number().finite().positive(),
    createdAt: z.string().min(1),
    idempotencyKey: z.string().min(1),
    side: z.enum(['buy', 'sell', 'add-lp', 'withdraw-lp', 'claim-fee', 'rebalance-lp']).default('buy'),
    tokenMint: z.string().default(''),
    fullPositionExit: z.boolean().default(false)
  })
});

type LocalLiveSignerServerOptions = {
  host: string;
  port: number;
  keypairPath: string;
  expectedPublicKey?: string;
  signerId?: string;
  authToken?: string;
  maxOutputSol?: number;
};

export function createLocalLiveSignerServer(options: LocalLiveSignerServerOptions) {
  const signer = new LocalLiveSigner({
    keypairPath: options.keypairPath,
    expectedPublicKey: options.expectedPublicKey,
    signerId: options.signerId
  });
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

            if (options.maxOutputSol !== undefined) {
              const allowlistResult = validateIntentAllowlist(
                payload.intent,
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

            const signed = await signer.sign(payload.intent);

            writeJson(response, 200, {
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
