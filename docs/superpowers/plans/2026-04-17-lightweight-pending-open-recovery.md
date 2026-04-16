# Lightweight Pending Open Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear unknown open pending submissions when the automation wallet quickly shows a matching LP position, without introducing heavyweight reconciliation.

**Architecture:** Keep recovery logic inside the existing pending submission gate. Add a lightweight heuristic for automation-only wallets: if an unknown open has no signature but a fresh matching LP position appears for the same mint within a short window, treat it as a successful open and advance lifecycle state to `open`.

**Tech Stack:** TypeScript, Vitest, existing runtime recovery pipeline

---

### Task 1: Cover the new lightweight recovery rule with tests

**Files:**
- Modify: `tests/ts/runtime/pending-submission-recovery.test.ts`
- Test: `tests/ts/runtime/pending-submission-recovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Add one test that expects `recoverPendingSubmission()` to clear an unknown `add-lp` submission when a matching wallet LP position appears shortly after `createdAt`.

Add one test that expects the same submission to remain blocked when the matching LP evidence appears outside the allowed freshness window.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ts/runtime/pending-submission-recovery.test.ts`
Expected: FAIL on the new success-path assertion because the current code keeps the submission blocked.

- [ ] **Step 3: Commit**

```bash
git add tests/ts/runtime/pending-submission-recovery.test.ts
git commit -m "test: cover lightweight pending open recovery"
```

### Task 2: Implement the minimal recovery heuristic

**Files:**
- Modify: `src/runtime/pending-submission-recovery.ts`
- Test: `tests/ts/runtime/pending-submission-recovery.test.ts`

- [ ] **Step 1: Write the minimal implementation**

Add a helper that recognizes a fresh LP position for the same `tokenMint` when:
- the pending submission has no `submissionId`
- the action is an open-risk action
- the wallet now contains a matching LP position with liquidity evidence
- the current recovery check is still within a short freshness window from `createdAt`

Return `pending-submission-filled` for that case so existing lifecycle transitions keep working.

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- tests/ts/runtime/pending-submission-recovery.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/runtime/pending-submission-recovery.ts tests/ts/runtime/pending-submission-recovery.test.ts
git commit -m "fix: recover unknown opens from fresh lp evidence"
```

### Task 3: Verify no regression in the live-cycle recovery path

**Files:**
- Test: `tests/ts/runtime/live-cycle-production.test.ts`

- [ ] **Step 1: Run focused regression coverage**

Run: `npm test -- tests/ts/runtime/pending-submission-recovery.test.ts tests/ts/runtime/live-cycle-production.test.ts`
Expected: PASS

- [ ] **Step 2: Record final outcome**

Summarize that unknown open submissions can now self-heal for automation-only wallets when a fresh matching LP appears, while stale evidence still stays blocked.
