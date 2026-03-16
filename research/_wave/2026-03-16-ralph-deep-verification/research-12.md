# Research-12: Per-Task DSL Verification Config System

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Design a robust per-task DSL verification config system for ralph-loop
**Date**: 2026-03-16

---

## 1. Current System Inventory

### Existing Types (src/types.ts)

```typescript
export type VerifierFn = (task: Task, workspaceRoot: string, args?: Record<string, string>) => Promise<VerifyCheck>;

export interface VerifierConfig {
  type: string;
  args?: Record<string, string>;
  stages?: string[];
}

export interface VerificationTemplate {
  name: string;
  verifiers: VerifierConfig[];
}

// In RalphConfig:
verifiers?: VerifierConfig[];              // Global explicit verifiers
verificationTemplates?: VerificationTemplate[];  // Name-matched templates
autoClassifyTasks?: boolean;               // Keyword-based auto-classification
```

### Existing Resolution Logic (src/verify.ts — `resolveVerifiers`)

The current 3-tier cascade:

```
1. config.verifiers (global explicit)   → if set, return immediately (no per-task)
2. config.verificationTemplates         → match template.name against task description (substring)
3. Defaults: [checkbox, tsc]            → plus vitest if autoClassifyTasks && desc includes "test"
```

**Key gap**: There is NO per-task override mechanism. The current system is:
- **Global-only** for explicit verifiers — `config.verifiers` applies to ALL tasks
- **Template-matching** is description-based substring match (fragile, no explicit binding)
- **Auto-classification** is a single boolean with hardcoded keyword ("test" → vitest)
- No way to **disable** a verifier for a specific task
- No way to **add** a verifier to a specific task beyond what templates provide

### Existing PRD Task Format

Tasks use markdown checkbox format with optional metadata:
```markdown
- [ ] **Task 57 — Context Budget Awareness**: Description... → Spec: `research/14-phase9-refined-tasks.md` L15-L36
```

The `→ Spec:` reference is already parsed by `extractSpecReference()` in `src/prompt.ts` for frontmatter context injection.

### Existing Config Loading (src/orchestrator.ts — `loadConfig`)

All config is read from VS Code settings via `vscode.workspace.getConfiguration('ralph-loop')`. No file-based config exists currently (no `.ralph/config.json` or similar).

---

## 2. DSL Design

### 2.1 Design Principles

1. **Additive over replacement** — Per-task DSL should compose with global config, not replace it
2. **Inline brevity** — PRD task lines are already long; DSL must be compact
3. **File-based power** — Complex configurations go in `.ralph/verification.json`
4. **Familiar syntax** — Use `→ Verify:` prefix (matches existing `→ Spec:` pattern)
5. **Deterministic resolution** — Clear, documented cascade order with no ambiguity

### 2.2 Inline PRD DSL Syntax

#### Basic Syntax: `→ Verify: <directive>[, <directive>...]`

Appended to task description lines, parsed by `parsePrd()`:

```markdown
## Simple examples

- [ ] Add user validation → Verify: tsc, vitest
- [ ] Fix CSS layout → Verify: tsc, -vitest
- [ ] Deploy nginx config → Verify: fileExists(path=/etc/nginx/sites-enabled/app), commandExitCode(command=nginx -t)
- [ ] Write integration tests → Verify: vitest, +fileContains(path=test/integration.test.ts, content=describe)
- [ ] Quick docs update → Verify: checkbox-only

## Directive types

# Include a verifier (implicit +)
tsc                           # Built-in verifier, no args
vitest                        # Built-in verifier, no args

# Include a verifier with args
fileExists(path=src/new.ts)   # Parameterized verifier
commandExitCode(command=npm run lint)

# Exclude a verifier (- prefix)
-vitest                       # Remove vitest even if global/template adds it
-tsc                          # Remove tsc even if it's in defaults

# Add a verifier (explicit + prefix, same as no prefix)
+custom(command=npm run e2e)  # Explicitly additive

# Preset shorthand
checkbox-only                 # Only checkbox, nothing else (escape hatch)
tdd                           # Alias for: checkbox, tsc, vitest
full                          # Alias for: checkbox, tsc, vitest, diff, fileExists
none                          # Skip all verification (dangerous — requires confirm)

# Template reference
@api-endpoint                 # Use named template from config file
@database-migration           # Use named template from config file
```

