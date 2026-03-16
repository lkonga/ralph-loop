# Research Report 9: Inline Task Verification Spec System (`→ Verify:`)

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Design the `→ Verify:` DSL for inline task verification — auto-classification, manual override, composability with existing VerifierRegistry and 7 builtin verifiers.

---

## 1. Existing Patterns Analysis

### 1.1 `→ Spec:` Parser (prompt.ts L91-95) — The Template

```ts
export function extractSpecReference(taskDescription: string): {
  filePath: string; startLine: number; endLine: number
} | null {
  const match = taskDescription.match(/→\s*Spec:\s*`?([^`\s]+)`?\s+L(\d+)-L(\d+)/);
  if (!match) { return null; }
  return { filePath: match[1], startLine: parseInt(match[2], 10), endLine: parseInt(match[3], 10) };
}
```

Key characteristics:
- **DSL parsing**, not LLM classification — deterministic regex
- Arrow `→` prefix as namespace separator
- Single-line, inline within task description
- Returns structured data or `null`
- Used downstream by `buildSpecContextLine()` which reads the spec file and extracts frontmatter

### 1.2 `resolveVerifiers` Current Logic (verify.ts L96-121)

Resolution cascade (highest priority first):
1. **Explicit `config.verifiers`** — global override from `ralph.config`, applies to ALL tasks
2. **`verificationTemplates`** — name-matching against task description (case-insensitive `includes()`)
3. **Default `[checkbox, tsc]`** — always present
4. **Auto-classification** (`autoClassifyTasks: true`) — keyword matching ("test" → add vitest)

Problems with current approach:
- **No per-task override** — `config.verifiers` is global, templates are coarse
- **Keyword matching is fragile** — only checks `includes('test')`, no other heuristics
- **No composability DSL** — can't say "run tsc + vitest + fileExists for THIS task"
- **Templates are config-level**, not task-level — can't inline them in PRD.md

### 1.3 Existing 7 Verifier Types

| Type | Args | Purpose |
|------|------|---------|
| `checkbox` | `prdPath?` | PRD checkbox is marked `[x]` |
| `fileExists` | `path` | File exists at path |
| `fileContains` | `path`, `content` | File contains substring |
| `commandExitCode` | `command` | Shell command exits 0 |
| `tsc` | — | `npx tsc --noEmit` passes |
| `vitest` | — | `npx vitest run` passes |
| `custom` | `command` | Shell command via `/bin/sh` |

### 1.4 Type Definitions

```ts
interface VerifierConfig {
  type: string;
  args?: Record<string, string>;
  stages?: string[];
}

interface VerificationTemplate {
  name: string;
  verifiers: VerifierConfig[];
}
```

---

## 2. Design: `→ Verify:` DSL

### 2.1 Syntax Definition

```
→ Verify: <verifier>[:<arg1>=<val1>,<arg2>=<val2>] [, <verifier>[:<args>]]*
```

Examples in PRD.md task descriptions:

```markdown
- [ ] Implement auth module → Verify: tsc, vitest, fileExists:path=src/auth.ts
- [ ] Add config schema → Verify: tsc, fileContains:path=src/types.ts,content=AuthConfig
- [ ] Deploy script → Verify: commandExitCode:command=./deploy.sh --dry-run
- [ ] Quick fix → Verify: checkbox
- [ ] Complex validation → Verify: tsc, vitest, custom:command=npm run lint
```

### 2.2 Grammar (EBNF)

```ebnf
verify_directive = "→" SP "Verify:" SP verifier_list ;
verifier_list    = verifier_entry ("," SP verifier_entry)* ;
verifier_entry   = type_name [":" arg_list] ;
type_name        = IDENTIFIER ;
arg_list         = arg ("," arg)* ;
arg              = key "=" value ;
key              = IDENTIFIER ;
value            = CHAR+ ;  (* no commas, no spaces unless quoted *)
```

### 2.3 Parser Function

```ts
export interface InlineVerifyDirective {
  verifiers: VerifierConfig[];
}

