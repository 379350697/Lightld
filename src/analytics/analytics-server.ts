import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PortfolioAnalyzer } from './portfolio-analyzer.ts';

function hasExpectedBearerToken(request: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) {
    return true; // No auth token required
  }
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return false;
  }
  return authHeader === `Bearer ${authToken}`;
}

export type AnalyticsServerConfig = {
  host: string;
  port: number;
  strategyId: string;
  authToken?: string;
  journalRootDir?: string;
};

export class AnalyticsServer {
  private server: Server | null = null;
  private readonly analyzer: PortfolioAnalyzer;

  constructor(private readonly config: AnalyticsServerConfig) {
    this.analyzer = new PortfolioAnalyzer(config.strategyId, config.journalRootDir);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        try {
          if (!hasExpectedBearerToken(request, this.config.authToken)) {
            response.writeHead(401, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }

          if (request.method === 'GET' && request.url === '/api/v1/portfolio/summary') {
            const stats = await this.analyzer.getStats();
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(stats.summary));
            return;
          }

          if (request.method === 'GET' && request.url === '/api/v1/portfolio/positions') {
            const stats = await this.analyzer.getStats();
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(stats.positions));
            return;
          }

          response.writeHead(404, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'not_found' }));
        } catch (err: unknown) {
          console.error('[AnalyticsServer] Error handling request:', err);
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'internal_server_error' }));
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[AnalyticsServer] Listening on http://${this.config.host}:${this.config.port}`);
        console.log(`[AnalyticsServer] Strategy ID: ${this.config.strategyId}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
