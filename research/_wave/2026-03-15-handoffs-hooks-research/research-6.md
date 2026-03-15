## Research Report 6: Hook Executor Protocol

### Findings

#### Interface & Types (`common/hookExecutor.ts`)

The interface is defined in [src/platform/chat/common/hookExecutor.ts](src/platform/chat/common/hookExecutor.ts):

- **Service identifier**: `IHookExecutor` registered via `createServiceIdentifier`
- **Result enum** `HookCommandResultKind` (lines 11–17):
  ```ts
  Success = 1,        // exit code 0
  Error = 2,          // exit code 2 — blocking error shown to model
  NonBlockingError = 3 // other non-zero exit codes — shown to user only
  ```
- **Result interface** `IHookCommandResult` (lines 19–27):
  - `kind: HookCommandResultKind`
  - `result: string | object` — stdout parsed as JSON on success, stderr on error

#### Spawn Protocol (`node/hookExecutor.ts`)

Implementation in [src/platform/chat/node/hookExecutor.ts](src/platform/chat/node/hookExecutor.ts):

**Process spawning** (lines 53–59):
```ts
const child = spawn(hook.command, [], {
    stdio: 'pipe',
    cwd,                                    // hook.cwd or homedir()
    env: { ...process.env, ...hook.env },   // merges custom env vars
    shell: getShell(),                      // true on Linux/macOS, powershell.exe on Windows
});
```

**stdin protocol** (lines 107–118):
- Input is serialized via `JSON.stringify(input, replacer)` and written to stdin
- A custom replacer converts URI-like objects (`{ scheme, path }`) to filesystem paths via `uriToFsPath()`
- `stdin.end()` is always called after writing (or immediately if no input)
- stdin write errors are silently caught

**stdout/stderr collection** (lines 90–91):
- `child.stdout.on('data')` → pushed to `stdout[]` array
- `child.stderr.on('data')` → pushed to `stderr[]` array
- ANSI escape codes are stripped from stderr via `removeAnsiEscapeCodes()`

**Exit code semantics** (lines 133–156):
| Exit Code | Result Kind | Output Source |
|-----------|------------|---------------|
| 0 | `Success` | stdout (parsed as JSON if valid, else raw string) |
| 2 | `Error` (blocking — shown to model) | stderr |
| other non-zero | `NonBlockingError` (warning — user only) | stderr |

**JSON parsing** (lines 137–146): On exit code 0, stdout is attempted as `JSON.parse()`. If it fails, the raw string is kept and a warning is logged. Empty stdout returns `''`.

#### Timeout & Cancellation

**Constants** (lines 17–18):
```ts
const SIGKILL_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_SEC = 30;
```

**Timeout mechanism** (line 96):
```ts
const timeoutTimer = setTimeout(
    () => killWithEscalation('timeout'),
    (hook.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000
);
```
- Default timeout: **30 seconds**
- Custom timeout: `hook.timeout` (in seconds) from `ChatHookCommand.timeout`

**Cancellation** (lines 99–101):
- Listens on `token.onCancellationRequested`
- Triggers same `killWithEscalation('cancelled')` path

**Kill escalation** (lines 72–81):
1. First sends `SIGTERM`
2. After 5 seconds (`SIGKILL_DELAY_MS`), sends `SIGKILL` if process hasn't exited

#### Error Handling

**Spawn failures** (lines 36–46 in `executeCommand`):
- Caught in try/catch around `_spawn()`
- Returned as `NonBlockingError` (not blocking, just a warning)
- Logged to both `ILogService` and `IHooksOutputChannel`

**Process errors** (lines 158–161):
- `child.on('error')` rejects the promise → caught by outer try/catch → `NonBlockingError`

**Timeout/cancel logging** (lines 122–130):
- Timeout: logged as warning with duration
- Cancellation: logged to output channel

#### ChatHookCommand Shape (`vscode.proposed.chatHooks.d.ts`)

From [src/extension/vscode.proposed.chatHooks.d.ts](src/extension/vscode.proposed.chatHooks.d.ts):
```ts
interface ChatHookCommand {
    readonly command: string;      // shell command, already platform-resolved
    readonly cwd?: Uri;            // working directory
    readonly env?: Record<string, string>;  // additional env vars
    readonly timeout?: number;     // max execution time in seconds
}
```

