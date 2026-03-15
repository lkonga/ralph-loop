## Research Report 9: Hooks Slash Command and Output Channel

### Findings

#### 1. `/hooks` Slash Command — `hooksCommand.ts`

**File**: `src/extension/chatSessions/claude/vscode-node/slashCommands/hooksCommand.ts` (~935 lines)

The `/hooks` command is a full **configuration wizard** for Claude Code hooks, registered as `HooksSlashCommand` with:
- `commandName = 'hooks'`
- `commandId = 'copilot.claude.hooks'` (also available via Command Palette)
- Self-registers via `registerClaudeSlashCommand(HooksSlashCommand)` (L935)

**Supported hook events** (L56–133, `HOOK_EVENTS` array):

| Event ID | Category | Matcher? | Description |
|---|---|---|---|
| `PreToolUse` | Tool-based | Yes | Before tool execution. Exit 0=allow, Exit 2=block. |
| `PostToolUse` | Tool-based | Yes | After tool completes successfully. |
| `PostToolUseFailure` | Tool-based | Yes | After tool fails or is interrupted. |
| `PermissionRequest` | Tool-based | Yes | Custom permission handling. Exit 0=allow, Exit 2=deny. |
| `UserPromptSubmit` | Lifecycle | No | When user submits a prompt. |
| `Stop` | Lifecycle | No | When agent execution stops. |
| `SubagentStart` | Lifecycle | No | When a subagent is initialized. |
| `SubagentStop` | Lifecycle | No | When a subagent completes. |
| `PreCompact` | Lifecycle | No | Before conversation compaction. |
| `SessionStart` | Lifecycle | No | When a session is initialized. |
| `SessionEnd` | Lifecycle | No | When a session terminates. |
| `Notification` | Lifecycle | No | When agent status messages are sent. |

**Two distinct wizard flows** (documented L18–44):

- **CREATE flow**: Select event → enter new matcher pattern → enter hook command → choose save location (Workspace local/shared/User) → file opens at hook position.
- **EDIT flow**: Select event → pick existing matcher (grouped by settings file) → pick existing hook or add new → command is saved back to original settings file.

**Settings storage** (L696–717, `_selectSaveLocation`):
- `{workspace}/.claude/settings.local.json` — workspace-local, gitignored
- `{workspace}/.claude/settings.json` — workspace-shared, committed
- `~/.claude/settings.json` — user-global

Settings are JSON with shape: `{ hooks: { [HookEventId]: [{ matcher, hooks: [{ type: "command", command }] }] } }`

**Key services injected** (L226–230):
- `IWorkspaceService` — for workspace folder enumeration
- `IFileSystemService` — for reading/writing settings JSON files
- `INativeEnvService` — for user home directory
- `ILogService` — error/warn logging

**Multi-root workspace support**: Each workspace folder gets its own local+shared settings pair; matchers are grouped by location label in the QuickPick.

#### 2. Hooks Output Channel — `hooksOutputChannel.ts`

**Interface** — `src/platform/chat/common/hooksOutputChannel.ts` (L1–17):
```ts
export const IHooksOutputChannel = createServiceIdentifier<IHooksOutputChannel>('IHooksOutputChannel');
export interface IHooksOutputChannel {
    readonly _serviceBrand: undefined;
    appendLine(message: string): void;
}
```
Minimal interface: single `appendLine` method. Registered as a DI service identifier.

**Implementation** — `src/extension/chat/vscode-node/hooksOutputChannel.ts` (L1–21):
```ts
export class HooksOutputChannel implements IHooksOutputChannel {
    private _channel: LogOutputChannel | undefined;
    appendLine(message: string): void {
        if (!this._channel) {
            this._channel = window.createOutputChannel('GitHub Copilot Chat Hooks', { log: true });
        }
        this._channel.info(message);
    }
}
```
- Uses **lazy initialization** — the VS Code LogOutputChannel is only created on first use.
- Channel name: `"GitHub Copilot Chat Hooks"`
- Uses `{ log: true }` — a `LogOutputChannel`, which provides structured log levels and timestamps.
- All messages go through `.info()` level.

