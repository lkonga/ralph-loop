## Research 10: VS Code Extension Configuration

### Findings

#### Activation
- **Single activation event**: `workspaceContains:PRD.md` — the extension activates when any workspace folder contains a `PRD.md` file.
- **Entry point**: `./out/src/extension.js` (`src/extension.ts` → `activate()`)
- **Engine requirement**: `vscode ^1.93.0`
- **On activation**, Ralph also checks for incomplete sessions and offers Resume/Discard via an information message.

#### Registered Commands (6 total)

| Command ID | Declared in `package.json`? | Purpose |
|---|---|---|
| `ralph-loop.start` | **Yes** | Start the loop orchestrator |
| `ralph-loop.stop` | **Yes** | Stop the running loop |
| `ralph-loop.status` | **Yes** | Show current state (`idle`/`running`/etc.) |
| `ralph-loop.chatSend` | **Yes** | Switch chat mode + submit a query programmatically |
| `ralph-loop.yield` | **No** ❌ | Graceful yield — stops after current task completes |
| `ralph-loop.injectContext` | **No** ❌ | Inject user-provided context into the next iteration |

**Gap**: 2 commands (`yield`, `injectContext`) are registered at runtime but **not declared** in `package.json` `contributes.commands`. They won't appear in the Command Palette unless declared.

#### Declared Settings (`contributes.configuration`)

The `package.json` declares **9 settings** under `ralph-loop.*`:

| Setting Key | Type | Default | Notes |
|---|---|---|---|
| `ralph-loop.prdPath` | `string` | `"PRD.md"` | Relative path to PRD file |
| `ralph-loop.progressPath` | `string` | `"progress.txt"` | Progress tracking file path |
| `ralph-loop.maxIterations` | `number` | `50` | Max loop iterations (0 = unlimited) |
| `ralph-loop.countdownSeconds` | `number` | `12` | Inter-task wait |
| `ralph-loop.cooldownShowDialog` | `boolean` | `true` | Show countdown dialog with Pause/Stop/Edit |
| `ralph-loop.inactivityTimeoutMs` | `number` | `300000` | Inactivity timeout before next task |
| `ralph-loop.promptTemplate` | `string` | `""` | Custom prompt with `{{variable}}` placeholders; multiline |
| `ralph-loop.preset` | `enum` | `"general"` | Workflow preset: `general` / `feature` / `bugfix` / `refactor` |

#### Undeclared Settings (read via `getConfiguration` but NOT in `package.json`)

The `loadConfig()` function in `src/orchestrator.ts` reads **~25+ additional settings** that have no `contributes.configuration` declaration. These are "hidden" settings that power users can set in `settings.json` but won't see in the Settings UI:

**Scalar settings (`ralph-loop.*`):**
| Key | Type | Default |
|---|---|---|
| `hardMaxIterations` | `number` | `50` |
| `maxNudgesPerTask` | `number` | `3` |
| `hookScript` | `string?` | `undefined` |
| `executionStrategy` | `'command' \| 'api'` | `'command'` |
| `promptBlocks` | `string[]` | `['safety', 'discipline']` |
| `modelHint` | `string?` | `undefined` |
| `maxParallelTasks` | `number` | `1` |
| `maxDiffValidationRetries` | `number` | `3` |
| `maxConcurrencyPerStage` | `number` | `1` |

**Complex object settings (`ralph-loop.*`):**
| Key | Type | Default |
|---|---|---|
| `diffValidation` | `DiffValidationConfig` | `{ enabled: true, requireChanges: true, generateSummary: true }` |
| `reviewAfterExecute` | `ReviewAfterExecuteConfig` | `{ enabled: false, mode: 'same-session' }` |
| `parallelMonitor` | `ParallelMonitorConfig` | `{ enabled: false, intervalMs: 10000, stuckThreshold: 3 }` |
| `preCompactBehavior` | `PreCompactBehavior` | `{ enabled: true, summaryMaxLines: 50, injectGitDiff: true, injectProgressSummary: true }` |
| `stagnationDetection` | `StagnationDetectionConfig` | `{ enabled: true, maxStaleIterations: 2, hashFiles: [...] }` |
| `autoDecompose` | `AutoDecomposeConfig` | `{ enabled: true, failThreshold: 3 }` |
| `knowledge` | `KnowledgeConfig` | `{ enabled: true, path: 'knowledge.md', maxInjectLines: 15 }` |
| `contextTrimming` | `ContextTrimmingConfig` | `{ fullUntil: 3, abbreviatedUntil: 8 }` |

**Feature flags (`ralph-loop.features.*`):**
| Key | Type | Default |
|---|---|---|
| `useHookBridge` | `boolean` | `false` |
| `useSessionTracking` | `boolean` | `false` |
| `useAutopilotMode` | `boolean` | `false` |
| `useParallelTasks` | `boolean` | `false` |
| `useLlmConsistencyCheck` | `boolean` | `false` |

Feature flags are read from a separate configuration scope `ralph-loop.features` via `vscode.workspace.getConfiguration('ralph-loop.features')`.

