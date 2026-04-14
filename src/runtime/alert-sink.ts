import type { RuntimeMode } from './state-types.ts';

export interface AlertSink {
  send(payload: {
    previousMode: RuntimeMode;
    nextMode: RuntimeMode;
    reason: string;
    sentAt: string;
  }): Promise<void>;
}

export class NoopAlertSink implements AlertSink {
  async send(): Promise<void> {}
}

export function shouldSendAlert(input: {
  previousMode: RuntimeMode;
  nextMode: RuntimeMode;
  reason: string;
}) {
  return (
    input.previousMode !== input.nextMode &&
    (input.nextMode === 'circuit_open' || input.nextMode === 'flatten_only')
  );
}
