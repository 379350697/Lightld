export type IncidentKind =
  | 'spend_limit_blocked'
  | 'jupiter_rate_limited'
  | 'jupiter_no_route'
  | 'pending_partial_failure'
  | 'zero_token_balance'
  | 'dlmm_simulation_error'
  | 'missing_fill_evidence'
  | 'missing_lp_entry_metadata'
  | 'orphaned_position_without_bound_entry'
  | 'entry_reconstruction_ambiguous'
  | 'untrusted_requested_fallback_fill'
  | 'position_already_closed'
  | 'dependency_unavailable'
  | 'valuation_unavailable'
  | 'reconciliation_required'
  | 'unknown';

export type IncidentClassification = {
  kind: IncidentKind;
  rootCause: string;
  suggestedAction: string;
  severity?: 'warning' | 'error';
};

const POLICIES: Record<IncidentKind, Omit<IncidentClassification, 'kind'>> = {
  spend_limit_blocked: {
    rootCause: 'daily spend guard is correctly blocking new risk',
    suggestedAction: 'keep new opens paused until daily reset or raise the configured limit after review',
    severity: 'warning'
  },
  jupiter_rate_limited: {
    rootCause: 'Jupiter dependency is rate limited or cooling down',
    suggestedAction: 'honor cooldown, stop high-frequency quote/swap retries, and pause Jupiter-dependent opens',
    severity: 'warning'
  },
  jupiter_no_route: {
    rootCause: 'Jupiter cannot quote this mint/amount under current routing constraints',
    suggestedAction: 'apply target-level route negative cache and skip retries until the cache expires',
    severity: 'warning'
  },
  pending_partial_failure: {
    rootCause: 'a batched submission partially succeeded and needs chain/account evidence',
    suggestedAction: 'block same-target actions and only advance recovery from chain or account evidence',
    severity: 'error'
  },
  zero_token_balance: {
    rootCause: 'runtime tried to reduce inventory that is already absent from the wallet',
    suggestedAction: 'clear residual sell/close intent or mark the target as already flat after account sync',
    severity: 'warning'
  },
  dlmm_simulation_error: {
    rootCause: 'Meteora DLMM transaction simulation failed before landing',
    suggestedAction: 'decode DLMM error, validate position metadata/bin range/slippage, and cool down the target',
    severity: 'error'
  },
  missing_fill_evidence: {
    rootCause: 'close action reached terminal status without enough fill evidence',
    suggestedAction: 'keep pending reconciliation until account or chain evidence proves the realized fill',
    severity: 'warning'
  },
  missing_lp_entry_metadata: {
    rootCause: 'wallet has an LP position but runtime lacks entry metadata',
    suggestedAction: 'rebuild entry metadata from wallet LP position or mark the position orphaned',
    severity: 'warning'
  },
  orphaned_position_without_bound_entry: {
    rootCause: 'wallet has an LP position that is not bound to trusted entry evidence',
    suggestedAction: 'hold PnL exits and reconstruct entry from wallet delta or chain transaction evidence',
    severity: 'warning'
  },
  entry_reconstruction_ambiguous: {
    rootCause: 'multiple possible chain entries match the active LP position',
    suggestedAction: 'keep the position orphaned until an exact chain position or submission signature resolves the entry',
    severity: 'warning'
  },
  untrusted_requested_fallback_fill: {
    rootCause: 'a requested amount fallback reached a fill-like surface without trusted fill evidence',
    suggestedAction: 'exclude it from realized cashflow and repair from wallet delta or chain evidence',
    severity: 'warning'
  },
  position_already_closed: {
    rootCause: 'exit intent targeted an LP position that is already absent from the wallet',
    suggestedAction: 'treat the exit as not submitted, sync account state, and avoid creating pending or realized PnL',
    severity: 'warning'
  },
  dependency_unavailable: {
    rootCause: 'required external dependency has no currently usable endpoint',
    suggestedAction: 'enter dependency cooldown and avoid opening new risk until health recovers',
    severity: 'warning'
  },
  valuation_unavailable: {
    rootCause: 'position valuation is unavailable, stale, or invalid',
    suggestedAction: 'hold until valuation is refreshed or use account evidence for reduce-risk actions',
    severity: 'warning'
  },
  reconciliation_required: {
    rootCause: 'wallet/account state does not match journal state',
    suggestedAction: 'block risk-increasing actions and run account reconciliation before continuing',
    severity: 'warning'
  },
  unknown: {
    rootCause: 'incident reason has no typed handler yet',
    suggestedAction: 'inspect raw reason and add a taxonomy mapping if it recurs',
    severity: 'warning'
  }
};

