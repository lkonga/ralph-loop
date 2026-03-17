# Aggregation Report 1

## Source Reports

### research-1.md — Parallel Mode Robustness
Comprehensive audit of parallel mode safeguards. Found triple feature gate (off by default), DAG-aware `pickReadyTasks()`, per-task error isolation via `Promise.all` with `try/catch`, concurrency caps, and countdown between batches. **Verdict: not production-grade** due to critical git race conditions in `atomicCommit()`, missing per-task timeouts, no monitoring in parallel path, no diff validation, and zero integration test coverage for the parallel execution path. [source: research-1.md#L1-L5]

### research-2.md — Merge Conflict Prevention
Deep dive into concurrent file access during parallel execution. Found **zero file-level locking** anywhere in the codebase — no mutex, semaphore, or advisory locks. `git add -A` stages ALL working tree changes indiscriminately, causing cross-task commit pollution. `markTaskComplete()` has TOCTOU race. VS Code's Copilot chat panel may accidentally serialize execution (masking bugs). Five concrete mitigation strategies proposed but none implemented. [source: research-2.md#L1-L5]

### research-3.md — Origins of Parallel Mode
Traced parallel mode's lineage. It is **original to ralph-loop**, synthesized from two sources: vinitm/ralph-loop's DAG dependency concept (`tasks.json`) and VS Code Copilot Chat's `SearchSubagentToolCallingLoop` background pipeline (`maxConcurrencyPerStage` concurrency cap). No other ralph implementation (frankbria, mikeyobrien, snarktank, giocaizzi, Gsaecy, choo-choo-ralph) has parallel task execution. The background pipeline analogy is imprecise — VS Code runs read-only reviewers in parallel, while ralph-loop runs write-heavy code-editing tasks. [source: research-3.md#L1-L5]

---

## Deduplicated Findings

### F1: Git Race Condition in `atomicCommit()` — CRITICAL
Multiple parallel tasks call `atomicCommit()` ([gitOps.ts L55–99](../../../src/gitOps.ts)) concurrently. The function runs `git add -A` → `git diff --cached` → `git commit` with no inter-task locking. `git add -A` stages **all** working tree changes, not just the calling task's files. Concurrent `git add` calls will hit `.git/index.lock` contention — the second call fails with "Unable to create index.lock: File exists". This is the single most critical correctness bug in parallel mode. [source: research-1.md#L89-L95] [source: research-2.md#L45-L58]

### F2: No File-Level Locking or Conflict Detection
Zero file-level locking exists in the codebase. No mutex, semaphore, or advisory lock in any `src/` file. The only locking references appear in aspirational research documents (design suggestions, not implementations). `pickReadyTasks()` selects tasks based solely on DAG dependency satisfaction — it has no awareness of which files tasks might modify, so overlapping file edits cannot be prevented. [source: research-2.md#L9-L14] [source: research-1.md#L26-L32]

### F3: Triple Feature Gate (Off by Default)
Parallel mode requires three conditions: `useParallelTasks: true` + `maxParallelTasks > 1` + the parallel code path in orchestrator.ts. Defaults are `false` and `1` respectively. A secondary `maxConcurrencyPerStage` overrides `maxParallelTasks` when > 1. This was introduced following VS Code's `ConfigType.ExperimentBased` pattern. [source: research-1.md#L9-L19] [source: research-3.md#L41-L43]

### F4: DAG-Aware Scheduling via `pickReadyTasks()`
Located in [prd.ts L106–124](../../../src/prd.ts). Collects completed task IDs, checks if all `dependsOn` entries are satisfied for pending tasks, caps output at `maxTasks`. Respects task ordering but has a weakness: `parseTaskId()` extracts bold-formatted IDs (`**Task-001**`) — if task descriptions don't follow this convention, dependency matching silently fails and tasks may run prematurely. [source: research-1.md#L21-L30]

### F5: Per-Task Error Isolation
Each parallel task in the `Promise.all` block has its own `try/catch`. One failure doesn't kill the batch — errors are logged via `appendProgress` and emitted as `LoopEventKind.Error`. However, `Promise.all` (not `Promise.allSettled`) is used, so an unhandled rejection bypassing the `try/catch` would fail the entire batch. [source: research-1.md#L32-L41] [source: research-1.md#L107-L108]

### F6: Missing Safeguards in Parallel Path
The parallel execution path lacks several safeguards present in the single-task path:
- **No per-task timeout**: Hung `executionStrategy.execute()` blocks entire `Promise.all` with no alert [source: research-1.md#L99-L101]
- **No monitoring**: `startMonitor()` is only invoked in the single-task path (L705), not parallel [source: research-1.md#L56-L62] [source: research-1.md#L96-L98]
- **No diff validation**: `DiffValidator` integration exists in single-task path but is skipped in parallel [source: research-1.md#L103-L104]
- **No backpressure/struggle detection**: `BackpressureClassifier` and `StruggleDetector` not engaged [source: research-1.md#L110-L111]

### F7: Progress File Concurrent Access
`appendProgress()` uses `fs.appendFileSync()` — minimally safe for small writes within a single Node.js process via `O_APPEND`, but logical ordering of progress entries may be confusing with interleaved timestamps. Each parallel task also reads `progressPath` via `fs.readFileSync()` while others append, causing stale reads that could affect prompt quality. [source: research-1.md#L91-L93] [source: research-2.md#L60-L68]

### F8: VS Code Chat Panel Serialization (Accidental Safety)
`CopilotCommandStrategy` sends prompts to VS Code's chat panel, which is single-threaded. `Promise.all` dispatches N tasks but VS Code likely serializes through a single Copilot session. This accidentally masks concurrency bugs at the application level, though git commit races remain because task completion timing is still unpredictable. [source: research-2.md#L71-L75] [source: research-3.md#L55-L57]

### F9: Origin — Cross-Pollination Design (Not Extracted)
Parallel mode is original to ralph-loop, not extracted from any ralph fork. It synthesizes:
- **Dependency graph** ← vinitm/ralph-loop's `tasks.json` DAG (adapted to PRD.md checkbox format with `depends:` annotations)
- **Execution engine** ← VS Code Copilot Chat's `SearchSubagentToolCallingLoop` background pipeline (`maxConcurrencyPerStage` cap, concurrent agents)
- **Monitor pattern** ← VS Code's per-stage monitoring with stuck detection

No other ralph implementation (6 analyzed) has parallel task execution. [source: research-3.md#L7-L43]

### F10: Background Pipeline Analogy Is Imprecise
VS Code's `SearchSubagentToolCallingLoop` runs **read-only** reviewers in parallel — they don't modify files. Ralph-loop's parallel tasks are **write-heavy** (edit code, modify PRD checkboxes, append progress.txt). The concurrent file modification race conditions have no counterpart in the original VS Code pattern, making the analogy misleading for correctness reasoning. [source: research-3.md#L58-L60]

### F11: Zero Integration Test Coverage for Parallel Path
Only `pickReadyTasks` cap behavior and `startMonitor` are tested ([parallelMonitor.test.ts](../../../test/parallelMonitor.test.ts), 6 test cases). The actual `Promise.all` branch in `runLoop()`, error isolation, and commit race conditions have **no integration tests**. [source: research-1.md#L113-L114]

### F12: `pickNextTask()` vs `pickReadyTasks()` Dual Scheduler Divergence
Sequential path uses `pickNextTask()` (ignores dependencies), parallel path uses `pickReadyTasks()` (DAG-aware). `depends:` annotations only have effect when parallel mode is enabled — this is a usability trap for users who add dependency annotations expecting them to work in sequential mode. [source: research-3.md#L49-L50] [source: research-3.md#L73-L74]

---

## Cross-Report Patterns

### P1: Git Commit Architecture Is the Central Flaw (HIGH CONFIDENCE — 3/3 reports)
All three reports converge on `atomicCommit()` as the critical weakness. R1 identifies the race condition, R2 details the `git add -A` cross-contamination mechanism and `.git/index.lock` failure mode, R3 explains why the original VS Code pattern didn't have this problem (read-only operations). The function name "atomicCommit" is misleading — it is atomic within a single call but provides no atomicity guarantees across concurrent calls. [source: research-1.md#L89-L95] [source: research-2.md#L45-L58] [source: research-3.md#L58-L60]

### P2: Accidental Serialization Masks Real Bugs (HIGH CONFIDENCE — 2/3 reports)
R2 and R3 both note that VS Code's single-threaded chat panel likely serializes parallel task execution, accidentally preventing the worst race conditions. This means parallel mode may appear to work in testing but would break with a truly concurrent execution strategy (e.g., `DirectApiStrategy` calling LLMs in parallel). The bugs are latent, not absent. [source: research-2.md#L71-L75] [source: research-3.md#L55-L57]

### P3: Thoughtful Design Foundation, Incomplete Execution (HIGH CONFIDENCE — 3/3 reports)
All three reports acknowledge the design is well-structured: triple feature gates (R1), DAG-aware scheduling (R1, R3), event-driven observability (R1), and clear lineage from proven patterns (R3). But the execution is incomplete: no locking (R2), no per-task timeouts (R1), no monitoring in parallel path (R1), no file-overlap awareness (R2), and no integration tests (R1). [source: research-1.md#L43-L63] [source: research-2.md#L9-L14] [source: research-3.md#L37-L43]

### P4: Read-Only vs Write-Heavy Analogy Gap (MODERATE CONFIDENCE — 2/3 reports)
R2 and R3 identify that the VS Code background pipeline model (read-only reviewers) was applied to write-heavy tasks without adapting the concurrency controls. The original pattern didn't need file locking because reviewers only read; ralph-loop needs it because tasks edit files. This is the root cause of most gaps. [source: research-2.md#L71-L75] [source: research-3.md#L58-L60]

### P5: DAG Concept Repurposed Beyond Original Intent (MODERATE CONFIDENCE — 2/3 reports)
R1 and R3 note that vinitm's `tasks.json` DAG was designed for sequential ordering (which task next), not parallel execution. Ralph-loop repurposed it for concurrency — a different use case with different failure modes. The `pickReadyTasks()` function works for ordering but doesn't address the file-level conflicts that parallelism introduces. [source: research-1.md#L21-L30] [source: research-3.md#L55-L57]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---------|--------|--------|--------------------------|
| **P1: Git commit race / `git add -A` cross-contamination** | Critical — data corruption, lost commits | Medium — mutex around `atomicCommit()` + per-task `git add <files>` | [research-1.md#L89-L95](research-1.md#L89-L95), [research-2.md#L45-L58](research-2.md#L45-L58), [research-3.md#L58-L60](research-3.md#L58-L60) |
| **P2: Missing per-task timeouts in parallel path** | High — hung task blocks entire batch indefinitely | Low — wrap `execute()` in `AbortSignal.timeout()` | [research-1.md#L99-L101](research-1.md#L99-L101) |
| **P3: No monitoring for parallel tasks** | High — hung parallel tasks undetectable | Low — start `startMonitor()` per-task in parallel path | [research-1.md#L56-L62](research-1.md#L56-L62), [research-1.md#L96-L98](research-1.md#L96-L98) |
| **P4: No diff validation in parallel path** | Medium — tasks marked complete without verifying changes | Medium — integrate `DiffValidator` per parallel task | [research-1.md#L103-L104](research-1.md#L103-L104) |
| **P5: `pickNextTask()` ignores `depends:` annotations** | Medium — usability trap, breaks user expectations | Low — have `pickNextTask()` respect `dependsOn` | [research-3.md#L73-L74](research-3.md#L73-L74) |
| **P6: Zero integration tests for parallel path** | Medium — regressions undetectable | Medium — test `Promise.all` branch, error isolation, commit races | [research-1.md#L113-L114](research-1.md#L113-L114) |
| **P7: `Promise.all` vs `Promise.allSettled`** | Low — mitigated by try/catch but not fully safe | Low — swap to `Promise.allSettled` | [research-1.md#L107-L108](research-1.md#L107-L108) |

---

## Gaps

1. **No research on `DirectApiStrategy` under parallel execution**: R2 and R3 raise the question of what happens when a truly concurrent strategy (not VS Code chat panel) is used. The latent git race bugs would become real failures and need separate investigation.

2. **No benchmarking of parallel vs sequential throughput**: None of the reports measure whether parallel mode actually improves completion speed, given the accidental serialization through VS Code's chat panel.

3. **No analysis of the `LinkedCancellationSource` timeout behavior**: R1 mentions it as the only timeout protection in parallel mode but doesn't investigate its configuration or effectiveness.

4. **`parseTaskId()` failure modes not tested**: R1 identifies that dependency matching silently fails if task formats deviate from `**Task-001**` convention, but no report investigates how often this happens in real PRD files.

5. **No analysis of partial batch failure recovery**: R2 notes no rollback for partial failures (2 of 3 tasks commit, 1 fails), but none of the reports explore what happens in the next iteration — does the failed task retry? Does it pick up the committed tasks' state correctly?

---

## Sources
- research-1.md — Parallel mode robustness audit (safeguards inventory, gap analysis, production-readiness verdict)
- research-2.md — Merge conflict prevention (file locking analysis, `atomicCommit` race conditions, concurrent file access patterns)
- research-3.md — Origins of parallel mode (lineage tracing across 7 ralph implementations, cross-pollination from VS Code Copilot Chat)