export function extractVerifyDirective(
  taskDescription: string
): InlineVerifyDirective | null {
  // Match → Verify: ... (everything after the directive to end of line)
  const match = taskDescription.match(/→\s*Verify:\s*(.+)$/m);
  if (!match) { return null; }

  const raw = match[1].trim();
  const verifiers: VerifierConfig[] = [];

  // Split on comma-space to get individual verifier entries
  // Use regex split to handle "command=echo hello" (spaces inside values)
  const entries = splitVerifierEntries(raw);

  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) {
      // No args — bare verifier name like "tsc" or "vitest"
      verifiers.push({ type: entry.trim() });
    } else {
      const type = entry.slice(0, colonIdx).trim();
      const argsStr = entry.slice(colonIdx + 1).trim();
      const args = parseVerifierArgs(argsStr);
      verifiers.push({ type, args });
    }
  }

  return verifiers.length > 0 ? { verifiers } : null;
}

function splitVerifierEntries(raw: string): string[] {
  // Split on ", " but not within key=value where value contains commas
  // Strategy: split on ", " where the next token starts with a known verifier
  // Simpler: split on /,\s+(?=[a-zA-Z])/ — comma followed by whitespace
  // then letter (start of next verifier type name)
  return raw.split(/,\s+(?=[a-zA-Z])/);
}

function parseVerifierArgs(argsStr: string): Record<string, string> {
  const args: Record<string, string> = {};
  // Split on "," only when followed by key= pattern
  const parts = argsStr.split(/,(?=[a-zA-Z]+=)/);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) {
      args[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim();
    }
  }
  return args;
}
```

### 2.4 Stripping the Directive from Task Description

The `→ Verify:` suffix should be stripped from the task description before it's sent to the LLM prompt (same pattern as `→ Spec:` being extracted then used separately):

```ts
export function stripVerifyDirective(taskDescription: string): string {
  return taskDescription.replace(/\s*→\s*Verify:\s*.+$/m, '').trim();
}
```

---

## 3. Integration with `resolveVerifiers`

### 3.1 Updated Resolution Cascade

The `→ Verify:` directive becomes the **highest per-task priority**, slotting in above global config:

```
Priority 1: → Verify: DSL in task description (per-task, explicit, inline)
Priority 2: config.verifiers (global explicit override)
Priority 3: verificationTemplates (category matching)
Priority 4: defaults [checkbox, tsc] + autoClassify additions
```

### 3.2 Updated `resolveVerifiers` Function

```ts
export function resolveVerifiers(
  task: Task,
  config: RalphConfig,
  registry: VerifierRegistry
): VerifierConfig[] {
  // Priority 1: Inline → Verify: directive in task description
  const inlineDirective = extractVerifyDirective(task.description);
  if (inlineDirective) {
    // Always prepend checkbox — it's the fundamental completion signal
    const hasCheckbox = inlineDirective.verifiers.some(v => v.type === 'checkbox');
    return hasCheckbox
      ? inlineDirective.verifiers
      : [{ type: 'checkbox' }, ...inlineDirective.verifiers];
  }

  // Priority 2: Explicit global verifiers from config
  if (config.verifiers && config.verifiers.length > 0) {
    return config.verifiers;
  }

  // Priority 3: Template matching by task description keywords
  if (config.verificationTemplates) {
    const descLower = task.description.toLowerCase();
    for (const tmpl of config.verificationTemplates) {
      if (descLower.includes(tmpl.name.toLowerCase())) {
        return tmpl.verifiers;
      }
    }
  }

  // Priority 4: Defaults + auto-classification
  const defaults: VerifierConfig[] = [{ type: 'checkbox' }, { type: 'tsc' }];
  if (config.autoClassifyTasks) {
    const descLower = task.description.toLowerCase();
    if (descLower.includes('test')) {
      defaults.push({ type: 'vitest' });
    }
  }

  return defaults;
}
```

### 3.3 Validation Against Registry

Add a validation step to catch typos — DSL references a verifier that doesn't exist:

```ts
export function validateVerifierConfigs(
  configs: VerifierConfig[],
  registry: VerifierRegistry
): { valid: boolean; unknownTypes: string[] } {
  const unknownTypes: string[] = [];
  for (const config of configs) {
    try {
      registry.get(config.type);
    } catch {
      unknownTypes.push(config.type);
    }
  }
  return { valid: unknownTypes.length === 0, unknownTypes };
}
```

---

## 4. Decision: DSL Parsing vs LLM Classification

### Recommendation: **DSL Parsing Only (no LLM)**

| Criterion | DSL Parsing | LLM Classification |
|-----------|-------------|---------------------|
| Determinism | ✅ 100% reproducible | ❌ Non-deterministic |
| Speed | ✅ ~0ms regex | ❌ 500ms-3s API call |
| Cost | ✅ Free | ❌ Token cost per task |
| Debuggability | ✅ Regex match or not | ❌ Opaque |
| Offline | ✅ Works offline | ❌ Requires API |
| Composability | ✅ Explicit, testable | ⚠️ Prompt engineering |

**Rationale**: The existing `extractSpecReference` proves DSL parsing works well for ralph-loop's architecture. The verifier system is inherently deterministic (machine verification, not LLM judgment). Adding an LLM call to decide which verifiers to run would be:
- Circular (using LLM to verify LLM work, then needing to verify the verification)
- Slow (adds latency to every task resolution)
- Unnecessary (the 7 verifiers map cleanly to simple keywords)

The existing `autoClassifyTasks` keyword matching is the appropriate level of intelligence — it's a lightweight heuristic, not a model call.

### Enhanced Auto-Classification (Still No LLM)

Extend the keyword matching in `resolveVerifiers` defaults path to cover more patterns:

```ts
// Enhanced auto-classification heuristics (no LLM needed)
const AUTO_CLASSIFY_RULES: Array<{
  pattern: RegExp;
  verifier: VerifierConfig;
}> = [
  { pattern: /\btest/i,                    verifier: { type: 'vitest' } },
  { pattern: /\bcreate\s+file|add\s+file/i, verifier: { type: 'fileExists' } },
  { pattern: /\bdeploy|script|migration/i, verifier: { type: 'commandExitCode' } },
];
```

This keeps auto-classification deterministic while covering more cases, and `→ Verify:` provides the escape hatch for anything the heuristics miss.

---

## 5. Composability with Existing System

### 5.1 How `→ Verify:` Composes with Each Layer

```
PRD.md Task:
  "- [ ] Implement auth → Verify: tsc, vitest, fileExists:path=src/auth.ts"
       │
       ▼
  extractVerifyDirective() → [tsc, vitest, fileExists]
       │
       ▼
  resolveVerifiers() returns inline directive (Priority 1)
       │
       ▼  (checkbox auto-prepended)
  [checkbox, tsc, vitest, fileExists:path=src/auth.ts]
       │
       ▼
  runVerifierChain() → executes all 4 verifiers
       │
       ▼
  computeConfidenceScore() → weighted score
       │
       ▼
  dualExitGateCheck() → canComplete: true/false
