type RpcEndpointPolicy = {
  writeRpcUrls: string[];
  readRpcUrls: string[];
  dlmmRpcUrl: string;
};

const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
const PUBLIC_MAINNET_RPC_2 = 'https://solana.public-rpc.com';
const DEFAULT_ALCHEMY_RPC = 'https://solana-mainnet.g.alchemy.com/v2/aX1RqrD7J3NBVdAf7WQeG';
const DEFAULT_HELIUS_KEYS = [
  '218113a4-bca4-4aad-a594-499bfef95880',
  'fb64f8b3-48ce-416f-8c7a-6f265c3ee227',
  'a5db71fe-3c58-472e-9ba8-3c2c37d9d533'
];

function normalizeUrl(value: string | undefined) {
  return value?.trim() ?? '';
}

function splitUrls(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => normalizeUrl(entry))
    .filter(Boolean);
}

function uniqueUrls(urls: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push(url);
  }

  return result;
}

function buildHeliusUrl(apiKey: string) {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export function getDefaultTradeRpcUrls() {
  return [
    ...DEFAULT_HELIUS_KEYS.map(buildHeliusUrl),
    PUBLIC_MAINNET_RPC,
    PUBLIC_MAINNET_RPC_2
  ];
}

export function getDefaultReadRpcUrls() {
  return [
    DEFAULT_ALCHEMY_RPC,
    ...getDefaultTradeRpcUrls()
  ];
}

export function resolveRpcEndpointPolicy(
  env: Record<string, string | undefined> = process.env
): RpcEndpointPolicy {
  const explicitWriteUrls = splitUrls(env.SOLANA_RPC_WRITE_URLS);
  const explicitReadUrls = splitUrls(env.SOLANA_RPC_READ_URLS);
  const explicitTradeRpc = normalizeUrl(env.SOLANA_RPC_URL);
  const explicitQueryRpc = normalizeUrl(env.SOLANA_QUERY_RPC_URL);
  const explicitDlmmRpc = normalizeUrl(env.SOLANA_DLMM_RPC_URL);

  const defaultWriteUrls = getDefaultTradeRpcUrls();
  const defaultReadUrls = getDefaultReadRpcUrls();

  const writeRpcUrls = uniqueUrls([
    ...explicitWriteUrls,
    ...(explicitTradeRpc ? [explicitTradeRpc] : []),
    ...defaultWriteUrls
  ]);

  const readRpcUrls = uniqueUrls([
    ...explicitReadUrls,
    ...(explicitQueryRpc ? [explicitQueryRpc] : []),
    ...defaultReadUrls,
    ...writeRpcUrls
  ]);

  const dlmmRpcUrl = explicitDlmmRpc || explicitQueryRpc || readRpcUrls[0] || writeRpcUrls[0] || PUBLIC_MAINNET_RPC;

  return {
    writeRpcUrls,
    readRpcUrls,
    dlmmRpcUrl
  };
}

export type { RpcEndpointPolicy };
