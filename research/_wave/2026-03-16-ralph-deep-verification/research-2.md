# Research Report: VerifierRegistry vs Orchestrator Ad-Hoc Verification Gap

**Wave**: 2026-03-16-ralph-deep-verification | **Report**: 2 | **Date**: 2026-03-16

---

## Executive Summary

The `VerifierRegistry` in `src/verify.ts` provides a fully-featured verification framework with 7 built-in verifiers, config resolution (`resolveVerifiers`), chain execution (`runVerifierChain`), and template matching (`VerificationTemplate`). **None of this infrastructure is used by the orchestrator.** Instead, the orchestrator constructs ad-hoc `VerifyCheck[]` arrays inline by manually reading PRD snapshots and checking file-change booleans, then feeds these to `dualExitGateCheck()` and `computeConfidenceScore()` — the only two functions imported from `verify.ts`. The registry system is exercised only in unit tests.

---

## 1. What the VerifierRegistry Offers (verify.ts)

### 1.1 Seven Built-in Verifiers (createBuiltinRegistry)

| Verifier | Type Key | What it does | Location |
|----------|----------|--------------|----------|
| Checkbox | `checkbox` | Reads PRD, checks if task marked complete | L24-29 |
| File Exists | `fileExists` | Checks if a specified file exists | L31-35 |
| File Contains | `fileContains` | Checks if file contains a given string | L37-44 |
| Command Exit Code | `commandExitCode` | Runs arbitrary shell command, checks exit 0 | L46-53 |
| TSC | `tsc` | Runs `npx tsc --noEmit` | L55-62 |
| Vitest | `vitest` | Runs `npx vitest run` | L64-71 |
| Custom | `custom` | Runs custom shell command | L73-80 |

### 1.2 Infrastructure Functions

| Function | Purpose | Location |
|----------|---------|----------|
| `VerifierRegistry` (class) | Map-based registry with `register()` / `get()` | L7-18 |
| `createBuiltinRegistry()` | Factory that returns registry with all 7 verifiers | L21-84 |
| `runVerifierChain()` | Iterates `VerifierConfig[]`, calls each verifier via registry | L87-93 |
| `resolveVerifiers()` | Resolves which verifiers apply: config > templates > defaults (`checkbox` + `tsc`) | L96-121 |
| `verifyTaskCompletion()` | Simple standalone: checks PRD checkbox only | L123-136 |

### 1.3 Config Types (types.ts)

- `RalphConfig.verifiers?: VerifierConfig[]` — user-specified verifier chain (L371)
- `RalphConfig.verificationTemplates?: VerificationTemplate[]` — task-name-matched templates (L372)
- `RalphConfig.autoClassifyTasks?: boolean` — auto-add vitest for test-related tasks
- `VerifierConfig` — `{ type, args?, stages? }` (L442-446)
- `VerificationTemplate` — `{ name, verifiers: VerifierConfig[] }` (L448-451)

### 1.4 Intended Flow (designed but NOT executed)

```
resolveVerifiers(task, config, registry)
  → VerifierConfig[]
    → runVerifierChain(task, workspaceRoot, configs, registry, logger)
      → VerifyCheck[] (actual results from running tsc, vitest, file checks, etc.)
```

---

## 2. What the Orchestrator Actually Does (orchestrator.ts)

The orchestrator imports only **two** functions from `verify.ts`:

```typescript
// orchestrator.ts L50
import { computeConfidenceScore, dualExitGateCheck } from './verify';
```

**Not imported**: `VerifierRegistry`, `createBuiltinRegistry`, `runVerifierChain`, `resolveVerifiers`, `verifyTaskCompletion`.

### 2.1 Verification Call Site 1: Dual Exit Gate (L775-783)

After task execution completes, the orchestrator constructs ad-hoc checks:

```typescript
// L775-783
const dualGateChecks: VerifyCheck[] = [];
{
    const snapshot = readPrdSnapshot(prdPath);
    const foundTask = snapshot.tasks.find(t => t.description === task.description);
    dualGateChecks.push({
        name: 'checkbox',
        result: foundTask?.status === TaskStatus.Complete
            ? VerifyResult.Pass : VerifyResult.Fail
    });
}
dualGateChecks.push({
    name: 'diff',
    result: waitResult.hadFileChanges
        ? VerifyResult.Pass : VerifyResult.Fail,
    detail: waitResult.hadFileChanges ? 'Files changed' : 'No file changes detected'
});

const gateResult = dualExitGateCheck(waitResult.completed, dualGateChecks);
```

