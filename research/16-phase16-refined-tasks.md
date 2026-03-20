---
type: spec
id: 16
phase: 16
tasks: [109, 110, 111, 112, 113, 114, 115, 116]
research: 15
principles:
  - nonblocking
  - observable
  - cancellable
  - incremental
  - bounded
verification:
  - npx tsc --noEmit
  - npx vitest run
completion_steps:
  - append to progress.txt
  - mark checkbox in PRD.md
  - git add -A && git commit -m 'feat: <description>'
---

# Phase 16 — Refined Task Specifications

> Based on startup-latency analysis in `research/15-phase16-deep-research.md`
>
> **Principles**: nonblocking, observable, cancellable, incremental, bounded.
> **TDD is MANDATORY**: every task must follow red-green-refactor.
> Run `npx tsc --noEmit` and `npx vitest run` — ALL tests must pass before marking any checkbox.

### Task 109 — Bearings Policy Split

**Goal**: Stop running full `tsc` + full `vitest` as an opaque default before every task.

**Design**:
- Replace the current boolean bearings shape with stage-aware policy:
  - `startup`: `'none' | 'tsc' | 'targeted-tests' | 'full'`
  - `perTask`: `'none' | 'dirty-tsc' | 'targeted-tests' | 'full'`
  - `checkpoint`: `'tsc' | 'targeted-tests' | 'full'`
- Default policy should be conservative for DX:
  - `startup: 'tsc'`
  - `perTask: 'none'`
  - `checkpoint: 'full'`
- Preserve strictness at explicit checkpoints, but remove unconditional full-suite startup cost.

**Tests (write FIRST)**:
- Config defaults resolve to `startup=tsc`, `perTask=none`, `checkpoint=full`
- Existing behavior preserved when `full` is explicitly chosen
- Task start no longer implies full `vitest run` by default

**Files**: `src/types.ts`, `src/orchestrator.ts`, `test/orchestrator.test.ts`

**Dependencies**: none

### Task 110 — CHECKPOINT: Bearings Policy Verification

**Goal**: Verify startup no longer triggers full-suite validation by default.

**Design**:
- Manual and automated validation task
- Confirm no `node (vitest …)` swarm appears on simple startup with default config
- Confirm checkpoints still run strong verification

**Tests (write FIRST)**:
- Startup path emits no full-suite trigger under default policy
- Checkpoint path still triggers configured validation

**Files**: `test/orchestrator.test.ts`

**Dependencies**: 109

### Task 111 — Async Verification Runner

**Goal**: Remove extension-host blocking caused by synchronous `execSync()` in `runBearings()`.

**Design**:
- Introduce an async command runner using `spawn`/`execFile`
- Stream stdout/stderr incrementally to logger/output channel
- Support cancellation via `AbortSignal`
- Replace `defaultBearingsExec()` sync shape with async equivalent
- Ensure extension host stays responsive while verification runs

**Tests (write FIRST)**:
- Async runner returns exit code/output shape equivalent to current API
- Cancellation stops child process cleanly
- Long-running verification does not block subsequent event emissions

**Files**: `src/orchestrator.ts`, `src/shellHookProvider.ts` (pattern reference or shared helper), `test/orchestrator.test.ts`

**Dependencies**: 109

### Task 112 — CHECKPOINT: Non-Blocking Verification Verification

**Goal**: Prove the extension host remains responsive during startup verification.

**Design**:
- Validation task for async bearings behavior
- Confirm user sees progress logs/messages before verification completes
- Confirm no multi-minute “dead air” before first visible update

**Tests (write FIRST)**:
- Bearings progress events/logs emitted before completion
- No sync-blocking helper remains in startup path

**Files**: `test/orchestrator.test.ts`

**Dependencies**: 111

### Task 113 — Verification Cache & Dirty-Aware Skip

**Goal**: Avoid rerunning expensive validation when nothing relevant changed.

**Design**:
- Add cached last-green verification metadata under `.ralph/verification.json`
- Key cache by relevant inputs: branch/tree-ish, selected policy, changed file set summary, timestamps
- If no relevant source/test/config files changed since last green result, reuse cached startup/per-task result
- Allow targeted invalidation when `package.json`, lockfiles, test config, or core runtime files change

**Tests (write FIRST)**:
- Cache hit skips rerun when inputs unchanged
- Cache miss reruns when relevant files/config change
- Cache invalidates on branch/tree change

**Files**: `src/orchestrator.ts`, `src/sessionPersistence.ts` or new verification-cache module, `test/orchestrator.test.ts`

**Dependencies**: 109, 111

### Task 114 — CHECKPOINT: Cache / Dirty-Skip Verification

**Goal**: Prove repeated task starts stay cheap when the workspace state is unchanged.

**Design**:
- Validation task for cache behavior
- Confirm second startup/per-task preflight reuses cached green state
- Confirm full verification still reappears when dirty conditions are triggered

**Tests (write FIRST)**:
- Repeated start uses cache
- Dirty change invalidates cache

**Files**: `test/orchestrator.test.ts`

**Dependencies**: 113

### Task 115 — Startup UX Transparency

**Goal**: Make startup behavior visible, understandable, and cancellable.

**Design**:
- Add explicit events/status for bearings lifecycle:
  - `BearingsStarted`
  - `BearingsProgress`
  - `BearingsCompleted`
  - `BearingsSkipped`
- Surface progress immediately in log output and a lightweight status/progress UI
- Show which stage is running (`tsc`, targeted tests, full tests, cache hit)
- Include elapsed time and reason for skips/cached reuse
- If startup validation is expected to take long, show an actionable message instead of silence

**Tests (write FIRST)**:
- Bearings lifecycle events emitted in correct order
- Cache skip path emits explicit skipped/cached message
- Long-running path emits progress before completion

**Files**: `src/types.ts`, `src/orchestrator.ts`, `src/extension.ts`, `test/orchestrator.test.ts`

**Dependencies**: 111, 113

### Task 116 — CHECKPOINT: Startup DX Verification

**Goal**: Final validation that Ralph startup is transparent, bounded, and stable.

**Design**:
- Manual + automated gate
- Confirm default startup no longer causes extension-host freeze or silent 1-2 minute wait
- Confirm process manager no longer shows full `vitest` worker swarm on ordinary task start
- Confirm logs clearly explain what stage is running or why it was skipped

**Tests (write FIRST)**:
- End-to-end startup path uses the new bearings policy, async runner, cache, and progress events
- No hidden full-suite default remains

**Files**: `test/orchestrator.test.ts`

**Dependencies**: 115
