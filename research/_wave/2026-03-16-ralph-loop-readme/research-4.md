## Research 4: Copilot Chat Integration

### Findings

Ralph-loop integrates with VS Code Copilot Chat through **three distinct layers**: direct VS Code command execution, a hook bridge system, and a file-based signal watcher for external processes.

#### Layer 1: Direct Command Execution (`src/copilot.ts`)

The primary integration is a **3-level fallback** strategy in `openCopilotWithPrompt()`:

1. **Agent Mode** (`workbench.action.chat.openEditSession`): Preferred path — opens a Copilot edit session with the prompt. When `useAutopilotMode` is enabled, passes `permissionLevel: 'autopilot'` via the `chatParticipantPrivate` proposed API.
2. **Chat Panel** (`workbench.action.chat.open`): Falls back to opening the chat panel with a `{ query: prompt }` argument.
3. **Clipboard**: Last resort — copies the prompt to the clipboard and logs a warning.

Session management uses `workbench.action.chat.newEditSession` (preferred) or `workbench.action.chat.newChat` as fallback via `startFreshChatSession()`.

A `sendReviewPrompt()` function builds a review prompt and sends it through the same fallback chain, optionally starting a new session first.

#### Layer 2: Execution Strategies (`src/strategies.ts`)

Two strategies implement `ITaskExecutionStrategy`:

- **`CopilotCommandStrategy`** (default, `executionStrategy: 'command'`): Calls `startFreshChatSession()` → `openCopilotWithPrompt()`, then enters a file-watcher polling loop:
  - Watches PRD.md via `vscode.workspace.createFileSystemWatcher` for checkbox changes
  - Watches all workspace files (`**/*`) for activity to reset the inactivity timer
  - Polls every 5 seconds calling `verifyTaskCompletion()` to check if the task's checkbox is marked
  - Resolves as completed when verification passes, or timed-out on inactivity

- **`DirectApiStrategy`** (placeholder, `executionStrategy: 'api'`): Throws — `chatProvider` proposed API is not yet available.

#### Layer 3: Hook Bridge (`src/hookBridge.ts`)

The hook bridge registers ralph-loop as a **Copilot chat hook provider** via VS Code's `chat.hooks` configuration:

- **Stop hook**: A generated Node.js script (`stop-hook.js`) that runs after the agent stops. Validates: PRD checkbox marked, progress.txt updated, `tsc --noEmit` passes, `vitest run` passes. Returns `{ resultKind: 'error', stopReason: ... }` to block premature stopping if checks fail.
- **PostToolUse hook**: Touches a marker file (`ralph-loop-tool-activity.marker`) in `/tmp` so the extension can detect tool activity and reset the inactivity timer.
- **PreCompact hook**: Injects session resumption context (progress summary + git diff + current task) when Copilot compacts context.

Scripts are generated at runtime, written to a temp directory, and registered in workspace `chat.hooks` settings. Cleanup removes scripts and unregisters hooks on dispose.

#### Layer 4: External Signal File (`src/hookBridge.ts` — `startChatSendWatcher`)

A filesystem watcher on `$TMPDIR/ralph-loop-chat-send.signal` enables **external processes** (wave orchestrators, hooks, etc.) to trigger chat interactions without VS Code API access:

1. External process writes a JSON `ChatSendRequest` to the signal file
2. The watcher parses it and fires `ralph-loop.chatSend` command
3. The command switches chat mode via `workbench.action.chat.toggleAgentMode` with `{ modeId, sessionResource }`
4. Optionally types and submits a query via `type` + `workbench.action.chat.submit`

The `ChatSendRequest` interface: `{ query: string; mode?: 'agent'|'ask'|'edit'; isPartialQuery?: boolean; sessionId?: string }`.

#### Session Tracking (`src/extension.ts`)

When `useSessionTracking` is enabled, polls `vscode.window.activeChatPanelSessionResource` (proposed API) every 2 seconds. If the session URI changes while the loop is running, the loop pauses and emits a `SessionChanged` event.

