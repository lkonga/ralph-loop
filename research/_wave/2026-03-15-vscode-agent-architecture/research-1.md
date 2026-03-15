# Q1: VS Code Hook Lifecycle and Enhanced Validation Patterns

## Findings

### Two Distinct Hook Systems

The VS Code Copilot Chat extension implements **two coexisting hook systems** for the Claude Agent SDK integration:

#### 1. Internal Registry Hooks (TypeScript, in-process)

Located in `src/extension/chatSessions/claude/`:

- **Registry**: [`common/claudeHookRegistry.ts`](../../src/extension/chatSessions/claude/common/claudeHookRegistry.ts) — a global `ClaudeHookRegistryType` map from `HookEvent` → `IClaudeHookHandlerCtor[]`
- **Registration**: `registerClaudeHook(hookEvent, ctor)` called at module load time via side-effect imports
- **Instantiation**: `buildHooksFromRegistry(instantiationService)` creates instances with full DI, called in [`claudeCodeAgent.ts`](../../src/extension/chatSessions/claude/node/claudeCodeAgent.ts) `_buildHooks()`
- **Pattern**: Each hook class implements `HookCallbackMatcher` with a `hooks: HookCallback[]` array
- **Return type**: `HookJSONOutput` — `{ continue: true }` to proceed, or structured output to block/modify

Files that register hooks via self-registration imports:
| File | Events |
|------|--------|
| `node/hooks/loggingHooks.ts` | Notification, UserPromptSubmit, **Stop**, PreCompact, PermissionRequest |
| `node/hooks/sessionHooks.ts` | SessionStart, SessionEnd |
| `node/hooks/subagentHooks.ts` | SubagentStart, SubagentStop |
| `node/hooks/toolHooks.ts` | PreToolUse, PostToolUse, PostToolUseFailure + PlanModeHook |

All current internal hooks are **logging-only** — they return `{ continue: true }` and trace to `ILogService`.

#### 2. Shell/External Hooks (user-configured, out-of-process)

Configured via VS Code settings JSON (`.vscode/settings.json`, user settings, or workspace settings). The `/hooks` slash command (`hooksCommand.ts`) provides a wizard UI.

**13 Hook Events** defined in `hooksCommand.ts`:

| Event | Type | Matcher | JSON Schema (stdin) | Exit Codes |
|-------|------|---------|---------------------|------------|
| `PreToolUse` | Tool | Yes (tool name) | `{ tool_name, tool_input }` | 0=allow, 2=block |
| `PostToolUse` | Tool | Yes | `{ tool_name, tool_input, tool_response }` | — |
| `PostToolUseFailure` | Tool | Yes | `{ tool_name, tool_input, error, is_interrupt }` | — |
| `PermissionRequest` | Tool | Yes | `{ tool_name, tool_input, permission_suggestions }` | 0=allow, 2=deny |
| `UserPromptSubmit` | Lifecycle | No | `{ prompt }` | 0=allow, 2=block |
| **`Stop`** | Lifecycle | No | `{ stop_hook_active }` | — |
| `SubagentStart` | Lifecycle | No | `{ agent_id, agent_type }` | — |
| `SubagentStop` | Lifecycle | No | `{ agent_id, agent_transcript_path, stop_hook_active }` | — |
| `PreCompact` | Lifecycle | No | `{ trigger, custom_instructions }` | — |
| `SessionStart` | Lifecycle | No | `{ source }` | — |
| `SessionEnd` | Lifecycle | No | `{ reason }` | — |
| `Notification` | Lifecycle | No | `{ message, notification_type, title }` | — |

### Hook I/O Contract (Shell Hooks)

**Input**: JSON on stdin with event-specific fields plus common fields (`cwd`, `session_id`, `stop_hook_active`)

