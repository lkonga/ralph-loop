# Phase 9 — Refined Task Specifications

> Based on deep research across ralph-loop-agent, ralph-orchestrator, ralph-playbook, choo-choo-ralph, aymenfurter/ralph, vscode-copilot-chat.
> Research report: `research/13-phase9-deep-research.md`
>
> **Principles**: Configurable, composable, chainable, deterministic, reproducible.
> **TDD is MANDATORY**: Every task MUST follow red-green-refactor.
> Run `npx tsc --noEmit` and `npx vitest run` — ALL tests must pass before marking ANY checkbox.
> After completing each task: (1) run `npx tsc --noEmit` (must exit 0), (2) run `npx vitest run` (all tests pass), (3) append what you did to progress.txt, (4) mark the checkbox [x] in PRD.md, (5) commit with `git add -A && git commit -m "feat: <short description>"`.

---

## Phase 9a — Context & Knowledge Intelligence

### Task 57 — Context Budget Awareness

**Goal**: Give ralph-loop awareness of how much context budget is being consumed, so prompts can include budget signals and the orchestrator can adapt behavior at high utilization.

**NOT building**: A full context manager (server-side Copilot/Anthropic handles compaction). NOT replacing existing progressive trimming (`prompt.ts` tiers). NOT estimating tokens client-side when actual counts are unavailable.

**Two approaches (configurable via config toggle)**:

**Approach A — Budget Annotation Mode** (`contextBudget.mode: 'annotate'`):
- In `src/types.ts`, add `ContextBudgetConfig { mode: 'annotate' | 'handoff'; maxEstimatedTokens: number; warningThresholdPct: number; handoffThresholdPct: number }` to `RalphConfig` (default `{ mode: 'annotate', maxEstimatedTokens: 150_000, warningThresholdPct: 70, handoffThresholdPct: 90 }`).
- In `src/prompt.ts`, add `estimatePromptTokens(prompt: string): number` using `Math.ceil(prompt.length / 3.5)` (same heuristic as `vercel-labs/ralph-loop-agent`).
- After `buildPrompt` returns, the orchestrator calls `estimatePromptTokens` on the result. If above `warningThresholdPct`, inject a one-line annotation at the top of the prompt: `"[Context budget: ~{pct}% utilized — be concise, avoid verbose output]"`.
- The existing progressive trimming tiers already reduce context at high iterations — this COMPLEMENTS them with a budget-based signal.

**Approach B — Mid-Task Handoff Mode** (`contextBudget.mode: 'handoff'`):
- If estimated tokens exceed `handoffThresholdPct` (default 90%), the orchestrator saves state to session file, stops the current chat session, starts a fresh chat with a state summary prompt.
- Reuses existing `SessionPersistence.save()` and `startFreshChatSession()` from `copilot.ts`.
- Add `LoopEventKind.ContextHandoff = 'context_handoff'` event.

**Config**: `ralph-loop.contextBudget.mode` defaults to `'annotate'`. Handoff can be enabled when faster models accumulate context rapidly.

**Tests**: `test/prompt.test.ts` — `estimatePromptTokens` returns correct estimate, budget annotation injected above threshold, not injected below threshold. `test/orchestrator.test.ts` — handoff triggered at threshold, event emitted.

---

### Task 58 — Knowledge Harvest Pipeline

**Goal**: Upgrade the current `KnowledgeManager` from simple `[LEARNING]`/`[GAP]` tag extraction + keyword-matching retrieval to a composable harvest pipeline with deduplication and categorization.

**Current state**: `knowledge.ts` has `extractLearnings()`, `extractGaps()`, `persist()` (append-only), `getRelevantLearnings()` (keyword ≥2 match, last 15 lines). No dedup, no categorization, no consolidation.

