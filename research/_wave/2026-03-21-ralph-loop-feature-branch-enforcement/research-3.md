# Research Report: PRD Task Lifecycle & "Before Any Work" Insertion Point

**Question**: What is the full PRD task lifecycle — from parsing to picking to execution to completion — and where exactly would a "before any actual work" insertion point live?

**Date**: 2026-03-21

---

## 1. Complete PRD Task Lifecycle

The lifecycle spans two files: `src/prd.ts` (data layer) and `src/orchestrator.ts` (execution layer).

### Phase A: Loop Startup (`runLoop()` entry, orchestrator.ts ~L521–L590)

Before the `while (true)` loop begins, the orchestrator runs these one-time setup steps in order:

1. **Linked cancellation signal** — combines manual stop + timeout signals (~L529–L530)
2. **Detector initialization** — stagnation, auto-decomposer, struggle detector, knowledge manager (~L534–L572)
3. **`onSessionStart` hook** — fires once, can inject `additionalContext` or block/stop (~L574–L582)
4. **Pre-flight PRD validation** — `readPrdSnapshot(prdPath)` + `validatePrd()`. If invalid, emits `PrdValidationFailed` and **returns immediately** (~L584–L593)

### Phase B: Main Loop Iteration (`while (true)`, ~L595 onward)

Each iteration of the `while (true)` loop runs:

1. **Stop/pause/abort checks** (~L596–L610)
2. **Circuit breaker pre-iteration check** (~L613–L624)
3. **Iteration limit check** with auto-expand (~L626–L645)
4. **Parse PRD → Pick task(s)**:
   - `readPrdSnapshot(prdPath)` → calls `parsePrd()` from prd.ts
   - If parallel enabled: `pickReadyTasks(snapshot, concurrencyCap)` (DAG-aware)
   - Otherwise: `pickNextTask(snapshot)` → returns first pending task with all deps met
5. **Completed-latch guard** — skip if task already in `completedTasks` set
6. **Checkpoint gate** — if `task.checkpoint`, runs checkpoint bearings then pauses for human
7. **Bearings phase** — stage-aware health check (startup level vs per-task level), with fix injection on failure (~L817–L880)

### Phase C: Task Execution (~L882 onward)

8. **`iteration++`** — counter incremented
9. **Task state set** — `task.status = InProgress`, current task metadata updated
10. **`LoopEventKind.TaskStarted` yielded** (~L889)
11. **Progress logged** — `appendProgress()` records task start
12. **Stagnation snapshot** taken
13. **PRD + progress content read** for prompt building
14. **Knowledge injection** — relevant learnings retrieved
15. **Operator context consumed** (injected via `injectContext()`)
16. **Prompt built** — `buildPrompt()` assembles the full prompt
17. **Monitor started** — parallel file-change watcher
18. **Strategy execution** — `this.executionStrategy.execute(task, prompt, options)`
19. **Nudge loop** — if not completed, re-sends prompt up to `maxNudgesPerTask` times with circuit breaker checks

### Phase D: Post-Execution Verification (~L1019 onward)

20. **Stagnation/struggle evaluation**
21. **Dual exit gate** — requires BOTH model signal AND machine verification (checkbox checked + file changes)
22. **If gate passes → `TaskCompleted` emitted**:
    - Knowledge extraction
    - Consistency check
    - Diff validation (with retry loop)
    - Confidence scoring
    - PreComplete hook chain
    - TaskComplete hook
    - Review-after-execute (optional)
    - PRD write protection validation
    - **Atomic git commit** → `TaskCommitted` event
    - Yield check
23. **If gate rejects** — injects feedback as `additionalContext`, loops back
24. **If timed out** — `TaskTimedOut` event, auto-decompose check, failure hook

### Phase E: Inter-Task Transition (~L1430 onward)

25. **Cooldown dialog or countdown** between tasks
26. **Session state saved** via `SessionPersistence`
27. **Back to top of `while (true)`**

---

## 2. `parsePrd()` and `pickNextTask()` Detail

### `parsePrd()` (prd.ts L48–L108)

- Scans lines for markdown checkboxes (`- [ ]` / `- [x]`)
- Extracts: description, status, line number, `[AGENT:xxx]` annotations, `depends:` annotations
- Two-pass: first collects tasks with indentation, second infers parent-child dependencies from indentation
- Returns `PrdSnapshot { tasks, total, completed, remaining }`

### `pickNextTask()` (prd.ts L210)

- Delegates to `pickReadyTasks(snapshot, 1)[0]`
- `pickReadyTasks()` filters for `Pending` tasks whose **all explicit dependencies are complete**
- Parallel safety: if batch > 1 and any task uses a write agent, falls back to single task

---

## 3. Insertion Point Analysis: "Before Any Actual Work"

### Option A: Before the FIRST task ever (once per loop run)

