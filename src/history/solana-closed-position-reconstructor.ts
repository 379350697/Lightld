export type SolanaClosedPositionLifecycleEvent = {
  signature: string;
  recordedAt: string;
  kind: 'open' | 'withdraw' | 'claim-fee';
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  positionAddress: string;
  solAmount: number;
  tokenAmount: number;
  tokenValueSol: number;
};

type ParsedInstruction = {
  programId?: string;
  accounts?: string[];
  program?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
};

type ParsedInnerInstructionGroup = {
  index: number;
  instructions: ParsedInstruction[];
};

type ParsedTransaction = {
  blockTime: number | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: Array<string | { pubkey?: string }>;
      instructions?: ParsedInstruction[];
    };
  };
  meta?: {
    preBalances?: number[];
    postBalances?: number[];
    logMessages?: string[];
    innerInstructions?: ParsedInnerInstructionGroup[];
  };
};

const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const DLMM_INSTRUCTION_NAMES = new Set([
  'InitializePosition',
  'AddLiquidityByStrategy2',
  'RemoveLiquidityByRange2',
  'ClaimFee2',
  'ClosePositionIfEmpty'
]);

export type ClosedPositionSnapshot = {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  positionAddress: string;
  openedAt: string;
  closedAt: string;
  depositSol: number;
  depositTokenAmount: number;
  withdrawSol: number;
  withdrawTokenAmount: number;
  withdrawTokenValueSol: number;
  feeSol: number;
  feeTokenAmount: number;
  feeTokenValueSol: number;
  pnlSol: number;
  source: 'solana-chain' | 'wallet-delta';
  confidence: 'exact' | 'partial';
};

export type OpenPositionEntryEvidence = {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  positionAddress: string;
  openedAt: string;
  entrySol: number;
  signature: string;
  source: 'solana-chain';
  confidence: 'exact' | 'partial';
};

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function toIsoString(blockTime: number | null) {
  if (typeof blockTime !== 'number' || !Number.isFinite(blockTime)) {
    return '';
  }

  return new Date(blockTime * 1000).toISOString();
}

function toNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (value && typeof value === 'object') {
    const uiAmount = (value as { uiAmount?: unknown }).uiAmount;
    if (typeof uiAmount === 'number' && Number.isFinite(uiAmount)) {
      return uiAmount;
    }

    const uiAmountString = (value as { uiAmountString?: unknown }).uiAmountString;
    if (typeof uiAmountString === 'string') {
      const parsed = Number(uiAmountString);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function findInstructionName(logMessages: string[] | undefined, name: string) {
  return logMessages?.some((message) => message.includes(`Instruction: ${name}`)) ?? false;
}

function isDlmmInstruction(instruction: ParsedInstruction) {
  return instruction.program === 'meteora' || instruction.programId === DLMM_PROGRAM_ID;
}

function resolveInstructionIndexes(input: {
  instructions: ParsedInstruction[];
  logMessages?: string[];
}) {
  const customInstructionIndexes = input.instructions
    .map((instruction, index) => ({ instruction, index }))
    .filter(({ instruction }) => isDlmmInstruction(instruction))
    .map(({ index }) => index);

  const names = (input.logMessages ?? [])
    .map((message) => {
      const match = message.match(/Instruction:\s+([A-Za-z0-9]+)/);
      return match?.[1] ?? '';
    })
    .filter((name) => DLMM_INSTRUCTION_NAMES.has(name));

  const namesByIndex = new Map<number, string>();
  for (let index = 0; index < customInstructionIndexes.length; index += 1) {
    const instructionIndex = customInstructionIndexes[index];
    const instructionName = names[index];
    if (instructionName) {
      namesByIndex.set(instructionIndex, instructionName);
    }
  }

  return namesByIndex;
}

function resolveIdentity(instructions: ParsedInstruction[]) {
  for (const instruction of instructions) {
    const info = instruction.parsed?.info;
    const poolAddress = typeof info?.pool === 'string' ? info.pool : '';
    const positionAddress = typeof info?.position === 'string' ? info.position : '';
    if (poolAddress.length > 0 || positionAddress.length > 0) {
      return { poolAddress, positionAddress };
    }
  }

  return { poolAddress: '', positionAddress: '' };
}

function instructionMentionsAddress(instruction: ParsedInstruction, address: string) {
  if (instruction.accounts?.includes(address)) {
    return true;
  }

  const info = instruction.parsed?.info;
  return Object.values(info ?? {}).some((value) => value === address);
}

function transactionMentionsAddress(transaction: ParsedTransaction, address: string) {
  if (!address) {
    return false;
  }

  const accountKeys = transaction.transaction?.message?.accountKeys ?? [];
  if (accountKeys.some((key) => accountKeyToString(key) === address)) {
    return true;
  }

  const topLevelInstructions = transaction.transaction?.message?.instructions ?? [];
  if (topLevelInstructions.some((instruction) => instructionMentionsAddress(instruction, address))) {
    return true;
  }

  return (transaction.meta?.innerInstructions ?? []).some((group) =>
    group.instructions.some((instruction) => instructionMentionsAddress(instruction, address))
  );
}

function hasStrictPositionEvidence(input: {
  transaction: ParsedTransaction;
  requestedPositionAddress?: string;
  parsedPositionAddress?: string;
}) {
  const requestedPositionAddress = input.requestedPositionAddress ?? '';

  if (!requestedPositionAddress) {
    return false;
  }

  if (input.parsedPositionAddress) {
    return input.parsedPositionAddress === requestedPositionAddress;
  }

  return transactionMentionsAddress(input.transaction, requestedPositionAddress);
}

function readTransferAmounts(instructions: ParsedInstruction[], tokenMint: string, tokenPriceInSol: number) {
  let solAmount = 0;
  let tokenAmount = 0;

  for (const instruction of instructions) {
    const type = instruction.parsed?.type ?? '';
    const info = instruction.parsed?.info ?? {};

    if (type === 'transfer' && 'lamports' in info) {
      solAmount += toNumber(info.lamports) / 1_000_000_000;
      continue;
    }

    if (type !== 'transferChecked' && type !== 'transfer') {
      continue;
    }

    const mint = typeof info.mint === 'string' ? info.mint : '';
    const amount = toNumber(info.tokenAmount);

    if (mint === 'So11111111111111111111111111111111111111112') {
      solAmount += amount;
      continue;
    }

    if (mint === tokenMint) {
      tokenAmount += amount;
    }
  }

  return {
    solAmount,
    tokenAmount,
    tokenValueSol: tokenAmount * tokenPriceInSol
  };
}

function accountKeyToString(value: string | { pubkey?: string } | undefined) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value.pubkey === 'string') {
    return value.pubkey;
  }

  return '';
}

