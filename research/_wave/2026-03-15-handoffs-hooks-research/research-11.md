## Research Report 11: Ralph-Loop Hook Execution Implementation

### Findings

#### 1. ShellHookProvider — Direct Process Spawn with JSON stdin/stdout Protocol

**File**: [src/shellHookProvider.ts](src/shellHookProvider.ts)

The `ShellHookProvider` class implements `IRalphHookService` and executes hooks by spawning an external script as a child process.

**JSON stdin/stdout protocol** ([lines 85–90](src/shellHookProvider.ts#L85-L90)):
```ts
// Input: JSON written to child's stdin
child.stdin.write(JSON.stringify(input));
child.stdin.end();

// Output: stdout parsed as HookResult JSON on exit code 0
const parsed = JSON.parse(stdout.trim()) as HookResult;
```

**Exit code semantics** ([lines 108–128](src/shellHookProvider.ts#L108-L128)):
| Exit Code | Meaning | Behavior |
|-----------|---------|----------|
| `0` | Success | Parse stdout as `HookResult` JSON; fallback to `{ action: 'continue' }` if not valid JSON |
| `1` | Warning | Log stderr, return `{ action: 'continue', reason }` |
| `2` | Block/Stop | Return `{ action: 'continue', blocked: true, reason }` |
| Other | Unexpected | Log warning, return `{ action: 'continue' }` |

**Security: Shell metacharacter guard** ([lines 18–22](src/shellHookProvider.ts#L18-L22)):
```ts
export const DANGEROUS_PATTERNS = /&&|\|\||;|\||>|<|`|\$\(|\$\{/;
```
Before spawning, the script path is checked against `DANGEROUS_PATTERNS`. If matched, execution is **blocked** and a `{ blocked: true }` result is returned — never reaches `spawn()`.

**Timeout handling** ([lines 93–101](src/shellHookProvider.ts#L93-L101)):
- 30-second timeout (`SHELL_HOOK_TIMEOUT_MS = 30_000`)
- On timeout: kills process tree via `killProcessTree()` (SIGTERM, then SIGKILL after 1s)
- Cross-platform: uses `taskkill /T /F` on Windows

**Hook types dispatched**: `SessionStart`, `PreCompact`, `PostToolUse`, `PreComplete`, `TaskComplete` — each maps to a method on `IRalphHookService`.

#### 2. HookBridge — Temp Script Generation + `chat.hooks` Registration

**File**: [src/hookBridge.ts](src/hookBridge.ts)

The `HookBridge` is the **VS Code integration layer** that generates Node.js scripts at runtime and registers them as Copilot `chat.hooks`.

**`registerHookBridge()` function** ([lines 253–320](src/hookBridge.ts#L253-L320)):

1. **Creates a temp directory**: `fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-hook-'))`
2. **Generates 3 hook scripts** as `.js` files written with mode `0o755`:
   - `stop-hook.js` — via `generateStopHookScript(prdPath, progressPath)`
   - `post-tool-use-hook.js` — via `generatePostToolUseHookScript()`
   - `pre-compact-hook.js` — via `generatePreCompactHookScript(prdPath, progressPath, config)` (if enabled)
3. **Registers in `chat.hooks` VS Code config**:
   ```ts
   const chatHooksConfig = vscode.workspace.getConfiguration('chat');
   const updatedHooks = {
       ...existingHooks,
       Stop: { command: process.execPath, args: [stopScriptPath] },
       PostToolUse: { command: process.execPath, args: [postToolUseScriptPath] },
   };
   chatHooksConfig.update('hooks', updatedHooks, vscode.ConfigurationTarget.Workspace);
   ```
   The hook command is always `process.execPath` (Node.js) with the generated script as argument.

**`generateStopHookScript()`** ([lines 10–99](src/hookBridge.ts#L10-L99)):
- Produces a self-contained `#!/usr/bin/env node` script as a template literal
- Reads JSON from stdin, then runs **4 verification checks**:
  1. **PRD checkbox check** — scans for `- [ ]` vs `- [x]` patterns
  2. **progress.txt freshness** — mtime must be within 5 minutes
  3. **TypeScript compilation** — `npx tsc --noEmit` (120s timeout)
  4. **Tests pass** — `npx vitest run` (120s timeout)
- Output protocol: writes JSON to stdout:
  - `{ resultKind: 'success' }` — all checks pass
  - `{ resultKind: 'error', stopReason: 'Verification failed: ...' }` — any check fails

**`generatePreCompactHookScript()`** ([lines 101–205](src/hookBridge.ts#L101-L205)):
- Injects **resumption context** for context window compaction:
  - Last N lines of progress.txt (configurable `summaryMaxLines`)
  - Git diff summary (`git diff --stat` + `git diff --name-only`)
  - Current unchecked PRD task
- Returns `{ resultKind: 'success', action: 'continue', additionalContext: resumptionBlock }`

**`generatePostToolUseHookScript()`** ([lines 210–235](src/hookBridge.ts#L210-L235)):
- Lightweight: reads stdin, writes a timestamp to a marker file at `os.tmpdir()/ralph-loop-tool-activity.marker`
- Extension watches this marker file via `fs.watch()` to detect tool activity

**Cleanup on dispose** ([lines 322–340](src/hookBridge.ts#L322-L340)):
- Deletes temp script files
- Removes `Stop`, `PostToolUse`, `PreCompact` keys from `chat.hooks` config

#### 3. Extension Integration — Wiring in `extension.ts`

**File**: [src/extension.ts](src/extension.ts)

**ShellHookProvider instantiation** ([lines 81–84](src/extension.ts#L81-L84)):
```ts
if (config.hookScript) {
    hookService = new ShellHookProvider(config.hookScript, logger);
}
```
Passed as optional `hookService` param to `LoopOrchestrator`.

**HookBridge registration** ([lines 87–94](src/extension.ts#L87-L94)):
```ts
if (config.features.useHookBridge) {
    hookBridgeDisposable = registerHookBridge(config, logger);
}
```
Gated behind `useHookBridge` feature flag. Fails gracefully if `proposed.chatHooks` API is unavailable.

**Cleanup** ([lines 290–296](src/extension.ts#L290-L296)):
```ts
export function deactivate(): void {
    orchestrator?.stop();
    hookBridgeDisposable?.dispose();
}
```

#### 4. Type System — `HookResult` and `IRalphHookService`

**File**: [src/types.ts](src/types.ts#L467-L500)

```ts
export type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'PreComplete' | 'TaskComplete';

export interface HookResult {
    action: 'continue' | 'retry' | 'skip' | 'stop';
    reason?: string;
    additionalContext?: string;
    blocked?: boolean;
}
```

The `IRalphHookService` interface defines 5 hook methods: `onSessionStart`, `onPreCompact`, `onPostToolUse`, `onPreComplete`, `onTaskComplete`.

### Patterns

1. **Dual-path hook architecture**: `ShellHookProvider` is the **orchestrator-side** hook system (ralph-loop spawns scripts itself), while `HookBridge` is the **VS Code Copilot-side** integration (registers scripts via `chat.hooks` config so Copilot calls them). Both use the same JSON stdin/stdout protocol.

2. **Template-literal script generation**: Hook scripts are generated as Node.js source code strings with `JSON.stringify()` for path interpolation. This avoids runtime path resolution issues and creates self-contained, dependency-free scripts.

3. **Graceful degradation everywhere**: Every hook call resolves to `{ action: 'continue' }` on error, timeout, or invalid JSON — hooks never crash the loop.

4. **Defense-in-depth security**: Shell metacharacter regex guard on script paths *before* `spawn()` + no shell interpretation (`stdio: ['pipe', 'pipe', 'pipe']`).

5. **Structured exit code protocol**: 0=success, 1=warning, 2=block — a simple, shell-friendly convention that degrades gracefully for any unexpected exit code.

6. **Marker file pattern for inter-process signaling**: PostToolUse hook writes a timestamp file; the extension watches it via `fs.watch()` — a lightweight IPC mechanism that avoids sockets or shared memory.

7. **Feature-flag gating**: `useHookBridge` flag controls whether `chat.hooks` registration happens, with try/catch for missing proposed API.

### Applicability

**HIGH** — This research directly documents the complete hook execution pipeline, both internal (`ShellHookProvider`) and external (`HookBridge` → `chat.hooks`). The patterns are reusable:
- The JSON stdin/stdout + exit code protocol is a clean interface for any external verification gate
- The temp script generation pattern solves the problem of registering dynamic hooks with VS Code's config-based `chat.hooks` system
- The dual-path architecture (orchestrator hooks vs chat.hooks) shows how to integrate with Copilot's proposed APIs while maintaining a fallback

### Open Questions

1. **`chat.hooks` API stability**: The HookBridge depends on `vscode.proposed.chatHooks` — what is the current status of this proposed API? Is the `{ command, args }` schema documented anywhere in vscode-copilot-chat?
2. **`resultKind` vs `action` discrepancy**: `ShellHookProvider` expects `HookResult` with `action: 'continue'|'retry'|'skip'|'stop'`, but the generated hook scripts output `{ resultKind: 'success'|'error', stopReason }`. Are these two different protocols (one for orchestrator, one for chat.hooks)?
3. **PreCompact hook `additionalContext`**: The generated script returns `additionalContext` in its JSON output — does Copilot's chat.hooks system actually consume this field, or is it only used by the orchestrator?
4. **Marker file race condition**: `fs.watch()` on the tool activity marker has known reliability issues on some Linux filesystems — is there a polling fallback?
5. **Hook script cleanup on crash**: If the extension crashes without calling `deactivate()`, orphan temp scripts and stale `chat.hooks` config entries remain. Is there a recovery mechanism?
