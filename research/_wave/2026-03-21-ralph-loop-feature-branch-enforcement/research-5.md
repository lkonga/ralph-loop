# Research Report #5: Hook System Analysis & Branch Creation as Hook

**Wave**: 2026-03-21-ralph-loop-feature-branch-enforcement
**Question**: What hook system exists today (`IRalphHookService`, `hookBridge.ts`, shell hooks) and could branch creation be implemented as a hook rather than core logic?

---

## 1. Hook System Architecture Overview

Ralph-loop has a **dual-layer hook system**: an internal `IRalphHookService` interface with shell-script execution, and a VS Code `chat.hooks` bridge that registers Node.js scripts at the Copilot Chat API level.

### 1.1 `IRalphHookService` Interface (`src/types.ts:650`)

The central hook contract defines five lifecycle hook points:

| Hook Type | Input Type | When Fired | Purpose |
|-----------|-----------|------------|---------|
| `SessionStart` | `SessionStartInput` (`{ prdPath }`) | Before first task iteration | Session initialization, context injection |
| `PreCompact` | `PreCompactInput` (`{ tokenCount, taskId }`) | Before context compaction | Inject resumption context (progress, git diff) |
| `PostToolUse` | `PostToolUseInput` (`{ toolName, taskId, taskInvocationId? }`) | After any tool is used | Activity tracking, timer resets |
| `PreComplete` | `PreCompleteInput` (`{ taskId, taskInvocationId, checksRun, prdPath, previousResults? }`) | After verifiers pass, before marking task done | Validation gates (PRD checkbox, progress update) |
| `TaskComplete` | `TaskCompleteInput` (`{ taskId, result: 'success'\|'failure', taskInvocationId? }`) | After task is marked complete or failed | Post-completion operations, context injection |

The `RalphHookType` union type is: `'SessionStart' | 'PreCompact' | 'PostToolUse' | 'PreComplete' | 'TaskComplete'`

### 1.2 HookResult Return Type

Every hook returns `HookResult`:

```typescript
interface HookResult {
  action: 'continue' | 'retry' | 'skip' | 'stop';
  reason?: string;
  additionalContext?: string;
  chatSend?: ChatSendRequest;
  blocked?: boolean;
}
```

**Key actions**:
- `continue`: proceed normally; if `additionalContext` is set, it's injected into the next prompt
- `retry`: re-enter the current task (used by `PreComplete` chain)
- `stop`: halt the loop entirely
- `skip`: move to next task
- `blocked`: signals the command was unsafe; injects a safe-alternative suggestion into context

### 1.3 `ShellHookProvider` (`src/shellHookProvider.ts`)

The concrete `IRalphHookService` implementation that executes an external shell script:

- Configured via `config.hookScript` (path to an executable)
- Spawns the script with hook type as argv[1], sends input as JSON to stdin
- Parses stdout as JSON `HookResult` on exit code 0
- Exit code semantics: 0=success, 1=warning (continue), 2=blocked (continue with blocked flag)
- **30-second timeout** with process tree kill (`SIGTERM` → 1s → `SIGKILL`)
- **Security**: Rejects scripts containing shell metacharacters (`&&`, `||`, `;`, `|`, `>`, `<`, backticks, `$()`, `${}`) before execution

### 1.4 `hookBridge.ts` — VS Code Chat Hooks Integration

A second hook layer that registers with the VS Code `chat.hooks` proposed API:

- Generates temporary Node.js scripts for `Stop`, `PostToolUse`, and `PreCompact` hooks
- Writes them to tmpdir and registers via `vscode.workspace.getConfiguration('chat').update('hooks', ...)`
- **Stop hook** (`generateStopHookScript`): Full verification gate — PRD checkbox check, progress.txt mtime, TypeScript compilation, and vitest run
- **PostToolUse hook** (`generatePostToolUseHookScript`): Touches a marker file to track tool activity
- **PreCompact hook** (`generatePreCompactHookScript`): Injects session resumption context (progress last N lines, git diff stat, current task)
- Gated behind `config.features.useHookBridge` flag (default: `false`)
- The `startChatSendWatcher` provides a file-based IPC channel: any process can write a `ChatSendRequest` to `/tmp/ralph-loop-chat-send.signal` and the extension forwards it to the chat panel

### 1.5 `NoOpHookService` (`src/orchestrator.ts:220`)

Default implementation used when no `hookScript` is configured — all five methods return `{ action: 'continue' }`.

### 1.6 PreComplete Hook Chain

The orchestrator runs a **chain pattern** for PreComplete hooks (`runPreCompleteChain`):
- Iterates through `config.preCompleteHooks[]` (array of `PreCompleteHookConfig`)
- Each hook sees previous results via `previousResults` field
- Chain short-circuits on `retry` or `stop` actions
- Default hooks: `prd-checkbox-check` and `progress-updated` (both builtin)
- Supports types: `builtin`, `shell`, `custom`

### 1.7 Hook Invocation Points in Orchestrator

From `src/orchestrator.ts`:

1. **Line ~572**: `onSessionStart({ prdPath })` — before first iteration; can inject context or stop loop
2. **Line ~1218**: `runPreCompleteChain(...)` then `onPreComplete(...)` — after task verifiers pass
3. **Line ~1231**: `onTaskComplete({ taskId, result: 'success' })` — after successful task completion
4. **Line ~1317**: `onTaskComplete({ taskId, result: 'failure' })` — after task failure
5. **Line ~1390**: `onTaskComplete({ taskId, result: 'failure' })` — after retries exhausted

---

## 2. Existing Git Operations (`src/gitOps.ts`)

The codebase already has git infrastructure:

