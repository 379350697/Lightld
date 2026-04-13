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
  private readonly rpcUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(options: SolanaRpcClientOptions = {}) {
    this.rpcUrl = options.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    this.requestId += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.rpcUrl, {
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
        throw new Error(`Solana RPC ${method} failed: ${response.status}`);
      }

      const body = (await response.json()) as RpcResponse<T>;

      if (body.error) {
        throw new Error(`Solana RPC ${method} error: ${body.error.message}`);
      }

      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendRawTransaction(base64Transaction: string): Promise<string> {
    return this.call<string>('sendTransaction', [
      base64Transaction,
      {
        encoding: 'base64',
        skipPreflight: false,
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
