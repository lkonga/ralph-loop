# Q11: VS Code Hook Lifecycle and Validation Patterns

## Findings

### Complete Hook Event Inventory

The canonical `ChatHookType` union (from `vscode.proposed.chatHooks.d.ts`):

```typescript
type ChatHookType = 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit'
  | 'PreToolUse' | 'PostToolUse' | 'PreCompact'
  | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'ErrorOccurred';
```

The hooksCommand wizard (`hooksCommand.ts`) further defines these additional events for the Claude SDK mapping:

| Event | Category | Matcher? | Stdin Schema |
|-------|----------|----------|-------------|
| `PreToolUse` | Tool-based | Yes (tool name) | `{ tool_name, tool_input, tool_use_id }` |
| `PostToolUse` | Tool-based | Yes | `{ tool_name, tool_input, tool_response, tool_use_id }` |
| `PostToolUseFailure` | Tool-based | Yes | `{ tool_name, tool_input, error, is_interrupt }` |
| `PermissionRequest` | Tool-based | Yes | `{ tool_name, tool_input, permission_suggestions[] }` |
| `UserPromptSubmit` | Lifecycle | No | `{ prompt }` |
| `Stop` | Lifecycle | No | `{ stop_hook_active }` |
| `SubagentStart` | Lifecycle | No | `{ agent_id, agent_type }` |
| `SubagentStop` | Lifecycle | No | `{ agent_id, agent_type, stop_hook_active }` |
| `PreCompact` | Lifecycle | No | `{ trigger, custom_instructions? }` |
| `SessionStart` | Lifecycle | No | `{ source }` |
| `SessionEnd` | Lifecycle | No | `{ reason }` |
| `Notification` | Lifecycle | No | `{ message, notification_type, title }` |

### Hook Execution I/O Contract

**Process spawning** (`hookExecutor.ts` — `NodeHookExecutor`):

1. **Spawn**: `child_process.spawn(command, [], { stdio: 'pipe', shell: true, cwd, env })`
2. **Stdin**: JSON-serialized input is written to stdin, then `stdin.end()`. Common fields are merged into every hook input:
   ```json
   {
     "timestamp": "ISO-8601",
     "hook_event_name": "Stop",
     "session_id": "...",
     "transcript_path": "/path/to/transcript.jsonl",
     "cwd": "/workspace/path",
     ...event-specific fields
   }
   ```
3. **Stdout**: Parsed as JSON if valid, otherwise kept as raw string.
4. **Exit code semantics**:
   - `0` → `HookCommandResultKind.Success` — stdout parsed as JSON
   - `2` → `HookCommandResultKind.Error` — blocking error, stderr shown to model
   - Other non-zero → `HookCommandResultKind.NonBlockingError` — warning shown to user only
5. **Timeout**: Default 30s (`DEFAULT_TIMEOUT_SEC`), configurable via `hook.timeout`. SIGTERM first, then SIGKILL after 5s.
6. **Cancellation**: Honors VS Code `CancellationToken` via SIGTERM→SIGKILL escalation.

### Stdout JSON Response Schema

The `_toHookResult` method in `chatHookService.ts` processes stdout JSON with these fields:

```typescript
// Common response fields (top-level)
{
  "continue": boolean,        // false → stopReason="" (implicit stop)
  "stopReason": string,       // explicit stop reason
  "systemMessage": string,    // warning shown to user
  "hookEventName": string,    // event routing — mismatched names are filtered out

  // Hook-specific output (nested)
  "hookSpecificOutput": {
    "hookEventName": string,  // secondary routing filter
    "additionalContext": string,  // injected into agent context
    "permissionDecision": "allow" | "deny" | "ask",  // PreToolUse only
    "permissionDecisionReason": string,  // PreToolUse only
    "updatedInput": object,   // PreToolUse only — modified tool input
  },

  // Stop/SubagentStop specific (top-level)
  "decision": "block",        // blocks agent from stopping
  "reason": string,           // why the agent should continue
}
```

### Per-Event Response Contracts

**Stop hook** (`StopHookOutput`):
- `decision: "block"` + `reason` → agent continues with reason injected as user message
- Empty/no output → agent stops normally

**UserPromptSubmit** (`UserPromptSubmitHookOutput`):
- `decision: "block"` → blocks prompt submission
- `hookSpecificOutput.additionalContext` → injected into agent context

**SessionStart** (`SessionStartHookOutput`):
- `hookSpecificOutput.additionalContext` → injected as initial context
- Errors silently ignored (`ignoreErrors: true`)

**SubagentStart** (`SubagentStartHookOutput`):
- `hookSpecificOutput.additionalContext` → injected into subagent context

**SubagentStop** (`SubagentStopHookOutput`):
- `decision: "block"` + `reason` → subagent continues

**PreToolUse** (collapsed via `executePreToolUseHook`):
- Multiple hooks collapsed: `deny > ask > allow` (most restrictive wins)
- `updatedInput` validated against tool's JSON schema before use
- Exit code 2 → automatic deny
- `additionalContext` collected from all hooks

**PostToolUse** (collapsed via `executePostToolUseHook`):
- `decision: "block"` → first block wins
- Exit code 2 → automatic block
- `additionalContext` collected from all hooks

### Hook Resolution and Loading