#### Full Example in PRD.md

```markdown
## Phase 9 — Adaptive Intelligence

### 9a — Context & Knowledge Intelligence

- [ ] **Task 57 — Context Budget Awareness**: Add token budget estimation... → Spec: `research/14-phase9-refined-tasks.md` L15-L36 → Verify: tsc, vitest, fileExists(path=src/contextBudget.ts)
- [ ] **Task 58 — Knowledge Harvest Pipeline**: Upgrade KnowledgeManager... → Verify: @knowledge-pipeline
- [ ] **Task 59 — Knowledge Garbage Collection**: Run-count based GC... → Verify: tdd, +fileContains(path=src/knowledge.ts, content=garbageCollect)

### 9c — Prompt & Workflow

- [ ] **Task 63 — Search-Before-Implement Gate**: In src/prompt.ts... → Verify: tsc, vitest, -diff
- [ ] **Task 67 — Atomic Session Writes**: Surgical 3-line fix... → Verify: checkbox-only
```

### 2.3 Config File DSL (`.ralph/verification.json`)

```jsonc
{
  "$schema": "./verification.schema.json",

  // Global defaults — applied to ALL tasks unless overridden
  "defaults": {
    "verifiers": ["checkbox", "tsc"],
    "autoClassify": true,
    "autoClassifyRules": [
      { "keyword": "test",     "add": ["vitest"] },
      { "keyword": "lint",     "add": ["commandExitCode"], "args": { "command": "npm run lint" } },
      { "keyword": "deploy",   "add": ["commandExitCode"], "args": { "command": "npm run build" } },
      { "keyword": "security", "add": ["commandExitCode"], "args": { "command": "npm audit --audit-level=high" } }
    ]
  },

  // Presets — shorthand aliases for verifier sets
  "presets": {
    "tdd":           ["checkbox", "tsc", "vitest"],
    "checkbox-only": ["checkbox"],
    "full":          ["checkbox", "tsc", "vitest", "diff"],
    "none":          []
  },

  // Named templates — referenced via @name in PRD lines
  "templates": {
    "api-endpoint": {
      "verifiers": [
        { "type": "checkbox" },
        { "type": "tsc" },
        { "type": "vitest" },
        { "type": "fileExists", "args": { "path": "src/routes/${taskId}.ts" } },
        { "type": "commandExitCode", "args": { "command": "npm run test:api" } }
      ]
    },
    "database-migration": {
      "verifiers": [
        { "type": "checkbox" },
        { "type": "tsc" },
        { "type": "commandExitCode", "args": { "command": "npx prisma validate" } },
        { "type": "vitest" }
      ]
    },
    "knowledge-pipeline": {
      "verifiers": [
        { "type": "checkbox" },
        { "type": "tsc" },
        { "type": "vitest" },
        { "type": "fileContains", "args": { "path": "src/knowledge.ts", "content": "Pipeline" } }
      ]
    }
  },

  // Per-task overrides — keyed by task ID or glob pattern
  "tasks": {
    "Task-057": {
      "add": ["fileExists"],
      "addArgs": { "fileExists": { "path": "src/contextBudget.ts" } },
      "remove": []
    },
    "Task-067": {
      "preset": "checkbox-only"
    },
    "Task-063": {
      "remove": ["diff"]
    },
    // Glob patterns for bulk overrides
    "Task-06*": {
      "add": ["vitest"]
    }
  }
}
```

### 2.4 TypeScript Type Definitions

