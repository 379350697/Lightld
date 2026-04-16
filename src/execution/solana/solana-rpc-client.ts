import type { FetchImpl } from '../../ingest/shared/http-client.ts';
import {
  classifyRetryableRpcError,
  type RpcEndpointRegistry
} from '../rpc-endpoint-registry.ts';

type SolanaRpcClientOptions = {
  rpcUrl?: string;
  writeRpcUrls?: string[];
  readRpcUrls?: string[];
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  endpointRegistry?: RpcEndpointRegistry;
};

type RpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result: T;
  error?: { code: number; message: string };
};

type SignatureStatus = {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
};

type TokenAccount = {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number | null;
            uiAmountString: string;
          };
        };
        type: string;
      };
      program: string;
    };
  };
};

export class SolanaRpcClient {
  private readonly writeUrls: string[];
  private readonly readUrls: string[];
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly endpointRegistry?: RpcEndpointRegistry;
  private requestId = 0;

  constructor(options: SolanaRpcClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.endpointRegistry = options.endpointRegistry;

    const fallbackUrl = options.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
    this.writeUrls = options.writeRpcUrls?.length ? options.writeRpcUrls : [fallbackUrl];
    this.readUrls = options.readRpcUrls?.length ? options.readRpcUrls : this.writeUrls;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    this.requestId += 1;
    const isWrite = method === 'sendTransaction';
    const urls = isWrite ? this.writeUrls : this.readUrls;
    const registry = this.endpointRegistry;

    if (!registry) {
      let lastError: Error | undefined;
      for (const url of urls) {
        try {
          return await this.executeCall<T>(url, method, params);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const disposition = this.classifyCallError(lastError);
          if (!disposition?.retryable) {
            throw lastError;
          }
        }
      }

      throw lastError ?? new Error(`All RPC endpoints failed for ${method}`);
    }

    return registry.runWithEndpoint({
      kind: isWrite ? 'solana-write' : 'solana-read',
      candidates: urls,
      execute: (url) => this.executeCall<T>(url, method, params),
      classifyError: (error) => this.classifyCallError(error)
    });
  }

  private classifyCallError(error: unknown) {
    const disposition = classifyRetryableRpcError(error);
    if (disposition) {
      return disposition;
    }

    const normalized = error instanceof Error ? error : new Error(String(error));
    if (normalized.message.includes('Solana RPC sendTransaction error:')) {
      return null;
    }

    if (normalized.message.includes('Solana RPC')) {
      return null;
    }

    return null;
  }

  private async executeCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.requestId,
          method,
          params
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw Object.assign(
          new Error(`Solana RPC ${method} failed: ${response.status} at ${new URL(url).hostname}`),
          { status: response.status }
        );
      }

      const body = (await response.json()) as RpcResponse<T>;

      if (body.error) {
        if (body.error.code !== 429 && body.error.code !== -32005) {
          throw Object.assign(
            new Error(`Solana RPC ${method} error: ${body.error.message}`),
            { status: 400 }
          );
        }

        throw Object.assign(
          new Error(`Solana RPC ${method} rate limit/quota: ${body.error.message}`),
          { status: 429 }
        );
      }

      return body.result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('timeout');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendRawTransaction(base64Transaction: string): Promise<string> {
    return this.call<string>('sendTransaction', [
      base64Transaction,
      {
        encoding: 'base64',
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }
    ]);
  }

  async getSignatureStatuses(
    signatures: string[]
  ): Promise<{ value: (SignatureStatus | null)[] }> {
    return this.call<{ value: (SignatureStatus | null)[] }>(
      'getSignatureStatuses',
      [signatures, { searchTransactionHistory: true }]
    );
  }

  async getBalance(publicKey: string): Promise<number> {
    const result = await this.call<{ value: number }>(
      'getBalance',
      [publicKey, { commitment: 'confirmed' }]
    );
    return result.value;
  }

  async getTokenAccountsByOwner(
    publicKey: string
  ): Promise<TokenAccount[]> {
    const result = await this.call<{ value: TokenAccount[] }>(
      'getTokenAccountsByOwner',
      [
        publicKey,
        { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { encoding: 'jsonParsed', commitment: 'confirmed' }
      ]
    );
    return result.value;
  }

  async getLatestBlockhash(): Promise<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }> {
    return this.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  }
}
