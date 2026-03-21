# Research-6: Ralph-Loop Configuration System & `featureBranch` Integration

## Question
What configuration system does ralph-loop use (`RalphConfig`, `DEFAULT_CONFIG`, VS Code settings) and how would a new `featureBranch` config option integrate?

---

## Findings

### 1. Configuration Architecture Overview

Ralph-loop uses a **three-layer configuration system**:

| Layer | Source | Mechanism |
|-------|--------|-----------|
| **Defaults** | `DEFAULT_CONFIG` in `src/types.ts` | Hardcoded `Omit<RalphConfig, 'workspaceRoot'>` object |
| **VS Code Settings** | `ralph-loop.*` namespace | `vscode.workspace.getConfiguration('ralph-loop')` |
| **Presets** | `src/presets.ts` | Named override bundles (`general`, `feature`, `bugfix`, `refactor`) |

Configuration is read **once at loop start** via `loadConfig(workspaceRoot)` in `src/orchestrator.ts:1463–1509`. There is **no `onDidChangeConfiguration` listener** — settings changes require restarting the loop.

### 2. `RalphConfig` Interface (`src/types.ts:489–535`)

The central config interface with ~35 fields:

```typescript
export interface RalphConfig {
  prdPath: string;
  progressPath: string;
  maxIterations: number;
  hardMaxIterations: number;
  countdownSeconds: number;
  inactivityTimeoutMs: number;
  maxNudgesPerTask: number;
  executionStrategy: 'command' | 'api';
  hookScript?: string;
  promptBlocks?: string[];
  modelHint?: string;
  features: RalphFeatures;
  useHookBridge: boolean;
  useSessionTracking: boolean;
  useAutopilotMode: boolean;
  maxParallelTasks: number;
  workspaceRoot: string;
  verifiers?: VerifierConfig[];
  verificationTemplates?: VerificationTemplate[];
  autoClassifyTasks?: boolean;
  circuitBreakers?: CircuitBreakerConfig[];
  preCompleteHooks?: PreCompleteHookConfig[];
  diffValidation?: DiffValidationConfig;
  maxDiffValidationRetries: number;
  reviewAfterExecute?: ReviewAfterExecuteConfig;
  maxConcurrencyPerStage: number;
  parallelMonitor?: ParallelMonitorConfig;
  preCompactBehavior?: PreCompactBehavior;
  stagnationDetection?: StagnationDetectionConfig;
  autoDecompose?: AutoDecomposeConfig;
  knowledge?: KnowledgeConfig;
  contextTrimming?: ContextTrimmingConfig;
  struggleDetection?: StruggleDetectionConfig;
  bearings?: BearingsConfig;
  backpressure?: BackpressureConfig;
  confidenceThreshold?: number;
  promptTemplate?: string;
  sessionPersistence?: { enabled: boolean; expireAfterMs: number };
  contextBudget?: ContextBudgetConfig;
  inactivity?: InactivityConfig;
  cooldownShowDialog?: boolean;
  agentMode?: string;
}
```

### 3. `DEFAULT_CONFIG` (`src/types.ts:537–572`)

```typescript
export const DEFAULT_CONFIG: Omit<RalphConfig, 'workspaceRoot'> = {
  prdPath: 'PRD.md',
  progressPath: 'progress.txt',
  maxIterations: 50,
  hardMaxIterations: 50,
  countdownSeconds: 12,
  inactivityTimeoutMs: 300_000,
  maxNudgesPerTask: 3,
  executionStrategy: 'command',
  // ... all sub-configs spread from their own DEFAULT_* constants
  agentMode: 'ralph-executor',
};
```

Pattern: each sub-config has its own `DEFAULT_*` constant (`DEFAULT_DIFF_VALIDATION`, `DEFAULT_BEARINGS_CONFIG`, etc.), which is spread into `DEFAULT_CONFIG`.

### 4. `loadConfig()` Function (`src/orchestrator.ts:1463–1509`)

The full config loading pipeline:

```typescript
export function loadConfig(workspaceRoot: string): RalphConfig {
  const vsConfig = vscode.workspace.getConfiguration('ralph-loop');
  const featConfig = vscode.workspace.getConfiguration('ralph-loop.features');

  // Feature flags from separate namespace
  const features = {
    useHookBridge: featConfig.get<boolean>('useHookBridge', DEFAULT_FEATURES.useHookBridge),
    useSessionTracking: featConfig.get<boolean>('useSessionTracking', ...),
    useAutopilotMode: featConfig.get<boolean>('useAutopilotMode', ...),
    useParallelTasks: featConfig.get<boolean>('useParallelTasks', ...),
    useLlmConsistencyCheck: featConfig.get<boolean>('useLlmConsistencyCheck', ...),
  };

  return {
    prdPath: vsConfig.get<string>('prdPath', DEFAULT_CONFIG.prdPath),
    // ... every field read with vsConfig.get() falling back to DEFAULT_CONFIG.*
    workspaceRoot,
  };
}
```

**Key patterns:**
- Two `getConfiguration()` calls: `ralph-loop` (main) and `ralph-loop.features` (feature flags)
- Every field has a `DEFAULT_CONFIG.*` fallback
- Complex objects (e.g., `diffValidation`, `bearings`) are read as whole objects, not per-subfield

