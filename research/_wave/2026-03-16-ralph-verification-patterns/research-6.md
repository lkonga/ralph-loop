# Research Report 6: VS Code Copilot Autopilot Completion Detection and How Ralph-Loop Drew Inspiration

**Wave**: 2026-03-16-ralph-verification-patterns
**Question**: How does VS Code Copilot's autopilot/agent mode implement its own completion detection and stop hooks — the `ChatHookCommand` proposed API, `yieldRequested` latch, nudge system, and continuation loop that ralph-loop drew inspiration from?

---

## Findings

### 1. The `task_complete` Tool — Binary Completion Signal

Copilot's autopilot mode uses a single built-in tool called `task_complete` as its **sole completion signal**. The tool is gated behind permission level:

```ts
// agentIntent.ts:116
allowTools['task_complete'] = request.permissionLevel === 'autopilot';
```

The harness performs a **100% deterministic check** — no LLM-based heuristic, no classifier:

```ts
// toolCallingLoop.ts:345-356
protected shouldAutopilotContinue(result): string | undefined {
    if (this.taskCompleted) return undefined;  // STOP
    const calledTaskComplete = this.toolCallRounds.some(
        round => round.toolCalls.some(tc => tc.name === 'task_complete')
    );
    if (calledTaskComplete) { this.taskCompleted = true; return undefined; }
    if (this.autopilotIterationCount >= 5) return undefined;  // GIVE UP
    this.autopilotIterationCount++;
    return '<nudge text>';  // CONTINUE
}
```

### 2. The Nudge System — User Messages for Maximum Compliance

When the model attempts to stop without calling `task_complete`, the loop injects a **nudge as a user message** (not a system message). This is deliberate — user messages have the highest compliance rate with instruction-following models.

The nudge text (`toolCallingLoop.ts:367-378`) instructs the model to:
- Not repeat previous responses
- Stop planning and start implementing
- Not call `task_complete` prematurely (open questions, errors, remaining steps)
- Provide a text summary before calling `task_complete`

**Three-stage injection pipeline:**
1. Attach to the completed round: `result.round.hookContext = formatHookContext([autopilotContinue])`
2. On next iteration, inject as the query: `query = formatHookContext([this.stopHookReason])`
3. Rendered as `<UserMessage>` in prompt TSX

### 3. Self-Resetting Iteration Counter

The iteration counter (max 5) only counts **consecutive unproductive** nudges. If the model does real work after being nudged, the counter resets:

```ts
// toolCallingLoop.ts:827-829
if (this.autopilotStopHookActive && result.round.toolCalls.length
    && !result.round.toolCalls.some(tc => tc.name === 'task_complete')) {
    this.autopilotStopHookActive = false;
    this.autopilotIterationCount = 0;  // RESET
}
```

This means a productive model can theoretically run indefinitely (bounded only by the 200 tool-call hard cap).

### 4. The `ChatHookCommand` Proposed API

VS Code exposes a proposed API (`vscode.proposed.chatHooks.d.ts`) with 10 hook types:

```ts
type ChatHookType = 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit'
    | 'PreToolUse' | 'PostToolUse' | 'PreCompact'
    | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'ErrorOccurred';
```

Each `ChatHookCommand` is a shell command with `command`, `cwd`, `env`, and `timeout` fields. Hook results can be `'success'`, `'error'` (blocking — shown to model), or `'warning'` (non-blocking — shown to user only).

The **Stop hook** is the critical one for completion detection. It executes after the model tries to stop but **before** the autopilot internal check:

```
① Check cancellation → break
② Auto-retry transient errors (max 3)
③ Execute external Stop hooks → maybe continue
④ Autopilot internal check → task_complete? nudge? give up?
⑤ break
```

External stop hooks return `{ decision: 'block', reason: '...' }` to prevent stopping. The reason string is fed to the model via `formatHookContext()` as a user message.

### 5. The `yieldRequested` Latch

VS Code can signal a "yield request" — a graceful pause when the user types a new message. This is passed as a callback `() => boolean` through the options:

```ts
// toolCallingLoop.ts:87
yieldRequested?: () => boolean;
```

**In autopilot mode, yield requests are suppressed** unless `taskCompleted` is true:

```ts
// toolCallingLoop.ts:804-808
if (lastResult && this.options.yieldRequested?.()) {
    if (this.options.request.permissionLevel !== 'autopilot' || this.taskCompleted) {
        break;
    }
}
```

There is also a secondary yield check inside `runOne()` before sending a new request:

```ts
// toolCallingLoop.ts:1067-1069
if (iterationNumber > 0 && this.options.yieldRequested?.()) {
    throw new CancellationError();
}
```

### 6. Safety Guardrails Stack

| Guardrail | Limit | Behavior |
|---|---|---|
| Max nudge iterations | 5 (consecutive) | Stops if 5 nudges without productive work |
| Auto-retry on errors | 3 attempts | Retries transient errors; never rate-limit/quota |
| Tool call hard cap | 200 (auto-expand) | Silently expands limit by 50%, ceiling 200 |
| Yield suppression | boolean latch | Ignored in autopilot until task is done |

### 7. Three-Tier Stop Hook Architecture

