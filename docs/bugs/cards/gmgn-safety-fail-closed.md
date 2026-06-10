# Bug Card: GMGN Safety Fail-Closed

## Stable Fingerprints

- `ingest.gmgn_safety.failure_preserves_candidates`

## Current Effective Rule

For live new-token candidate selection, GMGN safety dependency failures must fail closed and keep diagnostics. A safety outage cannot preserve unfiltered candidates.

## Source / Business Semantics

New-token live execution depends on token safety checks as a hard risk gate. If safety data cannot be fetched or interpreted, the correct live behavior is to skip the candidate and emit a block reason.

## Attempts Ledger

| Date | Attempt | Evidence | Result |
| --- | --- | --- | --- |
| 2026-06-11 | Initial audit | `applySafetyFilter` catch returned original candidates | Fixed local; deploy pending. |

## Recurrences

| Date | Cluster | Trigger | Result |
| --- | --- | --- | --- |
| 2026-06-11 | CL-002 | Mainnet readiness review | Fixed local; deploy pending |

## Regression Harness

- Safety fetch throw returns no candidates.
- Fallback route reports safety-check failure details.
- Candidate scan evidence contains rejected mint and error.

## Next Recurrence Checklist

- Verify safety exceptions are represented as diagnostics, not swallowed.
- Confirm no live strategy path bypasses safety after dependency failure.
- Mark closed only after targeted ingest tests and full suite pass.
