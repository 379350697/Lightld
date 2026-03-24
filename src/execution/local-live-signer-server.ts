import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { LocalLiveSigner } from './local-live-signer.ts';

const SignIntentRequestSchema = z.object({
  intent: z.object({
    strategyId: z.string().min(1),
    poolAddress: z.string().min(1),
    outputSol: z.number().finite().positive(),
    createdAt: z.string().min(1),
    idempotencyKey: z.string().min(1)
  })
});

type LocalLiveSignerServerOptions = {
  host: string;
  port: number;
  keypairPath: string;
  expectedPublicKey?: string;
  signerId?: string;
  authToken?: string;
};

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(`${message}\n`);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function hasExpectedBearerToken(request: IncomingMessage, authToken: string | undefined) {
  if (!authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${authToken}`;
}

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
