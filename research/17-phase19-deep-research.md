---
type: spec
id: 17
phase: 19
tasks: [138, 139, 140, 141, 142, 143]
research: 17
principles:
  - observable
  - idempotent
  - bounded
  - nonblocking
verification:
  - npx tsc --noEmit
  - npx vitest run
completion_steps:
  - append to progress.txt
  - mark checkbox in PRD.md
  - git add -A && git commit -m 'fix: <description>'
---

# Phase 19 — Spec: Status Bar Idle/Processing Consistency

> Generated from FINAL-REPORT.md by wave-spec-generator
> 6 tasks across 2 sub-phases

## Summary

This phase fixes the split-brain status bug where the visible bar can remain on `processing` while `ralph-loop.status` already reports `idle`. The work pairs a Ralph-side guaranteed idle refresh with a fork-side precedence model, then hardens terminal sequencing, abnormal exits, stop responsiveness, and regressions so the bar converges to idle across normal, failed, resumed, and consecutive runs.

## Sub-Phase 19.1 — Make idle authoritative

### Task 138 — Add a shared final idle refresh path in `src/extension.ts`

**Goal**: Guarantee one authoritative Ralph idle refresh after every `await orchestrator.start()` settlement, including crashes and auto-resume.

**Design**:
- Extract a shared runner/finalizer in `src/extension.ts` that wraps `orchestrator.start()` in `try/catch/finally` and always performs the same post-settlement idle refresh.
- The finalizer must call both the local status-bar path (`showStatusBarIdle()` or an equivalent zeroed `updateStatusBar()`) and `fireStateChangeNotification(LoopState.Idle, '')` so the Ralph bar and fork listener receive the same terminal state.
- Reuse that wrapper for the command-start flow and the activation-time auto-resume flow so resumed sessions stop logging-only and get the same UI cleanup semantics as fresh runs.
- Keep error messaging behavior unchanged; the new helper is a status-convergence path, not a second error-reporting surface.

**Tests (write FIRST)**:
- Extension command start: when `orchestrator.start()` resolves after `AllDone`, the finalizer pushes idle once and hides the local Ralph bar.
- Crash path: when `orchestrator.start()` rejects, the crash message is still shown and the finalizer still pushes idle.
- Auto-resume parity: when `resumeIncompleteSession()` starts an orchestrator, the resumed run uses the same finalizer and emits the same idle cleanup as a manual start.

**Files**: `src/extension.ts`, `src/statusBar.ts`, `src/stateNotification.ts`, `test/extensionResume.test.ts`

**Dependencies**: None

### Task 139 — Enforce fork-side precedence so Ralph idle beats lifecycle processing

**Goal**: Prevent a later `RequestLifecycleModel` `Processing` update from overwriting a correct Ralph idle push in the Copilot fork status bar.

**Design**:
- Refactor `vscode-copilot-chat/src/extension/prompt/node/forkStatusBar.ts` so lifecycle state and Ralph snapshot state are stored separately and rendered through one merge function instead of two direct writers to `item.text`.
- Introduce a small internal display model (for example `lifecycleStatus`, `ralphState`, and `ralphOwnsSurface`) that makes Ralph terminal `idle` authoritative over lifecycle `processing` until Ralph starts a new task or the lifecycle reaches a non-processing terminal state.
- Preserve existing tooltip/billing/effort behavior by letting the merge function decide text precedence only; model label and completed-turn metadata should still flow from `RequestLifecycleModel` when compatible.
- Keep the push-based `ralph-loop.onStateChange` contract stable unless an added field is strictly required; prefer fixing precedence in the fork without expanding the transport.

**Tests (write FIRST)**:
- Ralph idle followed by lifecycle processing still renders idle, not processing.
- Ralph running followed by lifecycle processing still renders the active Ralph task state.
- A new Ralph task after an idle lock releases precedence and allows fresh running text to appear.
- Finished/idle lifecycle updates after Ralph idle do not resurrect stale task text.

**Files**: `../vscode-copilot-chat/src/extension/prompt/node/forkStatusBar.ts`, `../vscode-copilot-chat/src/extension/prompt/common/requestLifecycleModel.ts`, `../vscode-copilot-chat/src/extension/prompt/node/test/forkStatusBar.lifecycle.spec.ts`, `../vscode-copilot-chat/src/extension/prompt/node/test/forkStatusBar.spec.ts`

**Dependencies**: None

### Task 140 — Make terminal snapshots truthful in `src/orchestrator.ts`

**Goal**: Ensure terminal event handlers stop reading stale `running` snapshots after the loop has already logically ended.

**Design**:
- Centralize terminal-state cleanup in `src/orchestrator.ts` with a helper that clears `_currentTaskId`/task metadata and transitions `this.state` to `LoopState.Idle` before the snapshot used by terminal UI paths is observed.
- Prefer the least-invasive implementation that still makes `getStateSnapshot()` truthful at shutdown: either move the idle transition ahead of terminal event emission for `AllDone`, `MaxIterations`, `YieldRequested`, and `Stopped`, or emit one final post-reset idle notification/event that extension handlers consume immediately.
- Keep session cleanup and branch switch-back behavior intact; this task changes terminal sequencing, not loop semantics.
- Align `StateNotified` emission with the settled state so command/state observers no longer report a different terminal snapshot than the bar-update path.

**Tests (write FIRST)**:
- On normal completion, `AllDone`-driven status updates see an idle snapshot with empty task id.
- On stop/yield/max-iterations exits, the terminal update path sees idle instead of a stale running task.
- Terminal sequencing does not regress branch switch-back or session-persistence cleanup.

**Files**: `src/orchestrator.ts`, `src/types.ts`, `test/orchestrator.test.ts`, `test/stateSnapshot.test.ts`