- `runGit(workspaceRoot, args)`: Promise-based `execFile('git', ...)` wrapper
- `atomicCommit(workspaceRoot, task, taskInvocationId)`: Full add → diff → commit pipeline with rebase/merge/cherry-pick guards
- `inferCommitType(description)`: Returns `'feat'` or `'fix'` based on keywords
- `buildCommitMessage(task, invId, changedFiles, testSummary?)`: Conventional commit format

**No branch creation logic exists today** — `gitOps.ts` only handles commits on the current branch.

---

## 3. Assessment: Branch Creation as Hook vs Core Logic

### 3.1 Which Hook Would Host Branch Creation?

The natural fit is **`SessionStart`** — it fires once before any task iteration, receives `{ prdPath }`, and can:
- Check if the current branch is `main`/`master`
- Create and checkout a feature branch
- Return `additionalContext` to inform the agent about the branch

Alternative: A hypothetical **`LoopStart`** or **`PreRun`** hook (does not exist yet) would be more semantically precise, but `SessionStart` is functionally equivalent since it fires at loop start.

### 3.2 Can Hooks Execute Git Operations?

**Yes, in both layers**:
- **ShellHookProvider**: Spawns an external script that can run any command including `git checkout -b`. The 30s timeout is generous for branch creation (~100ms operation).
- **HookBridge**: Generated Node.js scripts use `execSync`. A branch-creation script could be added alongside stop/tool-use scripts.
- **`runGit` helper** in `gitOps.ts` is already available for in-process hook implementations.

### 3.3 Trade-offs

| Criterion | Hook Implementation | Core Logic Implementation |
|-----------|-------------------|--------------------------|
| **Separation of concerns** | ✅ Clean — branch policy is decoupled from loop orchestration | ❌ Mixes git workflow concerns into task execution engine |
| **Configurability** | ✅ Users can disable/swap via `hookScript` or `preCompleteHooks` config | ⚠️ Requires feature flags to be toggleable |
| **Testability** | ✅ Shell hooks testable in isolation; `ShellHookProvider` has existing test patterns | ✅ Unit-testable via `gitOps.ts` |
| **Error handling** | ⚠️ Hook failures default to `continue` — a branch creation failure would silently proceed | ✅ Core logic can hard-fail and stop the loop |
| **Timing guarantee** | ⚠️ `SessionStart` fires at the right time but has no access to task details (only `prdPath`) | ✅ Can access full config, PRD content, and task metadata |
| **Branch naming** | ⚠️ Hook input (`SessionStartInput`) lacks task/PRD context for smart naming; would need to parse PRD internally | ✅ Has access to all config and can derive branch name from PRD title, etc. |
| **User experience** | ⚠️ Failure mode is opaque (logged but continues); user may not notice branch wasn't created | ✅ Can surface errors to UI via `vscode.window.showErrorMessage` |
| **Existing patterns** | ⚠️ Current hooks are read-only observers or validation gates — branch creation is a mutating side effect, breaking the pattern | ✅ Matches `atomicCommit` pattern in `gitOps.ts` |
| **Reusability** | ✅ External shell hook is reusable across different projects | ⚠️ Locked into ralph-loop's codebase |
| **Composability** | ✅ Can chain with other SessionStart logic | ⚠️ Harder to compose with other pre-loop steps |

### 3.4 Recommendation

**Hybrid approach — core logic with hook extensibility**:

1. **Core**: Add a `branchEnforcement` config section and implement branch creation in `gitOps.ts` as a new function (e.g., `ensureFeatureBranch`). Call it from the orchestrator's `runLoop()` early in the initialization block (before `SessionStart` hook), so it hard-fails if branch creation is impossible.

2. **Hook notification**: After branch creation, pass branch info to `SessionStart` hook via extended `SessionStartInput` (add optional `branch?: string` field). This lets shell hooks react to the branch (e.g., log, notify, set remote tracking).

**Reasoning**: Branch creation is a **precondition** for the loop, not a validation gate or observer. The existing hook system is designed for optional, non-critical lifecycle callbacks where failure defaults to `continue`. A branch creation failure should prevent the loop from running, which doesn't align with the hook system's fault-tolerant design.

However, if the requirement is specifically for a *configurable, optional* branch policy (e.g., some repos want enforcement, others don't), then a `SessionStart` hook implementation is viable — but the `SessionStartInput` interface would need to be extended with workspace/config data for smart branch naming.

---

## 4. Implementation Path If Using Hook

If the hook approach is chosen despite trade-offs:

1. Extend `SessionStartInput` to include `workspaceRoot` and PRD title
2. Add a `branch-enforcement` builtin to `PreCompleteHookConfig.type` or create a new `SessionStartHookConfig` array
3. Implement branch creation logic inside `ShellHookProvider.onSessionStart()` or as a new built-in hook in the orchestrator
4. Return `{ action: 'stop', reason: 'Cannot create feature branch: ...' }` on failure
5. Return `{ action: 'continue', additionalContext: 'Working on branch feature/...' }` on success

---

## 5. Files Referenced

| File | Relevance |
|------|-----------|
| `src/types.ts` (lines 599-660) | `RalphHookType`, `IRalphHookService`, all input/result types |
| `src/shellHookProvider.ts` | Shell-based hook execution with security guards |
| `src/hookBridge.ts` | VS Code chat.hooks integration, script generation |
| `src/orchestrator.ts` (lines 220-260, 570-590, 1214-1240, 1316-1320) | Hook invocation points, `NoOpHookService`, `runPreCompleteChain` |
| `src/gitOps.ts` | Existing git infrastructure (`runGit`, `atomicCommit`) |
| `test/shellHook.test.ts` | Shell hook security and process management tests |
| `test/hookBridge.test.ts` | Pre-compact script generation tests |