```

### 5.2 Interaction with `→ Spec:` Directives

Both can coexist on the same task:

```markdown
- [ ] Implement circuit breaker → Spec: docs/specs/003.md L1-L45 → Verify: tsc, vitest, fileExists:path=src/circuitBreaker.ts
```

Parsing is independent — `extractSpecReference()` and `extractVerifyDirective()` use different regex patterns and don't interfere. The spec provides *what* to build; the verify directive defines *how to confirm* it's built.

### 5.3 Interaction with `verificationTemplates` (Config-Level)

Templates remain useful for project-wide defaults ("all tasks matching 'deploy' use this verifier chain"). The `→ Verify:` directive lets individual tasks override templates when needed.

### 5.4 Interaction with `confidenceThreshold` and Confidence Scoring

The existing `computeConfidenceScore()` already handles arbitrary `VerifyCheck[]` arrays with named weights. New verifier types from `→ Verify:` directives score based on the same weight map:

```ts
const CONFIDENCE_WEIGHTS: Record<string, number> = {
  checkbox: 100,
  vitest: 20,
  tsc: 20,
  diff: 20,
  no_errors: 10,
  progress_updated: 10,
  fileExists: 10,        // NEW
  fileContains: 10,      // NEW
  commandExitCode: 15,   // NEW
  custom: 15,            // NEW
};
```

### 5.5 Interaction with `stages` Field

`VerifierConfig` already has an optional `stages?: string[]` field. The DSL can be extended to support stages:

```
→ Verify: tsc@pre, vitest@post, fileExists:path=src/auth.ts@pre
```

This is a future extension point — not required for initial implementation.

---

## 6. Complete Integration Plan

### 6.1 Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `src/prompt.ts` | Add `extractVerifyDirective()`, `stripVerifyDirective()` | New functions |
| `src/verify.ts` | Update `resolveVerifiers()` to check inline directive first | Modify existing function |
| `src/types.ts` | Add `InlineVerifyDirective` interface | New type |
| `src/prompt.ts` | Strip `→ Verify:` from task description before LLM prompt | Modify `buildPrompt()` |
| `test/verify.test.ts` | Add tests for inline directive resolution | New test cases |
| `test/prompt.test.ts` | Add tests for `extractVerifyDirective()` parser | New test cases |

### 6.2 Example Test Cases

```ts
describe('extractVerifyDirective', () => {
  it('parses bare verifier names', () => {
    const result = extractVerifyDirective('Build auth → Verify: tsc, vitest');
    expect(result).toEqual({
      verifiers: [{ type: 'tsc' }, { type: 'vitest' }]
    });
  });

  it('parses verifiers with args', () => {
    const result = extractVerifyDirective(
      'Create file → Verify: fileExists:path=src/foo.ts'
    );
    expect(result).toEqual({
      verifiers: [{ type: 'fileExists', args: { path: 'src/foo.ts' } }]
    });
  });

  it('parses mixed bare and args', () => {
    const result = extractVerifyDirective(
      'Task → Verify: tsc, vitest, fileExists:path=src/foo.ts'
    );
    expect(result!.verifiers).toHaveLength(3);
  });

  it('returns null when no directive', () => {
    expect(extractVerifyDirective('Regular task description')).toBeNull();
  });

  it('coexists with → Spec: directive', () => {
    const desc = 'Task → Spec: docs/spec.md L1-L20 → Verify: tsc';
    expect(extractVerifyDirective(desc)).toEqual({
      verifiers: [{ type: 'tsc' }]
    });
  });
});