```typescript
// --- New types for per-task DSL ---

/** Parsed inline verification directive from PRD task line */
export interface TaskVerifyDirective {
  /** Verifiers to include (explicit or from preset) */
  include: VerifierConfig[];
  /** Verifier types to exclude (- prefix) */
  exclude: string[];
  /** Preset name if used (e.g., 'tdd', 'checkbox-only') */
  preset?: string;
  /** Template reference if used (e.g., 'api-endpoint') */
  templateRef?: string;
}

/** Auto-classify rule for keyword-based verifier injection */
export interface AutoClassifyRule {
  keyword: string;
  add: string[];
  args?: Record<string, string>;
}

/** Verification presets — named shorthand for verifier sets */
export type VerificationPresets = Record<string, string[]>;

/** Per-task override in config file */
export interface TaskVerifyOverride {
  preset?: string;
  add?: string[];
  addArgs?: Record<string, Record<string, string>>;
  remove?: string[];
}

/** Full verification config file schema */
export interface VerificationConfigFile {
  defaults: {
    verifiers: string[];
    autoClassify: boolean;
    autoClassifyRules: AutoClassifyRule[];
  };
  presets: VerificationPresets;
  templates: Record<string, { verifiers: VerifierConfig[] }>;
  tasks: Record<string, TaskVerifyOverride>;
}

// Extend existing Task interface
export interface Task {
  // ... existing fields ...
  readonly verifyDirective?: TaskVerifyDirective;
}
```

---

## 3. Resolution Cascade

### 5-Level Priority Order (highest wins)

```
Level 1: Inline PRD directive    → Verify: tsc, vitest, -diff
Level 2: Config per-task         .ralph/verification.json → tasks["Task-057"]
Level 3: Template reference      → Verify: @api-endpoint  OR  templates matched by name
Level 4: Global defaults         .ralph/verification.json → defaults  OR  config.verifiers
Level 5: Hardcoded defaults      [checkbox, tsc]  +  auto-classify
```

### Resolution Algorithm: `resolveVerifiers` v2

