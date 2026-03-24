import { z } from 'zod';

const HttpExecutionConfigSchema = z.object({
  executionMode: z.literal('http'),
  quoteServiceUrl: z.string().url(),
  signServiceUrl: z.string().url(),
  broadcastServiceUrl: z.string().url(),
  confirmationServiceUrl: z.string().url(),
  accountStateUrl: z.string().url(),
  authToken: z.string().min(1).optional()
});

const TestExecutionConfigSchema = z.object({
  executionMode: z.literal('test')
});

export const LiveRuntimeConfigSchema = z.discriminatedUnion('executionMode', [
  TestExecutionConfigSchema,
  HttpExecutionConfigSchema
]);

export type LiveRuntimeConfig = z.infer<typeof LiveRuntimeConfigSchema>;

export function loadLiveRuntimeConfig(env: Record<string, string | undefined> = process.env): LiveRuntimeConfig {
  if ((env.LIVE_EXECUTION_MODE ?? 'test') === 'http') {
    return LiveRuntimeConfigSchema.parse({
      executionMode: 'http',
      quoteServiceUrl: env.LIVE_QUOTE_URL,
      signServiceUrl: env.LIVE_SIGN_URL,
      broadcastServiceUrl: env.LIVE_BROADCAST_URL,
      confirmationServiceUrl: env.LIVE_CONFIRMATION_URL,
      accountStateUrl: env.LIVE_ACCOUNT_STATE_URL,
      authToken: env.LIVE_AUTH_TOKEN
    });
  }

  return LiveRuntimeConfigSchema.parse({
    executionMode: 'test'
  });
}
