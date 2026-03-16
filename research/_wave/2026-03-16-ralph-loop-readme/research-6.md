## Research 6: Git Operations & Hook Bridge

### Findings

#### 1. Git Operations (`src/gitOps.ts`)

The git subsystem provides **atomic, per-task commits** as the core state-durability mechanism. Three exported functions compose the workflow:

- **`runGit(workspaceRoot, args)`** — Internal helper that wraps `child_process.execFile('git', ...)` with a 10 MB output buffer. Returns `{ stdout, stderr, err }` without throwing, so callers handle errors explicitly.

- **`inferCommitType(description)`** — Regex-based classifier (`/\b(fix|bug|debug|patch|repair|resolve|hotfix|error|crash|broken|issue|handle)\b/i`). Returns `'fix'` or `'feat'` for conventional commit prefixes.

- **`buildCommitMessage(task, taskInvocationId, changedFiles, testSummary?)`** — Generates conventional-commit messages: `feat(Task-001): truncated-description` (subject capped at 72 chars), followed by a body containing the full description, `Task-Invocation-Id` trailer, changed file list, and optional test results.

- **`atomicCommit(workspaceRoot, task, taskInvocationId)`** — The main entry point. Five-step process:
  1. **Guard checks**: Rejects if `.git/rebase-merge`, `.git/rebase-apply`, `.git/MERGE_HEAD`, or `.git/CHERRY_PICK_HEAD` exist (prevents commits during conflicting git states).
  2. **`git add -A`**: Stages all changes.
  3. **`git diff --cached --name-only`**: Determines changed files. Returns early if empty.
  4. **`git commit -m <message> --no-verify`**: Commits with `--no-verify` to skip user git hooks (ralph has its own hook system).
  5. **`git rev-parse HEAD`**: Captures the commit hash for event tracking.

Returns `CommitResult { success, commitHash?, error? }`.

#### 2. Commit Integration in the Orchestrator (`src/orchestrator.ts`)

`atomicCommit` is imported at line 50 and used in two paths:

- **Single-task path** (lines ~970-980): After dual exit gate passes, confidence scoring passes, PreComplete hook chain passes, TaskComplete hook passes, and optional review-after-execute passes, `atomicCommit` is called. On success, it appends the commit hash to `progress.txt` and emits `LoopEventKind.TaskCommitted`.

- **Parallel-task path** (lines ~540-555): Inside `Promise.all()` for concurrent task batches, `atomicCommit` runs per-task after completion detection. Same event emission pattern.

The ordering is significant: commit happens **after** all verification gates and hooks but **before** the cooldown countdown, ensuring only verified work is committed.

#### 3. Hook Bridge System (`src/hookBridge.ts`)

The hook bridge integrates ralph-loop with VS Code's proposed `chatHooks` API by generating temporary Node.js scripts and registering them in workspace configuration.

**Architecture:**
- At activation, if `config.features.useHookBridge` is `true`, `registerHookBridge()` is called.
- It creates a temp directory (`ralph-hook-*`) and writes three scripts:
  - **`stop-hook.js`** (Stop/PreComplete): Runs a 4-check verification gate:
    1. PRD checkbox marked
    2. `progress.txt` recently updated (within 5 min)
    3. TypeScript compilation (`npx tsc --noEmit`)
    4. Test pass (`npx vitest run`)
    Returns `{ resultKind: 'error', stopReason: ... }` on failure or `{ resultKind: 'success' }` on pass.
  - **`post-tool-use-hook.js`**: Writes a timestamp to a marker file (`ralph-loop-tool-activity.marker` in `$TMPDIR`). The extension watches this file to detect tool activity and reset inactivity timers.
  - **`pre-compact-hook.js`** (optional, gated by `preCompactBehavior.enabled`): Generates a session resumption context block by reading the last N lines of `progress.txt`, running `git diff --stat` / `git diff --name-only`, and finding the current unchecked PRD task. Returns this as `additionalContext` in the hook result so the LLM retains state across context compaction.

**Registration:** Scripts are registered via `vscode.workspace.getConfiguration('chat').update('hooks', ...)` as `{ command: process.execPath, args: [scriptPath] }` entries for `Stop`, `PostToolUse`, and optionally `PreCompact`.

**Cleanup:** `dispose()` removes temp files, closes the marker watcher, and deletes hook entries from config.

**ChatSend Signal Watcher:** `startChatSendWatcher()` watches a file at `$TMPDIR/ralph-loop-chat-send.signal`. Any process can write a JSON `ChatSendRequest` to this path, and the extension forwards it to the chat panel via `ralph-loop.chatSend` command. This enables external scripts/hooks to trigger chat interactions.

#### 4. Shell Hook Provider (`src/shellHookProvider.ts`)

