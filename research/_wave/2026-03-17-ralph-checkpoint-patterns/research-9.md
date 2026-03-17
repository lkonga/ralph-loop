# Research Report: Dependency-Driven Implicit Checkpoints

**Question**: Can `depends: TaskN` + verification failure reliably create natural break points without explicit checkpoint DSL?

**Date**: 2026-03-17  
**Scope**: `src/prd.ts`, `src/orchestrator.ts`, `src/verify.ts`, `src/types.ts`

---

## Findings

### 1. Dependency Resolution Mechanics

Ralph has two dependency resolution paths:

**Explicit annotations** (`prd.ts:16-22`): The `parseDependsOn()` function extracts `depends: Task1, Task2` from task description text via regex. These take priority — if present, indentation-based inference is skipped.

**Indentation-based inference** (`prd.ts:65-73`): When no explicit annotation exists, indented tasks automatically depend on the nearest preceding less-indented task. This creates parent-child relationships from PRD nesting.

**Ready task selection** (`prd.ts:106-120`): `pickReadyTasks()` builds a set of completed task descriptions (via `parseTaskId()`) and only returns pending tasks whose `dependsOn` entries all appear in that completed set. This is the DAG-aware scheduler.

**Critical detail**: `pickReadyTasks` resolves dependencies against `parseTaskId()` output (bold text or slugified description), NOT against the sequential `taskId` (`Task-001`). The `depends:` annotation values must match the `parseTaskId()` output of the dependency target.

### 2. How the Orchestrator Uses Dependencies

Two task selection paths exist in the main loop:

- **Parallel path** (`orchestrator.ts:517-520`): When `useParallelTasks` is enabled and `maxParallelTasks > 1`, uses `pickReadyTasks()` — fully DAG-aware. Tasks with unmet dependencies are invisible to the scheduler.
- **Sequential fallback** (`orchestrator.ts:596`): Uses `pickNextTask()` — simply returns the first pending task. **This path ignores dependencies entirely.** A task with unmet `depends:` will be picked and executed.

This is a critical reliability gap: **dependencies only block in parallel mode.** In sequential mode (the default), `pickNextTask()` bypasses the dependency graph.

### 3. Verification System as a Blocking Gate

The dual exit gate (`verify.ts:189-215`, `orchestrator.ts:789`) requires BOTH:
- Model signal (task marked complete in PRD)  
- Machine verification (all `VerifyCheck` results pass)

When gate rejects, the task is NOT added to `completedTasks` and the loop continues attempting it. The orchestrator has multiple escalation tiers:
1. **Nudge loop** — re-sends prompt up to `maxNudgesPerTask` times
2. **Stagnation detection** — if progress files don't change for `maxStaleIterations`
3. **HumanCheckpointRequested** — pauses loop, yields event, waits for `resume()`
4. **Circuit breaker** — trips on repeated errors, can stop or skip

### 4. Builtin Verifiers Available for Sentinel Pattern

The `VerifierRegistry` (`verify.ts:22-82`) provides these builtins:
- **`fileExists`**: Checks `fs.existsSync(path)` — ideal sentinel verifier
- **`fileContains`**: Checks file exists AND contains specific text
- **`commandExitCode`**: Runs arbitrary command, checks exit 0
- **`checkbox`**: Checks PRD checkbox state
- **`tsc`**: TypeScript compilation check
- **`vitest`**: Test suite run check
- **`custom`**: Arbitrary shell command

### 5. Verifier Resolution & Configuration

`resolveVerifiers()` (`verify.ts:96-117`) determines which verifiers run for a task:
1. Global `config.verifiers` (if set, used for ALL tasks)
2. `verificationTemplates` — matched against task description substring
3. Default fallback: `['checkbox', 'tsc']` plus `vitest` if task mentions "test"

**However**: The orchestrator currently does NOT call `resolveVerifiers()` or `runVerifierChain()` in the main loop. The dual exit gate constructs its own `VerifyCheck[]` inline (`orchestrator.ts:782-786`), checking only checkbox status and diff presence. The configurable verifier chain is available but unused in the primary execution path.

---

## Patterns

### Pattern 1: Sentinel Verifier via fileExists

**Concept**: A task depends on a predecessor and has a `fileExists` verifier pointing to a human-created approval file (e.g., `.approvals/task-5-approved`).

```markdown
- [x] **Task-5** Implement payment gateway
  - [ ] **Task-6** Deploy to production (depends: Task-5) <!-- verifier: fileExists(.approvals/task-5-reviewed) -->
```

**Expected behavior**: Task-6 won't be picked (dependency unmet until Task-5 completes). After Task-5 completes, Task-6 is picked but the `fileExists` verifier blocks completion until a human creates the approval file.

