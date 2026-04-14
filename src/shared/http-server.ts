import type { IncomingMessage, ServerResponse } from 'node:http';

export function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(payload)}\n`);
}

export function writeText(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(`${message}\n`);
}

export function hasExpectedBearerToken(request: IncomingMessage, authToken: string | undefined) {
  if (!authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${authToken}`;
}

export async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}
