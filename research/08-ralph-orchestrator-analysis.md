# Phase 9 — Orchestrator Patterns (from mikeyobrien/ralph-orchestrator analysis)

> Patterns extracted from: mikeyobrien/ralph-orchestrator (Rust multi-crate orchestrator with TypeScript web backend).
> **Focus**: UNIQUE patterns not seen in other ralph implementations already analyzed in Phases 2–8.
> **TDD is MANDATORY**: Every task MUST follow red-green-refactor. Write failing tests FIRST.
> Run `npx tsc --noEmit` and `npx vitest run` — ALL tests must pass before marking ANY checkbox.
> After completing each task: (1) run `npx tsc --noEmit` (must exit 0), (2) run `npx vitest run` (all tests pass), (3) append what you did to progress.txt, (4) mark the checkbox [x] in PRD.md, (5) commit with `git add -A && git commit -m "feat: <short description>"`.

---

## Area 1: Event-Driven Hat System (Pub/Sub Task Routing)

**What ralph-orchestrator does**: Instead of a linear task queue, it uses an event-driven pub/sub model. "Hats" are specialized personas that subscribe to specific event topics and publish new events. A `HatRegistry` routes events to the correct hat. The core loop is: check termination → get next hat (by subscribed topic) → build prompt with hat instructions → execute → parse emitted events → route via EventBus → repeat. "Hatless Ralph" is the sovereign coordinator that owns `LOOP_COMPLETE` and acts as universal fallback when no hat handles an event.

**What's UNIQUE**: ralph-loop currently has a flat task queue from PRD checkboxes. This pub/sub pattern enables multi-phase workflows (e.g., "implement" hat emits `tests.needed` → "tester" hat picks it up → emits `review.needed` → "reviewer" hat picks it up) without hardcoding the sequence.

**Adoption for ralph-loop (simplified)**:

### Event Bus & Topic Routing

- [ ] **9.1 — Event topic routing**: Create `src/eventBus.ts` exporting `EventBus` class. Types: `Topic = string` (e.g., `'task.implement'`, `'task.verify'`, `'task.review'`), `Subscription = { topics: Topic[]; handler: (event: LoopEvent) => void }`. Methods: `subscribe(topics: Topic[], handler): () => void` (returns unsubscribe fn), `publish(topic: Topic, event: LoopEvent): void` (calls all matching handlers), `hasSubscribers(topic: Topic): boolean`. The EventBus replaces direct event yields with routable events. In `src/types.ts`, add `topic?: string` to `LoopEvent` interface. Write tests FIRST in `test/eventBus.test.ts`: subscribe receives matching events, unsubscribe stops delivery, no subscribers returns false, multiple subscribers all receive event. Run `npx tsc --noEmit` and `npx vitest run`.

### Fallback Event Injection

- [ ] **9.2 — Fallback event injection for stuck loops**: In `src/orchestrator.ts`, add `injectFallbackEvent(currentTask: string, consecutiveFallbacks: number): LoopEvent | null`. When the loop detects no progress after an iteration (no file changes, no checkbox checked, no new events), inject a synthetic `task.resume` event that re-sends the current task with additional context: `"You appear stuck. Re-read the task requirements and try a different approach. Previous attempt produced no file changes."` Track `consecutiveFallbacks` per task — after 3 consecutive fallbacks with no progress, escalate to `LoopEventKind.TaskAbandoned` (new event) and move to next task. This mirrors ralph-orchestrator's `inject_fallback_event()` which targets the last executing hat. Write tests FIRST in `test/orchestrator.test.ts`: fallback injects resume event, 3 consecutive fallbacks yields TaskAbandoned, file changes reset fallback counter. Run `npx tsc --noEmit` and `npx vitest run`.

---

## Area 2: Multi-Strategy Backend Support

**What ralph-orchestrator does**: A `CliBackend` factory creates backend adapters for 10+ agents (Claude, Gemini, Codex, Copilot, etc.) with per-backend configuration. Each hat can override which backend it uses via YAML config. Auto-detection scans for available backends with priority ordering. Three `PromptMode` variants (Arg, Stdin) and three `OutputFormat` variants (Text, StreamJson, PiStreamJson) handle differences between agents.

