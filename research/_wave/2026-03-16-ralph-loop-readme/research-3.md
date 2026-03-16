## Research 3: PRD-Driven Task Management

### Findings

Ralph-loop implements a **PRD.md-as-database** task management system where a single Markdown file with GitHub-style checkboxes (`- [ ]` / `- [x]`) serves as the canonical task store, parser input, and execution ledger simultaneously.

#### 1. Parsing (`src/prd.ts`)

The `parsePrd(content: string): PrdSnapshot` function performs **two-pass checkbox parsing**:

- **Pass 1** — Scans every line for `- [ ]` (pending) and `- [x]` (complete) checkboxes using regex. Captures indentation depth, task description, and line number. Skips any line containing `[DECOMPOSED]` (non-actionable marker from auto-decomposition in `src/stagnationDetector.ts`). Parses explicit `depends: task-1, task-2` annotations from task descriptions.
- **Pass 2** — Assigns sequential task IDs (`Task-001`, `Task-002`, …) via zero-padded indexing. Infers dependency edges from **indentation**: indented tasks are linked to the nearest preceding less-indented task as a parent. Explicit `depends:` annotations take priority over inferred indentation dependencies.

Output is a `PrdSnapshot { tasks, total, completed, remaining }` — a complete DAG-structured view of all work items.

#### 2. Task Selection (`src/prd.ts`)

Two selection strategies exist:

- **Sequential** — `pickNextTask(snapshot)` returns the first `Pending` task (FIFO order). Used when `maxParallelTasks = 1`.
- **DAG-aware** — `pickReadyTasks(snapshot, maxTasks)` returns all tasks whose dependencies are satisfied (all `dependsOn` entries exist in the completed set), up to `maxTasks`. Enables parallel execution when `features.useParallelTasks` is enabled and `maxConcurrencyPerStage > 1`.

#### 3. Progression & State Mutation

Task progression operates on **two files** in lockstep:

| File | Mutation | Function |
|------|----------|----------|
| `PRD.md` | Checkbox `[ ]` → `[x]` at exact line number | `markTaskComplete(prdPath, task)` — regex replacement on the task's `lineNumber` |
| `progress.txt` | Timestamped append-only log | `appendProgress(progressPath, message)` — ISO 8601 timestamp + message |

The orchestrator threads a UUID `taskInvocationId` through every progress entry, event, and hook invocation for end-to-end traceability (pattern from VS Code's `subAgentInvocationId`).

#### 4. Progression Tracking in the Orchestrator (`src/orchestrator.ts`)

The orchestrator loop is a **re-read-on-every-iteration** design:
1. Re-reads `PRD.md` via `readPrdSnapshot()` at the start of each iteration (detects external edits by Copilot).
2. Picks the next task(s) via `pickNextTask` or `pickReadyTasks`.
3. Builds a prompt (with filtered PRD showing only unchecked tasks + completion count).
4. Fires the prompt to Copilot and waits for completion.
5. Verifies completion via multi-verifier chain (`src/verify.ts`), circuit breakers, diff validation, confidence scoring, and dual exit gate.
6. On success: appends to progress.txt, marks checkbox, commits atomically, emits `TaskCompleted`.

#### 5. The PRD File Structure

The PRD itself is a phased document (Phases 1–9 across 75 tasks) with:
- Markdown headings for phases/categories.
- Blockquote instructions at phase level.
- Tasks as checkbox list items with **bold task names** and inline implementation instructions.
- The entire file is self-modifying: the agent **writes to its own task list** as part of completing work.

#### 6. Auto-Decomposition

When a task fails 3+ times consecutively (`AutoDecomposer` in `src/stagnationDetector.ts`), the system:
- Marks the parent task with `[DECOMPOSED]` prefix.
- Inserts 2–3 sub-task checkboxes directly below it in PRD.md.
- The parser's `[DECOMPOSED]` skip ensures these don't double-count.
- Sub-tasks are picked up naturally by `pickNextTask` on subsequent iterations.

#### 7. Progress Prompt Context

`buildPrompt()` in `src/prompt.ts` uses `filterPrdContent()` to show only unchecked tasks + `Progress: N/M tasks completed` header. Progress logs are truncated to the last `maxProgressLines` (default 20) with a `[...N earlier entries omitted]` banner. Progressive context trimming reduces this further in later iterations (5 lines by iteration 9+).

### Patterns

1. **File-as-database** — PRD.md is simultaneously the spec, task queue, and completion ledger. No external DB or state store needed for task management.
2. **Checkbox protocol** — The universal signal for "done" across agent (marks checkbox) and orchestrator (detects checkbox change). Both read/write the same line.
3. **Dual-file state** — PRD.md (structured/current state) + progress.txt (append-only audit log) form a two-table system with different access patterns.
4. **Re-read every iteration** — No in-memory task queue; the PRD file is the single source of truth, re-parsed on every loop cycle. This tolerates concurrent edits by the agent.
5. **Indentation-as-dependency** — Nested checkboxes infer a dependency DAG without requiring explicit annotations.
6. **Self-modifying spec** — Auto-decomposition rewrites PRD.md, inserting new tasks and marking parents as decomposed. The parser adapts via `[DECOMPOSED]` filtering.
7. **Invocation ID threading** — Every task attempt gets a UUID, threaded through progress entries, events, hooks, and commits for full traceability.

### Applicability

- The PRD-driven model is highly portable: any Markdown file with checkboxes becomes an executable task queue. This could be adapted for any autonomous agent framework.
- The dual-file (PRD + progress.txt) pattern provides both structured state and audit trail — useful for debugging agent runs.
- The `parsePrd` → `PrdSnapshot` → `pickReadyTasks` pipeline is a clean, testable abstraction over what could be a complex scheduling problem.
- Indentation-based dependency inference is pragmatic but fragile — explicit `depends:` annotations are more reliable for complex DAGs.
- Auto-decomposition is a unique pattern not seen in most agent frameworks; it gives the system "self-healing" task management.

### Open Questions

1. **PRD contention**: Agent and orchestrator both write to PRD.md. Are there race conditions between `markTaskComplete` (by orchestrator/agent) and the agent's own PRD edits during task execution?
2. **Task ordering stability**: `pickNextTask` returns the first pending task. If the agent marks a checkbox mid-file, does re-parsing preserve stable ordering of remaining tasks?
3. **Decomposition depth**: Auto-decomposition creates sub-tasks, but can those sub-tasks themselves be decomposed? Is there a depth limit to prevent infinite recursion?
4. **Progress.txt growth**: While prompt truncation limits context injection, the file itself grows unboundedly. Is there a rotation/archival strategy?
5. **Line number drift**: `markTaskComplete` uses `task.lineNumber` — if auto-decomposition inserts lines above a task, does the line number become stale within the same parsing cycle?