**Location**: `orchestrator.ts`, inside `runLoop()`, between the pre-flight PRD validation block (~L593) and the `while (true)` loop entry (~L595).

```
Pre-flight PRD validation   ← L584-L593
                             ← ★ INSERT HERE: "before any actual work" (once per session)
while (true) {               ← L595
```

This is **after** all setup (detectors, hooks, validation) but **before** any task is picked or executed. The `onSessionStart` hook already fires at ~L574, so a new insertion here would be a distinct "pre-work gate" that runs after session hooks but before the first iteration.

**Existing precedent**: The `onSessionStart` hook (~L574) already occupies this "once before any work" slot. A feature-branch check could either:
- Be added to the `onSessionStart` hook contract, or
- Be a dedicated check between L593 and L595

### Option B: Before EACH task (every iteration)

**Location**: `orchestrator.ts`, inside the `while (true)` loop, after task picking but before the task begins execution.

The precise spot is between the bearings phase completion and the `iteration++` / `TaskStarted` yield:

```
} // end bearings phase       ← ~L880
                               ← ★ INSERT HERE: "before each task" pre-flight
iteration++;                   ← L882
task.status = InProgress;      ← L883
yield TaskStarted              ← L889
```

This is the **last possible moment** before a task starts actual work. The task object is available (`task` variable), the PRD snapshot is fresh, and bearings have already confirmed health.

### Option C: Before each task — alternative (before bearings)

**Location**: Right after `pickNextTask()` returns and the completed-latch check, but before the checkpoint/bearings gates:

```
if (this.completedTasks.has(task.id)) { continue; }   ← ~L768
                                                        ← ★ INSERT HERE: earliest per-task pre-flight
if (task.checkpoint) {                                  ← ~L772
```

This would run before bearings, meaning it's the **earliest** per-task gate.

---

## 4. "Before First Task" vs "Before Each Task" — Key Differences

| Aspect | Before First Task (Option A) | Before Each Task (Option B/C) |
|--------|------------------------------|-------------------------------|
| **Runs** | Once per `start()` call | Every iteration of `while (true)` |
| **Task available?** | No — no task picked yet | Yes — `task` variable populated |
| **Bearings done?** | No | Option B: yes. Option C: no |
| **Can block loop?** | Yes — return before entering loop | Yes — `continue` to skip, or yield Stopped |
| **Precedent** | `onSessionStart` hook | Bearings phase, checkpoint gate |
| **Best for** | One-time environment checks (e.g., "are we on a feature branch?") | Per-task preconditions |

---

## 5. Recommendation for "Before Any Actual Work" (Feature Branch Enforcement)

A feature-branch check is a **one-time environment gate** — it should run **once before the first task** (Option A). The branch won't change mid-loop.

**Recommended insertion**: Between PRD validation (~L593) and the `while (true)` loop (~L595):

```typescript
// Pre-flight PRD validation
{
    const preflight = readPrdSnapshot(prdPath);
    const validation = validatePrd(preflight);
    if (!validation.valid) {
        yield { kind: LoopEventKind.PrdValidationFailed, errors: validation.errors };
        return;
    }
}

// ★ Feature branch enforcement — runs once before any task execution
// Example: check git branch, yield error event and return if on main/master

while (true) {
    // ... main loop
}
```

This mirrors the PRD validation pattern: a pre-flight gate that can abort the loop before any work begins. It's clean, non-invasive, and follows the established pattern of yielding an event and returning.

---

## 6. Key Code References

| Concept | File | Line(s) |
|---------|------|---------|
| `parsePrd()` | [src/prd.ts](../../../src/prd.ts) | L48–L108 |
| `pickNextTask()` | [src/prd.ts](../../../src/prd.ts) | L210 |
| `pickReadyTasks()` | [src/prd.ts](../../../src/prd.ts) | L218–L240 |
| `markTaskComplete()` | [src/prd.ts](../../../src/prd.ts) | L242–L250 |
| `runLoop()` entry | [src/orchestrator.ts](../../../src/orchestrator.ts) | L521 |
| `onSessionStart` hook | [src/orchestrator.ts](../../../src/orchestrator.ts) | L574 |
| Pre-flight PRD validation | [src/orchestrator.ts](../../../src/orchestrator.ts) | L584–L593 |
| `while (true)` loop start | [src/orchestrator.ts](../../../src/orchestrator.ts) | L595 |
| Task picking (single) | [src/orchestrator.ts](../../../src/orchestrator.ts) | L757 |
| Bearings phase | [src/orchestrator.ts](../../../src/orchestrator.ts) | L817–L880 |
| `iteration++` / TaskStarted | [src/orchestrator.ts](../../../src/orchestrator.ts) | L882–L889 |
| TaskCompleted + commit | [src/orchestrator.ts](../../../src/orchestrator.ts) | L1095–L1270 |
| `LoopEventKind` enum | [src/types.ts](../../../src/types.ts) | L63–L105 |
