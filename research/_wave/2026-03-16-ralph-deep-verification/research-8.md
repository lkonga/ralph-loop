# Research Report 8: resolveVerifiers & runVerifierChain — Dead Code Analysis

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: What exactly do resolveVerifiers and runVerifierChain do today? Show the full code, explain the composability/chaining/enable-disable mechanics, and what "not wired" means concretely.
**Date**: 2026-03-16

---

## 1. Full Code of the Verifier System

### 1.1 Type Definitions (`src/types.ts` L440–451)

```ts
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
```

`RalphConfig` has two optional fields (L371–372):
```ts
verifiers?: VerifierConfig[];
verificationTemplates?: VerificationTemplate[];
```

### 1.2 VerifierRegistry (`src/verify.ts` L7–19)

```ts
export class VerifierRegistry {
    private registry = new Map<string, VerifierFn>();
    register(type: string, fn: VerifierFn): void { this.registry.set(type, fn); }
    get(type: string): VerifierFn {
        const fn = this.registry.get(type);
        if (!fn) { throw new Error(`Unknown verifier type: ${type}`); }
        return fn;
    }
}
```

Classic type-keyed registry. Extensible via `register()` before passing to chain runner.

### 1.3 Built-in Verifiers (`createBuiltinRegistry`, L21–85)

7 built-in verifiers registered:

| Type | What it does | Args |
|------|-------------|------|
| `checkbox` | Reads PRD.md, checks if task is marked `[x]` | `prdPath?` |
| `fileExists` | `fs.existsSync(workspaceRoot + args.path)` | `path` |
| `fileContains` | Reads file, checks `.includes(args.content)` | `path`, `content` |
| `commandExitCode` | `execSync(args.command)`, pass on exit 0 | `command` |
| `tsc` | `npx tsc --noEmit`, pass on exit 0 | none |
| `vitest` | `npx vitest run`, pass on exit 0 | none |
| `custom` | Shell command via `/bin/sh`, pass on exit 0 | `command` |

Each returns a `VerifyCheck` with `{ name, result: Pass|Fail, detail }`.

### 1.4 `runVerifierChain` (L87–93)

```ts
export async function runVerifierChain(
    task: Task, workspaceRoot: string, configs: VerifierConfig[],
    registry: VerifierRegistry, logger: ILogger
): Promise<VerifyCheck[]> {
    const results: VerifyCheck[] = [];
    for (const config of configs) {
        const fn = registry.get(config.type);
        results.push(await fn(task, workspaceRoot, config.args));
    }
    return results;
}
```

**Key behaviors:**
- **Sequential execution** — runs each verifier in order
- **No short-circuit** — always runs ALL verifiers even if one fails
- **Returns composite array** — caller decides pass/fail policy via `allChecksPassed()`

### 1.5 `resolveVerifiers` (L96–118)

