# Ralph Loop V2 — Phase 1 Self-Fix PRD

> Being executed BY ralph-loop ON itself.
> Run `npx tsc --noEmit` after each change. Run `npx vitest run` if test files change.

## Tasks

- [x] In `src/prompt.ts`: Add a new section to the prompt output. After the "YOUR TASK TO IMPLEMENT" banner and task description, before the "MANDATORY" section, insert a block titled "ROLE & BEHAVIOR" containing: "You are an autonomous coding agent. Complete the task below by editing files directly. If you encounter errors, debug and fix them — do not stop. If tests fail, fix the tests or the code. When done, mark the checkbox in PRD.md and append what you did to progress.txt. Do not ask questions — act." Run `npx tsc --noEmit` and `npx vitest run` to verify — update test expectations in `test/copilot.test.ts` if they fail due to changed output format. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

- [x] In `src/prompt.ts`: Modify the `buildPrompt` function to accept a 4th optional parameter `maxProgressLines: number = 20`. When progressContent has more lines than maxProgressLines, keep only the LAST maxProgressLines lines and prepend a summary line like `[...N earlier entries omitted]`. This prevents the prompt from growing unboundedly as progress.txt grows. Run `npx tsc --noEmit` and `npx vitest run` — add a new test in `test/copilot.test.ts` that verifies truncation with 30 lines of progress. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

- [x] In `src/prompt.ts`: Change how PRD content is shown in the prompt. Instead of including the FULL PRD file content, filter it to show only unchecked task lines (lines matching `- [ ]`) plus a summary header like `Progress: N/M tasks completed`. Keep the markdown code fence wrapper. This reduces context waste since completed tasks aren't relevant. Run `npx tsc --noEmit` and `npx vitest run` — update tests in `test/copilot.test.ts` that check for PRD content format. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

- [x] Add a file `src/prompt.test.ts` (or use the existing `test/copilot.test.ts`) to add a test that verifies `buildPrompt` includes the "ROLE & BEHAVIOR" section in its output. Also add a test that when given 30 lines of progress content, the output contains `[...10 earlier entries omitted]` (since default maxProgressLines is 20). Also add a test that checked PRD lines (`- [x]`) are NOT included in the output but unchecked ones are. Run `npx vitest run` to verify all tests pass. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

---

## Phase 2 — Autopilot Patterns (from VS Code Copilot analysis)

> Patterns extracted from Justin Chen's autopilot implementation in vscode-copilot-chat.
> These are listed in priority order. Each task is self-contained.

### Nudge System (highest impact)

- [x] **Nudge on premature stop**: In `src/orchestrator.ts`, when the inactivity timeout fires but the PRD checkbox is NOT checked yet, instead of immediately yielding `TaskTimedOut` and moving on, first re-send the same task prompt via Copilot with a continuation nudge appended: `"Continue with the current task. You have NOT marked the checkbox yet. Do NOT repeat previous work — pick up where you left off. If you encountered errors, resolve them. If you were planning, start implementing."` Add a new event `LoopEventKind.TaskNudged` with `{ task, nudgeCount }`. Only THEN, if the nudge also times out, yield `TaskTimedOut`. Add a config `maxNudgesPerTask: number = 3` to `RalphLoopConfig`. Track `nudgeCount` per task. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [x] **Reset inactivity timer on file activity**: In `src/orchestrator.ts`, reset the inactivity timeout whenever the `FileSystemWatcher` detects a file change (the `onDidChange`/`onDidCreate`/`onDidDelete` events already exist for PRD watching). Currently the timeout is a fixed wall clock from task start. Instead, restart it on ANY watched file change — this prevents timing out on a task where Copilot is actively editing files but hasn't checked the box yet. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Enhanced Prompt (enriches existing Task 1)

- [x] **Anti-premature-termination checklist**: In `src/prompt.ts`, after the "ROLE & BEHAVIOR" section (added by Task 1), add a "DO NOT STOP IF" section: `"DO NOT STOP if: you encounter an error (debug and fix it), tests fail (fix them), you have remaining steps (complete them first), you have open questions (make a decision and proceed)."` Also add explicit ordering: `"When done: FIRST append what you did to progress.txt, THEN mark the checkbox in PRD.md. Both updates are required."` Also add persistence framing: `"Continue working until the task is fully complete. It's YOUR RESPONSIBILITY to finish. Do not hand back to the user."` Run `npx tsc --noEmit` and `npx vitest run`. Mark checkbox and append to progress.txt.

### Retry System

