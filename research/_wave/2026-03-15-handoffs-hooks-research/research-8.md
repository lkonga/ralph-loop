# Research Report 8: Hook Integration in toolCallingLoop

## Findings

### Hook Types and Where They Fire

There are **5 hook families** in the agent loop. Three fire from `toolCallingLoop.ts` itself; two fire from the tool execution layer (`toolCalling.tsx`).

#### 1. SessionStart Hook — [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L411-L443)

- **Method**: `executeSessionStartHook()` (L411)
- **Called from**: `runStartHooks()` (L582) — only on the **first turn** of a non-subagent session
- **Input**: `{ source: 'new' }` (L625)
- **Flow control**: Additive only — collects `additionalContext` from hook outputs and stores in `this.additionalHookContext`. Errors with `ignoreErrors: true` are silently swallowed (L432).
- **Abort**: Throws `HookAbortError` if a hook sets `stopReason`, which propagates up and kills the session.

#### 2. SubagentStart Hook — [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L449-L487)

- **Method**: `executeSubagentStartHook()` (L449)
- **Called from**: `runStartHooks()` (L585-592) — when `request.subAgentInvocationId` is set
- **Input**: `{ agent_id, agent_type }`
- **Flow control**: Same as SessionStart — additive `additionalContext`, errors silently ignored.
- **Abort**: Same `HookAbortError` mechanism.

#### 3. Stop Hook — [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L271-L311)

- **Method**: `executeStopHook()` (L271)
- **Called from**: `_runLoop()` main while-loop (L862-876) — when the model produces **no tool calls** and response is not cancelled
- **Input**: `{ stop_hook_active: boolean }` — flag indicating if a prior stop hook already kept the loop running
- **Flow control**: **This is the critical flow-control hook.** If any hook output has `decision === 'block'` with a `reason`, the result is `{ shouldContinue: true, reasons }`. The loop then:
  1. Calls `showStopHookBlockedMessage()` to display the block reason in the chat stream (L319-328)
  2. Sets `this.stopHookReason` to the joined reasons
  3. Sets `result.round.hookContext` to `formatHookContext(reasons)` so the context survives across turns
  4. Sets `stopHookActive = true` and `this.stopHookUserInitiated = true`
  5. **Continues the while loop** (the model never actually stops)
- **On next iteration**: `createPromptContext()` (L218-227) detects `this.stopHookReason`, uses `formatHookContext()` to inject the blocking reasons as the user query, sets `isContinuation = true`, and clears `stopHookReason`.

#### 4. SubagentStop Hook — [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L496-L544)

- **Method**: `executeSubagentStopHook()` (L496)
- **Called from**: `_runLoop()` (L845-860) — only when `request.subAgentInvocationId` is set, before the regular Stop hook path
- **Input**: `{ agent_id, agent_type, stop_hook_active }`
- **Flow control**: Identical to Stop hook — blocks with `shouldContinue: true` and reasons, causes loop to continue.

#### 5. PreToolUse / PostToolUse Hooks — [toolCalling.tsx](../../../vscode-copilot-chat/src/extension/prompts/node/panel/toolCalling.tsx#L244-L530)

- **NOT in toolCallingLoop.ts** — these fire from the tool invocation layer in `toolCalling.tsx`
- **PreToolUse** (L244): `chatHookService.executePreToolUseHook()` — called **before** each individual tool invocation. Can:
  - Modify tool input (`updatedInput`)
  - Set `permissionDecision` (`allow`/`deny`/`ask`)
  - Provide `additionalContext` appended to tool result as `<PreToolUse-context>` tags
- **PostToolUse** (L496): `chatHookService.executePostToolUseHook()` — called **after** each tool execution. Can:
  - Block the tool result (`decision: 'block'`, adds `<PostToolUse-context>` with block reason)
  - Add `additionalContext` as `<PostToolUse-context>` tags appended to tool result
  - Skipped entirely if PreToolUse denied the tool (L492)

### Hook Execution Infrastructure