describe('resolveVerifiers with inline directive', () => {
  it('uses inline directive as highest priority', () => {
    const task = makeTask({
      description: 'Build X → Verify: vitest, fileExists:path=src/x.ts'
    });
    const config = {
      ...DEFAULT_CONFIG,
      workspaceRoot: '/tmp',
      verifiers: [{ type: 'tsc' }], // would normally override
    } as RalphConfig;
    const result = resolveVerifiers(task, config, createBuiltinRegistry());
    // Inline directive wins over config.verifiers
    expect(result[0].type).toBe('checkbox'); // auto-prepended
    expect(result[1].type).toBe('vitest');
    expect(result[2].type).toBe('fileExists');
  });
});
```

---

## 7. Edge Cases and Error Handling

| Edge Case | Handling |
|-----------|----------|
| Unknown verifier type in DSL | `validateVerifierConfigs()` catches at resolution time; log warning, skip unknown type or fail task |
| Empty `→ Verify:` | Return `null` from parser → fall through to next priority |
| Multiple `→ Verify:` on one line | Only match last one (regex is greedy from `→ Verify:` to EOL) |
| Arg values with spaces | Use `command=echo hello world` — split on `,(?=[a-zA-Z]+=)` preserves spaces in values |
| Both `→ Spec:` and `→ Verify:` | Independent parsers, both extract from same description string |
| `checkbox` explicitly omitted from DSL | Auto-prepended — it's the fundamental completion signal |
| `→ Verify: checkbox` only | Valid — minimal verification, just PRD checkbox check |

---

## 8. Summary

The `→ Verify:` system is a **deterministic DSL parser** (not LLM classification) that provides per-task verifier override inline in PRD.md task descriptions. It:

1. **Follows the `→ Spec:` pattern** — regex extraction from task description, structured output
2. **Slots as Priority 1** in `resolveVerifiers()` — above global config and templates
3. **Composes with all 7 existing verifiers** — same `VerifierConfig` structure, same registry
4. **Auto-prepends `checkbox`** — the fundamental completion signal is never skippable
5. **No LLM involvement** — deterministic, fast, free, debuggable
6. **Preserves backward compatibility** — tasks without `→ Verify:` use existing resolution cascade unchanged