### 5. VS Code `package.json` Configuration Contributions

Only **9 settings** are declared in `package.json` `contributes.configuration`:

| Setting | Type | Default |
|---------|------|---------|
| `ralph-loop.prdPath` | `string` | `"PRD.md"` |
| `ralph-loop.progressPath` | `string` | `"progress.txt"` |
| `ralph-loop.maxIterations` | `number` | `50` |
| `ralph-loop.countdownSeconds` | `number` | `12` |
| `ralph-loop.cooldownShowDialog` | `boolean` | `true` |
| `ralph-loop.inactivityTimeoutMs` | `number` | `300000` |
| `ralph-loop.promptTemplate` | `string` | `""` |
| `ralph-loop.preset` | `enum` | `"general"` |

The remaining ~25+ settings are **undeclared "dark" settings** — they work via `getConfiguration().get()` but are not discoverable in the VS Code Settings UI.

### 6. Preset System (`src/presets.ts`)

Four presets that overlay `DEFAULT_CONFIG` with partial overrides:

```typescript
export function resolveConfig(
  workspaceRoot: string,
  preset?: PresetName,
  overrides?: Partial<RalphConfig>,
): RalphConfig {
  const presetOverrides = preset && preset in PRESETS
    ? PRESETS[preset].overrides : {};
  return { ...DEFAULT_CONFIG, ...presetOverrides, ...overrides, workspaceRoot };
}
```

**Note:** `resolveConfig()` exists in `src/presets.ts` but is NOT called by the main `loadConfig()` in `src/orchestrator.ts`. The preset system is a parallel path used in tests/CLI but not wired into the VS Code extension activation flow.

### 7. CLI Config (`cli/ralph.ts`)

The CLI uses `DEFAULT_CONFIG` directly with no VS Code settings layer — only `--prd` and `--cwd` CLI flags are supported. It does not call `loadConfig()`.

---

## Proposal: `featureBranch` Config Option Integration

### Where It Fits

A `featureBranch` option belongs as a **top-level optional string field** on `RalphConfig`, following the pattern of other simple scalar settings like `prdPath`, `hookScript`, `modelHint`, and `agentMode`.

### Type & Default

```typescript
// In src/types.ts, add to RalphConfig interface:
featureBranch?: string;

// In DEFAULT_CONFIG:
featureBranch: undefined,  // No enforcement by default
```

### Rationale for `string | undefined`
- `undefined` = no enforcement (backward compatible, zero friction for existing users)
- When set to e.g. `"feat/my-feature"`, the orchestrator or gitOps module can validate the current git branch before allowing loop execution
- Matches the pattern of `hookScript?: string` and `modelHint?: string`

### Integration Points

#### 1. `RalphConfig` interface (`src/types.ts:489`)
Add `featureBranch?: string;` alongside other optional string fields.

#### 2. `DEFAULT_CONFIG` (`src/types.ts:537`)
Add `featureBranch: undefined,`.

#### 3. `loadConfig()` (`src/orchestrator.ts:1463`)
Add one line:
```typescript
featureBranch: vsConfig.get<string | undefined>('featureBranch', undefined),
```

#### 4. `package.json` `contributes.configuration`
Optionally declare for discoverability:
```json
"ralph-loop.featureBranch": {
  "type": "string",
  "default": "",
  "description": "Expected git branch name. If set, the loop will refuse to start on a different branch."
}
```

#### 5. `src/gitOps.ts` — Enforcement
Add a `validateBranch()` function:
```typescript
export async function getCurrentBranch(workspaceRoot: string): Promise<string> {
  const { stdout } = await runGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}
```

#### 6. Orchestrator guard (`src/orchestrator.ts`)
Check in `runLoop()` or in `extension.ts` before `orchestrator.start()`:
```typescript
if (config.featureBranch) {
  const currentBranch = await getCurrentBranch(workspaceRoot);
  if (currentBranch !== config.featureBranch) {
    // Block start or emit error event
  }
}
```

#### 7. Preset overrides (`src/presets.ts`)
The `feature` preset could optionally set a convention, but since branch names are project-specific, this is better left to user config.

### Validation Considerations
- Empty string (`""`) and `undefined` should both mean "no enforcement"
- Branch comparison should be exact-match (or optional glob/prefix matching for `feat/*` patterns)
- The check should happen **before** loop starts (fail-fast), not mid-loop

---

## Summary

| Aspect | Detail |
|--------|--------|
| **Config system** | 3 layers: `DEFAULT_CONFIG` → VS Code settings → presets |
| **Central type** | `RalphConfig` interface (~35 fields) in `src/types.ts` |
| **Loading** | `loadConfig()` in `src/orchestrator.ts` reads VS Code settings once at start |
| **Declared settings** | Only 9 of ~35+ in `package.json` (the rest are "dark" settings) |
| **Proposed type** | `featureBranch?: string` (optional, `undefined` = no enforcement) |
| **Files to change** | `src/types.ts`, `src/orchestrator.ts` (loadConfig), `src/gitOps.ts` (validation), optionally `package.json` |
| **Pattern match** | Follows exact pattern of `hookScript`, `modelHint`, `agentMode` |