```typescript
export function resolveVerifiersV2(
  task: Task,
  config: RalphConfig,
  verificationFile: VerificationConfigFile | null,
  registry: VerifierRegistry,
): VerifierConfig[] {

  // --- Step 1: Determine base verifier set ---
  let base: VerifierConfig[];
  let source: string;

  // Level 1: Inline PRD directive with preset
  if (task.verifyDirective?.preset) {
    const presetVerifiers = resolvePreset(task.verifyDirective.preset, verificationFile);
    if (presetVerifiers) {
      base = presetVerifiers.map(type => ({ type }));
      source = 'inline-preset';
    }
  }

  // Level 1: Inline PRD directive with template ref
  if (!base && task.verifyDirective?.templateRef) {
    const tmpl = verificationFile?.templates[task.verifyDirective.templateRef];
    if (tmpl) {
      base = [...tmpl.verifiers];
      source = 'inline-template-ref';
    }
  }

  // Level 1: Inline PRD directive with explicit verifiers (no preset/template)
  if (!base && task.verifyDirective?.include.length) {
    base = [...task.verifyDirective.include];
    source = 'inline-explicit';
  }

  // Level 2: Config per-task override
  if (!base && verificationFile?.tasks) {
    const override = matchTaskOverride(task.taskId, verificationFile.tasks);
    if (override) {
      if (override.preset) {
        const presetV = resolvePreset(override.preset, verificationFile);
        base = presetV ? presetV.map(type => ({ type })) : undefined;
      }
      // If override only has add/remove, fall through to apply on top of defaults
      source = 'config-per-task';
    }
  }

  // Level 3: Template match by description substring (existing behavior)
  if (!base && verificationFile?.templates) {
    const descLower = task.description.toLowerCase();
    for (const [name, tmpl] of Object.entries(verificationFile.templates)) {
      if (descLower.includes(name.toLowerCase())) {
        base = [...tmpl.verifiers];
        source = 'template-match';
        break;
      }
    }
  }
  // Also check legacy config.verificationTemplates
  if (!base && config.verificationTemplates) {
    const descLower = task.description.toLowerCase();
    for (const tmpl of config.verificationTemplates) {
      if (descLower.includes(tmpl.name.toLowerCase())) {
        base = [...tmpl.verifiers];
        source = 'legacy-template';
        break;
      }
    }
  }

  // Level 4: Global defaults from verification file
  if (!base && verificationFile?.defaults) {
    base = verificationFile.defaults.verifiers.map(type => ({ type }));
    source = 'config-defaults';
  }

  // Level 4: Global config.verifiers (legacy)
  if (!base && config.verifiers?.length) {
    base = [...config.verifiers];
    source = 'legacy-global';
  }

  // Level 5: Hardcoded defaults
  if (!base) {
    base = [{ type: 'checkbox' }, { type: 'tsc' }];
    source = 'hardcoded';
  }

  // --- Step 2: Apply auto-classification (additive) ---
  if (verificationFile?.defaults.autoClassify) {
    for (const rule of verificationFile.defaults.autoClassifyRules) {
      if (task.description.toLowerCase().includes(rule.keyword)) {
        for (const verifierType of rule.add) {
          if (!base.some(v => v.type === verifierType)) {
            base.push({ type: verifierType, args: rule.args });
          }
        }
      }
    }
  } else if (config.autoClassifyTasks) {
    // Legacy auto-classify
    if (task.description.toLowerCase().includes('test')) {
      if (!base.some(v => v.type === 'vitest')) {
        base.push({ type: 'vitest' });
      }
    }
  }

  // --- Step 3: Apply per-task additive overrides (Level 2 add/remove) ---
  if (verificationFile?.tasks) {
    const override = matchTaskOverride(task.taskId, verificationFile.tasks);
    if (override && !override.preset) {
      // Add
      for (const addType of override.add ?? []) {
        if (!base.some(v => v.type === addType)) {
          const args = override.addArgs?.[addType];
          base.push({ type: addType, args });
        }
      }
      // Remove
      for (const removeType of override.remove ?? []) {
        base = base.filter(v => v.type !== removeType);
      }
    }
  }

  // --- Step 4: Apply inline exclusions (always highest priority) ---
  if (task.verifyDirective?.exclude.length) {
    base = base.filter(v => !task.verifyDirective!.exclude.includes(v.type));
  }

  // --- Step 5: Validate all verifier types exist in registry ---
  for (const v of base) {
    registry.get(v.type); // throws if unknown
  }

  return base;
}
```

### Helper Functions

```typescript
/** Match task ID against override keys (exact match or glob) */
function matchTaskOverride(
  taskId: string,
  tasks: Record<string, TaskVerifyOverride>,
): TaskVerifyOverride | undefined {
  // Exact match first
  if (tasks[taskId]) return tasks[taskId];
  // Glob match (simple * wildcard)
  for (const [pattern, override] of Object.entries(tasks)) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(taskId)) return override;
    }
  }
  return undefined;
}

/** Resolve a preset name to verifier type list */
function resolvePreset(
  name: string,
  verificationFile: VerificationConfigFile | null,
): string[] | undefined {
  const builtins: Record<string, string[]> = {
    'tdd': ['checkbox', 'tsc', 'vitest'],
    'checkbox-only': ['checkbox'],
    'full': ['checkbox', 'tsc', 'vitest', 'diff'],
    'none': [],
  };
  return verificationFile?.presets[name] ?? builtins[name];
}
```

---

## 4. PRD Parsing Integration

### Parsing `→ Verify:` Directives in `src/prd.ts`