**Upgrade pattern** (from `choo-choo-ralph`'s label-based harvest with 6-step pipeline):

- Add `HarvestPipeline` class in `src/knowledge.ts` with composable stages:
  ```
  Extract → Dedup → Categorize → Score → Persist
  ```
  Each stage is a pure function `(entries: KnowledgeEntry[]) → KnowledgeEntry[]`, toggleable via config.

- `KnowledgeEntry { content: string; category: 'pattern' | 'fix' | 'context' | 'gap'; timestamp: string; taskId: string; hash: string }`.
- **Dedup stage**: Hash each learning (MD5 of lowercase trimmed content). Skip if hash already exists in `knowledge.md` (scan file for `<!-- hash:abc123 -->` annotations).
- **Categorize stage**: Keyword-based classification — entries containing "fix"/"resolve"/"error" → `fix`, entries with "pattern"/"approach"/"strategy" → `pattern`, `[GAP]` entries → `gap`, remainder → `context`.
- **Score stage**: Higher score for entries retrieved frequently by `getRelevantLearnings` (track hit count in a sidecar `knowledge-meta.json` file), lower for never-retrieved entries.
- **Persist stage**: Append to `knowledge.md` with hash annotations for dedup on next harvest.

- In `src/orchestrator.ts`, after each task completion, run the harvest pipeline on captured output. The pipeline is chainable — each stage feeds the next.

**Config**: `ralph-loop.knowledge.harvest.stages` array: `['extract', 'dedup', 'categorize', 'persist']` (default, score is opt-in). Each stage toggleable.

**Does NOT replace** existing `getRelevantLearnings()` retrieval — that stays as-is. This upgrades the **ingestion** side.

**Tests**: `test/knowledge.test.ts` — dedup skips existing hashes, categorize assigns correct categories, pipeline chains stages in order, hash annotations persisted, empty input produces no output.

---

### Task 59 — Knowledge Garbage Collection

**Goal**: Prevent `knowledge.md` from growing unboundedly by implementing run-count based GC that archives stale entries.

**Why run-count, not time-based**: In fast model runs, hundreds of commits can happen in 1-3 hours. Time-based staleness (e.g., "3 days old") is meaningless when context changes by the minute.

**Design**:
- In `src/knowledge.ts`, add `KnowledgeGC` class:
  ```typescript
  interface GCPolicy {
    triggerEveryNRuns: number;    // default: 10
    maxEntries: number;          // hard cap, default: 200
    stalenessThreshold: number;  // N runs since last retrieval hit, default: 20
  }
  ```
- Track run counter in `.ralph/meta.json` (increment on each `orchestrator.run()` completion).
- Track per-entry retrieval hit count in `knowledge-meta.json` (incremented when `getRelevantLearnings` matches an entry).
- **GC trigger**: `runCount % triggerEveryNRuns === 0`.
- **GC pass**: Score each entry by (a) retrieval hit count, (b) age in runs since creation, (c) age in runs since last hit. Entries with 0 hits AND age > `stalenessThreshold` → archive candidate.
- **Archive**: Move low-scoring entries to `knowledge-archive.md` (not delete — recoverable). Keep at most `maxEntries` in active `knowledge.md`.
- **GC is non-destructive**: archived entries can be restored by moving lines back.

**Config**: `ralph-loop.knowledge.gc` object with `triggerEveryNRuns`, `maxEntries`, `stalenessThreshold`. All configurable.

**Tests**: `test/knowledge.test.ts` — GC triggers at correct run count, stale entries archived, fresh entries kept, maxEntries cap enforced, archive file created/appended, entries with hits survive.

---

## Phase 9b — Detection & Intelligence

### Task 60 — Thrashing Detection (EventSignature Pattern)

**Goal**: Detect when the agent is editing the same file regions back and forth without net progress (circular edits).

**Current state**: `StruggleDetector` has `no-progress` (0 files changed), `short-iteration`, `repeated-error`. But NO detection of thrashing (files DO change but the same regions oscillate).

**Design** (from `ralph-orchestrator`'s `EventSignature` fingerprinting):

- Add `ThrashingDetector` class in `src/struggleDetector.ts`:
  ```typescript
  interface ThrashingDetector {
    recordEdit(file: string, regionHash: string): void;
    isThrashing(): { thrashing: boolean; file?: string; editCount?: number };
    config: { regionRepetitionThreshold: number; windowSize: number };
  }
  ```
- **Region hash**: Hash of `file_path + ":" + startLine + "-" + endLine` of the edited region. Derived from `git diff` hunk headers (`@@ -a,b +c,d @@`).
- **Sliding window**: Track last `windowSize` (default: 10) edit region hashes. If the same hash appears `regionRepetitionThreshold` (default: 3) times, it's thrashing.
- **Integration with StruggleDetector**: Add `'thrashing'` as a 4th signal. `ThrashingDetector.isThrashing()` feeds into `StruggleDetector.isStruggling()`.
- **Escalation**: thrashing → inject guidance `"You are editing the same code regions repeatedly. Step back and try a fundamentally different approach."` → after 2 more thrashing iterations → circuit breaker skip.

**Config**: `ralph-loop.struggleDetection.thrashingThreshold` (default: 3), `ralph-loop.struggleDetection.thrashingWindowSize` (default: 10).

**Tests**: `test/struggleDetector.test.ts` — same region hash 3x triggers thrashing, different hashes don't trigger, window slides correctly, thrashing signal appears in `isStruggling()`, reset clears thrashing state.

---

### Task 61 — Backpressure Classification (Convergence Detection)

**Goal**: Classify whether struggle signals indicate the agent is making productive progress (converging) vs truly stuck (stagnant) vs going in circles (thrashing).

**Current state**: `StruggleDetector` reports boolean signals. No interpretation of whether struggle is productive (e.g., error count dropping) or unproductive.

**Design** (from `ralph-orchestrator`'s backpressure signals table):

- Add `BackpressureClassifier` class in `src/struggleDetector.ts`:
  ```typescript
  interface BackpressureClassifier {
    update(snapshot: ConvergenceSnapshot): void;
    classify(): 'productive' | 'stagnant' | 'thrashing';
  }

  interface ConvergenceSnapshot {
    errorCount: number;
    testPassCount: number;
    uniqueErrorCount: number;
    filesEdited: string[];
  }
  ```
- **Classification rules**:
  - `productive`: error count decreasing over last 3 snapshots OR test pass count increasing.
  - `stagnant`: error count flat (±0), same errors repeating (unique/total ratio < 0.3).
  - `thrashing`: delegates to `ThrashingDetector.isThrashing()`.
- **Orchestrator integration**: After each iteration, take a `ConvergenceSnapshot`. The classifier determines how the orchestrator should respond:
  - `productive` → continue normally, no intervention.
  - `stagnant` → inject guidance nudge with specific suggestions.
  - `thrashing` → escalate to circuit breaker.
- The classifier COMPOSABLE with existing `StruggleDetector` — it interprets signals, doesn't replace detection.

**Config**: `ralph-loop.backpressure.enabled` (default: true), `ralph-loop.backpressure.historySize` (default: 3 snapshots).

**Tests**: `test/struggleDetector.test.ts` — decreasing errors classified as productive, flat errors as stagnant, low uniqueErrorRatio as stagnant, delegates to thrashing detector, history window respected.

---

### Task 62 — Plan Regeneration via Circuit Breaker

**Goal**: Add `'regenerate'` as a new circuit breaker action — when decomposition has been tried and the agent is still failing, regenerate the plan (re-run bearings/planning) instead of skipping.

**Current escalation chain**: nudge → decompose → skip → stop.
**New chain**: nudge → decompose → regenerate → skip → stop.

**Design** (from `ralph-playbook` — "plan is disposable, regeneration cost is one planning loop"):

- In `src/types.ts`, change `CircuitBreakerResult.action` union to include `'regenerate'`:
  ```typescript
  action: 'continue' | 'retry' | 'skip' | 'stop' | 'nudge' | 'regenerate';
  ```
- Add `PlanRegenerationBreaker` in `src/circuitBreaker.ts`:
  - Triggers when: decomposition has been attempted (check `TaskDecomposed` event count for current task > 0) AND `consecutiveFailuresAfterDecomp >= triggerAfterDecompFailures` (default: 2).
  - Returns `{ tripped: true, action: 'regenerate', reason: 'Decomposition failed — regenerating plan' }`.
  - Configurable: `maxRegenerations: number` (default: 1), `triggerAfterDecompFailures: number` (default: 2).
- In `src/orchestrator.ts`, handle `'regenerate'` action:
  1. Save current task context to progress.txt: `"[REGENERATING] Previous approach for task {id} failed after decomposition."`.
  2. Re-run bearings check (`runBearings()`).
  3. Re-send the task prompt with added context: `"Previous approach failed. The task was decomposed but sub-tasks also failed. Take a completely different approach. Start from scratch."`.
  4. Yield `LoopEventKind.PlanRegenerated` event.
  5. After `maxRegenerations` regenerations, fall through to `skip`.
- Insert `PlanRegenerationBreaker` in the chain after `StagnationBreaker`, before `RepeatedErrorBreaker`.

**Config**: `ralph-loop.circuitBreakers` array entry `{ name: 'planRegeneration', enabled: true, maxRegenerations: 1, triggerAfterDecompFailures: 2 }`.

**Tests**: `test/circuitBreaker.test.ts` — breaker doesn't trip without decomposition, trips after decomp + N failures, maxRegenerations cap works, action is 'regenerate'. `test/orchestrator.test.ts` — regenerate action re-sends prompt with changed context, event emitted, falls to skip after max.

---

## Phase 9c — Prompt & Workflow

### Task 63 — Search-Before-Implement Gate (Prompt Tier)

**Goal**: Add a prompt instruction that tells the agent to search the codebase before implementing new functionality. Tier 1 only — just a prompt-level gate, no tooling.

**Design** (from `ralph-playbook` — "don't assume not implemented"):

- In `src/prompt.ts`, in `buildPrompt()`, after the TDD GATE section and before the `'When done: FIRST append...'` line, insert:
  ```
  ===================================================================
                     SEARCH-BEFORE-IMPLEMENT GATE
  ===================================================================

  Before implementing ANY new functionality:
  1. Search the existing codebase for similar implementations (use grep, find, or file search)
  2. Check if the pattern already exists in a different form or file
  3. Only implement new code if no existing implementation serves the purpose
  4. If you find existing code, extend or reuse it rather than creating duplicates

  This prevents accidental duplication and ensures consistency with existing patterns.
  ```
- This is UNCONDITIONAL — always emitted (like TDD gate). It costs minimal tokens and prevents the #1 agent mistake.
- **Tier 2 (future — tracker issue)**: Automated codebase search tooling before each implementation step. Create GitHub issue for tracking.

**Config**: None — always active.

**Tests**: `test/copilot.test.ts` — `buildPrompt` output contains `'SEARCH-BEFORE-IMPLEMENT'` and `'Search the existing codebase'`.

---

### Task 64 — Workflow Presets (Smart Defaults)

**Goal**: Named preset configurations so users can quickly switch between workflow modes without manually tuning 20+ config fields.

**Design**:

- In `src/types.ts`, add:
  ```typescript
  interface RalphPreset {
    name: string;
    description: string;
    overrides: Partial<RalphConfig>;
  }
  ```
- In `src/presets.ts` (new file), define built-in presets:
  ```typescript
  const PRESETS: Record<string, RalphPreset> = {
    general: {
      name: 'general',
      description: 'Balanced defaults — works for most tasks',
      overrides: {} // uses DEFAULT_CONFIG as-is
    },
    feature: {
      name: 'feature',
      description: 'Higher retry tolerance, strict TDD',
      overrides: {
        maxNudgesPerTask: 5,
        maxIterations: 30,
        contextTrimming: { fullUntil: 5, abbreviatedUntil: 12 },
      }
    },
    bugfix: {
      name: 'bugfix',
      description: 'Aggressive error tracking, lower timeout',
      overrides: {
        inactivityTimeoutMs: 180_000,
        circuitBreakers: [
          { name: 'repeatedError', enabled: true },
          { name: 'errorRate', enabled: true },
        ],
      }
    },
    refactor: {
      name: 'refactor',
      description: 'Higher stagnation tolerance, conservative',
      overrides: {
        maxNudgesPerTask: 6,
        stagnationDetection: { enabled: true, maxStaleIterations: 4, hashFiles: ['progress.txt', 'PRD.md'] },
      }
    },
  };
  ```
- Add `resolveConfig(preset?: string, overrides?: Partial<RalphConfig>): RalphConfig` that merges: DEFAULT_CONFIG ← preset overrides ← user overrides.
- Add `ralph-loop.preset` VS Code setting (enum: `'general' | 'feature' | 'bugfix' | 'refactor'`).

**Config**: `ralph-loop.preset` defaults to `'general'`. User config fields override preset values.

**Tests**: `test/presets.test.ts` — general preset returns defaults, feature preset overrides maxNudges, user overrides take priority over preset, unknown preset name falls back to general.

---

### Task 65 — Inter-Task Cooldown Dialog

**Goal**: During the existing countdown between tasks, show a dialog that auto-accepts after the countdown but lets the user intervene (pause/stop/steer).

**Current state**: `orchestrator.ts` has `LoopEventKind.Countdown` with `countdownSeconds: 12` (default). The countdown loop just sleeps — no user interaction.

**Design** (from `aymenfurter/ralph` CountdownTimer + VS Code API `Promise.race` pattern):

- In `src/extension.ts` (or new `src/cooldownDialog.ts`), add:
  ```typescript
  async function showCooldownDialog(
    nextTask: string, timeoutMs: number
  ): Promise<'continue' | 'pause' | 'stop' | 'edit'> {
    const userChoice = vscode.window.showInformationMessage(
      `Next: ${nextTask.slice(0, 80)}...`, 'Pause', 'Stop', 'Edit Next Task'
    );
    const autoAccept = new Promise<undefined>(resolve =>
      setTimeout(() => resolve(undefined), timeoutMs)
    );
    const result = await Promise.race([userChoice, autoAccept]);

    if (result === undefined) return 'continue';  // auto-accepted
    if (result === 'Pause') return 'pause';
    if (result === 'Stop') return 'stop';
    if (result === 'Edit Next Task') return 'edit';
    return 'continue';
  }
  ```
- **VS Code API limitation**: `showInformationMessage` has no auto-dismiss. The dialog stays visible after auto-accept. This is acceptable — the loop continues and the stale dialog is harmless (clicking it after is a no-op since the Promise already resolved).
- In the orchestrator's inter-task countdown loop, after each countdown tick, if `config.cooldownShowDialog` is true, show the dialog. Handle responses:
  - `continue`: proceed to next task (default on timeout)
  - `pause`: yield `YieldRequested` and break
  - `stop`: yield `Stopped` and break
  - `edit`: open input box for user to provide context, inject via `injectContext()`

**Config**: `ralph-loop.cooldownShowDialog` (default: true), `ralph-loop.countdownSeconds` (default: 12, already exists).

**Tests**: `test/orchestrator.test.ts` — auto-accept continues after timeout, pause yields YieldRequested, stop yields Stopped. Unit tests mock the dialog function.

---

## Phase 9d — Signals & Safety

### Task 66 — Filesystem Inactivity Signal (Configurable Threshold)

**Goal**: Make filesystem inactivity timeout configurable with a higher default (120s instead of 60s) and add graduated response.

**Current state**: `strategies.ts` has FileSystemWatcher + `inactivityTimeoutMs` in config. Current default in `DEFAULT_CONFIG` is `300_000` (5 min). The concern is about the INNER inactivity timeout within a single task iteration.

**Design** (from `aymenfurter/ralph` InactivityMonitor at 60s, with user's feedback that 60s is too low):

- Add `InactivityConfig { timeoutMs: number; warningAtPct: number; adaptive: boolean }` to `RalphConfig`:
  ```typescript
  inactivity: {
    timeoutMs: 120_000,       // 2 minutes default (was effectively 60s concern)
    warningAtPct: 50,         // log warning at 50% of timeout
    adaptive: false,          // future: scale based on task complexity
  }
  ```
- In the orchestrator's file watcher loop, add a warning at `warningAtPct` of timeout: log `"No filesystem activity for {N}s — monitoring continues"` (informational, no action).
- At full timeout, existing behavior: multi-button dialog ("Continue Waiting", "Nudge", "Skip", "Stop").
- **Adaptive mode** (future, `adaptive: true`): scale timeout based on task description length (proxy for complexity). Longer tasks get longer timeouts. Deferred to tracker issue — just add the config field and a no-op path.

**Config**: `ralph-loop.inactivity.timeoutMs` (default: 120000), `ralph-loop.inactivity.warningAtPct` (default: 50).

**Tests**: `test/orchestrator.test.ts` — warning logged at 50% threshold, timeout fires at full threshold, custom timeoutMs respected.

---

### Task 67 — Atomic Session Writes

**Goal**: Fix `SessionPersistence.save()` to use atomic writes (tmp + rename pattern) preventing corruption on crash.

**Current state**: `sessionPersistence.ts` `save()` uses `fs.writeFileSync(filePath, data)` directly — if the process crashes mid-write, the file can be corrupted (partial JSON).

**Design** (standard Node.js atomic write pattern):

- In `src/sessionPersistence.ts`, modify `save()`:
  ```typescript
  save(workspaceRoot: string, state: SerializedLoopState): void {
    const dir = path.join(workspaceRoot, SESSION_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const data: SerializedLoopState = { ...state, version: CURRENT_VERSION };
    const filePath = path.join(dir, SESSION_FILE);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
  ```
- `writeFileSync` to `.tmp` + `renameSync` to target is atomic on POSIX (rename is an atomic filesystem operation). On Windows, rename replaces atomically too in Node.js (it calls `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`).
- No other changes to the class API — this is a surgical internal fix.

**Config**: None — always active.

**Tests**: `test/sessionPersistence.test.ts` — save creates file that can be loaded back, tmp file is cleaned up after save, corrupted tmp doesn't affect existing session file (simulate crash by pre-creating a `.tmp` file). Add a new test: mock `fs.renameSync` to throw and verify the `.tmp` file exists but the target doesn't get corrupted.

---

### Task 68 — Session ID & Isolation

**Goal**: Add session IDs to `SerializedLoopState` for session isolation and cross-window safety.

**Current state**: `sessionPersistence.ts` saves/loads state but has no session identity — any ralph-loop instance in any window can resume any session.

**Design**:

- In `src/sessionPersistence.ts`, extend `SerializedLoopState`:
  ```typescript
  interface SerializedLoopState {
    // existing fields...
    sessionId: string;        // NEW: UUID
    pid: number;              // NEW: process PID
    workspacePath: string;    // NEW: workspace root for isolation
  }
  ```
- In `save()`, populate `sessionId` (generated once per `startLoop()` call via `crypto.randomUUID()`), `pid` (`process.pid`), `workspacePath`.
- In `load()`, validate:
  1. `workspacePath` matches current workspace (prevents cross-workspace resume).
  2. PID is no longer running (if PID is alive → another instance already owns this session → return null with warning log).
- PID liveness check: `process.kill(pid, 0)` (sends signal 0 — doesn't kill, just checks existence). Wrap in try-catch — `ESRCH` means process is dead (safe to resume), `EPERM` means process exists (another instance).
- The session ID is threaded through yielded events and progress.txt entries for traceability.

**Config**: None — always active when session persistence is enabled.

**Tests**: `test/sessionPersistence.test.ts` — sessionId generated and persisted, workspace mismatch returns null, dead PID allows resume, live PID prevents resume (mock `process.kill`).

---

## Phase 9e — Implementation-Only

### Task 69 — Direct Implementation: No Extra Research

**Tasks from prior phases that just need implementation with proper tests, no additional research:**

**Deferred to GitHub Issue**: Task 63 from original proposal (whatever it was) — create tracking issue.

---

## Task Dependency Graph

```
Phase 9a (Context & Knowledge):
  57 (Context Budget) — independent
  58 (Harvest Pipeline) — depends on existing knowledge.ts
  59 (Knowledge GC) — depends on 58 (uses harvest metadata)

Phase 9b (Detection & Intelligence):
  60 (Thrashing Detection) — depends on existing struggleDetector.ts
  61 (Backpressure Classification) — depends on 60 (uses thrashing signal)
  62 (Plan Regeneration) — depends on existing circuitBreaker.ts

Phase 9c (Prompt & Workflow):
  63 (Search Gate) — independent
  64 (Workflow Presets) — independent
  65 (Cooldown Dialog) — independent

Phase 9d (Signals & Safety):
  66 (FS Inactivity) — independent
  67 (Atomic Writes) — independent
  68 (Session ID) — depends on 67 (uses atomic writes)
```

**Recommended execution order**:
1. 67 (Atomic Writes) — smallest, surgical fix, unblocks 68
2. 63 (Search Gate) — prompt-only, minimal risk
3. 57 (Context Budget) — self-contained
4. 58 (Harvest Pipeline) — builds on knowledge.ts
5. 59 (Knowledge GC) — needs 58's metadata
6. 60 (Thrashing Detection) — builds on struggleDetector.ts
7. 61 (Backpressure) — needs 60
8. 62 (Plan Regeneration) — circuit breaker extension
9. 64 (Workflow Presets) — config layer
10. 65 (Cooldown Dialog) — UI feature
11. 66 (FS Inactivity) — config refinement
12. 68 (Session ID) — needs 67