**What's UNIQUE**: ralph-loop is locked to VS Code Copilot Chat. While we can't add external backends (it's a VS Code extension), we CAN adopt the strategy pattern for how we interact with Copilot — different "strategies" for different task types (implementation vs. debugging vs. review).

### Task-Type Strategies

- [ ] **9.3 — Task-type execution strategies**: Create `src/strategies.ts` exporting `TaskStrategy` interface: `{ name: string; detect(task: string): boolean; buildPrompt(task: string, context: PromptContext): string; parseResult(output: string): TaskResult }`. Implement three strategies: (1) `ImplementStrategy` — default, for `- [ ]` tasks, uses standard prompt; (2) `DebugStrategy` — detects tasks containing "fix", "debug", "error", "broken" — prepends diagnostic instructions: `"First reproduce the error, then identify root cause, then fix. Show the error output."` ; (3) `ReviewStrategy` — detects "review", "refactor", "optimize" — adds: `"Analyze the existing code first. List issues found. Then make targeted changes."` In orchestrator, before building the prompt, iterate strategies and use the first matching one (fallback to ImplementStrategy). Add `strategy?: string` to force a specific strategy via config. Write tests FIRST in `test/strategies.test.ts`: each strategy detects its keywords, non-matching falls to default, forced strategy overrides detection. Run `npx tsc --noEmit` and `npx vitest run`.

---

## Area 3: Loop Thrashing & Stale Detection

**What ralph-orchestrator does**: Beyond simple stagnation, it detects two specific failure modes: (1) **Loop thrashing** — same hat repeatedly blocked on the same event, triggers `build.task.abandoned`; (2) **Stale loop** — same event signature emitted 3+ times consecutively, indicating circular behavior. Also validates JSONL output format — 3+ consecutive malformed events trigger `ValidationFailure` termination.

**What's UNIQUE**: ralph-loop has basic stagnation detection (3-signal struggle), but lacks signature-based circular detection and output validation.

### Circular Behavior Detection

- [ ] **9.4 — Loop signature dedup (circular detection)**: In `src/stagnationDetector.ts`, add `detectCircularBehavior(eventHistory: string[]): { isCircular: boolean; pattern?: string }`. Track the last N event signatures (hash of: task ID + iteration + files changed). If the same signature appears 3+ consecutive times, return `{ isCircular: true, pattern: signature }`. In orchestrator, after each iteration, compute the event signature and pass the history to `detectCircularBehavior`. If circular, yield `LoopEventKind.CircularDetected` (new event) with the repeating pattern, inject a "break the cycle" prompt: `"You are repeating the same actions. Try a completely different approach: different files, different strategy, or decompose the task into smaller steps."` If still circular after the intervention, yield `TaskAbandoned`. Write tests FIRST in `test/stagnationDetector.test.ts`: 3 identical signatures = circular, 2 identical = not circular, different signatures = not circular, intervention resets detection. Run `npx tsc --noEmit` and `npx vitest run`.

### Output Validation

- [ ] **9.5 — Copilot output validation**: In `src/diffValidator.ts`, add `validateAgentOutput(output: string): { valid: boolean; issues: string[] }`. Check for: (1) output is not empty, (2) output doesn't contain only apologies/refusals ("I can't", "I'm sorry", "I don't have access"), (3) output contains actionable content (file paths, code blocks, or checkbox marks), (4) output length is within bounds (not suspiciously short < 50 chars for implementation tasks). Track `consecutiveInvalidOutputs` — after 3, yield `LoopEventKind.ValidationFailure` (new event) and attempt recovery by resending with: `"Your previous response was not actionable. You MUST edit files directly. Do not explain — act."` Write tests FIRST in `test/diffValidator.test.ts`: valid output passes, empty fails, apology-only fails, 3 consecutive invalids triggers failure, recovery resets counter. Run `npx tsc --noEmit` and `npx vitest run`.

---

## Area 4: Advanced Recovery Patterns

**What ralph-orchestrator does**: Rich `TerminationReason` enum (13 variants), hook suspend policies (`WaitForResume`, `RetryBackoff`, `WaitThenRetry`), backpressure for review events requiring verification evidence, late event recovery with polling, and `recoverStuckTasks()` for server restart recovery.

**What's UNIQUE**: ralph-loop has retry and nudge but lacks: backpressure (requiring verification before accepting completion), hook suspend policies, and the rich termination taxonomy.

### Backpressure Verification

- [ ] **9.6 — Backpressure verification gate**: In `src/verify.ts`, add `requireVerificationEvidence(taskResult: TaskResult): { accepted: boolean; missing: string[] }`. Before accepting a task as complete, require concrete evidence: (1) at least one file was modified (git diff non-empty), (2) if task mentions "test", test files were modified, (3) progress.txt was updated (mtime changed). If evidence is missing, reject completion and send back: `"Task completion rejected — missing evidence: {missing items}. You must actually make the changes, not just describe them."` This is the "backpressure" concept from ralph-orchestrator where `review.done` is rejected without `tests_passed`/`build_passed` evidence. Write tests FIRST in `test/verify.test.ts`: all evidence present = accepted, no file changes = rejected with reason, test task without test file changes = rejected. Run `npx tsc --noEmit` and `npx vitest run`.

### Graceful Termination Taxonomy

- [ ] **9.7 — Rich termination reasons**: In `src/types.ts`, replace the current simple stop reasons with a `TerminationReason` enum: `AllTasksComplete`, `MaxIterations`, `MaxRuntime`, `UserStopped`, `YieldRequested`, `ConsecutiveFailures`, `CircularDetected`, `ValidationFailure`, `BearingsFailed`, `CrashRecoveryFailed`. Each carries metadata: `{ reason: TerminationReason; detail: string; exitAction: 'commit' | 'stash' | 'none' }`. In orchestrator, use `TerminationReason` in the final `LoopComplete` event instead of a generic message. The `exitAction` field tells the extension what to do with uncommitted changes: `'commit'` for successful completions, `'stash'` for failures (preserve work), `'none'` for user stops. Write tests FIRST: each termination path produces correct reason and exitAction. Run `npx tsc --noEmit` and `npx vitest run`.

---

## Area 5: Configuration Presets & Guardrails

**What ralph-orchestrator does**: YAML preset system with 21 presets (16 standalone, 5 planner-dependent). `ConfigMerger` merges base config with preset hats. Embedded presets compiled into binary. Default guardrails include "Fresh context each iteration", "Backpressure is law", "Confidence protocol 0-100", "Commit atomically". Preflight checks validate config, hooks, backend, git state, paths, tools, and specs before loop start.

**What's UNIQUE**: ralph-loop has config but no preset system and limited preflight checks (only tsc + vitest in bearings).

### Configuration Presets

- [ ] **9.8 — Loop presets**: In `src/types.ts`, add `LoopPreset` type: `{ name: string; description: string; config: Partial<RalphConfig> }`. Create `src/presets.ts` with built-in presets: (1) `'careful'` — maxIterations: 5, maxNudgesPerTask: 1, promptBlocks: ['safety', 'discipline', 'security'], bearings.enabled: true; (2) `'fast'` — maxIterations: 20, maxNudgesPerTask: 5, promptBlocks: ['discipline', 'brevity'], inactivityTimeoutMs: 120000; (3) `'thorough'` — maxIterations: 15, maxNudgesPerTask: 3, promptBlocks: ['safety', 'discipline', 'security'], hardMaxIterations: 30, confidenceThreshold: 140. In `src/orchestrator.ts`, add `applyPreset(presetName: string, baseConfig: RalphConfig): RalphConfig` that deep-merges preset config over base (preset values win). Add `preset?: string` to `RalphConfig`. In VS Code settings, expose `ralph-loop.preset` as a dropdown. Write tests FIRST in `test/presets.test.ts`: each preset applies correct overrides, unknown preset throws, base config preserved for non-overridden fields. Run `npx tsc --noEmit` and `npx vitest run`.

### Extended Preflight Checks

- [ ] **9.9 — Extended preflight checks**: In `src/orchestrator.ts`, extend `runBearings` to include: (1) **Git check** — workspace has a git repo and clean working tree (warn if dirty), (2) **PRD check** — PRD file exists and has at least one unchecked task, (3) **Config check** — validate config values are within bounds (maxIterations > 0, inactivityTimeoutMs > 10000, etc.), (4) **Hook check** — if hookScript configured, verify file exists and is executable. Each check returns `{ name: string; passed: boolean; message?: string; severity: 'error' | 'warning' }`. Errors block the loop; warnings are logged but loop continues. Add `preflight?: { strict: boolean; skipChecks?: string[] }` to `RalphConfig` — when `strict: true`, warnings also block. Write tests FIRST in `test/orchestrator.test.ts`: clean state passes all, missing PRD fails, dirty git warns, invalid config fails, strict mode blocks on warnings. Run `npx tsc --noEmit` and `npx vitest run`.

---

## Area 6: Lifecycle Hooks & Guardrails

**What ralph-orchestrator does**: Full lifecycle hook system with `pre/post` pairs for: `loop.start`, `iteration.start`, `plan.created`, `human.interact`, `loop.complete`, `loop.error`. Hook suspend policies: `WaitForResume` (pause until signal), `RetryBackoff` (exponential retry with configurable delays), `WaitThenRetry` (fixed wait then retry). Default guardrails injected into every prompt: "Fresh context each iteration", "Don't assume not implemented", "Backpressure is law", "Exercise real app", "Confidence protocol 0-100", "Commit atomically".

**What's UNIQUE**: ralph-loop has basic hooks (SessionStart, PreCompact, PostToolUse, TaskComplete) but lacks iteration-level hooks, hook suspend policies, and systematic guardrails.

### Iteration-Level Hooks

- [ ] **9.10 — Iteration lifecycle hooks**: In `src/types.ts`, extend `RalphHookType` with `'IterationStart' | 'IterationEnd'`. Add `IterationStartInput = { taskId: string; iterationNumber: number; previousResult?: string }` and `IterationEndInput = { taskId: string; iterationNumber: number; filesChanged: string[]; checkboxChecked: boolean }`. Extend `IRalphHookService` with `onIterationStart(input: IterationStartInput): Promise<HookResult>` and `onIterationEnd(input: IterationEndInput): Promise<HookResult>`. In orchestrator, call `onIterationStart` before sending the prompt and `onIterationEnd` after processing the result. `onIterationEnd` returning `'retry'` re-runs the iteration; `'skip'` moves to next task; `'stop'` halts the loop. Update `NoOpHookService` and `ShellHookProvider`. Write tests FIRST: iteration hooks fire in correct order, retry re-runs, skip advances, stop halts. Run `npx tsc --noEmit` and `npx vitest run`.

### Default Guardrails Prompt

- [ ] **9.11 — Systematic guardrails injection**: In `src/prompt.ts`, add `GUARDRAILS` constant array: `["Fresh context: treat each iteration as if you have no memory of previous iterations — re-read files before editing.", "Don't assume: never assume a function doesn't exist — search the codebase first.", "Commit atomically: each task should result in one atomic commit with all related changes.", "Exercise the app: after making changes, run the app/tests to verify they work."]`. Add `injectGuardrails(prompt: string, guardrails: string[]): string` that appends a `## GUARDRAILS` section to the prompt with numbered rules. In `buildPrompt`, call `injectGuardrails` with the default guardrails plus any custom ones from `config.customGuardrails?: string[]`. Write tests FIRST in `test/copilot.test.ts`: default guardrails present in output, custom guardrails appended, empty custom guardrails only shows defaults. Run `npx tsc --noEmit` and `npx vitest run`.

---

## Summary of Unique Patterns Adopted

| # | Pattern | Source (ralph-orchestrator) | ralph-loop Adoption |
|---|---------|---------------------------|-------------------|
| 9.1 | Event pub/sub routing | `hat.rs`, `EventBus` | `EventBus` class with topic subscriptions |
| 9.2 | Fallback event injection | `inject_fallback_event()` | Synthetic resume events for stuck loops |
| 9.3 | Task-type strategies | `CliBackend` factory, per-hat backends | Strategy pattern for implement/debug/review |
| 9.4 | Circular behavior detection | Stale loop (same signature 3x) | Event signature dedup with intervention |
| 9.5 | Output validation | 3+ malformed JSONL → ValidationFailure | Agent output validation with recovery |
| 9.6 | Backpressure verification | `review.done` rejection without evidence | Evidence-required completion gate |
| 9.7 | Rich termination taxonomy | 13-variant `TerminationReason` enum | 10-variant enum with exit actions |
| 9.8 | Configuration presets | 21 YAML presets, `ConfigMerger` | 3 built-in presets (careful/fast/thorough) |
| 9.9 | Extended preflight | 8-category preflight checks | Git/PRD/config/hook validation |
| 9.10 | Iteration hooks | `pre/post.iteration.start` lifecycle | IterationStart/End hooks with suspend |
| 9.11 | Guardrails injection | Default guardrails in every prompt | Systematic numbered guardrails section |