```ts
export function resolveVerifiers(
    task: Task, config: RalphConfig, registry: VerifierRegistry
): VerifierConfig[] {
    // Priority 1: Explicit config.verifiers
    if (config.verifiers && config.verifiers.length > 0) {
        return config.verifiers;
    }
    // Priority 2: Template matching by task description keyword
    if (config.verificationTemplates) {
        const descLower = task.description.toLowerCase();
        for (const tmpl of config.verificationTemplates) {
            if (descLower.includes(tmpl.name.toLowerCase())) {
                return tmpl.verifiers;
            }
        }
    }
    // Priority 3: Defaults [checkbox, tsc] + optional vitest
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

**3-tier priority cascade:**
1. **Explicit** — `config.verifiers` array if non-empty (user override)
2. **Template match** — `config.verificationTemplates` matched by keyword in task description (e.g., template named "deploy" matches task "Deploy the application")
3. **Defaults** — `[checkbox, tsc]`, with `vitest` appended if `autoClassifyTasks: true` and task description contains "test"

**Enable/disable mechanics:**
- Set `config.verifiers: []` → falls through to templates/defaults
- Set `config.verifiers: [{ type: 'checkbox' }]` → only checkbox, disables everything else
- Set `config.autoClassifyTasks: false` (default) → no vitest auto-append
- Templates allow per-task-category customization without per-task config

---

## 2. What "Not Wired" Means Concretely

### 2.1 Who calls these functions today?

**`resolveVerifiers`**: Called by **nobody** in production code. Zero callers in `src/orchestrator.ts` or `src/extension.ts`. Only called in `test/verify.test.ts`.

**`runVerifierChain`**: Called by **nobody** in production code. Zero callers in `src/orchestrator.ts` or `src/extension.ts`. Only called in `test/verify.test.ts`.

**`createBuiltinRegistry`**: Called by **nobody** in production code. Only called in `test/verify.test.ts`.

**`VerifierRegistry`**: Never instantiated in production code. Only in tests.

### 2.2 What the orchestrator does instead

The orchestrator (`src/orchestrator.ts`) imports only `computeConfidenceScore` and `dualExitGateCheck` from `verify.ts`. It constructs `VerifyCheck[]` arrays **ad-hoc inline** rather than using the registry system:

**Dual exit gate (L775–781)** — manually builds checks:
```ts
const dualGateChecks: VerifyCheck[] = [];
// Manually reads PRD and checks checkbox
dualGateChecks.push({ name: 'checkbox', result: ... });
// Manually checks diff
dualGateChecks.push({ name: 'diff', result: ... });
const gateResult = dualExitGateCheck(waitResult.completed, dualGateChecks);
```

**Confidence scoring (L886–898)** — **hardcodes pass assumptions**:
```ts
const confidenceChecks: VerifyCheck[] = [];
// Manually checks checkbox (real check)
confidenceChecks.push({ name: 'checkbox', result: ... });
// HARDCODED as Pass — never actually runs tsc or vitest!
confidenceChecks.push({ name: 'vitest', result: VerifyResult.Pass });
confidenceChecks.push({ name: 'tsc', result: VerifyResult.Pass });
confidenceChecks.push({ name: 'no_errors', result: VerifyResult.Pass });
// Checks progress file mtime
confidenceChecks.push({ name: 'progress_updated', result: ... });
```

**This is the core problem**: `vitest` and `tsc` verifiers exist in the registry and would actually run `npx tsc --noEmit` and `npx vitest run`, but the orchestrator never calls them. Instead it hardcodes `VerifyResult.Pass`, making the confidence score unreliable — it always assumes TypeScript compiles and tests pass.

### 2.3 Is it dead code?

**Technically alive but functionally dead.** The code:
- Compiles ✓
- Is exported ✓
- Is tested with 22+ passing tests ✓
- Is imported by tests ✓
- Is **never called by any production code path** ✗

The functions `resolveVerifiers`, `runVerifierChain`, `createBuiltinRegistry`, and `VerifierRegistry` are a complete, tested subsystem that was implemented (Phase 5, 2026-03-14) but never integrated into the orchestrator's main loop.

---

## 3. Test Coverage

`test/verify.test.ts` has comprehensive coverage of the verifier subsystem:

| Test Suite | Tests | Status |
|-----------|-------|--------|
| `VerifierRegistry` | 2 (register/get, throws on unknown) | ✅ |
| `checkbox verifier` | 2 (pass/fail) | ✅ |
| `fileExists verifier` | 2 (exists/missing) | ✅ |
| `fileContains verifier` | 3 (found/not-found/missing-file) | ✅ |
| `commandExitCode verifier` | 2 (exit 0/non-zero) | ✅ |
| `tsc verifier` | 1 (registered) | ✅ |
| `vitest verifier` | 1 (registered) | ✅ |
| `custom verifier` | 2 (pass/fail) | ✅ |
| `runVerifierChain` | 2 (composite no-short-circuit, empty) | ✅ |
| `resolveVerifiers` | 5 (explicit/defaults/templates/auto/no-auto) | ✅ |
| `allChecksPassed with chain` | 3 (all pass/any fail/empty) | ✅ |
| `computeConfidenceScore` | 6 (max/checkbox-only/zero/empty/threshold/breakdown) | ✅ |
| `dualExitGateCheck` | 4 (both pass/model-only/machine-only/neither) | ✅ |

All tests test the subsystem in isolation — none test integration with the orchestrator (because there is none).

---

## 4. What Wiring It In Would Look Like

### 4.1 Where it should be called

In `src/orchestrator.ts`, at two locations:

1. **Replacing the hardcoded confidence checks** (~L886–898)
2. **Optionally replacing the ad-hoc dual gate checks** (~L775–781)

### 4.2 Concrete code change

**Step 1**: Add imports to orchestrator.ts (L50):
```ts
// Change from:
import { computeConfidenceScore, dualExitGateCheck } from './verify';
// To:
import { computeConfidenceScore, dualExitGateCheck, createBuiltinRegistry, resolveVerifiers, runVerifierChain } from './verify';
```

**Step 2**: Initialize registry in the orchestrator constructor or at loop start:
```ts
const registry = createBuiltinRegistry();
```

**Step 3**: Replace hardcoded confidence checks (~L886–898) with:
```ts
// Instead of hardcoding vitest/tsc as Pass:
const verifierConfigs = resolveVerifiers(task, this.config, registry);
const confidenceChecks = await runVerifierChain(task, this.config.workspaceRoot, verifierConfigs, registry, this.logger);
// Add progress_updated check separately (not in registry)
let progressUpdated = false;
try { const stat = fs.statSync(progressPath); progressUpdated = (Date.now() - stat.mtimeMs) < 60000; } catch {}
confidenceChecks.push({ name: 'progress_updated', result: progressUpdated ? VerifyResult.Pass : VerifyResult.Fail });
```

**Step 4**: Similarly for dual gate checks (~L775–781), optionally replace ad-hoc construction with:
```ts
const gateConfigs = resolveVerifiers(task, this.config, registry);
const dualGateChecks = await runVerifierChain(task, this.config.workspaceRoot, gateConfigs, registry, this.logger);
// Add diff check (not a registry verifier)
dualGateChecks.push({ name: 'diff', result: waitResult.hadFileChanges ? VerifyResult.Pass : VerifyResult.Fail });
```

### 4.3 Trade-offs and considerations

| Concern | Impact |
|---------|--------|
| **Performance** | `tsc --noEmit` and `vitest run` can take 5–30+ seconds each per task iteration. Currently zero overhead because they're hardcoded Pass. |
| **Reliability** | Currently confidence score is inflated (always assumes tests+tsc pass). Wiring in real checks makes it accurate but may cause more task retries. |
| **Configuration** | Users could override verifiers via `ralph.json` config by setting `verifiers` or `verificationTemplates`, enabling per-project customization. |
| **Backwards compat** | Adding real verification where none existed may cause existing workflows to fail verification that previously "passed". |

### 4.4 Minimal viable wiring (incremental approach)

A safer incremental approach: wire `resolveVerifiers` + `runVerifierChain` behind a feature flag:
```ts
// In RalphConfig:
useRegistryVerifiers?: boolean; // default: false

// In orchestrator:
if (this.config.useRegistryVerifiers) {
    const configs = resolveVerifiers(task, this.config, registry);
    confidenceChecks = await runVerifierChain(task, this.config.workspaceRoot, configs, registry, this.logger);
} else {
    // existing hardcoded behavior
}
```

---

## 5. Summary

| Aspect | Status |
|--------|--------|
| `resolveVerifiers` | Implemented, tested, **never called in production** |
| `runVerifierChain` | Implemented, tested, **never called in production** |
| `createBuiltinRegistry` | Implemented, tested, **never called in production** |
| `VerifierRegistry` | Implemented, tested, **never instantiated in production** |
| Test coverage | 22+ tests, all passing |
| Orchestrator usage | Imports only `computeConfidenceScore` + `dualExitGateCheck`; constructs `VerifyCheck[]` ad-hoc with **hardcoded Pass** for vitest/tsc |
| What "not wired" means | The registry/chain/resolver subsystem exists as a complete but disconnected module — the orchestrator duplicates its logic inline with weaker semantics |
| Wiring effort | ~20 lines changed in orchestrator.ts + optional feature flag |