**Ad-hoc checks performed**: 2 (checkbox + diff)
**Registry checks available but unused**: tsc, vitest, fileExists, fileContains, commandExitCode, custom

### 2.2 Verification Call Site 2: Confidence Scoring (L884-906)

After dual gate passes and diff validation, the orchestrator builds *another* ad-hoc check array:

```typescript
// L884-906
const confidenceChecks: VerifyCheck[] = [];
{
    const snapshot = readPrdSnapshot(prdPath);
    const foundTask = snapshot.tasks.find(t => t.description === task.description);
    confidenceChecks.push({
        name: 'checkbox',
        result: foundTask?.status === TaskStatus.Complete
            ? VerifyResult.Pass : VerifyResult.Fail
    });
}
confidenceChecks.push({ name: 'vitest', result: VerifyResult.Pass });  // HARDCODED PASS
confidenceChecks.push({ name: 'tsc', result: VerifyResult.Pass });     // HARDCODED PASS
confidenceChecks.push({ name: 'no_errors', result: VerifyResult.Pass }); // HARDCODED PASS
{
    let progressUpdated = false;
    try {
        const stat = fs.statSync(progressPath);
        progressUpdated = (Date.now() - stat.mtimeMs) < 60000;
    } catch { /* ignore */ }
    confidenceChecks.push({
        name: 'progress_updated',
        result: progressUpdated ? VerifyResult.Pass : VerifyResult.Fail
    });
}
const confidence = computeConfidenceScore(confidenceChecks, diffForConfidence);
```

**Critical finding**: `vitest`, `tsc`, and `no_errors` are **hard-coded to `VerifyResult.Pass`**. The registry has actual `tsc` and `vitest` verifiers that run real commands (`npx tsc --noEmit`, `npx vitest run`), but the orchestrator never calls them — it simply assumes they pass.

### 2.3 Verification Call Site 3: Bearings Pre-flight (L602-625)

The `runBearings()` function (L100-131) is separate from the registry — it runs `npx tsc --noEmit` and `npx vitest run` directly via `execSync`, duplicating what the `tsc` and `vitest` registry verifiers do, but independently.

```typescript
// L104-117 (runBearings)
if (config.runTsc) {
    const tscResult = execFn('npx tsc --noEmit', workspaceRoot);
    if (tscResult.exitCode !== 0) {
        issues.push(`TypeScript errors: ${tscResult.output.slice(0, 500)}`);
    }
}
if (config.runTests) {
    const testResult = execFn('npx vitest run', workspaceRoot);
    if (testResult.exitCode !== 0) {
        issues.push(`Test failures: ${testResult.output.slice(0, 500)}`);
    }
}
```

This runs at the START of each task iteration (L602) but is NOT part of the VerifierRegistry. Its results do NOT flow into `VerifyCheck[]` arrays.

### 2.4 Other Verification-Adjacent Code

| Mechanism | Location | What it does | Uses Registry? |
|-----------|----------|--------------|----------------|
| Diff Validation | L820-870 | Validates git diff exists after task | No — uses `DiffValidator` class |
| Consistency Check | L802-815 | Runs deterministic consistency check | No — uses `IConsistencyChecker` |
| Stagnation Detection | L732-757 | Detects no-progress iterations | No — uses `StagnationDetector` |
| Struggle Detection | L761-770 | Detects repeated failures | No — uses `StruggleDetector` |
| Review After Execute | L941-955 | LLM-based review via prompt | No — uses `sendReviewPrompt` |
| PreComplete Hooks | L913-928 | Hook chain before completion | No — uses `IRalphHookService` |

### 2.5 verifyTaskCompletion() in Strategies (strategies.ts)

`CopilotCommandStrategy.waitForCompletion()` uses `verifyTaskCompletion()` (L66) as a polling check to detect when the model marks a checkbox. This is the **only production usage** of any verify.ts function besides `computeConfidenceScore` and `dualExitGateCheck` — and it's the simplest one (checkbox-only check).

---

## 3. The Gap: Summary Table