- [x] **Auto-retry with error classification**: In `src/orchestrator.ts`, when a task errors (caught by the existing try/catch), classify the error before giving up. Add `shouldRetry(error: Error, retryCount: number): boolean` — return `true` for transient errors (network, timeout) and `false` for fatal errors (user cancel via `stopRequested`, max iterations reached). Add `MAX_RETRIES_PER_TASK = 3` constant. In the catch block, if `shouldRetry` returns true, wait 2 seconds, decrement nothing, and re-enter the task body (re-send prompt). Track `retryCount` per task separately from `nudgeCount`. Add `LoopEventKind.TaskRetried` event. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### State Machine Enrichment

- [x] **Separate nudge/retry counters and latch pattern**: In `src/types.ts`, add `nudgeCount` and `retryCount` to `TaskState` (or create a new per-task tracking interface). Add `LoopEventKind.TaskNudged` and `LoopEventKind.TaskRetried` to the event union. In the orchestrator, when a nudge produces productive file changes (detected by the file watcher), reset `nudgeCount` to 0 — this allows the agent to be nudged again later if it stalls a second time. Once a task is verified complete (checkbox checked), set a `taskCompletedLatch` flag so it's never re-checked. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Testability

- [x] **Extract decision logic for testability**: Refactor `src/orchestrator.ts` to extract three pure methods: `shouldContinueLoop(state): boolean`, `shouldNudge(state): string | undefined`, `shouldRetry(error, retryCount): boolean`. These take plain state objects (no VS Code dependencies) and return decisions. Create `test/orchestrator.test.ts` with tests: (1) `shouldContinueLoop` returns false when all tasks done, true when tasks remain; (2) `shouldNudge` returns nudge text when task not complete and nudgeCount < max, undefined when at max; (3) `shouldRetry` returns true for transient errors under cap, false for fatal or over cap. Run `npx vitest run`. Mark checkbox and append to progress.txt.

### Hook System (V2 foundation)

- [x] **Hook type definitions**: In `src/types.ts`, define the hook system types: `type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'TaskComplete'`. For each, define typed input interfaces (`SessionStartInput { prdPath: string }`, `TaskCompleteInput { taskId: string; result: 'success' | 'failure' }`, etc.) and a shared `HookResult { action: 'continue' | 'retry' | 'skip' | 'stop'; reason?: string; additionalContext?: string }`. Define `IRalphHookService` interface with one method per hook type. Export all types. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Hook integration in orchestrator**: In `src/orchestrator.ts`, accept an optional `IRalphHookService` in the constructor. At each yield point, call the corresponding hook method and check the returned `HookResult.action` — `'continue'` proceeds normally, `'retry'` re-enters the task, `'skip'` moves to next task, `'stop'` breaks the loop. If `additionalContext` is set, include it in the next prompt sent to Copilot. Create a default no-op implementation that always returns `{ action: 'continue' }`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

---

## Phase 3 — Extended Autopilot Patterns

> Additional patterns from VS Code Copilot autopilot. All are implementable in ralph-loop's architecture.

### Graceful Yield / External Stop Request

- [ ] **External yield request**: In `src/types.ts`, add `yieldRequested: boolean` to `LoopOrchestrator` state. In `src/orchestrator.ts`, expose a `requestYield()` method that sets this flag. In the main loop, check `yieldRequested` after each task completes — if true, yield a new `LoopEventKind.YieldRequested` event and break the loop gracefully (not a hard stop). In autopilot mode, the yield is deferred: the loop continues until the current task's checkbox is checked, THEN yields. This mirrors VS Code's `yieldRequested` which autopilot ignores until `taskCompleted`. In `src/extension.ts`, wire a new VS Code command `ralph-loop.yield` that calls `requestYield()`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Dynamic Iteration Limits

- [ ] **Auto-expand iteration limit in autopilot**: In `src/orchestrator.ts`, when `maxIterations` is reached but tasks remain, instead of immediately yielding `MaxIterations` and stopping, auto-expand the limit by 50% (capped at a hard maximum of 50 iterations). Add `hardMaxIterations: number = 50` to `RalphLoopConfig`. Log the expansion via `LoopEventKind.IterationLimitExpanded` (new event). Only auto-expand once per loop run — if the expanded limit is also reached, stop for real. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Shell Hook Execution