export function classifyIncidentReason(reason: string): IncidentClassification {
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();
  let kind: IncidentKind = 'unknown';

  if (
    lower.includes('daily-spend-limit-exceeded') ||
    lower.includes('hourly-spend-limit-exceeded')
  ) {
    kind = 'spend_limit_blocked';
  } else if (
    lower.includes('pending-submission-partial-failure') ||
    lower.includes('pending-submission-recovery-required')
  ) {
    kind = 'pending_partial_failure';
  } else if (
    lower.includes('no rpc endpoint available for jupiter') ||
    lower.includes('jupiter') && (
      lower.includes('429') ||
      lower.includes('too many requests') ||
      lower.includes('rate-limited') ||
      lower.includes('rate limit')
    )
  ) {
    kind = 'jupiter_rate_limited';
  } else if (
    lower.includes('no_routes_found') ||
    lower.includes('cannot_compute_other_amount_threshold') ||
    lower.includes('jupiter quote no route') ||
    lower.includes('jupiter_no_route')
  ) {
    kind = 'jupiter_no_route';
  } else if (
    lower.includes('token balance is zero') ||
    lower.includes('zero_token_balance') ||
    lower.includes('zero-token-balance')
  ) {
    kind = 'zero_token_balance';
  } else if (
    lower.includes('custom program error: 0x1771') ||
    lower.includes('custom program error: 0x1774') ||
    lower.includes('dlmm') && lower.includes('simulation')
  ) {
    kind = 'dlmm_simulation_error';
  } else if (lower.includes('missing-fill-evidence')) {
    kind = 'missing_fill_evidence';
  } else if (
    lower.includes('orphaned-position-without-bound-entry') ||
    lower.includes('orphaned_position_without_bound_entry')
  ) {
    kind = 'orphaned_position_without_bound_entry';
  } else if (
    lower.includes('entry-reconstruction-ambiguous') ||
    lower.includes('entry_reconstruction_ambiguous')
  ) {
    kind = 'entry_reconstruction_ambiguous';
  } else if (
    lower.includes('requested-position-fallback') ||
    lower.includes('untrusted_requested_fallback_fill')
  ) {
    kind = 'untrusted_requested_fallback_fill';
  } else if (
    lower.includes('position-already-closed') ||
    lower.includes('position not found for pool')
  ) {
    kind = 'position_already_closed';
  } else if (lower.includes('lp-position-missing-entry-metadata')) {
    kind = 'missing_lp_entry_metadata';
  } else if (lower.includes('valuation-unavailable')) {
    kind = 'valuation_unavailable';
  } else if (lower.includes('reconciliation-required')) {
    kind = 'reconciliation_required';
  } else if (lower.includes('no rpc endpoint available')) {
    kind = 'dependency_unavailable';
  }

  if (kind === 'dlmm_simulation_error') {
    if (lower.includes('0x1771')) {
      return {
        kind,
        rootCause: 'Meteora DLMM invalidBinId (6001) simulation failure',
        suggestedAction: 'refresh active bin and position range before retrying; cool down the target if bin data is stale',
        severity: 'error'
      };
    }

    if (lower.includes('0x1774')) {
      return {
        kind,
        rootCause: 'Meteora DLMM exceededBinSlippageTolerance (6004) simulation failure',
        suggestedAction: 'refresh active bin/slippage inputs and skip retry until the target cooldown expires',
        severity: 'error'
      };
    }
  }

  return {
    kind,
    ...POLICIES[kind]
  };
}

export function buildIncidentDedupeKey(input: {
  kind: IncidentKind;
  strategyId?: string;
  stage: string;
  reason: string;
  tokenMint?: string;
  poolAddress?: string;
  action?: string;
}) {
  return [
    input.strategyId || 'unknown-strategy',
    input.kind,
    input.stage || 'unknown-stage',
    input.action || 'unknown-action',
    input.tokenMint || 'unknown-mint',
    input.poolAddress || 'unknown-pool',
    input.reason || 'unknown-reason'
  ].join('|');
}
