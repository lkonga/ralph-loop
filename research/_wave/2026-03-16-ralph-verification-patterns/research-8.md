# Research Report: Shell Hook Provider & External Hook Integration

**Wave**: 2026-03-16-ralph-verification-patterns
**Report**: 8
**Question**: How does ralph-loop's shell hook provider and external hook integration enable user-authored quality gates — what is the stdin/stdout JSON protocol, exit code semantics, and how does `IRalphHookService` bridge in-process TS hooks with external scripts?

---

## Findings

### 1. `IRalphHookService` — The Unified Hook Interface

Defined in `src/types.ts` (lines ~505–512), `IRalphHookService` is the single abstraction for all hook invocations:

```typescript
interface IRalphHookService {
  onSessionStart(input: SessionStartInput): Promise<HookResult>;
  onPreCompact(input: PreCompactInput): Promise<HookResult>;
  onPostToolUse(input: PostToolUseInput): Promise<HookResult>;
  onPreComplete(input: PreCompleteInput): Promise<HookResult>;
  onTaskComplete(input: TaskCompleteInput): Promise<HookResult>;
}
```

There are **three concrete implementations**:

| Implementation | Location | Purpose |
|---|---|---|
| `NoOpHookService` | `src/orchestrator.ts` | Default pass-through; all methods return `{ action: 'continue' }` |
| `ShellHookProvider` | `src/shellHookProvider.ts` | Executes an external shell script per hook event |
| Hook Bridge (generated scripts) | `src/hookBridge.ts` | Generates Node.js scripts registered as VS Code `chat.hooks` |

The orchestrator accepts `hookService?: IRalphHookService` in its constructor. If none is provided, it falls back to `NoOpHookService`. The extension wires a `ShellHookProvider` when `config.hookScript` is set.

### 2. The stdin/stdout JSON Protocol

`ShellHookProvider.executeHook()` uses a clean subprocess protocol:

**Invocation**: `spawn(scriptPath, [hookType], { stdio: ['pipe', 'pipe', 'pipe'] })`
- The hook type string (e.g., `'SessionStart'`, `'PreCompact'`, `'PostToolUse'`, `'PreComplete'`, `'TaskComplete'`) is passed as the **first CLI argument**.
- The hook-specific input payload is serialized as JSON and written to **stdin**, then stdin is closed.

**Per-hook input payloads** (all serialized to stdin as JSON):

| Hook Type | Input Shape |
|---|---|
| `SessionStart` | `{ prdPath: string }` |
| `PreCompact` | `{ tokenCount: number; taskId: string }` |
| `PostToolUse` | `{ toolName: string; taskId: string; taskInvocationId?: string }` |
| `PreComplete` | `{ taskId: string; taskInvocationId: string; checksRun: VerifyCheck[]; prdPath: string; previousResults?: PreCompleteHookResult[] }` |
| `TaskComplete` | `{ taskId: string; result: 'success' | 'failure'; taskInvocationId?: string }` |

**Response**: The script writes a JSON `HookResult` to **stdout**:

```typescript
interface HookResult {
  action: 'continue' | 'retry' | 'skip' | 'stop';
  reason?: string;
  additionalContext?: string;
  chatSend?: ChatSendRequest;
  blocked?: boolean;
}
```

### 3. Exit Code Semantics

The `ShellHookProvider` interprets exit codes with a 3-tier scheme:

| Exit Code | Meaning | Behavior |
|---|---|---|
| **0** | Success/continue | Parse stdout as `HookResult` JSON if non-empty; otherwise return `{ action: 'continue' }` |
| **1** | Warning | Log stderr as warning, return `{ action: 'continue', reason: stderr }` |
| **2** | Block/stop | Log stderr, return `{ action: 'continue', blocked: true, reason: stderr }` |
| **Other** | Unexpected | Log warning, return `{ action: 'continue', reason: 'unexpected exit code N' }` |
| **Timeout (30s)** | Script hung | Kill process tree (SIGTERM→SIGKILL), return `{ action: 'continue', reason: 'timed out' }` |
| **spawn error** | Script missing/unexecutable | Log error, return `{ action: 'continue', reason: error.message }` |

Key design choice: **all error paths resolve to `action: 'continue'`**. Hooks never crash the loop — they degrade gracefully. The `blocked: true` flag on exit code 2 is the strongest signal, which the orchestrator can use to inject feedback context.

### 4. Security: Dangerous Pattern Pre-Gate

Before spawning, `ShellHookProvider` validates the script path with `containsDangerousChars()` against `DANGEROUS_PATTERNS = /&&|\|\||;|\||>|<|\`|\$\(|\$\{/`. If detected, the hook is **rejected immediately** without spawning, returning `{ action: 'continue', blocked: true, reason: 'shell metacharacters detected' }`.

This is defense-in-depth: the check runs before any process is spawned. The `blocked` flag feeds back to the orchestrator, which injects guidance like `"Shell command blocked: {reason}. Provide a safe alternative."` — enabling the AI agent to self-correct.

### 5. Process Kill: SIGTERM→SIGKILL Cascade

`killProcessTree(pid)` implements graceful termination:
1. Send `SIGTERM` first
2. After 1-second delay, send `SIGKILL`
3. On Windows, use `taskkill /PID {pid} /T /F` (tree kill with force)
4. All signals wrapped in try-catch for ESRCH (process already exited)

Applied in the 30-second timeout handler when hook scripts hang.

### 6. Hook Bridge — VS Code `chat.hooks` Integration