#### Prompt Construction (`src/prompt.ts`)

Prompts are built with structured sections:
- **Task description** (sanitized: control chars stripped, `<prompt>` tags removed, triple backticks escaped, 5000 char limit)
- **Role & Behavior** block: "You are an autonomous coding agent..."
- **TDD Gate**: Mandatory test-first workflow
- **Search-Before-Implement Gate**: Prevents accidental duplication
- **Spec Reference Gate**: Forces reading spec files when referenced
- **Capabilities** (hooks, validators, model hints)
- **Learnings** from knowledge manager
- **Operator context** (injected mid-loop by the user)
- **Context trimming** tiers: Full (iterations 1-3), Abbreviated (4-8), Minimal (9+) — progressively reduces context to manage token budget
- **Context budget annotation**: Adds `[Context budget: ~N% utilized]` header when approaching token limits

#### Autopilot Mode

When `useAutopilotMode` is enabled in config, `openCopilotWithPrompt()` passes `permissionLevel: 'autopilot'` on the chat request arguments. This leverages the `chatParticipantPrivate` proposed API to grant the agent elevated permissions.

### Patterns

1. **Graceful Degradation**: The 3-level fallback (agent → chat → clipboard) ensures the prompt always reaches the user/agent even if APIs are unavailable.

2. **File-Watcher Completion Detection**: Instead of an API callback, completion is detected by watching PRD.md for checkbox changes and workspace files for activity — a robust pattern when no direct completion API exists.

3. **Signal File IPC**: The `/tmp/ralph-loop-chat-send.signal` pattern enables any process to drive VS Code's chat panel without API access — useful for orchestrators running outside VS Code's extension host.

4. **Generated Hook Scripts**: Hook scripts are Node.js programs generated at runtime from templates with embedded paths, written to temp files, and registered via `chat.hooks` config. This avoids shipping separate scripts and keeps paths dynamic.

5. **Inactivity-Based Timeout**: The agent is presumed stuck if no file changes occur within `inactivityTimeoutMs`. The PostToolUse hook marker resets this timer, preventing false timeouts during long tool operations.

6. **Context Budget Management**: Token estimation (`length / 3.5`), tiered context trimming by iteration number, and an annotation mode that prepends budget warnings to the prompt.

### Applicability

- The VS Code command-based approach (`workbench.action.chat.*`) is the **only viable integration** since the `chatProvider` proposed API is not available. The `DirectApiStrategy` stub confirms this is a known limitation.
- The hook bridge (`chat.hooks`) is gated behind `useHookBridge` feature flag and requires the `chatHooks` proposed API — making it available only in VS Code Insiders with the right API enablement.
- The signal file watcher is always active (registered in `activate()`) regardless of loop state, enabling external control at all times.
- Autopilot mode (`permissionLevel: 'autopilot'`) depends on `chatParticipantPrivate` proposed API — gracefully falls back if unavailable.

### Open Questions

1. **chatProvider API timeline**: `DirectApiStrategy` is a stub. When will the `chatProvider` proposed API be available, and what will it enable over the command-based approach?
2. **Session tracking reliability**: Polling `activeChatPanelSessionResource` every 2 seconds is a workaround for no change event. Is there a proposed API for session change notifications?
3. **Hook script security**: Generated hook scripts run `npx tsc --noEmit` and `npx vitest run` with 120-second timeouts. In adversarial PRD scenarios, could a malicious task description influence hook script behavior? (The scripts don't consume task descriptions directly, so likely safe.)
4. **Autopilot permission scope**: What exactly does `permissionLevel: 'autopilot'` grant beyond the default? The code sets it but doesn't document the behavioral difference.
5. **Race conditions in signal file**: The signal file is read → parsed → cleared in sequence. If two writes happen between reads, the first is lost. Is this acceptable for the expected use case?
6. **`type` command reliability**: The `chatSend` command uses `vscode.commands.executeCommand('type', { text: query })` to input text. This simulates typing into the focused editor/input. Is this reliable across different VS Code versions and states?
