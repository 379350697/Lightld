import type { FetchImpl } from '../../ingest/shared/http-client.ts';

type SolanaRpcClientOptions = {
  rpcUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
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
  private requestId = 0;

  constructor(options: SolanaRpcClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;

    const basePublicUrl = 'https://api.mainnet-beta.solana.com';
    const alchemyUrl = 'https://solana-mainnet.g.alchemy.com/v2/aX1RqrD7J3NBVdAf7WQeG';
    const heliusKeys = [
      '218113a4-bca4-4aad-a594-499bfef95880',
      'fb64f8b3-48ce-416f-8c7a-6f265c3ee227',
      'a5db71fe-3c58-472e-9ba8-3c2c37d9d533'
    ];
    const heliusUrls = heliusKeys.map(k => `https://mainnet.helius-rpc.com/?api-key=${k}`);

    // If generic rpcUrl is provided via config, push it to front, otherwise use the priority list
    const defaultsWrite = [...heliusUrls, basePublicUrl];
    const defaultsRead = [alchemyUrl, ...heliusUrls, basePublicUrl];

    this.writeUrls = options.rpcUrl && options.rpcUrl !== basePublicUrl ? [options.rpcUrl, ...defaultsWrite] : defaultsWrite;
    this.readUrls = options.rpcUrl && options.rpcUrl !== basePublicUrl ? [options.rpcUrl, ...defaultsRead] : defaultsRead;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    this.requestId += 1;
    const isWrite = method === 'sendTransaction';
    const urls = isWrite ? this.writeUrls : this.readUrls;
    let lastError: Error | undefined;

    for (const url of urls) {
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
          throw new Error(`Solana RPC ${method} failed: ${response.status} at ${new URL(url).hostname}`);
        }

        const body = (await response.json()) as RpcResponse<T>;

        if (body.error) {
          // If it's a simulation or invalid params error from Solana itself, we shouldn't necessarily cycle to the next RPC
          // But since we want resilience, we'll throw here and let the catch block decide (or just log and try next if it's a rate limit / RPC node issue)
          // Actually, if it's an RPC quota/rate limit error (usually handled at HTTP status level), it would have been caught above.
          // Protocol-level errors (like 'Blockhash not found' or 'Transaction simulation failed') shouldn't be retried blindly.
          if (body.error.code !== 429 && body.error.code !== -32005) {
             throw new Error(`Solana RPC ${method} error: ${body.error.message}`);
          }
           throw new Error(`Solana RPC ${method} rate limit/quota: ${body.error.message}`);
        }

        return body.result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // If it's a protocol level error (simulation failed), abort retry loop immediately
        if (lastError.message.includes('Solana RPC sendTransaction error:')) {
           throw lastError;
        }
        // Otherwise, it was a fetch failure, timeout, or rate limit. Try next URL.
        continue;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new Error(`All RPC endpoints failed for ${method}`);
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