**Dependencies**: Task 138

## Sub-Phase 19.2 — Backfill edge cases and lock regressions

### Task 141 — Backfill abnormal exits and resumed cleanup through the shared idle path

**Goal**: Ensure non-happy exits also converge the UI to idle instead of relying on happy-path terminal events.

**Design**:
- Route `BranchEnforcementFailed`, `PrdValidationFailed`, and uncaught task/loop exceptions through the shared idle-finalization helper introduced in Task 138.
- Update the resumed-session event wiring so auto-resume no longer uses a log-only callback; resumed runs must surface status transitions and the same final idle cleanup as standard runs.
- Preserve existing warning/error toasts and output logging while adding the missing idle push/bar reset after these exits.
- If a failure occurs before any task starts, the cleanup must still emit an empty-task idle state so the fork bar can clear stale processing text from an older turn.

**Tests (write FIRST)**:
- Branch enforcement failure emits the existing error message and still forces idle cleanup.
- PRD validation failure emits the existing validation error and still forces idle cleanup.
- Uncaught exception during execution emits the crash/error surface and still forces idle cleanup.
- Auto-resume failure after activation also ends in idle cleanup instead of leaving the prior state visible.

**Files**: `src/extension.ts`, `src/orchestrator.ts`, `src/stateNotification.ts`, `test/orchestrator.test.ts`, `test/extensionResume.test.ts`

**Dependencies**: Task 138, Task 140

### Task 142 — Make `delay()` abort-aware so stop requests collapse stale UI windows

**Goal**: Reduce stop-path lag by making orchestrator waits terminate promptly when the loop is stopping.

**Design**:
- Replace the current timer-only `delay(ms)` helper in `src/orchestrator.ts` with an abort-aware variant that listens to `this.linkedSignal?.signal` or the stop controller and resolves immediately when aborted.
- Use the new helper everywhere stop responsiveness matters: pause loops, retry backoff, countdown waits, and any other orchestrator-controlled delay that can currently outlive a stop request.
- Ensure timer listeners are cleaned up on both normal completion and abort to avoid leaked timeouts or duplicate wakeups.
- Do not change the public stop command shape; this is an internal responsiveness fix that should shrink the time between `ralph-loop.stop` and the final idle refresh path.

**Tests (write FIRST)**:
- A stop request during countdown exits promptly without waiting the full second-per-tick budget.
- A stop request during pause/retry sleep resolves the wait immediately and yields terminal cleanup.
- Aborted waits clean up listeners/timers and do not emit duplicate stopped handling.

**Files**: `src/orchestrator.ts`, `test/orchestrator.test.ts`

**Dependencies**: Task 140

### Task 143 — Add regression coverage for normal, failure, stop, resume, and consecutive-run scenarios

**Goal**: Lock in the status-bar convergence contract so the bar, snapshots, and status command stay aligned across all reported exit paths.

**Design**:
- Add Ralph-side regression tests that exercise the full status lifecycle: normal completion, `BranchEnforcementFailed`, `PrdValidationFailed`, uncaught exceptions, stop command, resume flow, and back-to-back runs in the same window.
- Add fork-side regression tests that reproduce the original split-brain sequence: Ralph idle push, then lifecycle processing, and assert the visible fork bar remains idle.
- Assert both channels, not just one: the local/status snapshot path, the `ralph-loop.status` command state, and the downstream fork surface must all converge to idle after terminal cleanup.
- Prefer focused unit/integration tests over polling or sleeps; use direct event sequencing to keep the suite deterministic.

**Tests (write FIRST)**:
- Normal completion: bar ends idle/hidden and the status command reports idle.
- Failure exits: branch enforcement failure, PRD validation failure, and thrown exceptions all end idle.
- Stop command: stopping during a wait ends idle without lingering processing text.
- Resume flow: auto-resume settles back to idle on completion and on failure.
- Consecutive runs: a second run after an idle cleanup starts cleanly and does not inherit stale task text or lifecycle ownership.
- Fork precedence: lifecycle processing after Ralph idle never re-displays processing for the old turn.

**Files**: `test/orchestrator.test.ts`, `test/extensionResume.test.ts`, `test/stateNotification.test.ts`, `test/stateSnapshot.test.ts`, `../vscode-copilot-chat/src/extension/prompt/node/test/forkStatusBar.lifecycle.spec.ts`, `../vscode-copilot-chat/src/extension/prompt/node/test/forkStatusBar.spec.ts`

**Dependencies**: Task 138, Task 139, Task 140, Task 141, Task 142

## Dependency Graph

- Task 138 — shared extension idle finalizer
- Task 139 — fork precedence merge
- Task 140 — terminal snapshot truthfulness → depends on 138
- Task 141 — abnormal-exit/resume cleanup → depends on 138, 140
- Task 142 — abort-aware stop-path delays → depends on 140
- Task 143 — regression matrix → depends on 138, 139, 140, 141, 142

## Line Range Index

| Task | Title | Lines |
|------|-------|-------|
| 138 | Add a shared final idle refresh path in `src/extension.ts` | L33-L51 |
| 139 | Enforce fork-side precedence so Ralph idle beats lifecycle processing | L53-L72 |
| 140 | Make terminal snapshots truthful in `src/orchestrator.ts` | L74-L92 |
| 141 | Backfill abnormal exits and resumed cleanup through the shared idle path | L96-L115 |
| 142 | Make `delay()` abort-aware so stop requests collapse stale UI windows | L117-L134 |
| 143 | Add regression coverage for normal, failure, stop, resume, and consecutive-run scenarios | L136-L157 |

_Line ranges are for PRD `→ Spec:` references._