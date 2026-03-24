import { runStrategyCycle } from './run-strategy-cycle.ts';
import { HttpLiveBroadcaster } from '../execution/http-live-broadcaster.ts';
import { HttpLiveConfirmationProvider } from '../execution/http-live-confirmation-provider.ts';
import { HttpLiveQuoteProvider } from '../execution/http-live-quote-provider.ts';
import { HttpLiveSigner } from '../execution/http-live-signer.ts';
import type { DecisionContextInput } from '../runtime/build-decision-context.ts';
import { HttpLiveAccountStateProvider } from '../runtime/live-account-provider.ts';
import { loadLiveRuntimeConfig } from '../runtime/live-runtime-config.ts';

type ParsedArgs = {
  strategy?: string;
  requestedPositionSol?: number;
  whitelist?: string[];
  context?: DecisionContextInput;
  json: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--strategy' && next) {
      parsed.strategy = next;
      index += 1;
      continue;
    }

    if (current === '--requested-position-sol' && next) {
      parsed.requestedPositionSol = Number(next);
      index += 1;
      continue;
    }

    if (current === '--whitelist' && next) {
      parsed.whitelist = next
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (current === '--context-json' && next) {
      parsed.context = JSON.parse(next) as DecisionContextInput;
      index += 1;
      continue;
    }

    if (current === '--json') {
      parsed.json = true;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeConfig = loadLiveRuntimeConfig();

  if (args.strategy !== 'new-token-v1' && args.strategy !== 'large-pool-v1') {
    throw new Error('Expected --strategy to be one of: new-token-v1, large-pool-v1');
  }

  const executionAdapters = runtimeConfig.executionMode === 'http'
    ? {
        quoteProvider: new HttpLiveQuoteProvider({
          url: runtimeConfig.quoteServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        signer: new HttpLiveSigner({
          url: runtimeConfig.signServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        broadcaster: new HttpLiveBroadcaster({
          url: runtimeConfig.broadcastServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        confirmationProvider: new HttpLiveConfirmationProvider({
          url: runtimeConfig.confirmationServiceUrl,
          authToken: runtimeConfig.authToken
        }),
        accountProvider: new HttpLiveAccountStateProvider({
          url: runtimeConfig.accountStateUrl,
          authToken: runtimeConfig.authToken
        })
      }
    : {};

  const result = await runStrategyCycle({
    strategy: args.strategy,
    requestedPositionSol: args.requestedPositionSol,
    whitelist: args.whitelist,
    context: args.context,
    ...executionAdapters
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `status=${result.status}`,
      `mode=${result.mode}`,
      `action=${result.action}`,
      `reason=${result.reason}`,
      `liveOrderSubmitted=${result.liveOrderSubmitted}`
    ].join('\n') + '\n'
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