```typescript
const VERIFY_DIRECTIVE = /→\s*Verify:\s*(.+?)(?:\s*→|$)/i;

export function parseVerifyDirective(description: string): TaskVerifyDirective | undefined {
  const match = VERIFY_DIRECTIVE.exec(description);
  if (!match) return undefined;

  const raw = match[1].trim();
  const tokens = raw.split(',').map(t => t.trim()).filter(Boolean);

  const include: VerifierConfig[] = [];
  const exclude: string[] = [];
  let preset: string | undefined;
  let templateRef: string | undefined;

  for (const token of tokens) {
    // Template reference: @name
    if (token.startsWith('@')) {
      templateRef = token.slice(1);
      continue;
    }
    // Exclusion: -type
    if (token.startsWith('-')) {
      exclude.push(token.slice(1));
      continue;
    }
    // Preset: known preset name (no parens)
    if (['tdd', 'checkbox-only', 'full', 'none'].includes(token) || token.match(/^[a-z-]+$/) && !token.includes('(')) {
      // Could be a preset or a simple verifier type
      // Presets are resolved later; treat as preset if it's a known name
      if (['tdd', 'checkbox-only', 'full', 'none'].includes(token)) {
        preset = token;
        continue;
      }
    }
    // Parameterized verifier: type(key=val, key=val)
    const paramMatch = /^(\+?)(\w+)\((.+)\)$/.exec(token);
    if (paramMatch) {
      const type = paramMatch[2];
      const argsStr = paramMatch[3];
      const args: Record<string, string> = {};
      for (const pair of argsStr.split(',').map(p => p.trim())) {
        const [k, ...vParts] = pair.split('=');
        args[k.trim()] = vParts.join('=').trim();
      }
      include.push({ type, args });
      continue;
    }
    // Simple verifier: type or +type
    const stripped = token.startsWith('+') ? token.slice(1) : token;
    include.push({ type: stripped });
  }

  return { include, exclude, preset, templateRef };
}
```