#### Preset System

Four presets alter the default config at startup:

| Preset | Description | Key Overrides |
|---|---|---|
| `general` | Balanced defaults | None (uses `DEFAULT_CONFIG` as-is) |
| `feature` | Higher retry tolerance, strict TDD | `maxNudgesPerTask: 5`, `maxIterations: 30`, wider context trimming |
| `bugfix` | Aggressive error tracking | Lower timeout (180s), enables circuit breakers |
| `refactor` | Higher stagnation tolerance | `maxNudgesPerTask: 6`, `maxStaleIterations: 4` |

Resolution order: `DEFAULT_CONFIG` → preset overrides → user overrides → `workspaceRoot` injected.

#### Hook Bridge Integration

When `features.useHookBridge` is enabled, the extension writes into VS Code's `chat.hooks` configuration (workspace scope) to register:
- **Stop hook**: Intercepts loop stop
- **PostToolUse hook**: Monitors agent tool usage
- **PreCompact hook** (if `preCompactBehavior.enabled`): Injects summaries before context compaction

This is read/written via `vscode.workspace.getConfiguration('chat')` — a *cross-extension* configuration surface (Copilot Chat's `chat.hooks`).

#### VS Code Commands Used (external dependencies)

The extension calls these workbench commands programmatically:
- `workbench.action.chat.toggleAgentMode` — switch chat mode
- `workbench.panel.chat.view.copilot.focus` — focus the chat panel
- `type` — simulate keyboard input
- `workbench.action.chat.submit` — submit the chat message

These require the Copilot Chat extension to be installed.

#### CLI Surface

The `ralph` CLI (`cli/ralph.ts`) provides 4 subcommands outside VS Code:
- `ralph status [--prd <path>]` — show PRD progress
- `ralph next [--prd <path>]` — show next pending task
- `ralph init [--prd <path>]` — create blank PRD template
- `ralph help` — show usage

CLI options: `--prd <path>` (default: `PRD.md`), `--cwd <path>` (default: `.`)

#### Proposed API Dependencies

The extension optionally depends on proposed VS Code APIs (not enforced via `enabledApiProposals` in package.json):
- `activeChatPanelSessionResource` — for session tracking (polled every 2s)
- `chat.hooks` — for hook bridge registration

These degrade gracefully with `try/catch` wrappers when unavailable.

### Patterns

1. **Declared vs undeclared split**: Only 9 of ~35+ total settings are declared in `package.json`. The bulk of the configuration is "dark" — accessible only via manual `settings.json` edits. This is intentional for power users but creates a discoverability gap.

2. **Feature flag isolation**: Feature flags use a separate `ralph-loop.features` configuration namespace, read via a dedicated `getConfiguration()` call. None are declared in `package.json`.

3. **Undeclared commands**: 2 of 6 registered commands (`yield`, `injectContext`) lack `package.json` declarations. They work when invoked programmatically but are invisible in the Command Palette.

4. **Config-on-start**: Configuration is read once at loop start via `loadConfig()`. There is **no `onDidChangeConfiguration` listener** — settings changes require restarting the loop to take effect.

5. **Cross-extension coupling**: The hook bridge writes to `chat.hooks` in workspace settings, creating a tight coupling to Copilot Chat's proposed `chatHooks` API.

6. **Graceful degradation**: All proposed API usage is wrapped in try/catch with warning logs, allowing the extension to work with reduced functionality when APIs are unavailable.

7. **Session persistence**: On activation, checks for incomplete sessions and offers resume — a form of crash recovery.

### Applicability

For a README, this research feeds into:
- **Installation & Requirements** section: engine version, Copilot Chat dependency
- **Configuration Reference** table: all 9 declared settings with types and defaults
- **Advanced Configuration** section: pointer to the ~25+ undeclared settings
- **Commands** section: all 6 commands (noting 2 are undeclared)
- **CLI Usage** section: the 4 subcommands
- **Feature Flags** section: the 5 boolean flags
- **Presets** section: the 4 workflow presets
- **Architecture Notes**: activation flow, session recovery, hook bridge

For quality/completeness improvements, this research exposes:
- **Missing `package.json` declarations**: 2 commands + ~25 settings should be declared for discoverability
- **No live config reload**: adding `onDidChangeConfiguration` would improve UX
- **Feature flag documentation gap**: power users have no way to discover flags without reading source

### Open Questions

1. **Should all ~25+ undeclared settings be declared in `package.json`?** This would make them visible in Settings UI but may overwhelm users. Consider using `"scope": "window"` and grouping.
2. **Should `ralph-loop.yield` and `ralph-loop.injectContext` be added to `contributes.commands`?** They're useful but may clutter the palette for non-power-users.
3. **Is live config reload (`onDidChangeConfiguration`) planned?** Currently requires loop restart.
4. **Should the preset system be documented in README?** Currently only visible via the `ralph-loop.preset` setting enum.
5. **What is the intended stability contract for undeclared settings?** Are they considered internal/experimental?