Hooks come from `request.hooks` (`ChatRequestHooks`), which is a `Record<ChatHookType, ChatHookCommand[]>` resolved by VS Code core before reaching the extension. The settings are stored in:
- `.vscode/settings.json` (workspace local)
- Workspace settings (shared)
- User settings (global)
- Agent `.agent.md` frontmatter `hooks:` field

### Result Processing Pipeline

`processHookResults()` in `hookResultProcessor.ts`:
1. Check `stopReason` → throws `HookAbortError` (unless `ignoreErrors`)
2. Collect `warningMessage` entries
3. Route `success` results to `onSuccess` callback
4. Route `error` results to `onError` callback (or throw `HookAbortError`)
5. Warnings displayed via `hookProgress()` on the response stream

### Stop Hook Continuation Flow

In `toolCallingLoop.ts`:
1. Agent signals completion → `executeStopHook()` called
2. All Stop hooks run; blocking reasons collected via `onError` callback
3. If any hook returns `decision: "block"`, `shouldContinue: true` with reasons
4. Reasons formatted via `formatHookContext()` and injected as the next user message
5. `stop_hook_active: true` flag set for re-entry detection (prevents infinite loops)
6. Autopilot mode has separate `MAX_AUTOPILOT_ITERATIONS` (5) safety valve

## Patterns

### Soft Enforcement (Context Injection)
- **SessionStart / SubagentStart**: Inject `additionalContext` — the agent sees extra instructions but isn't blocked. Used by `wave-subagent-start.py` to inject parallel dispatch rules.
- **PreToolUse `additionalContext`**: Extra context added to the tool call without blocking it.
- **systemMessage field**: Warning shown to user, not to agent — purely informational.

### Hard Enforcement (Completion Blocking)
- **Stop hook `decision: "block"`**: Prevents agent from stopping; reason becomes the next prompt. Used by `wave-orchestrator-stop.py` to validate artifacts before completion.
- **PreToolUse `permissionDecision: "deny"`**: Blocks tool execution entirely.
- **Exit code 2**: Universal blocking signal across all hook types.
- **SubagentStop `decision: "block"`**: Prevents subagent from completing.
- **`stopReason` field**: Throws `HookAbortError`, immediately halts the entire request.

### Multi-Hook Collapsing
- PreToolUse: Most restrictive decision wins (`deny > ask > allow`)
- PostToolUse: First block wins
- Stop/SubagentStop: All blocking reasons collected into a set, all presented to agent
- Context: All `additionalContext` values concatenated

### hookEventName Routing
A single hook script can emit responses for multiple event types. The `hookEventName` field acts as a filter:
- Top-level mismatch → entire result ignored
- Nested (in `hookSpecificOutput`) mismatch → `hookSpecificOutput` stripped, rest preserved

## Applicability

### Enhanced Stop Hook Patterns for Wave

1. **Structural validation** (current `wave-orchestrator-stop.py`): Check file counts, minimum sizes, required sections. Return `decision: "block"` with specific deficiency.

2. **Multi-stage validation**: Check `stop_hook_active` to distinguish first-pass vs re-entry. On first pass, do full validation. On re-entry, only check the specific deficiency that was reported.

3. **Aggregate stop hooks** (current `wave-aggregate-stop.py`): Verify FINAL-REPORT.md exists before letting aggregator complete.

4. **Context injection via SubagentStart**: Pre-load rules into each subagent type. No blocking — pure context shaping.

5. **PreToolUse guard rails**: Could block specific tool calls (e.g., prevent `create_file` when the target already exists) by matching tool name patterns.

6. **Transcript-aware validation**: Hooks receive `transcript_path` — can read the full conversation to detect patterns like repeated failures, unused tools, or missing verification steps.

7. **Chained hook scripts**: Multiple hooks per event type run sequentially. First hook returning `stopReason` stops remaining hooks from executing.

## Open Questions

1. **SessionEnd and Notification hooks**: Defined in the `HOOK_EVENTS` wizard but have no corresponding typed Input/Output interfaces in `chatHookService.ts`. Implementation status unclear — may be stub-only.

2. **ErrorOccurred hook**: Listed in `ChatHookType` union but not found in `HOOK_EVENTS` wizard or any execution path. Possibly planned but unimplemented.

3. **PostToolUseFailure and PermissionRequest**: Present in wizard UI but no corresponding execution code found in `chatHookService.ts` or `toolCallingLoop.ts`. May be Claude SDK forward-compatibility stubs.

4. **Timeout behavior**: Default 30s with SIGTERM→SIGKILL. No per-event-type timeout customization — all hooks share the same default. Long-running validation hooks could hit this.

5. **No retry on hook failure**: A hook that crashes (non-zero, non-2 exit code) produces a non-blocking warning. There's no retry mechanism — the hook simply fails silently.

6. **Agent-scoped hook resolution**: The exact mechanism for loading hooks from `.agent.md` frontmatter `hooks:` field is in VS Code core (not in the extension). The extension only sees pre-resolved `ChatRequestHooks`.

7. **Hook ordering**: Multiple hooks for the same event run sequentially in array order. No priority mechanism exists — order depends on settings file discovery order.

8. **No PreCompact output schema**: `PreCompactHookInput` is defined but no corresponding output type exists. The hook runs but its output may not be consumed.