An alternative to the hook bridge, for running a **user-provided** shell script as the hook backend.

**Security:**
- **`DANGEROUS_PATTERNS`** regex blocks shell metacharacters (`&&`, `||`, `;`, `|`, `>`, `<`, `` ` ``, `$(`, `${`) in the script path before any execution. If detected, the hook returns `{ action: 'continue', blocked: true, reason }`.
- **`killProcessTree(pid)`**: Cross-platform process termination — `taskkill /T /F` on Windows, `SIGTERM` then `SIGKILL` (after 1s) on Unix.

**Execution model:**
- Spawns `scriptPath` with `hookType` as the first argument (e.g., `SessionStart`, `PreComplete`).
- Writes hook input as JSON to the child's stdin.
- Reads JSON `HookResult` from stdout.
- 30-second timeout with process tree kill on expiry.
- Exit code protocol:
  - `0`: Success — parse stdout as `HookResult` if valid JSON, otherwise `{ action: 'continue' }`.
  - `1`: Warning — log stderr, continue.
  - `2`: Block — returns `{ action: 'continue', blocked: true, reason }`.

#### 5. Hook Lifecycle in the Orchestrator

The orchestrator uses `IRalphHookService` (no-op by default, or `ShellHookProvider` if `config.hookScript` is set):

| Hook Point | When | Can Block/Stop | Purpose |
|---|---|---|---|
| `onSessionStart` | Before loop begins | Yes (stop) | Initialize session, inject context |
| `onPreCompact` | (via chatHooks API) | No | Inject resumption context at compaction |
| `onPostToolUse` | (via chatHooks API) | No | Track tool activity for inactivity timer |
| `onPreComplete` | After verification passes, before commit | Yes (retry/stop) | Final quality gate chain |
| `onTaskComplete` | After commit (success or failure) | Yes (retry/stop) | Post-task actions, context injection |

The `PreComplete` hooks run as a **chain** (`runPreCompleteChain`): multiple hooks execute sequentially, each receiving previous results. Any hook returning `retry` or `stop` short-circuits the chain.

### Patterns

1. **Git-as-ground-truth**: Every verified task completion produces an atomic git commit with structured metadata (conventional commits, task invocation IDs, changed file lists). This provides rollback points and audit trails.

2. **Defense-in-depth security**: Shell hook scripts are protected by dangerous-character rejection, process timeouts with tree kills, and stdin/stdout isolation (no shell expansion).

3. **Dual integration strategy**: The hook bridge uses VS Code's proposed `chatHooks` API for deep integration (Stop, PostToolUse, PreCompact), while `ShellHookProvider` offers a portable script-based alternative. Both implement the same `IRalphHookService` interface.

4. **File-based IPC**: The chatSend signal watcher and tool-activity marker use filesystem watching for cross-process communication — simple, debuggable, and dependency-free.

5. **Generated scripts**: Hook bridge scripts are generated at runtime with embedded paths (PRD, progress) and configuration values, avoiding the need for environment variables or config file discovery in the hook scripts.

6. **Commit after all gates**: The commit is the last durable action after dual exit gate → confidence scoring → pre-complete hook chain → task-complete hook → optional review. This ensures only fully-verified work enters the git history.

### Applicability

- The git operations module is self-contained and reusable — it depends only on `child_process`, `fs`, `path`, and the `Task` type.
- The hook bridge is tightly coupled to VS Code's proposed `chatHooks` API and the extension activation lifecycle.
- The `ShellHookProvider` is portable and could be adapted for non-VS Code contexts (CLI, CI).
- The file-based IPC pattern (signal files + `fs.watch`) is a pragmatic choice for single-machine setups but would need replacement for distributed scenarios.

### Open Questions

1. **`--no-verify` on commit**: The `atomicCommit` function uses `--no-verify`, bypassing user-configured git hooks entirely. Is this intentional to avoid conflicts with ralph's own hook system, or should there be an opt-in for running standard git hooks?

2. **Parallel commit safety**: In the parallel task path, multiple `atomicCommit` calls run concurrently via `Promise.all`. Since each does `git add -A` → `commit`, concurrent commits could race on the staging area. Is there a locking mechanism planned?

3. **Hook bridge API stability**: The hook bridge depends on `vscode.proposed.chatHooks`, which is gated behind a try/catch. What's the fallback behavior when this API is unavailable — do hooks silently degrade to no-ops?

4. **PreCompact hook and git diff**: The generated pre-compact script runs `git diff --stat` via `execSync` in the hook script. In long sessions, this could be slow for large repos. Is there a caching or debouncing strategy?

5. **ChatSend signal file security**: The signal file at a predictable `$TMPDIR` path accepts JSON commands from any process. Could a malicious local process inject commands into the chat panel?