| Priority | Hook Type | Controller |
|---|---|---|
| 1st | External Stop Hook | User-configured via `chat.hooks` setting |
| 2nd | Subagent Stop Hook | Parent agent's hook config |
| 3rd | Autopilot Internal Hook | Hardcoded in `toolCallingLoop.ts` |

The autopilot hook **reuses the same plumbing** as external hooks (same `hookContext`, `stopHookReason`, `formatHookContext` pipeline) but is not configurable.

---

## Patterns

### Pattern A: Deterministic Harness + Opaque Model Intelligence
All intelligence is pushed into the model via prompt engineering (nudge text). The harness itself is a simple state machine: did-tool-call-happen → yes/no. No embeddings, no classifiers, no "is-this-done?" heuristics.

### Pattern B: Self-Resetting Stall Detection
Counters track *consecutive* failures, not cumulative. Productive work resets stall detectors, enabling long-running tasks. Both Copilot (`autopilotIterationCount = 0`) and ralph-loop (`taskState.nudgeCount = 0`) implement this.

### Pattern C: Hook-as-User-Message Injection
Both systems format hook/nudge output as user messages rather than system messages. `formatHookContext()` wraps reasons in natural language: *"You were about to complete but a hook blocked you..."*

### Pattern D: External Stop Hooks for Verification Gates
The `ChatHookCommand` API allows external scripts to block completion. Ralph-loop's `generateStopHookScript()` generates a Node.js script that checks: PRD checkbox marked, progress.txt updated, TypeScript compiles, tests pass. If any check fails, it returns `{ resultKind: 'error', stopReason: '...' }`.

### Pattern E: Signal File IPC
Ralph-loop uses filesystem signal files for cross-process communication:
- `ralph-loop-chat-send.signal` — triggers chat message sends
- `ralph-loop-tool-activity.marker` — PostToolUse hook touches this to signal activity and reset inactivity timers

---

## Applicability

### Ralph-Loop's Direct Adaptations

| Copilot Concept | Ralph-Loop Equivalent | Adaptation |
|---|---|---|
| `task_complete` tool | PRD checkbox marking | Instead of a built-in tool, ralph checks for `- [x]` in PRD |
| `shouldAutopilotContinue()` | `shouldNudge()` in `decisions.ts` | Same binary check: completed or not |
| `MAX_AUTOPILOT_ITERATIONS = 5` | `maxNudgesPerTask` config | Configurable per-project instead of hardcoded |
| Self-resetting counter | `taskState.nudgeCount = 0` on file changes | Same pattern, triggered by diff detection not tool calls |
| `formatHookContext()` | `buildFinalNudgePrompt()` | Ralph builds a full prompt suffix instead of wrapping reasons |
| External Stop Hook | `generateStopHookScript()` | Ralph generates the actual stop hook scripts for Copilot to run |
| PostToolUse hook | `generatePostToolUseHookScript()` | Writes marker file to detect tool activity |
| `yieldRequested` suppression | Not directly adapted | Ralph uses its own `stopRequested` flag instead |
| Tool call hard cap (200) | Circuit breaker chain | More sophisticated: multiple breaker rules, skip/stop actions |

### Key Architectural Difference
Copilot's autopilot runs **inside** the tool-calling loop as a state flag. Ralph-loop runs **outside** Copilot as an orchestrator — it generates hook scripts that Copilot invokes, and uses the `chat.hooks` configuration API to register them. Ralph cannot modify the inner loop; it can only influence it through the hook boundary.

### What Ralph-Loop Adds Beyond Copilot
1. **Multi-task orchestration** — loops over multiple PRD checkboxes, not just one task
2. **Circuit breaker chain** — multiple rules (stagnation, nudge count, time limit) with skip/stop actions
3. **Diff-based productivity detection** — checks `git diff`, not just "did a tool call happen"
4. **Pre-compact hooks** — injects progress summary and git diff context before context compaction
5. **Stagnation detection** — tracks files unchanged across iterations  

---

## Open Questions

1. **Hook API stability**: `ChatHookCommand` is still a *proposed* API (`vscode.proposed.chatHooks.d.ts` version 6). How stable is this contract? Breaking changes would affect ralph-loop's hook bridge.

2. **Subagent hooks**: The API defines `SubagentStart` and `SubagentStop` hooks. Ralph-loop doesn't use these yet — could they enable more granular verification when Copilot delegates to subagents?

3. **PreCompact hook timing**: Ralph-loop registers a `PreCompact` hook to inject context before compaction. Is the timing guaranteed to fire before the context window is truncated, or is there a race condition?

4. **Nudge text evolution**: Copilot's nudge text is hardcoded in `toolCallingLoop.ts`. Ralph's `shouldNudge()` in `decisions.ts` uses simpler text. Would adopting Copilot's more detailed nudge instructions (especially the "don't call task_complete prematurely" guards) improve ralph's completion accuracy?

5. **Counter reset heuristic**: Copilot resets on any non-`task_complete` tool call. Ralph resets on file changes detected by diff. Which is more reliable? Tool calls can be unproductive (e.g., reading files without making changes), while diff detection has a latency window.

6. **200-cap auto-expansion**: Copilot auto-expands the tool call limit up to 200 in autopilot. Ralph has no equivalent — its circuit breakers enforce hard limits. Should ralph implement soft expansion for long tasks?
