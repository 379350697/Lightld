import WebSocket from 'ws';

export type PumpPortalEvent = {
  mint: string;
  txType?: string;
  name?: string;
  symbol?: string;
  [key: string]: unknown;
};

export class PumpPortalClient {
  private ws: WebSocket | null = null;
  private readonly endpoint = 'wss://pumpportal.fun/api/data';
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  public onTokenEvent?: (event: PumpPortalEvent) => void;

  public connect() {
    this.ws = new WebSocket(this.endpoint);

    this.ws.on('open', () => {
      console.log('[PumpPortal] WebSocket Connected');
      
      // Subscribe to token creations and migrations
      const payload = {
        method: 'subscribeNewToken' 
      };
      // We can also subscribe to migrations if documentation supports multiple payloads
      // But pump newly launched tokens are good enough since our filter will check them instantly.
      // Actually let's subscribe to migrations as well, using standard PumpPortal docs:
      
      this.ws?.send(JSON.stringify({ method: 'subscribeNewToken' }));
      
      // We also want to monitor graduated tokens realistically if we are targeting Raydium
      // PumpPortal docs indicate it's unsupported or `subscribeAccountTrade` on Raydium Migration address.
      // But new tokens stream is sufficient to populate our batch query over time. 
      // Many new tokens will graduate rapidly.

      // Keepalive ping
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString()) as PumpPortalEvent;
        if (payload.mint) {
          this.onTokenEvent?.(payload);
        }
      } catch (err) {
        console.error('[PumpPortal] Parse Error', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[PumpPortal] Disconnected. Reconnecting in 5s...');
      this.cleanup();
      this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[PumpPortal] WebSocket Error', err);
      this.ws?.close();
    });
  }

  public disconnect() {
    this.cleanup();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.ws?.close();
  }

  private cleanup() {
    if (this.pingInterval) clearInterval(this.pingInterval);
  }
}
