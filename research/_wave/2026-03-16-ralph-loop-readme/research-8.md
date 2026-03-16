## Research 8: Presets & Strategy System

### Findings

The system has three distinct decision-layer modules that separate concerns cleanly:

#### 1. Presets (`src/presets.ts`)

Four named presets defined as `Record<PresetName, RalphPreset>`, each providing `Partial<RalphConfig>` overrides:

| Preset | Purpose | Key Overrides |
|--------|---------|---------------|
| `general` | Balanced defaults | Empty overrides (inherits all `DEFAULT_CONFIG`) |
| `feature` | Higher retry tolerance, strict TDD | `maxNudgesPerTask: 5`, `maxIterations: 30`, custom `contextTrimming` |
| `bugfix` | Aggressive error tracking | `inactivityTimeoutMs: 180_000`, circuit breakers (`repeatedError`, `errorRate`) enabled |
| `refactor` | Higher stagnation tolerance | `maxNudgesPerTask: 6`, `stagnationDetection` with `maxStaleIterations: 4` |

**Resolution function**: `resolveConfig(workspaceRoot, preset?, overrides?)` merges in priority order:
```
DEFAULT_CONFIG ← preset.overrides ← user overrides ← { workspaceRoot }
```
Unknown preset names silently fall back to defaults (no overrides applied). Merge is **shallow** — nested objects (like `stagnationDetection`) are replaced wholesale, not deep-merged.

**Type**: `PresetName = 'general' | 'feature' | 'bugfix' | 'refactor'` (string literal union in `types.ts`).

**Integration gap**: PRD task 64 specifies exposing `ralph-loop.preset` as a VS Code setting, but `package.json` has no `contributes.configuration` entry for it. The `loadConfig()` function in the orchestrator reads config from VS Code settings, but the preset is not wired through from settings → `resolveConfig()` in the current extension activation flow (`src/extension.ts`).

#### 2. Strategies (`src/strategies.ts`)

Two `ITaskExecutionStrategy` implementations:

- **`CopilotCommandStrategy`** (active): Drives Copilot via VS Code commands — starts a fresh chat session, sends a prompt, then watches for file changes and PRD checkbox completion via filesystem watchers + polling. Uses `verifyTaskCompletion()` as the completion gate.
- **`DirectApiStrategy`** (stub): Throws immediately — the `chatProvider` proposed API is not yet available. Exists as a forward-looking placeholder.

Strategy selection happens in `LoopOrchestrator.resolveStrategy()` based on `config.executionStrategy` (`'command'` | `'api'`). Default is `'command'`.

The `CopilotCommandStrategy.waitForCompletion()` method is the core waiting mechanism:
- Creates a `RelativePattern` watcher on the PRD file for checkbox changes
- Creates a workspace-wide activity watcher for any file changes (resets inactivity timer)
- Runs a 5-second polling interval calling `verifyTaskCompletion()`
- Settles on: completion detected, inactivity timeout, or stop requested

#### 3. Decisions (`src/decisions.ts`)

Three pure functions extracted from the orchestrator for testability (PRD task 43):

- **`shouldContinueLoop(state: LoopDecisionState): boolean`** — Returns `false` if: stop requested, no tasks remaining, or iteration limit reached. Used conceptually (the orchestrator inlines equivalent logic in `runLoop()`).

- **`shouldNudge(state: NudgeDecisionState): string | undefined`** — Returns a nudge message if task is not completed and nudge count is below max; `undefined` otherwise. The nudge text is hardcoded: *"Continue with the current task..."*

- **`shouldRetryError(error, retryCount, stopRequested?): boolean`** — Returns `true` only for transient network errors (`timeout`, `econnreset`, `fetch failed`, etc.) when under `MAX_RETRIES_PER_TASK` (3) and not stopped. The orchestrator imports and uses `shouldRetryError` directly; the other two decision functions exist but the orchestrator has equivalent inline logic rather than calling them directly.

### Patterns

1. **Layered override pattern**: `DEFAULT_CONFIG ← preset ← user` follows a common configuration cascade. Each layer wins over the previous. This is clean but shallow-only merging limits composability for nested configs.

2. **Strategy pattern (GoF)**: `ITaskExecutionStrategy` interface with two implementations. Clean separation — the orchestrator doesn't know how tasks are executed, just that it gets an `ExecutionResult`. The `api` strategy is a planned extension point.

3. **Pure decision functions**: Extracted from the orchestrator to enable unit testing without VS Code dependencies. State objects (`LoopDecisionState`, `NudgeDecisionState`) are plain readonly interfaces — no side effects, no async.

4. **Circuit breaker integration**: The bugfix preset activates named circuit breakers (`repeatedError`, `errorRate`) that plug into the `CircuitBreakerChain` system in the orchestrator.

5. **Stagnation-as-preset-parameter**: The refactor preset tunes stagnation detection (`maxStaleIterations: 4` vs default `2`), recognizing that refactoring tasks are expected to take longer without visible progress.

6. **Decision function underuse**: `shouldContinueLoop` and `shouldNudge` are defined but the orchestrator inlines equivalent logic. Only `shouldRetryError` is imported and used directly. The other two serve as tested documentation of the decision rules.

### Applicability

- **README documentation**: Presets are a user-facing concept that should be prominently documented — users need to know which preset to pick for their workflow type. The four-preset taxonomy (general/feature/bugfix/refactor) maps cleanly to common development activities.

- **Strategy selection**: Currently binary (command vs api), with api being unavailable. Worth documenting as an architecture feature with future extensibility.

- **Decision logic**: The pure function pattern is worth highlighting as a design decision — it demonstrates the project's emphasis on testability and separation from VS Code runtime.

- **Configuration gap**: The preset isn't wired to a VS Code setting despite PRD task 64 specifying it. Users can only select presets programmatically (via `resolveConfig`) not through the settings UI.

### Open Questions

1. **Preset UI exposure**: PRD task 64 says "Expose `ralph-loop.preset` VS Code setting" but `package.json` has no such configuration contribution. Is this a deferred task or was it dropped?

2. **Decision function drift**: `shouldContinueLoop` and `shouldNudge` in `decisions.ts` are not called by the orchestrator — the orchestrator has its own inline logic that has evolved beyond these simple functions (e.g., auto-expand iteration limits, circuit breaker checks). Are these functions still accurate representations of the actual decision logic?

3. **Shallow merge limitation**: Preset overrides use shallow merge (`{ ...DEFAULT_CONFIG, ...presetOverrides }`). This means a preset can't partially override nested objects (e.g., change `stagnationDetection.maxStaleIterations` without replacing the entire `stagnationDetection` object). Is this intentional?

4. **Custom presets**: The `PresetName` type is a closed union (`'general' | 'feature' | 'bugfix' | 'refactor'`). Is there a plan for user-defined presets or preset composition?

5. **DirectApiStrategy timeline**: The `chatProvider` proposed API stub has been in place since early development. What's the expected availability timeline, and should the README document this as a future capability?