**Hook types**: `'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'ErrorOccurred'`

#### Consumption (`chatHookService.ts`)

The `ChatHookService` in [src/extension/chat/vscode-node/chatHookService.ts](src/extension/chat/vscode-node/chatHookService.ts):
- Iterates `hookCommands` sequentially (not parallel)
- Enriches input with common fields: `timestamp`, `hook_event_name`, `session_id`, `transcript_path`, `cwd`
- Flushes session transcript before running hooks (with 500ms timeout)
- Converts `IHookCommandResult` to `vscode.ChatHookResult` with `resultKind: 'success' | 'error' | 'warning'`
- Supports `stopReason` to halt remaining hooks in the chain
- Redacts `toolArgs` and `tool_input` keys from logged input
- Reports telemetry: hook type, count, elapsed, error/exception flags

#### Test Coverage (`hookExecutor.spec.ts`)

From [src/platform/chat/test/node/hookExecutor.spec.ts](src/platform/chat/test/node/hookExecutor.spec.ts) — 10 test cases covering:
- String and JSON stdout parsing on exit 0
- Empty output handling
- Exit code 1 → `NonBlockingError`, exit code 2 → `Error`
- JSON input written to stdin, stdin skipped when undefined
- URI-to-path conversion in JSON replacer
- Custom env and cwd passthrough
- Spawn error (`ENOENT`) → `NonBlockingError`
- Cancellation → `SIGTERM`
- Timeout → `SIGTERM` after configured seconds

### Patterns

1. **Stdin/stdout JSON protocol**: Write JSON to stdin, read JSON (or string) from stdout. This is a clean CLI-tool integration pattern — any language can implement a hook by reading stdin JSON and writing stdout JSON.

2. **Exit code semantics as severity levels**: Exit 0 = success, exit 2 = blocking error (model sees it), other = warning (user-only). The exit code 2 convention is unusual but deliberate — it distinguishes "stop the agent" errors from "informational" failures.

3. **Graceful kill escalation**: SIGTERM → wait 5s → SIGKILL. Standard graceful shutdown pattern.

4. **Service injection**: `IHookExecutor` is a service identifier injected via VS Code's `IInstantiationService` DI system, registered as `NodeHookExecutor` in `services.ts`.

5. **URI normalization in JSON**: Custom `JSON.stringify` replacer converts URI-like objects to filesystem paths before sending to hooks. This shields hook scripts from needing to understand VS Code's URI format.

6. **Sequential hook execution with early stop**: Hooks for a given type run sequentially. A hook can set `stopReason` to abort remaining hooks — useful for deny/allow gates (e.g., PreToolUse).

### Applicability

**HIGH** — This is directly relevant for understanding how external hook scripts integrate with the Copilot Chat agent loop. Key takeaways for ralph-loop:

- The stdin JSON / stdout JSON / exit-code protocol is simple and language-agnostic
- The input envelope (timestamp, hook_event_name, session_id, transcript_path, tool info) provides rich context to hook scripts
- The 3-tier exit code system (0/2/other) provides nuanced flow control
- The timeout + cancellation + kill escalation pattern is production-grade
- Hook execution is sequential with early-stop capability — not parallel

### Open Questions

1. **Where are hooks configured?** The `ChatRequestHooks` object is passed into `executeHook()` — need to trace where it's constructed (likely from `.copilot/hooks/` or similar user configuration).
2. **What input shapes exist per hook type?** The `hookCommandTypes.ts` file defines `IPreToolUseHookCommandInput`, `IPostToolUseHookCommandInput` etc. — these weren't fully explored.
3. **How does `_toHookResult` map blocking errors to flow control?** The remaining lines of `chatHookService.ts` (after line 180) detail how `Error` results translate to deny/stop behaviors per hook type.
4. **Is there a web implementation?** Only `NodeHookExecutor` was found — hooks appear to be Node-only (no web worker equivalent), which makes sense since they spawn shell processes.