function readWalletNativeSolDelta(input: {
  walletAddress: string;
  transaction: ParsedTransaction;
}) {
  const accountKeys = input.transaction.transaction?.message?.accountKeys ?? [];
  const walletIndex = accountKeys.findIndex((key) => accountKeyToString(key) === input.walletAddress);

  if (walletIndex < 0) {
    return undefined;
  }

  const preLamports = input.transaction.meta?.preBalances?.[walletIndex];
  const postLamports = input.transaction.meta?.postBalances?.[walletIndex];

  if (
    typeof preLamports !== 'number'
    || typeof postLamports !== 'number'
    || !Number.isFinite(preLamports)
    || !Number.isFinite(postLamports)
  ) {
    return undefined;
  }

  const deltaSol = (postLamports - preLamports) / 1_000_000_000;
  return Number.isFinite(deltaSol) && deltaSol !== 0 ? deltaSol : undefined;
}

export function extractLifecycleEventsFromTransaction(input: {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenPriceInSol?: number;
  poolAddress?: string;
  positionAddress?: string;
  transaction: ParsedTransaction;
}): SolanaClosedPositionLifecycleEvent[] {
  const topLevelInstructions = input.transaction.transaction?.message?.instructions ?? [];
  const signature = input.transaction.transaction?.signatures?.[0] ?? '';
  const recordedAt = toIsoString(input.transaction.blockTime);
  const identity = resolveIdentity(topLevelInstructions);
  const poolAddress = identity.poolAddress || input.poolAddress || '';
  const positionAddress = identity.positionAddress || input.positionAddress || '';
  const instructionNames = resolveInstructionIndexes({
    instructions: topLevelInstructions,
    logMessages: input.transaction.meta?.logMessages
  });
  const events: SolanaClosedPositionLifecycleEvent[] = [];
  const tokenPriceInSol = input.tokenPriceInSol ?? 0;

  if (findInstructionName(input.transaction.meta?.logMessages, 'AddLiquidityByStrategy2')) {
    const { solAmount, tokenAmount, tokenValueSol } = readTransferAmounts(
      topLevelInstructions.filter((instruction) =>
        instruction.program === 'system'
        && typeof instruction.parsed?.info?.source === 'string'
        && instruction.parsed.info.source === input.walletAddress
      ),
      input.tokenMint,
      tokenPriceInSol
    );

    events.push({
      signature,
      recordedAt,
      kind: 'open',
      walletAddress: input.walletAddress,
      tokenMint: input.tokenMint,
      tokenSymbol: input.tokenSymbol,
      poolAddress,
      positionAddress,
      solAmount,
      tokenAmount,
      tokenValueSol
    });
  }

  const innerGroups = new Map((input.transaction.meta?.innerInstructions ?? []).map((group) => [group.index, group.instructions]));

  for (const [instructionIndex, instructionName] of instructionNames.entries()) {
    if (instructionName !== 'RemoveLiquidityByRange2' && instructionName !== 'ClaimFee2') {
      continue;
    }

    const { solAmount, tokenAmount, tokenValueSol } = readTransferAmounts(
      innerGroups.get(instructionIndex) ?? [],
      input.tokenMint,
      tokenPriceInSol
    );

    events.push({
      signature,
      recordedAt,
      kind: instructionName === 'ClaimFee2' ? 'claim-fee' : 'withdraw',
      walletAddress: input.walletAddress,
      tokenMint: input.tokenMint,
      tokenSymbol: input.tokenSymbol,
      poolAddress,
      positionAddress,
      solAmount,
      tokenAmount,
      tokenValueSol
    });
  }

  return events.filter((event) => event.recordedAt.length > 0 && event.signature.length > 0);
}