**DI registration** — `src/extension/extension/vscode-node/services.ts` L222:
```ts
builder.define(IHooksOutputChannel, new SyncDescriptor(HooksOutputChannel));
```

#### 3. Consumers of `IHooksOutputChannel`

**`NodeHookExecutor`** (`src/platform/chat/node/hookExecutor.ts`):
Injects `IHooksOutputChannel` and logs:
- Spawn failures: `"Hook command failed to start: {command}: {error}"` (L42)
- Timeouts: `"Hook command timed out after {N}s: {command}"` (L127)
- Cancellations: `"Hook command was cancelled: {command}"` (L129)
- Non-JSON output warnings: `"Hook command returned non-JSON output: {command}"` (L143)

**`ChatHookService`** (`src/extension/chat/vscode-node/chatHookService.ts`):
Higher-level orchestrator that logs per-request:
- `[#N] [hookType] Executing M hook(s)` (L122)
- `[#N] [hookType] Running: {hookCommand}` (L129)
- `[#N] [hookType] Input: {redactedInput}` (L131) — `toolArgs`/`tool_input` are redacted
- `[#N] [hookType] Completed (Success|NonBlockingError|Error) in Nms` (L67–71)
- `[#N] [hookType] Output: {result}` (on non-empty output)
- `[#N] [hookType] Stopping: {reason}` (when hook stops chain)
- `[#N] [hookType] Error: {message}` (caught exceptions)

The `_log` helper (L49) formats all messages as `[#requestId] [hookType] message`.

### Patterns

1. **Service Interface + Lazy Implementation**: `IHooksOutputChannel` lives in `platform/chat/common/` (no VS Code dependency), while `HooksOutputChannel` in `extension/chat/vscode-node/` uses VS Code APIs. Classic platform/extension split enabling testability.

2. **Self-Registration Pattern**: `registerClaudeSlashCommand(HooksSlashCommand)` at module scope — handlers register themselves on import, collected by registry.

3. **Source-Tracking Edits**: `MatcherWithSource` and `HookWithSource` track which settings file each config came from, enabling edit-in-place without re-asking the user where to save.

4. **Structured Log Channel**: Using `LogOutputChannel` (`{ log: true }`) instead of plain `OutputChannel` gives timestamps and log levels for free.

5. **Request Counter Pattern**: `ChatHookService._requestCounter` assigns monotonically increasing IDs to correlate multi-line log entries for a single hook execution.

6. **Input Redaction**: `chatHookService._redactForLogging` strips `toolArgs` and `tool_input` from logged input to avoid leaking sensitive data.

7. **Exit Code Convention** (from Claude Code SDK): `0` = success/allow, `2` = blocking error/deny, other non-zero = non-blocking warning.

### Applicability

**HIGH** — These files demonstrate the complete hooks subsystem surface area:
- The `/hooks` slash command is the primary user-facing entry point for hook configuration.
- `IHooksOutputChannel` is the debug/observability surface for all hook activity.
- Together they form the end-to-end lifecycle: configure hooks via wizard → hooks execute at runtime → activity observable in Output panel under "GitHub Copilot Chat Hooks".
- The patterns (lazy output channel, source-tracking, self-registration) are directly reusable for any similar hook/plugin configuration system.

### Open Questions

1. **No delete/disable flow**: The `/hooks` wizard supports create and edit but no apparent delete or disable mechanism — users would need to manually edit the JSON files.
2. **No output channel for the slash command itself**: `HooksSlashCommand` logs errors via `ILogService` but doesn't write to the hooks output channel — the channel only captures runtime hook execution, not configuration wizard activity.
3. **Log level fixed at `.info()`**: All output channel messages use `.info()` regardless of severity (timeouts, errors, success all go through `info`). The `ILogService` separately handles `warn`/`error` but those don't appear in the user-facing hooks channel at appropriate levels.
4. **Lifecycle hook matchers**: For lifecycle hooks, matcher is hardcoded to `"*"` — unclear if the SDK supports finer-grained matching for these event types.
5. **Test coverage for slash command**: `hookExecutor.spec.ts` exists but no corresponding test file for `hooksCommand.ts` was found.
