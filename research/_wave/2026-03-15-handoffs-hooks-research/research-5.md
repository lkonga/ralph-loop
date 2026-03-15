# Research Report 5: VS Code Hook Type Taxonomy

## Findings

### 1. Canonical `ChatHookType` (VS Code Proposed API)

**File**: [src/extension/vscode.proposed.chatHooks.d.ts](../../../vscode-copilot-chat/src/extension/vscode.proposed.chatHooks.d.ts#L13) (version 6)

```typescript
export type ChatHookType = 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit'
  | 'PreToolUse' | 'PostToolUse' | 'PreCompact'
  | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'ErrorOccurred';
```

**10 hook types total.** This is the VS Code extension's authoritative type.

### 2. Claude Agent SDK `HookEvent` (Superset)

**File**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:407`

```typescript
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'Notification' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd'
  | 'Stop' | 'SubagentStart' | 'SubagentStop' | 'PreCompact'
  | 'PermissionRequest' | 'Setup' | 'TeammateIdle' | 'TaskCompleted'
  | 'Elicitation' | 'ElicitationResult' | 'ConfigChange'
  | 'WorktreeCreate' | 'WorktreeRemove';
```

**20 hook events total** — a strict superset of `ChatHookType` with 10 additional SDK-only events.

### 3. HOOK_EVENTS Wizard (UI-exposed subset)

**File**: [src/extension/chatSessions/claude/vscode-node/slashCommands/hooksCommand.ts](../../../vscode-copilot-chat/src/extension/chatSessions/claude/vscode-node/slashCommands/hooksCommand.ts#L57-L148)

The `/hooks` slash command wizard exposes **13 hook events** organized in two categories:

| Category | Hook ID | Needs Matcher | JSON Input Schema |
|----------|---------|:---:|---|
| **Tool-based** | `PreToolUse` | ✓ | `{ tool_name, tool_input }` |
| | `PostToolUse` | ✓ | `{ tool_name, tool_input, tool_response }` |
| | `PostToolUseFailure` | ✓ | `{ tool_name, tool_input, error, is_interrupt }` |
| | `PermissionRequest` | ✓ | `{ tool_name, tool_input, permission_suggestions }` |
| **Lifecycle** | `UserPromptSubmit` | ✗ | `{ prompt }` |
| | `Stop` | ✗ | `{ stop_hook_active }` |
| | `SubagentStart` | ✗ | `{ agent_id, agent_type }` |
| | `SubagentStop` | ✗ | `{ agent_id, agent_transcript_path, stop_hook_active }` |
| | `PreCompact` | ✗ | `{ trigger, custom_instructions }` |
| | `SessionStart` | ✗ | `{ source }` |
| | `SessionEnd` | ✗ | `{ reason }` |
| | `Notification` | ✗ | `{ message, notification_type, title }` |

### 4. Test Shim (Reduced subset)

**File**: [src/util/common/test/shims/chatTypes.ts](../../../vscode-copilot-chat/src/util/common/test/shims/chatTypes.ts#L63)

```typescript
export type ChatHookType = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse'
  | 'PostToolUse' | 'SubagentStart' | 'SubagentStop' | 'Stop';
```

**7 types** — omits `SessionEnd`, `PreCompact`, `ErrorOccurred`. This is used only in unit test shims.

### 5. Typed Input/Output Interfaces

**File**: [src/platform/chat/common/hookCommandTypes.ts](../../../vscode-copilot-chat/src/platform/chat/common/hookCommandTypes.ts) (complete file, 58 lines)

Only **2 hook types** have typed interfaces in this file:

| Hook | Input Interface | Output Interface |
|------|----------------|-----------------|
| `PreToolUse` | `IPreToolUseHookCommandInput` | `IPreToolUseHookSpecificCommandOutput` |
| `PostToolUse` | `IPostToolUseHookCommandInput` | `IPostToolUseHookSpecificCommandOutput` |

**File**: [src/platform/chat/common/chatHookService.ts](../../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts#L85-L280) — additional typed interfaces:

| Hook | Input Interface | Output Interface |
|------|----------------|-----------------|
| `UserPromptSubmit` | `UserPromptSubmitHookInput` | `UserPromptSubmitHookOutput` |
| `Stop` | `StopHookInput` | `StopHookOutput` |
| `SessionStart` | `SessionStartHookInput` | `SessionStartHookOutput` |
| `SubagentStart` | `SubagentStartHookInput` | `SubagentStartHookOutput` |
| `SubagentStop` | `SubagentStopHookInput` | `SubagentStopHookOutput` |
| `PreCompact` | `PreCompactHookInput` | *(no output interface)* |

### 6. Collapsed Result Types (Service Layer)

**File**: [src/platform/chat/common/chatHookService.ts](../../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts#L78-L93)

```typescript
export interface IPreToolUseHookResult {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: object;
  additionalContext?: string[];
}

export interface IPostToolUseHookResult {
  decision?: 'block';
  reason?: string;
  additionalContext?: string[];
}
```

Only PreToolUse and PostToolUse have dedicated collapsed result types. Other hooks use the generic `ChatHookResult` from the proposed API.

### 7. Execution Infrastructure

**File**: [src/platform/chat/common/hookExecutor.ts](../../../vscode-copilot-chat/src/platform/chat/common/hookExecutor.ts)

- `HookCommandResultKind` enum: `Success(1)`, `Error(2)`, `NonBlockingError(3)`
- Exit code semantics: 0=success, 2=blocking error (shown to model), other=non-blocking warning (shown to user only)
- `IHookExecutor.executeCommand()` — runs a single shell command, writes JSON to stdin, captures stdout/stderr.

**File**: [src/extension/intents/node/hookResultProcessor.ts](../../../vscode-copilot-chat/src/extension/intents/node/hookResultProcessor.ts)

- `HookAbortError` — thrown when a hook requests abort (has `hookType` and `stopReason`)
- `processHookResults()` — generic processor that handles stop/warn/error/success for any hook type
- `ignoreErrors` flag for `SessionStart`/`SubagentStart` (silently swallow blocking errors)
- `onError` callback for `Stop`/`SubagentStop` (collect errors as blocking reasons)

### 8. Production Invocation Sites

| Hook Type | Invocation Site | Notes |
|-----------|----------------|-------|
| `SessionStart` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L413) | `ignoreErrors: true` |
| `SubagentStart` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L456) | `ignoreErrors: true` |
| `SubagentStop` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L499) | `onError` collects blocking reasons |
| `Stop` | [toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L273) | `onError` collects blocking reasons |
| `UserPromptSubmit` | [defaultIntentRequestHandler.ts](../../../vscode-copilot-chat/src/extension/prompt/node/defaultIntentRequestHandler.ts#L367) | Runs after start hooks |
| `PreToolUse` | via `executePreToolUseHook()` in `IChatHookService` | Dedicated method with permission collapsing |
| `PostToolUse` | via `executePostToolUseHook()` in `IChatHookService` | Dedicated method with block collapsing |
| `SessionEnd` | Not found in extension code | Only in Claude SDK hooks registration |
| `PreCompact` | Only in Claude SDK hooks | Via `registerClaudeHook('PreCompact', ...)` |
| `ErrorOccurred` | **Not implemented** | Listed in type but no execution path found |

### 9. Claude Hook Registry (Side-effect Registration)

**File**: [src/extension/chatSessions/claude/common/claudeHookRegistry.ts](../../../vscode-copilot-chat/src/extension/chatSessions/claude/common/claudeHookRegistry.ts)

Registered hooks (all logging-only in current codebase):

| File | Registered Events |
|------|------------------|
| `toolHooks.ts` | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` + `PlanModeHook` on `PostToolUse` |
| `subagentHooks.ts` | `SubagentStart`, `SubagentStop` |
| `sessionHooks.ts` | `SessionStart`, `SessionEnd` |
| `loggingHooks.ts` | `Notification`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PermissionRequest` |

### 10. Common Output Contract

All hook commands share a common JSON stdout protocol:

```json
{
  "hookEventName": "string",           // routing filter — mismatched names are skipped
  "hookSpecificOutput": { ... },        // hook-type-specific fields
  "continue": true,                     // flow control (Claude SDK specific)
  "decision": "allow|deny|ask|block"    // permission/blocking decision
}
```

Top-level `stopReason` and `warningMessage` are extracted by the `ChatHookResult` wrapper in the proposed API layer.

## Patterns

1. **Layered type taxonomy**: `ChatHookType` (10, VS Code API) ⊂ HOOK_EVENTS wizard (13) ⊂ `HookEvent` (20, Claude SDK). Each layer adds events relevant to its scope.

2. **Tool-based vs Lifecycle split**: Tool hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`) use matchers to filter by tool name. Lifecycle hooks fire unconditionally.