export function reconstructOpenPositionEntryEvidence(input: {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenPriceInSol?: number;
  poolAddress?: string;
  positionAddress?: string;
  transaction: ParsedTransaction;
}): OpenPositionEntryEvidence | null {
  const parsedIdentity = resolveIdentity(input.transaction.transaction?.message?.instructions ?? []);
  if (input.positionAddress && !hasStrictPositionEvidence({
    transaction: input.transaction,
    requestedPositionAddress: input.positionAddress,
    parsedPositionAddress: parsedIdentity.positionAddress
  })) {
    return null;
  }

  if (!input.positionAddress) {
    return null;
  }

  const events = extractLifecycleEventsFromTransaction(input);
  const openEvents = events.filter((event) => event.kind === 'open');

  if (openEvents.length === 0) {
    return null;
  }

  const matchingOpenEvents = openEvents.filter((event) => {
    if (input.poolAddress && event.poolAddress && input.poolAddress !== event.poolAddress) {
      return false;
    }

    if (input.positionAddress && event.positionAddress && input.positionAddress !== event.positionAddress) {
      return false;
    }

    return true;
  });

  if (matchingOpenEvents.length === 0) {
    return null;
  }

  const firstOpen = matchingOpenEvents[0];
  const walletDeltaSol = readWalletNativeSolDelta({
    walletAddress: input.walletAddress,
    transaction: input.transaction
  });
  const walletSpendSol = typeof walletDeltaSol === 'number' && walletDeltaSol < 0
    ? Math.abs(walletDeltaSol)
    : undefined;
  const entrySol = walletSpendSol ?? firstOpen.solAmount;

  if (entrySol <= 0) {
    return null;
  }

  return {
    walletAddress: input.walletAddress,
    tokenMint: input.tokenMint,
    tokenSymbol: firstOpen.tokenSymbol,
    poolAddress: firstOpen.poolAddress || input.poolAddress || '',
    positionAddress: firstOpen.positionAddress || input.positionAddress || '',
    openedAt: firstOpen.recordedAt,
    entrySol,
    signature: firstOpen.signature,
    source: 'solana-chain',
    confidence: walletSpendSol ? 'exact' : 'partial'
  };
}

export function reconstructClosedPositionSnapshot(input: {
  walletAddress: string;
  tokenMint: string;
  events: SolanaClosedPositionLifecycleEvent[];
}): ClosedPositionSnapshot | null {
  const relevantEvents = input.events
    .filter((event) => event.walletAddress === input.walletAddress && event.tokenMint === input.tokenMint)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));

  const openEvents = relevantEvents.filter((event) => event.kind === 'open');
  const withdrawEvents = relevantEvents.filter((event) => event.kind === 'withdraw');

  if (openEvents.length === 0 || withdrawEvents.length === 0) {
    return null;
  }

  const feeEvents = relevantEvents.filter((event) => event.kind === 'claim-fee');
  const firstOpen = openEvents[0];
  const lastWithdraw = withdrawEvents[withdrawEvents.length - 1];
  const depositSol = sum(openEvents.map((event) => event.solAmount));
  const depositTokenAmount = sum(openEvents.map((event) => event.tokenAmount));
  const withdrawSol = sum(withdrawEvents.map((event) => event.solAmount));
  const withdrawTokenAmount = sum(withdrawEvents.map((event) => event.tokenAmount));
  const withdrawTokenValueSol = sum(withdrawEvents.map((event) => event.tokenValueSol));
  const feeSol = sum(feeEvents.map((event) => event.solAmount));
  const feeTokenAmount = sum(feeEvents.map((event) => event.tokenAmount));
  const feeTokenValueSol = sum(feeEvents.map((event) => event.tokenValueSol));
  const pnlSol = withdrawSol + withdrawTokenValueSol + feeSol + feeTokenValueSol - depositSol;
  const hasEstimatedTokenComponent = depositTokenAmount > 0 || withdrawTokenAmount > 0 || feeTokenAmount > 0;

  return {
    walletAddress: input.walletAddress,
    tokenMint: input.tokenMint,
    tokenSymbol: firstOpen.tokenSymbol || lastWithdraw.tokenSymbol,
    poolAddress: lastWithdraw.poolAddress || firstOpen.poolAddress,
    positionAddress: lastWithdraw.positionAddress || firstOpen.positionAddress,
    openedAt: firstOpen.recordedAt,
    closedAt: lastWithdraw.recordedAt,
    depositSol,
    depositTokenAmount,
    withdrawSol,
    withdrawTokenAmount,
    withdrawTokenValueSol,
    feeSol,
    feeTokenAmount,
    feeTokenValueSol,
    pnlSol,
    source: 'solana-chain',
    confidence: hasEstimatedTokenComponent ? 'partial' : 'exact'
  };
}