All hooks route through `IChatHookService.executeHook()` ([chatHookService.ts](../../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts#L36)) which:
- Takes `hookType`, the request's `hooks` config, input data, sessionId, and cancellation token
- Returns `HookResult[]` processed by `processHookResults()` ([hookResultProcessor.ts](../../../vscode-copilot-chat/src/extension/intents/node/hookResultProcessor.ts#L75-L140))

`processHookResults()` handles:
- **stopReason**: Throws `HookAbortError` (unless `ignoreErrors` set)
- **warnings**: Aggregated and displayed via `outputStream.hookProgress()`
- **errors**: Passed to `onError` callback (Stop/SubagentStop collect as blocking reasons) or throw `HookAbortError`
- **success**: Passed to `onSuccess` callback for hook-specific processing

### State Variables for Hook Flow Control

| Variable | Type | Purpose |
|---|---|---|
| `stopHookReason` | `string \| undefined` | Blocking reason from Stop/SubagentStop hook, injected as query on next iteration |
| `additionalHookContext` | `string \| undefined` | Context from Start hooks, passed into prompt via `IBuildPromptContext` |
| `stopHookUserInitiated` | `boolean` | Tracks if stop hook continuation was user-initiated |
| `stopHookActive` (local) | `boolean` | Flag passed to `stop_hook_active` input so hooks know they already blocked once |
| `autopilotStopHookActive` | `boolean` | Tracks if the autopilot internal stop hook is active |
| `taskCompleted` | `boolean` | Set when `task_complete` tool is called in autopilot mode |

### Call Sequence in `_runLoop()`

```
defaultIntentRequestHandler.ts:
  loop.runStartHooks()           → SessionStart OR SubagentStart
  executeHook('UserPromptSubmit')  → separate hook, not in toolCallingLoop
  loop.run()
    └─ _runLoop() while(true):
         runOne()                   → builds prompt, fetches, processes response
           └─ toolCalling.tsx:     → PreToolUse → tool execution → PostToolUse
         if no tool calls:
           if subagent:            → executeSubagentStopHook()
           else:                   → executeStopHook()
           if blocked:             → continue (sets stopHookReason)
           if autopilot:           → shouldAutopilotContinue() (internal stop hook)
           else:                   → break
```

### `formatHookContext()` — [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L146-L152)

Formats blocking reasons into a prompt message like:
- Single reason: `"You were about to complete but a hook blocked you with the following message: "{reason}". Please address this requirement before completing."`
- Multiple reasons: Numbered list with `"Please address all of these requirements before completing."`

This formatted string is both:
1. Set as `this.stopHookReason` → becomes the next turn's query
2. Set as `result.round.hookContext` → persisted on the round for transcript/history

## Patterns

1. **Dual-layer hook architecture**: Loop-level hooks (SessionStart, SubagentStart, Stop, SubagentStop) control session/agent lifecycle; tool-level hooks (PreToolUse, PostToolUse) control individual tool invocations. They're architecturally separate — loop hooks in `toolCallingLoop.ts`, tool hooks in `toolCalling.tsx`.

2. **Blocking-continue pattern**: Stop/SubagentStop hooks can block the agent from stopping by returning `{ decision: 'block', reason }`. The reason is fed back to the model as the next user query, creating a continuation loop where the model addresses the hook's requirements.

3. **Additive context injection**: Start hooks (SessionStart, SubagentStart) can only add context but never block. Their `additionalContext` is accumulated in `this.additionalHookContext` and passed to prompt building via `IBuildPromptContext.additionalHookContext`.

4. **Fail-safe error handling**: Start hooks use `ignoreErrors: true` (non-blocking); Stop hooks collect errors as blocking reasons via `onError` callback (errors become continuation reasons rather than crashes). Only `HookAbortError` propagates.

5. **Autopilot as internal stop hook**: The `shouldAutopilotContinue()` method (L345-395) acts as a built-in stop hook that nudges the model to call `task_complete`, with iteration limits as safety valves.

6. **Hook results surface in multiple ways**: Via `outputStream.hookProgress()` for UI display, via `stopHookReason` for model re-prompting, and via `round.hookContext` for transcript persistence.

## Applicability

**HIGH** — This is the definitive reference for how hooks integrate with the Copilot agent loop. Understanding this architecture is essential for:
- Building extensions that use `chat.hooks` (like ralph-loop's hook bridge)
- Understanding how the Stop hook creates continuation loops
- Knowing that PreToolUse/PostToolUse are NOT in `toolCallingLoop.ts` but in `toolCalling.tsx`
- Implementing custom subagent lifecycle hooks

## Open Questions

1. **PreCompact hook**: Listed in `ChatHookType` (`'PreCompact'`) but not called from `toolCallingLoop.ts` — where is it invoked? Likely in conversation history compaction logic.
2. **SessionEnd / ErrorOccurred hooks**: Listed in the proposed API type (`chatHooks.d.ts` L13) but no `execute` calls found in `toolCallingLoop.ts` — are they implemented elsewhere or planned?
3. **Hook ordering guarantees**: When multiple hooks are registered, does `executeHook()` run them in parallel or sequentially? The `processHookResults()` processes an array, suggesting they may run concurrently.
4. **`stop_hook_active` re-entrance**: When a Stop hook blocks and the loop continues, the next stop check passes `stop_hook_active: true`. Do hooks use this flag to avoid infinite blocking loops? The mechanism exists but hook implementations may or may not respect it.
5. **`appendAdditionalHookContext()`**: Public method on `ToolCallingLoop` (L171) — who calls it besides the internal start hook methods? Could external code inject hook context directly.