**Current reliability**: LOW. Two problems:
1. `pickNextTask()` in sequential mode ignores `depends:` — Task-6 gets picked immediately
2. The configurable verifier chain is not wired into the orchestrator's main loop — only inline checkbox+diff checks run

### Pattern 2: Dependency-Only Gate (No Custom Verifier)

**Concept**: Rely purely on `depends:` to hold a task until its predecessor is marked complete.

**Current reliability**: HIGH in parallel mode, NONE in sequential mode. When parallel task selection is enabled, `pickReadyTasks()` correctly gates on dependency completion. A task stays invisible until all dependencies resolve.

### Pattern 3: Stagnation-Triggered Checkpoint

**Concept**: If a task's verifier consistently fails, the stagnation detector eventually fires `HumanCheckpointRequested`, pausing the loop.

**Current reliability**: MEDIUM. This works but is indirect — the pause happens after `maxStaleIterations + 2` polling intervals of no progress, not immediately upon verification failure. The delay is unpredictable and depends on iteration timing.

### Pattern 4: Pre-Complete Hook as Gate

**Concept**: Use the `PreCompleteHookConfig` chain (`orchestrator.ts:923+`) to block completion via a shell hook that checks for an approval artifact.

**Current reliability**: HIGH. This path IS wired into the orchestrator. If the hook returns `action: 'retry'`, the task re-enters. If it returns `action: 'stop'`, the loop halts. A shell hook checking `test -f .approvals/task-approved` would reliably block.

---

## Applicability

### Can dependencies + verification create predictable break points?

**Partially, with significant caveats:**

1. **Dependencies alone work in parallel mode** — `pickReadyTasks()` provides reliable DAG-aware scheduling. But it requires `useParallelTasks: true` and `maxParallelTasks > 1`.

2. **Dependencies are ignored in sequential mode** — `pickNextTask()` returns the first pending task regardless of `dependsOn`. This is the default configuration.

3. **Configurable verifiers are available but disconnected** — `runVerifierChain()` and `resolveVerifiers()` exist with the perfect primitives (`fileExists`, `fileContains`, `commandExitCode`) but are not invoked in the main orchestrator loop. The dual exit gate only checks checkbox + diff.

4. **Pre-complete hooks ARE reliable gates** — they run in the main loop and can block/retry/stop. A shell-based sentinel leveraging this path would work today.

5. **No cycle detection** — `pickReadyTasks()` has no cycle detection. Circular dependencies (A depends B, B depends A) create a deadlock where no tasks appear ready. The fallback `pickNextTask()` would pick one, but in parallel-only mode the loop terminates with `AllDone` even though tasks remain.

### Recommended Implementation Path

To achieve reliable implicit checkpoints without new DSL:

1. **Enable parallel task selection** (`useParallelTasks: true`) to activate DAG-aware scheduling
2. **Wire `runVerifierChain()` into the orchestrator's dual exit gate** — replace the inline checkbox+diff checks with configurable verifier resolution
3. **Use `fileExists` verifier as sentinel** — configure via `verificationTemplates` matching tasks that need human review
4. **Add a dependency cycle detector** to `pickReadyTasks()` to prevent silent deadlocks

---

## Open Questions

1. **Why is `runVerifierChain()` not used in the main loop?** — The infrastructure exists (registry, chain execution, resolution) but the orchestrator only does inline checks. Was this intentional to avoid slow verifiers blocking the loop, or an incomplete integration?

2. **`pickNextTask()` vs `pickReadyTasks()` divergence** — Should the sequential path also respect dependencies? Currently sequential mode silently ignores the dependency graph, which makes `depends:` annotations unreliable for users who don't enable parallel mode.

3. **`parseTaskId()` vs `taskId` naming mismatch** — Dependencies resolve against `parseTaskId()` output (bold text or slugified description), but tasks are displayed with sequential `taskId` (`Task-001`). Users writing `depends: Task-001` will get no match because `parseTaskId()` would return the bold text. This is confusing and error-prone.

4. **No blocked-task detection** — If all remaining tasks have unmet dependencies (deadlock), `pickReadyTasks()` returns empty, the fallback `pickNextTask()` also returns nothing (all remaining are pending with unmet deps only in parallel), and `AllDone` fires incorrectly. Should there be a `DeadlockDetected` event?

5. **Sentinel verifier timing** — If a `fileExists` verifier were wired in, how would the orchestrator behave? It would fail verification, loop nudging, eventually stagnate, then fire `HumanCheckpointRequested`. This is correct but slow. Would it be better to have verifiers that can signal "wait" (distinct from "fail") to immediately pause?

6. **Pre-complete hooks vs verifiers** — Both can gate completion. Should they be unified? Currently hooks run after verifiers pass, creating a two-layer gate that could be simplified.
