# Bug Ledger README

This directory tracks production-risk bug iterations for Lightld.

## Quick Workflow

1. Search existing cards first:
   `rg "<event|error|symbol|fingerprint>" docs/bugs/cards docs/bugs/BUG_INDEX.md`.
2. Update a card's Recurrences and Attempts if the issue belongs to an existing family.
3. Record full incident evidence in `docs/bugs/daily/YYYY-MM-DD.md`.
4. Add or update only the index-level row in `docs/bugs/BUG_INDEX.md`.
5. Mark closed only after the required harness or probe evidence. Local tests alone are `local green`; real deployment remains `deploy pending`.

## File Layout

- `docs/bugs/cards/<family-fingerprint>.md` - recurring or high-risk bug families.
- `docs/bugs/daily/YYYY-MM-DD.md` - full daily incident and fix ledger.
- `docs/bugs/BUG_INDEX.md` - compact status index.
- Standalone `BUG-YYYYMMDD-topic-fingerprint.md` files are reserved for unusually large investigations.

## Daily Cluster Template

```md
## Cluster CL-XXX-short-topic

### GitNexus Keys

| Key | Value |
| --- | --- |
| Components | component-a, component-b |
| Fingerprint | stable.family.fingerprint |
| Status | open / fixed-local-green / deployed-verified |

### Summary

### Root Cause

### Attempts

| Time | Attempt | Evidence | Result |
| --- | --- | --- | --- |

### Fix

### Verification

| Command / Probe | Evidence | Result |
| --- | --- | --- |

### Acceptance
```

## Bug Card Template

```md
# Bug Card: Family Name

## Stable Fingerprints

## Current Effective Rule

## Source / Business Semantics

## Attempts Ledger

| Date | Attempt | Evidence | Result |
| --- | --- | --- | --- |

## Recurrences

| Date | Cluster | Trigger | Result |
| --- | --- | --- | --- |

## Regression Harness

## Next Recurrence Checklist
```
