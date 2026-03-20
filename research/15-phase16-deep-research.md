---
type: research
id: 15
phase: 16
date: 2026-03-20
sources:
  - ralph-loop/src/orchestrator.ts
  - ralph-loop/src/strategies.ts
  - ralph-loop/src/extension.ts
methodology: direct code inspection + live process/log correlation
derived_specs: [16]
tags: [startup-latency, bearings, vitest, extension-host, dx]
---

# Phase 16 — Startup Latency & Preflight Transparency Research

## Problem Statement

When Ralph starts a task, the extension often appears frozen for 1-2 minutes: no user-facing feedback, no prompt window, and heavy CPU load from multiple `node (vitest …)` worker processes. This creates a poor developer experience and destabilizes the VS Code Insiders extension host.

## Evidence

### Code Path

1. `activate()` in `src/extension.ts` logs `Loop started` and immediately enters `runLoop()`.
2. `runLoop()` in `src/orchestrator.ts` performs a **Bearings phase** before task execution.
3. `runBearings()` executes:
   - `npx tsc --noEmit`
   - `npx vitest run`
   synchronously via `execSync()`.
4. Because Ralph runs **inside the VS Code extension host**, these `execSync()` calls block the extension host event loop.
5. `npx vitest run` spawns many worker processes and can consume significant CPU even before the first task is shown.

### Supporting Source Evidence

- `src/orchestrator.ts`: `defaultBearingsExec()` uses `execSync(cmd, …)`
- `src/orchestrator.ts`: `runBearings()` runs full `npx vitest run` whenever bearings `runTests` is enabled
- `src/orchestrator.ts`: no progress event is emitted before or during bearings execution
- `src/extension.ts`: startup logs show `Loop started` before any visible task-start signal
- `src/strategies.ts`: the per-task wait path also creates a workspace-wide file watcher + 5s polling loop, but the **initial startup stall happens before prompt send**, so bearings is the primary startup bottleneck

## Root Cause

The startup delay is caused by **synchronous full-suite validation inside the extension host on every task-start path**. This couples heavyweight verification with interactive startup and provides no progressive feedback.

This is not just a performance bug; it violates extension-host best practices:
- avoid `execSync()` for long-running commands in the extension host
- avoid full test-suite runs as a default per-task preflight
- avoid opaque waits without progress or cancellation feedback

## Best-Practice Direction

### 1. Non-blocking command execution
Replace synchronous `execSync()` bearings with async process execution (`spawn` / `execFile`) and stream progress to the log/output channel.

### 2. Stage-aware validation policy
Validation should be split into tiers:
- **Session-start baseline**: one-time cheap health check
- **Per-task preflight**: cheap or skipped by default
- **Checkpoint/full verification**: expensive checks run only at explicit task gates

### 3. Cached / dirty-aware preflight
If no relevant files changed since the last green verification, reuse cached results instead of rerunning `tsc`/`vitest`.

### 4. Transparent startup UX
Ralph must immediately surface what it is doing:
- `Bearings started`
- `TypeScript check running`
- `Test verification running`
- `Using cached verification` / `Skipping full suite`
- estimated or elapsed time

### 5. Bounded test scope
Full `npx vitest run` should **not** be the default at task start. Prefer:
- no tests on startup by default
- targeted tests for affected areas
- full suite only at explicit checkpoints or when a task changes shared/runtime-critical code

## Recommended PRD Shape

A new phase should introduce:
1. A **validation policy** object that separates startup, per-task, and checkpoint verification.
2. An **async verification runner** with streaming progress and cancellation.
3. A **verification cache** keyed by branch/tree/changed files.
4. A **startup UX/progress layer** so the user is never left staring at nothing.

## Non-goals

- Do not remove validation entirely.
- Do not weaken checkpoints that intentionally gate correctness.
- Do not make startup polling-based or add new background timers just to report progress.

## Conclusion

The bug is primarily architectural, not just tuning: Ralph performs heavyweight synchronous verification in the extension host before presenting work. The fix is to decouple startup from full validation, make validation async and scoped, and make its status visible.