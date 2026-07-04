import type { FetchImpl } from '../../ingest/shared/http-client.ts';
import { AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
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
  error?: { code: number; message: string; data?: unknown };
};

export type SignatureStatus = {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
};

type AddressSignatureInfo = {
  signature: string;
  slot: number;
  blockTime: number | null;
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

const SPL_TOKEN_PROGRAM_IDS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
] as const;

const DEFAULT_SIGNATURE_VISIBILITY_ATTEMPTS = 8;
const DEFAULT_SIGNATURE_VISIBILITY_DELAY_MS = 1_500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRpcSimulationLogs(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const logs = (data as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) {
    return [];
  }

  return logs.filter((line): line is string => typeof line === 'string' && line.length > 0);
}

function formatRpcErrorMessage(method: string, error: { message: string; data?: unknown }) {
  const logs = readRpcSimulationLogs(error.data);
  if (logs.length === 0) {
    return `Solana RPC ${method} error: ${error.message}`;
  }

  const compactLogs = logs.slice(-12).join(' | ');
  return `Solana RPC ${method} error: ${error.message}; simulationLogs=${compactLogs}`;
}

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

  private nextRequestId() {
    this.requestId += 1;
    return this.requestId;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
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
          id: this.nextRequestId(),
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
            new Error(formatRpcErrorMessage(method, body.error)),
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

  private sendRawTransactionToUrl(url: string, base64Transaction: string): Promise<string> {
    return this.executeCall<string>(url, 'sendTransaction', [
      base64Transaction,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5
      }
    ]);
  }

  async sendRawTransaction(base64Transaction: string): Promise<string> {
    return this.call<string>('sendTransaction', [
      base64Transaction,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5
      }
    ]);
  }

  async sendRawTransactionAndWaitForVisibility(
    base64Transaction: string,
    options: {
      visibilityAttempts?: number;
      visibilityDelayMs?: number;
    } = {}
  ): Promise<{ signature: string; status: SignatureStatus }> {
    const attempts = options.visibilityAttempts ?? DEFAULT_SIGNATURE_VISIBILITY_ATTEMPTS;
    const delayMs = options.visibilityDelayMs ?? DEFAULT_SIGNATURE_VISIBILITY_DELAY_MS;
    const acceptedSignatures: string[] = [];
    let lastError: Error | undefined;

    for (const url of this.writeUrls) {
      try {
        const signature = await this.sendRawTransactionToUrl(url, base64Transaction);
        acceptedSignatures.push(signature);
        const status = await this.waitForSignatureVisibility(signature, { attempts, delayMs });

        if (status) {
          if (status.err) {
            throw new Error('Solana transaction failed pre-confirmation: ' + JSON.stringify(status.err));
          }

          return { signature, status };
        }

        lastError = new Error('Solana transaction ' + signature + ' was accepted by RPC but never became visible');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (
          lastError.message.includes('Solana transaction failed pre-confirmation:') ||
          lastError.message.includes('Solana RPC sendTransaction error:')
        ) {
          throw lastError;
        }

        const disposition = this.classifyCallError(lastError);

        if (!disposition?.retryable && acceptedSignatures.length === 0) {
          throw lastError;
        }
      }
    }

    throw new Error(
      'Solana transaction was not visible after broadcast attempts' +
      (acceptedSignatures.length > 0 ? '; acceptedSignatures=' + acceptedSignatures.join(',') : '') +
      (lastError ? '; lastError=' + lastError.message : '')
    );
  }

  async getSignatureStatuses(
    signatures: string[]
  ): Promise<{ value: (SignatureStatus | null)[] }> {
    return this.call<{ value: (SignatureStatus | null)[] }>(
      'getSignatureStatuses',
      [signatures, { searchTransactionHistory: true }]
    );
  }

  async getSignatureStatusesAcrossReadEndpoints(
    signatures: string[]
  ): Promise<{ value: (SignatureStatus | null)[] }> {
    const merged: (SignatureStatus | null)[] = signatures.map(() => null);
    let lastError: Error | undefined;
    let successfulReads = 0;

    for (const url of this.readUrls) {
      try {
        const result = await this.executeCall<{ value: (SignatureStatus | null)[] }>(
          url,
          'getSignatureStatuses',
          [signatures, { searchTransactionHistory: true }]
        );
        successfulReads += 1;

        result.value.forEach((status, index) => {
          if (status && !merged[index]) {
            merged[index] = status;
          }
        });

        if (merged.every(Boolean)) {
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (successfulReads === 0 && lastError) {
      throw lastError;
    }

    return { value: merged };
  }

  async waitForSignatureVisibility(
    signature: string,
    options: {
      attempts?: number;
      delayMs?: number;
    } = {}
  ): Promise<SignatureStatus | null> {
    const attempts = options.attempts ?? DEFAULT_SIGNATURE_VISIBILITY_ATTEMPTS;
    const delayMs = options.delayMs ?? DEFAULT_SIGNATURE_VISIBILITY_DELAY_MS;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const statuses = await this.getSignatureStatusesAcrossReadEndpoints([signature]);
      const status = statuses.value[0];

      if (status) {
        return status;
      }

      if (attempt < attempts - 1) {
        await sleep(delayMs);
      }
    }

    return null;
  }

  async getSignaturesForAddress(
    address: string,
    options: { before?: string; until?: string; limit?: number } = {}
  ): Promise<AddressSignatureInfo[]> {
    return this.call<AddressSignatureInfo[]>(
      'getSignaturesForAddress',
      [address, options]
    );
  }

  async getTransaction<T = unknown>(signature: string): Promise<T | null> {
    return this.call<T | null>(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
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
    const results = await Promise.all(
      SPL_TOKEN_PROGRAM_IDS.map(async (programId) => {
        const result = await this.call<{ value: TokenAccount[] }>(
          'getTokenAccountsByOwner',
          [
            publicKey,
            { programId },
            { encoding: 'jsonParsed', commitment: 'confirmed' }
          ]
        );
        return result.value;
      })
    );
    return results.flat();
  }

  async getLatestBlockhash(): Promise<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }> {
    return this.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  }

  async getAddressLookupTable(address: string): Promise<AddressLookupTableAccount | null> {
    const result = await this.call<{ value: { data: [string, string] } | null }>(
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: 'confirmed' }]
    );

    const encoded = result.value?.data?.[0];
    if (!encoded) {
      return null;
    }

    return new AddressLookupTableAccount({
      key: new PublicKey(address),
      state: AddressLookupTableAccount.deserialize(Buffer.from(encoded, 'base64'))
    });
  }
}
