import { z } from 'zod';

const HttpExecutionConfigSchema = z.object({
  executionMode: z.literal('http'),
  quoteServiceUrl: z.string().url(),
  signServiceUrl: z.string().url(),
  broadcastServiceUrl: z.string().url(),
  broadcastTimeoutMs: z.number().int().positive(),
  confirmationServiceUrl: z.string().url(),
  accountStateUrl: z.string().url(),
  accountStateTimeoutMs: z.number().int().positive(),
  authToken: z.string().min(1).optional(),
  maxSingleOrderSol: z.number().finite().positive().optional(),
  maxDailySpendSol: z.number().finite().positive().optional(),
  maxHourlySpendSol: z.number().finite().positive().optional(),
  resetSpendingLimitsOnStartup: z.boolean().optional()
});

const TestExecutionConfigSchema = z.object({
  executionMode: z.literal('test'),
  maxSingleOrderSol: z.number().finite().positive().optional(),
  maxDailySpendSol: z.number().finite().positive().optional(),
  maxHourlySpendSol: z.number().finite().positive().optional(),
  resetSpendingLimitsOnStartup: z.boolean().optional()
});

export const LiveRuntimeConfigSchema = z.discriminatedUnion('executionMode', [
  TestExecutionConfigSchema,
  HttpExecutionConfigSchema
]);

export type LiveRuntimeConfig = z.infer<typeof LiveRuntimeConfigSchema>;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalBoolean(value: string | undefined) {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) {
    return false;
  }

  return undefined;
}

export function loadLiveRuntimeConfig(env: Record<string, string | undefined> = process.env): LiveRuntimeConfig {
  const maxSingleOrderSol = env.LIVE_MAX_SINGLE_ORDER_SOL
    ? Number(env.LIVE_MAX_SINGLE_ORDER_SOL)
    : undefined;
  const maxDailySpendSol = env.LIVE_MAX_DAILY_SPEND_SOL
    ? Number(env.LIVE_MAX_DAILY_SPEND_SOL)
    : undefined;
  const maxHourlySpendSol = env.LIVE_MAX_HOURLY_SPEND_SOL
    ? Number(env.LIVE_MAX_HOURLY_SPEND_SOL)
    : undefined;
  const resetSpendingLimitsOnStartup = parseOptionalBoolean(env.LIVE_RESET_SPENDING_LIMITS_ON_START);

  if ((env.LIVE_EXECUTION_MODE ?? 'test') === 'http') {
    return LiveRuntimeConfigSchema.parse({
      executionMode: 'http',
      quoteServiceUrl: env.LIVE_QUOTE_URL,
      signServiceUrl: env.LIVE_SIGN_URL,
      broadcastServiceUrl: env.LIVE_BROADCAST_URL,
      broadcastTimeoutMs: parsePositiveInteger(env.LIVE_BROADCAST_TIMEOUT_MS, 30_000),
      confirmationServiceUrl: env.LIVE_CONFIRMATION_URL,
      accountStateUrl: env.LIVE_ACCOUNT_STATE_URL,
      accountStateTimeoutMs: parsePositiveInteger(env.LIVE_ACCOUNT_STATE_TIMEOUT_MS, 45_000),
      authToken: env.LIVE_AUTH_TOKEN,
      maxSingleOrderSol,
      maxDailySpendSol,
      maxHourlySpendSol,
      resetSpendingLimitsOnStartup
    });
  }

  return LiveRuntimeConfigSchema.parse({
    executionMode: 'test',
    maxSingleOrderSol,
    maxDailySpendSol,
    maxHourlySpendSol,
    resetSpendingLimitsOnStartup
  });
}