3. **Permission collapsing**: `PreToolUse` results from multiple hooks collapsed via "most restrictive wins" (deny > ask > allow). `PostToolUse` uses "any block wins."

4. **Error handling strategy varies by hook**: `SessionStart`/`SubagentStart` silently ignore errors (`ignoreErrors: true`). `Stop`/`SubagentStop` collect errors as blocking reasons (`onError` callback). Other hooks throw `HookAbortError`.

5. **hookEventName routing**: A single hook script can respond to multiple event types. The `hookEventName` field in output acts as a secondary filter — if it doesn't match the current hook type, the result is discarded.

6. **Shell command protocol**: JSON stdin → shell process → JSON stdout. Exit codes: 0=success, 2=blocking error, other=warning. Default 30s timeout with SIGTERM→SIGKILL.

## Applicability

**HIGH** — The hook type taxonomy is directly relevant to ralph-loop's `IRalphHookService` design. The three-layer type hierarchy (VS Code API → wizard → SDK) and the distinct error handling strategies per hook category are critical for correct implementation. The `hookCommandTypes.ts` file is intentionally minimal (only PreToolUse/PostToolUse) because most typed interfaces live in `chatHookService.ts`.

## Open Questions

1. **`ErrorOccurred` hook**: Listed in `ChatHookType` but has no execution path, no typed interfaces, and no Claude SDK registration. Is it planned/experimental or dead code?

2. **`SessionEnd` in extension layer**: Registered in Claude hook registry but not invoked via `executeHook()` in the extension's tool calling loop. Is it only used by the Claude SDK's internal lifecycle?

3. **Test shim drift**: The test shim `ChatHookType` omits `SessionEnd`, `PreCompact`, and `ErrorOccurred`. This may cause test blind spots for these hook types.

4. **`PreCompact` output**: Has a typed input interface (`PreCompactHookInput`) but no corresponding output interface. Does it use the generic `ChatHookResult` or is output simply ignored?

5. **SDK-only events** (`Setup`, `TeammateIdle`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`): These exist in the Claude SDK type but have no corresponding VS Code API type or wizard entry. Are any of these planned for VS Code integration?