`src/hookBridge.ts` takes a different approach: it **generates** Node.js scripts at runtime and registers them via VS Code's `chat.hooks` configuration (proposed `chatHooks` API). This creates an event-driven integration where Copilot itself invokes hooks:

- **Stop hook** (`generateStopHookScript`): Runs PRD checkbox check, progress.txt freshness check, `npx tsc --noEmit`, and `npx vitest run`. If all pass → `{ resultKind: 'success' }` (Copilot stops). If any fail → `{ resultKind: 'error', stopReason: 'Verification failed: ...' }` (Copilot forced to continue).
- **PostToolUse hook** (`generatePostToolUseHookScript`): Writes a timestamp marker file so the extension can detect tool activity and reset inactivity timers.
- **PreCompact hook** (`generatePreCompactHookScript`): On context compaction, reads last N lines of progress.txt, optionally runs `git diff --stat`, and outputs a structured session resumption block in `additionalContext`.

The bridge uses a **different JSON protocol** from `ShellHookProvider` — it uses `resultKind: 'success' | 'error'` (Copilot chat hook format) rather than `action: 'continue' | 'stop'`.

### 7. `runPreCompleteChain` — Sequential Hook Chain

The orchestrator runs pre-complete hooks in sequence via `runPreCompleteChain()`:
1. Iterates enabled `PreCompleteHookConfig` entries in order
2. Passes accumulated `previousResults` to each hook
3. Short-circuits on `action: 'retry'` or `action: 'stop'`
4. Returns composite `{ action, results }` — the first non-continue action wins

### 8. ChatSend Signal File

`hookBridge.ts` also provides `startChatSendWatcher()` which watches a signal file at `$TMPDIR/ralph-loop-chat-send.signal`. Any external process (hooks, scripts, wave orchestrators) can write a JSON `ChatSendRequest` to this file, and the extension forwards it to the chat panel via a VS Code command. This enables hooks to **inject follow-up prompts** into the chat.

---

## Patterns

### P1: Fail-Open Hook Design
All hook error paths (timeout, spawn error, parse failure, unexpected exit codes) resolve to `{ action: 'continue' }`. Hooks never break the loop. This is a deliberate fail-open pattern — external quality gates add value when working but don't block progress when broken.

### P2: Dual Protocol — ShellHookProvider vs Hook Bridge
Two complementary hook systems exist:
- **ShellHookProvider**: User-authored scripts, stdin/stdout JSON, exit code semantics. Orchestrator-driven.
- **Hook Bridge**: Generated Node.js scripts, registered via `chat.hooks`, invoked by Copilot itself. Uses `resultKind` protocol.

### P3: Security Feedback Loop
Blocked commands don't silently fail — they return `blocked: true` with a reason string. The orchestrator injects this as context for the next iteration, enabling the AI agent to self-correct without human intervention.

### P4: Uniform Interface, Pluggable Implementation
`IRalphHookService` is the seam — the orchestrator doesn't know or care whether hooks are no-ops, shell scripts, or VS Code chat hooks. This enables testing with `NoOpHookService` and production use with `ShellHookProvider`.

### P5: Signal File as IPC
The `ChatSendRequest` signal file pattern enables unidirectional IPC from any external process (including hook scripts) back into the VS Code extension, without requiring direct API access.

---

## Applicability

### For VS Code Copilot Chat Extension

1. **Quality gate extensibility**: The `IRalphHookService` interface pattern could inform how VS Code agent mode exposes hook points for extensions — a uniform async interface with fail-open semantics and structured JSON results.

2. **Exit code conventions**: The 0/1/2 exit code scheme (success/warn/block) is a clean, language-agnostic protocol for external quality gates. Could be adopted for any `chat.hooks` script protocol.

3. **Security pre-gate pattern**: Validating script paths against dangerous shell patterns before spawning is directly applicable to any extension feature that executes user-configured commands.

4. **Graceful kill cascade**: The SIGTERM→SIGKILL with ESRCH handling is a production-ready pattern for any subprocess timeout scenario in VS Code extensions.

5. **Hook bridge as agentic proxy**: The pattern of generating verification scripts at runtime and registering them as `chat.hooks` demonstrates how extensions can create event-driven quality gates for Copilot agent mode without polling.

---

## Open Questions

1. **No `onPreCompact` in hook bridge?** The hook bridge generates and registers a PreCompact script only when `preCompactConfig.enabled` is true, but it uses a different format (`resultKind`/`stopReason`) than the `ShellHookProvider` (`action`/`reason`). Are these two protocols intentionally divergent, or is there a planned unification?

2. **Exit code 2 vs blocked flag**: Exit code 2 sets `blocked: true` but still returns `action: 'continue'`. The orchestrator must check both `blocked` and `action` to determine behavior. Should `action: 'stop'` be the exit-2 action instead, letting the chain decide whether to actually stop?

3. **Shell hook vs hook bridge concurrency**: Both systems can be active simultaneously (shell hook provider wired from `config.hookScript`, hook bridge from `features.useHookBridge`). Are there race conditions when both try to control the same hook lifecycle (e.g., both validate on task completion)?

4. **`additionalContext` propagation**: `HookResult.additionalContext` is defined but it's unclear from the orchestrator source how/where this context gets injected into the next prompt. The field exists in the type but the orchestrator.ts file doesn't show explicit handling (may be handled elsewhere or via the `pendingContext` mechanism).

5. **`chatSend` field in HookResult**: The `HookResult` includes an optional `chatSend?: ChatSendRequest` field. Is this an alternative to the signal file IPC for hooks to inject follow-up prompts? The `ShellHookProvider` passes through parsed JSON from stdout, so a hook script could include this field, but the consumption path isn't visible in the orchestrator.