In `parsePrd()`, after extracting the description, strip the `→ Verify:` portion from the stored description (so it doesn't pollute the prompt) and attach the parsed directive to the Task object:

```typescript
// In parsePrd(), after description extraction:
const verifyDirective = parseVerifyDirective(description);
const cleanDescription = description.replace(/→\s*Verify:.+$/, '').trim();
```

---

## 5. Auto-Classification Logic

### Current (v1 — Hardcoded)

```typescript
if (config.autoClassifyTasks && descLower.includes('test')) {
  defaults.push({ type: 'vitest' });
}
```

### Proposed (v2 — Configurable Rules)

Auto-classification becomes a configurable rule engine in `.ralph/verification.json`:

```jsonc
"autoClassifyRules": [
  // Keyword-based rules (run in order, all matching rules apply)
  { "keyword": "test",       "add": ["vitest"] },
  { "keyword": "lint",       "add": ["commandExitCode"], "args": { "command": "npm run lint" } },
  { "keyword": "migration",  "add": ["commandExitCode"], "args": { "command": "npx prisma validate" } },
  { "keyword": "api",        "add": ["commandExitCode"], "args": { "command": "npm run test:api" } },
  { "keyword": "security",   "add": ["commandExitCode"], "args": { "command": "npm audit" } },
  { "keyword": "deploy",     "add": ["commandExitCode"], "args": { "command": "npm run build" } }
]
```

**Auto-analyze** behavior: Classification rules are applied additively after the base verifier set is determined. Multiple rules can match the same task. Rules never **remove** verifiers — only `exclude` directives and `remove` overrides can do that.

**Priority**: Auto-classify runs BEFORE per-task `add`/`remove` and BEFORE inline `exclude`, so both can override its results.

---

## 6. Enable/Disable Individual Verifiers Per Task

### Three Mechanisms

| Mechanism | Syntax | Location | Scope |
|-----------|--------|----------|-------|
| **Inline exclude** | `→ Verify: -vitest` | PRD.md | Single task |
| **Config remove** | `"remove": ["vitest"]` | .ralph/verification.json tasks | Single task or glob |
| **Preset override** | `→ Verify: checkbox-only` | PRD.md | Single task (replaces all) |

### Examples

```markdown
# Disable vitest for a task that only touches config  
- [ ] Update package.json metadata → Verify: tsc, -vitest

# Use only checkbox (escape hatch for non-code tasks)
- [ ] Update README documentation → Verify: checkbox-only

# Add a custom verifier AND disable tsc (e.g., shell-only task)
- [ ] Fix nginx config → Verify: -tsc, commandExitCode(command=nginx -t)

# Disable all verification (requires explicit "none" — intentional friction)  
- [ ] Experimental prototype → Verify: none
```

### In Config File

```jsonc
{
  "tasks": {
    // Disable vitest for documentation tasks
    "Task-071": { "remove": ["vitest"] },
    
    // All Phase 9d tasks: add filesystem check, no diff required
    "Task-06*": { "add": ["fileExists"], "remove": ["diff"] },
    
    // Single task: full override via preset
    "Task-067": { "preset": "checkbox-only" }
  }
}
```

---

## 7. Composition with Existing System

### Backward Compatibility

The existing `resolveVerifiers` in `src/verify.ts` continues to work as-is for projects without `.ralph/verification.json` or `→ Verify:` directives:

```
No verification.json + No inline directives = Current behavior exactly  
↓ config.verifiers? → use them  
↓ config.verificationTemplates? → match by name  
↓ defaults [checkbox, tsc] + autoClassify  
```

### Migration Path

1. **Phase 1** (non-breaking): Add `parseVerifyDirective()` to `src/prd.ts`, parse `→ Verify:` lines, attach `verifyDirective` to `Task` objects. `resolveVerifiers` unchanged — directive is ignored until Phase 2.

2. **Phase 2** (non-breaking): Add `loadVerificationConfig()` to read `.ralph/verification.json`. Add `resolveVerifiersV2()` alongside `resolveVerifiers`. Use V2 in orchestrator when either config file or task directives exist; fall back to V1 otherwise.

3. **Phase 3** (non-breaking): Deprecate `config.verifiers`, `config.verificationTemplates`, `config.autoClassifyTasks` in `RalphConfig` — read them as fallbacks in V2 cascade but log deprecation warnings.

### Interaction with Existing Features

| Feature | Interaction |
|---------|-------------|
| `VerifierConfig.stages` | Unchanged — stages filter WHEN verifiers run, DSL filters WHICH verifiers run |
| `VerificationTemplate` | Templates in config file supersede legacy `RalphConfig.verificationTemplates` |
| `autoClassifyTasks` | Legacy boolean replaced by `autoClassifyRules` array; boolean maps to `[{keyword:"test", add:["vitest"]}]` |
| `computeConfidenceScore` | Unchanged — operates on final `VerifyCheck[]` output |
| `dualExitGateCheck` | Unchanged — operates on final `VerifyCheck[]` output |
| `runVerifierChain` | Unchanged — takes resolved `VerifierConfig[]` and runs them |
| `VerifierRegistry` | Unchanged — DSL references verifier types by name; registry validates they exist |
| `PreCompleteHookConfig` | Orthogonal — PreComplete hooks run AFTER verifiers pass |
| `CircuitBreaker` chain | Orthogonal — breakers make loop-level decisions; verifiers make task-level decisions |

---

## 8. Config File Loading

### Location and Discovery

```typescript
// src/verificationConfig.ts — new file
import * as fs from 'fs';
import * as path from 'path';

export function loadVerificationConfig(workspaceRoot: string): VerificationConfigFile | null {
  const configPath = path.join(workspaceRoot, '.ralph', 'verification.json');
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as VerificationConfigFile;
}
```

### Default TDD Config

When `.ralph/verification.json` doesn't exist, the system uses built-in defaults equivalent to:

```jsonc
{
  "defaults": {
    "verifiers": ["checkbox", "tsc"],
    "autoClassify": false,
    "autoClassifyRules": []
  },
  "presets": {
    "tdd": ["checkbox", "tsc", "vitest"],
    "checkbox-only": ["checkbox"],
    "full": ["checkbox", "tsc", "vitest", "diff"],
    "none": []
  },
  "templates": {},
  "tasks": {}
}
```

To make TDD the default (as requested), users add to their config:

```jsonc
{
  "defaults": {
    "verifiers": ["checkbox", "tsc", "vitest"],
    "autoClassify": true,
    "autoClassifyRules": [
      { "keyword": "test", "add": ["vitest"] }
    ]
  }
}
```

---

## 9. Visual Summary: Resolution Flow

```
                    PRD.md Task Line
                         │
             ┌───────────┴───────────┐
             │ parseVerifyDirective() │
             └───────────┬───────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  Has inline preset? │──yes──▶ Resolve preset → base
              └─────────┬──────────┘
                        no
                        ▼
              ┌─────────────────────┐
              │ Has @template ref?  │──yes──▶ Lookup template → base
              └─────────┬──────────┘
                        no
                        ▼
              ┌─────────────────────┐
              │ Has explicit types? │──yes──▶ Use as base
              └─────────┬──────────┘
                        no
                        ▼
              ┌─────────────────────┐
              │ Config per-task     │──yes──▶ Apply override → base
              │ tasks[Task-NNN]?    │
              └─────────┬──────────┘
                        no
                        ▼
              ┌─────────────────────┐
              │ Template match by   │──yes──▶ Use template → base
              │ description?        │
              └─────────┬──────────┘
                        no
                        ▼
              ┌─────────────────────┐
              │ Global defaults     │──yes──▶ Use defaults → base
              │ from config file?   │
              └─────────┬──────────┘
                        no
                        ▼
              ┌─────────────────────┐
              │ Hardcoded defaults  │──────▶ [checkbox, tsc] → base
              └─────────┬──────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │ Auto-classify rules │──────▶ Add matching verifiers
              └─────────┬──────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │ Config add/remove   │──────▶ Apply per-task add/remove
              └─────────┬──────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │ Inline excludes (-) │──────▶ Remove excluded types
              └─────────┬──────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │ Validate registry   │──────▶ Throw if unknown type
              └─────────┬──────────┘
                        │
                        ▼
                 Final VerifierConfig[]
                        │
                        ▼
               runVerifierChain()
```

---

## 10. Implementation Recommendations

### Implementation as PRD Tasks

```markdown
- [ ] **Task 75 — Parse Verify Directive**: In `src/prd.ts`, add `parseVerifyDirective()` function and integrate into `parsePrd()`. Attach `verifyDirective` to Task interface. Strip `→ Verify:` from stored description. Write tests FIRST.

- [ ] **Task 76 — Verification Config File**: Create `src/verificationConfig.ts` with `loadVerificationConfig()`, `VerificationConfigFile` type, and `matchTaskOverride()`. Add `.ralph/verification.json` to `.gitignore` template. Write tests FIRST.

- [ ] **Task 77 — resolveVerifiers v2**: In `src/verify.ts`, add `resolveVerifiersV2()` implementing the 5-level cascade. Backward compatible — falls back to v1 behavior when no config file or directives exist. Wire into orchestrator. Write tests FIRST.

- [ ] **Task 78 — Auto-Classify Rules Engine**: Replace hardcoded auto-classify with configurable `autoClassifyRules` array. Support keyword matching and parameterized verifier injection. Write tests FIRST.
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `→ Verify:` syntax (not YAML frontmatter) | Keeps PRD.md purely markdown; `→` prefix is established pattern |
| JSON config (not YAML) | Consistent with `package.json` and VS Code settings; no extra parser needed |
| Additive-first composition | Prevents accidental removal of safety verifiers; explicit `-` required to remove |
| `none` preset requires explicit opt-in | Intentional friction against skipping all verification |
| Glob patterns in task overrides | Enables bulk configuration for task ranges without listing each one |
| Inline excludes applied last | Highest priority — user can always override any automatic decision |
| Separate `verifyDirective` field on Task | Clean separation; doesn't pollute `description` used in prompts |

---

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PRD lines become too long | Readability | Encourage `@template` references for complex configs; inline for simple cases |
| Unknown verifier type in directive | Runtime crash | `registry.get()` validation in `resolveVerifiersV2`; clear error message |
| Config file JSON syntax errors | Startup failure | `loadVerificationConfig` returns null on parse error + logs warning |
| `none` preset bypasses all safety | False completions | Log warning when `none` is resolved; require `--allow-none` in strict mode |
| Glob patterns match unintended tasks | Wrong verifiers | Exact match takes priority; document glob behavior |