- [ ] **External shell command hooks**: Extend `IRalphHookService` to support shell command hooks alongside in-process TS callbacks. Add a `ShellHookProvider` that executes a user-configured shell script on each hook event, passing hook input as JSON on stdin and reading `HookResult` as JSON from stdout. The script path is configured via `RalphLoopConfig.hookScript?: string`. Exit codes: 0 = success/continue, 1 = warning (log and continue), 2 = block/stop (halt the loop with the script's stderr as reason). This enables user-authored quality gates (e.g., run linter, check test coverage, validate git state) without modifying ralph-loop source. Add timeout of 30s per hook execution. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Prompt Enrichment Blocks

- [ ] **Security and safety prompt blocks**: In `src/prompt.ts`, add optional prompt blocks that are injected when configured. Add `promptBlocks?: string[]` to `RalphLoopConfig` with possible values: `'security'` (OWASP Top 10 awareness, input validation, no hardcoded secrets), `'safety'` (prefer reversible actions, confirm destructive ops, don't delete files without PRD instruction), `'discipline'` (minimal changes, no over-engineering, no unsolicited refactoring), `'brevity'` (concise output, no verbose explanations in comments). Each block is a 2-3 sentence instruction appended after the "ROLE & BEHAVIOR" section. Default: `['safety', 'discipline']`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Tool Capability Discovery

- [ ] **Deferred tool/capability awareness**: In `src/prompt.ts`, add a "AVAILABLE CAPABILITIES" section to the prompt that lists what the agent CAN do based on configuration. When hooks are enabled, mention it: `"Quality hooks are active — your work will be validated after each tool use."` When shell hooks are configured, mention the script: `"External validator: [script path] will run on task completion."` When specific prompt blocks are active, list them. This gives the agent awareness of the guardrails around it, similar to how VS Code's `nonDeferredToolNames` ensures the model knows about critical tools. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Agentic Proxy Pattern

- [ ] **Copilot hook registration as agentic proxy**: Instead of polling the filesystem to detect task completion, register ralph-loop as a Copilot chat hook provider using the `ChatHookCommand` proposed API. Create `src/hookBridge.ts` that: (1) generates a small Node.js script at runtime (written to a temp file) that listens for hook invocations from Copilot on stdin, (2) registers this script as a `Stop` hook via VS Code's `chat.hooks` configuration so Copilot calls it when the agent wants to stop, (3) the script checks whether the PRD checkbox was actually marked — if not, returns `{ resultKind: 'error', stopReason: 'Task not complete — checkbox not marked in PRD.md' }` which makes Copilot continue working, (4) when the checkbox IS marked, returns `{ resultKind: 'success' }` letting Copilot stop normally. Also register a `PostToolUse` hook that resets the inactivity timer on each tool call. This replaces filesystem polling with event-driven completion detection. Note: requires `vscode.proposed.chatHooks` API — gate behind a feature flag `useHookBridge: boolean = false` in config. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Session identity tracking via proposed API**: In `src/extension.ts`, when available, read `vscode.window.activeChatPanelSessionResource` to get the URI of the active chat session. Store this in the orchestrator as `currentSessionId`. Use it to: (1) correlate which chat session ralph-loop fired a prompt into, (2) detect when the session changes (user opened a different chat) and pause the loop, (3) target hook registration to the specific session. Gate behind a feature flag `useSessionTracking: boolean = false` since this requires `vscode.proposed.chatParticipantPrivate`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Permission level escalation**: When firing prompts to Copilot, if the proposed `chatParticipantPrivate` API is available, set `permissionLevel: 'autopilot'` on the chat request. This enables Copilot's internal autopilot mode: auto-approves tool calls, auto-continues on stalls, requires explicit `task_complete` tool call before stopping. Ralph-loop's nudge system becomes a second layer on top of Copilot's built-in autopilot — ralph handles task sequencing while Copilot handles within-task autonomy. Gate behind `useAutopilotMode: boolean = false`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

---

## Phase 4 — Agentic Proxy Patterns (from SearchSubagentToolCallingLoop analysis)

> Patterns extracted from the agentic proxy implementation: ProxyAgenticSearchEndpoint, SearchSubagentToolCallingLoop, subagent invocation lifecycle, and background pipeline architecture.

### Subagent Task Model

- [ ] **Invocation ID threading**: In `src/types.ts`, add `taskInvocationId: string` (UUID) to each task's runtime state. Generate it in `src/orchestrator.ts` when a task starts (before the prompt is sent). Thread it through: progress.txt entries, events, hook invocations, and any telemetry. This enables correlating "which task produced which changes" across the entire system. Similar to VS Code's `subAgentInvocationId` + `parentRequestId` pattern that links subagent calls to parent requests for tracing. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Isolated task conversation**: In `src/copilot.ts`, when opening a new Copilot chat for each task, ensure a FRESH chat session is used (no conversation history from previous tasks). Currently ralph fires `workbench.action.chat.open` — verify this opens a new session. If it reuses the panel, add `workbench.action.chat.newChat` before the prompt send. This mirrors the search subagent's pattern of creating a fresh `Conversation` with no parent history — each task should start clean without context pollution from prior tasks. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Forced conclusion nudge on iteration limit**: In `src/prompt.ts`, add a `buildFinalNudgePrompt(task, nudgeCount, maxNudges)` function that generates a "wrap it up" message when `nudgeCount >= maxNudges - 1`: `"Your remaining time is almost up. Produce your final result NOW: commit any partial work, update progress.txt, and mark the checkbox. If tests fail, document the failure and mark done anyway."` This mirrors VS Code's search subagent `isLastTurn` nudge: "your allotted iterations are finished — produce answer now." The orchestrator calls this for the final nudge instead of the standard continuation nudge. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Endpoint / Backend Abstraction

- [ ] **Task execution strategy interface**: In `src/types.ts`, define `ITaskExecutionStrategy` with one method: `execute(task: PrdTask, prompt: string, options: ExecutionOptions): Promise<ExecutionResult>`. Create two implementations: (1) `CopilotCommandStrategy` (current approach — fire workbench command, poll filesystem), (2) `DirectApiStrategy` (future — call Copilot's API directly via proposed `chatProvider` API, get streaming response). Add `executionStrategy?: 'command' | 'api'` to `RalphLoopConfig`, defaulting to `'command'`. The orchestrator resolves the strategy from config and delegates. This mirrors VS Code's `ChatEndpoint` base class where `ProxyAgenticSearchEndpoint` swaps the backend by overriding `urlOrRequestMetadata`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Synthetic model awareness**: In `src/prompt.ts`, add a `modelHints` section to the prompt when configured. If `RalphLoopConfig.modelHint?: string` is set (e.g., `'claude-sonnet'`, `'gpt-4o'`), include model-specific behavioral instructions: Claude gets "use artifacts for long code", GPT gets "use code blocks". This mirrors VS Code's `ProxyAgenticSearchEndpoint` constructing synthetic `IChatModelInformation` — ralph doesn't know which model Copilot uses, but the user can hint it for prompt optimization. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

### Background Pipeline (future foundation)

- [ ] **Task parallelization with DAG dependencies**: In `src/types.ts`, add optional `dependsOn?: string[]` to `PrdTask` (parsed from PRD.md indentation or explicit `depends: task-1` annotations). In `src/orchestrator.ts`, modify `pickNextTask` to return ALL tasks whose dependencies are met (not just the first one). When multiple independent tasks are ready, execute them in parallel — open multiple Copilot chats simultaneously. Add `maxParallelTasks: number = 1` to config (default sequential). This mirrors VS Code's background pipeline where reviewers run in parallel (up to 20) with a `maxConcurrencyPerStage` cap. Emit `LoopEventKind.TasksParallelized` with the task list. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **SubagentStop hook — completion verification gate**: In `src/hookBridge.ts` (created in Phase 3), extend the `Stop` hook to be a full verification gate. When Copilot's agent calls `task_complete`, the hook runs a verification checklist before allowing the stop: (1) PRD checkbox is marked, (2) progress.txt was updated, (3) no TypeScript compilation errors (`npx tsc --noEmit` exit code 0), (4) no test failures (`npx vitest run` exit code 0). If any check fails, return `{ resultKind: 'error', stopReason: 'Verification failed: [details]' }` which makes Copilot continue working on the failures. This mirrors VS Code's `SubagentStop` hook that can block stopping with reasons. Gate behind `useVerificationGate: boolean = false`. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.

- [ ] **Config-gated feature system**: In `src/types.ts`, add a `features` object to `RalphLoopConfig` that groups all boolean feature flags: `{ useHookBridge: boolean, useSessionTracking: boolean, useAutopilotMode: boolean, useVerificationGate: boolean, useParallelTasks: boolean }`. All default to `false`. In `src/extension.ts`, read these from VS Code settings under `ralph-loop.features.*`. In `src/orchestrator.ts`, check the feature object before activating each capability. This mirrors VS Code's `ConfigType.ExperimentBased` pattern where each consumer gets its own independent toggle. Run `npx tsc --noEmit`. Mark checkbox and append to progress.txt.