| Capability | Exists in verify.ts | Used by Orchestrator | Notes |
|------------|-------------------|---------------------|-------|
| `VerifierRegistry` class | Yes (L7) | **NO** | Never instantiated |
| `createBuiltinRegistry()` | Yes (L21) | **NO** | Never called |
| `resolveVerifiers()` | Yes (L96) | **NO** | Config fields `verifiers`, `verificationTemplates`, `autoClassifyTasks` all dead |
| `runVerifierChain()` | Yes (L87) | **NO** | Never called |
| `verifyTaskCompletion()` | Yes (L123) | **Indirectly** — by `CopilotCommandStrategy` only | Checkbox-only, not the full registry |
| `computeConfidenceScore()` | Yes (L167) | **YES** | But fed with hardcoded Pass values |
| `dualExitGateCheck()` | Yes (L185) | **YES** | But with only 2 ad-hoc checks |
| `allChecksPassed()` | Yes (L140) | **Indirectly** — via `dualExitGateCheck` and `CopilotCommandStrategy` | |
| `checkbox` verifier | Yes (L24) | **Duplicated** — orchestrator reads PRD inline | Same logic, different code path |
| `tsc` verifier | Yes (L55) | **Duplicated** — `runBearings()` runs tsc inline; confidence score assumes Pass | |
| `vitest` verifier | Yes (L64) | **Duplicated** — `runBearings()` runs vitest inline; confidence score assumes Pass | |
| `fileExists` verifier | Yes (L31) | **NO** | |
| `fileContains` verifier | Yes (L37) | **NO** | |
| `commandExitCode` verifier | Yes (L46) | **NO** | |
| `custom` verifier | Yes (L73) | **NO** | |
| `VerificationTemplate` matching | Yes (L102) | **NO** | Config field exists but never resolved |

---

## 4. Specific Code Duplication

### Checkbox check — 3 independent implementations:

1. **Registry verifier** (`verify.ts` L24-29): `readPrdSnapshot` → find task → check status
2. **`verifyTaskCompletion()`** (`verify.ts` L123-136): nearly identical, different field name (`prd_checkbox` vs `checkbox`)
3. **Orchestrator inline** (`orchestrator.ts` L776-779): `readPrdSnapshot` → find task → check status, manually constructs `VerifyCheck`

### TSC/Vitest — 2 independent implementations:

1. **Registry verifiers** (`verify.ts` L55-71): `execSync('npx tsc --noEmit')` / `execSync('npx vitest run')`
2. **`runBearings()`** (`orchestrator.ts` L104-117): `execFn('npx tsc --noEmit')` / `execFn('npx vitest run')`

The orchestrator's confidence scoring (L890-892) doesn't run either — it hardcodes `VerifyResult.Pass` for `vitest`, `tsc`, and `no_errors`.

---

## 5. Root Cause Analysis

The registry system was designed for a configuration-driven verification pipeline where users could specify `verifiers` and `verificationTemplates` in `RalphConfig`. The orchestrator was never wired to:

1. **Create** a `VerifierRegistry` instance
2. **Call** `resolveVerifiers()` to determine which checks apply
3. **Execute** `runVerifierChain()` to run the actual verifiers
4. **Feed** the real results into `dualExitGateCheck()` and `computeConfidenceScore()`

Instead, the orchestrator evolved ad-hoc checks inline, and the `runBearings()` pre-flight duplicated some verifier logic independently. The confidence scoring became misleading because it scores vitest/tsc as passing without running them.

---

## 6. Impact Assessment

| Impact | Severity | Detail |
|--------|----------|--------|
| False confidence scores | **High** | vitest/tsc always score as Pass even if they fail |
| Dead config options | Medium | `verifiers`, `verificationTemplates`, `autoClassifyTasks` in config do nothing |
| Code duplication | Medium | Checkbox logic exists 3 times, tsc/vitest logic exists 2 times |
| Missed verification | **High** | Post-task verification never runs real tsc/vitest, only pre-flight bearings does |
| Unreachable code | Low | 5 of 7 registry verifiers (`fileExists`, `fileContains`, `commandExitCode`, `custom`, and effectively `tsc`/`vitest`) are only exercised by unit tests |

---

## 7. Actionable Items

1. **Wire the registry into the orchestrator**: After `dualExitGateCheck`, call `resolveVerifiers()` → `runVerifierChain()` and use real results for `computeConfidenceScore()`.
2. **Eliminate hardcoded Pass values**: Replace L890-892 with actual verifier results from the chain.
3. **Consolidate bearings with registry**: Make `runBearings()` use the `tsc` and `vitest` registry verifiers instead of duplicating `execSync` calls.
4. **Deduplicate checkbox logic**: Use either the `checkbox` registry verifier or `verifyTaskCompletion()`, not inline reconstruction.
5. **Document or remove dead config**: Either wire `verifiers`/`verificationTemplates`/`autoClassifyTasks` or remove them from `RalphConfig`.