**Output**: JSON on stdout. Key response fields:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "decision": "block",          // "block" prevents the action
    "reason": "human-readable why",
    "additionalContext": "injected into model context"
  },
  "systemMessage": "informational message to model"
}
```

**Exit codes** (tool hooks only): `0` = allow, `2` = block with stderr fed to model

### Stop Hook Lifecycle

1. Agent completes its task and signals stop
2. SDK checks `stop_hook_active` — if `true`, it's a recursive stop (hook calling stop), so hooks return `{}` immediately to prevent infinite loops
3. Stop hooks receive `{ stop_hook_active: boolean, cwd, session_id }` on stdin
4. Hook can:
   - Return `{}` → allow stop (no-op)
   - Return `{ hookSpecificOutput: { decision: "block", reason: "..." } }` → **block the stop**, reason is fed back to the model as context, forcing it to continue work
   - Return `{ systemMessage: "..." }` → allow stop but inject a message

## Patterns

### Pattern 1: Artifact-Gated Stop (wave-orchestrator-stop.py)
Block agent completion unless required files exist. Checks filesystem for `research-*.md` and `FINAL-REPORT.md` in the latest wave directory. Short-circuits for modes without expected artifacts.

### Pattern 2: Single-File Gate Stop (wave-aggregate-stop.py)
Simpler variant — blocks unless one specific file (`FINAL-REPORT.md`) exists. Clean separation of concerns from the orchestrator hook.

### Pattern 3: Context Injection on Subagent Spawn (wave-subagent-start.py)
Uses `SubagentStart` hook to inject role-specific guardrails via `additionalContext` based on `agent_type`. Maps agent types to prescriptive instructions (e.g., forcing parallel dispatch for research agents).

### Pattern 4: Recursive Stop Guard
All stop hooks check `data.get("stop_hook_active", False)` first — if truthy, return `{}` immediately. This prevents infinite loops where a blocked stop triggers another stop event.

### Pattern 5: Registry + Runtime Composition (claudeCodeAgent.ts)
`_buildHooks()` merges registry hooks with runtime edit-tracking hooks:
```
registry hooks (DI-created) + edit tool hooks (inline lambdas) → combined config
```

## Applicability

### For wave-explore-fast
- **Stop hooks are the primary enforcement mechanism**: A stop hook can verify that the research output file was actually written before allowing the agent to complete
- **SubagentStart hooks inject context**: Can inject search strategy hints, file path constraints, or output format requirements per agent type
- **Pattern**: `wave-explore-fast` could use a lightweight stop hook that checks for the existence of the target `research-N.md` file

### For ralph-loop
- Ralph already has its own `IRalphHookService` with `ShellHookProvider` that mirrors this architecture
- Ralph's `HookResult.action` values (`continue | retry | skip | stop`) are richer than VS Code's binary allow/block
- The `PreCompleteHookResult` chain in `runPreCompleteChain()` is ralph-loop's equivalent of stop hooks
- Ralph could adopt the `hookSpecificOutput.additionalContext` pattern to inject dynamic instructions into the model context at hook points

### Key Difference
VS Code hooks are **boolean gates** (allow/block via exit code or `decision`). Ralph hooks are **action-driven** with retry semantics. Ralph's approach is more expressive but requires the orchestrator to handle retry logic.

## Open Questions

1. **Shell hook timeout behavior**: VS Code SDK timeout for shell hooks is not documented in the wizard UI. Ralph uses 30s (`SHELL_HOOK_TIMEOUT_MS`). What does the Claude Agent SDK use?
2. **Hook ordering**: When multiple hooks register for the same event (e.g., multiple `PreToolUse` hooks), what's the execution order? Registry order? All must pass?
3. **Stop hook re-entry depth**: If a blocked stop causes the agent to do more work and stop again, can stop hooks block indefinitely? Is there a max retry count in the SDK?
4. **Matcher syntax**: The `matcher` field supports glob-like patterns (e.g., `"Bash"`, `"*"`, `"Edit|MultiEdit"`). Exact syntax and semantics need SDK documentation review.
5. **`systemMessage` vs `additionalContext`**: Both inject text to the model but at different levels. Need to clarify which one persists across turns vs. is ephemeral.
