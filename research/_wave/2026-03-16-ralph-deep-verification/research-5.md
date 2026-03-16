# Research-5: CrewAI Dual-Gate, Semantic Kernel Middleware, and ralph-loop — Concrete Code Comparisons

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Does CrewAI's dual-gate (deterministic + LLM) mirror ralph-loop's `dualExitGateCheck`? Does Semantic Kernel's middleware/filter pattern mirror ralph-loop's hook architecture? Is ralph-loop already combining both? Show concrete code comparisons.
**Date**: 2026-03-16
**Method**: Codebase analysis (ralph-loop src/), prior wave research synthesis (research-7 from 2026-03-16-ralph-verification-patterns), framework documentation analysis
**Key Sources**: `src/verify.ts`, `src/shellHookProvider.ts`, `src/types.ts`, `src/orchestrator.ts`, `src/consistencyChecker.ts`

---

## Executive Summary

**Yes, ralph-loop already combines both patterns** — and goes further than either framework individually. CrewAI's dual-gate (`output_validator` + `expected_output` LLM grading) is structurally mirrored by ralph-loop's `dualExitGateCheck(modelSignal, machineVerification)`. Semantic Kernel's `IFunctionInvocationFilter` middleware pattern is structurally mirrored by ralph-loop's `IRalphHookService` with its 5-method lifecycle. However, ralph-loop's LLM verification layer (`IConsistencyChecker.runLlmVerification`) is currently a **stub** — the dual-gate runs entirely deterministic today. The hook architecture is **fully implemented and active**.

---

## 1. CrewAI Dual-Gate vs ralph-loop `dualExitGateCheck`

### 1.1 CrewAI's Verification Flow

CrewAI validates task completion through a **two-layer gate**:

```python
# CrewAI — Task definition with dual verification
task = Task(
    description="Analyze dataset",
    expected_output="A summary report with key metrics",     # LLM gate
    output_validator=lambda output: "metrics" in output.lower(),  # Deterministic gate
    max_retry_on_error=3,
    human_input=True,   # Optional human gate (third layer)
)
```

**CrewAI's internal validation flow:**
1. Agent executes the task → produces output
2. **Gate 1 (Deterministic)**: `output_validator(output)` runs — a Python callable returning `True`/`False`
3. **Gate 2 (LLM)**: If `expected_output` is set, an LLM grades the actual output against the expected description
4. **Gate 3 (Human, optional)**: If `human_input=True`, prompts user for approval
5. On failure at any gate: retry up to `max_retry_on_error` times
6. Reports `TaskOutput.quality_score` when LLM grading is used

### 1.2 ralph-loop's `dualExitGateCheck` — Side-by-Side

```typescript
// ralph-loop — src/verify.ts (lines 188-216)
export function dualExitGateCheck(
    modelSignal: boolean,                    // ← LLM gate (did Copilot signal "complete"?)
    machineVerification: VerifyCheck[],      // ← Deterministic gate (tsc, vitest, checkbox, diff)
): { canComplete: boolean; reason?: string } {
    const machinePassed = allChecksPassed(machineVerification);

    if (modelSignal && machinePassed) {
        return { canComplete: true };
    }

    if (modelSignal && !machinePassed) {
        const failing = machineVerification
            .filter(c => c.result === VerifyResult.Fail)
            .map(c => c.detail ? `${c.name}: ${c.detail}` : c.name)
            .join(', ');
        return { canComplete: false, reason: `Model claims complete but verification failed: ${failing}` };
    }

    if (!modelSignal && machinePassed) {
        return { canComplete: false, reason: 'Verification passes but task not marked complete in PRD' };
    }

    // Both failed
    return { canComplete: false, reason: `Task not marked complete and verification failed: ${failing}` };
}
```

**Invocation in the orchestrator loop** (`src/orchestrator.ts`, lines 774-783):
```typescript
// Dual exit gate: require BOTH model signal AND machine verification
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

### 1.3 Structural Comparison

| Aspect | CrewAI | ralph-loop |
|--------|--------|------------|
| **Deterministic gate** | `output_validator` callable | `VerifyCheck[]` chain via `VerifierRegistry` |
| **LLM gate** | `expected_output` grading | `modelSignal` (Copilot's `task_complete` signal) |
| **Gate logic** | Sequential: validator → LLM → human | AND-gate: BOTH must pass simultaneously |
| **Retry on failure** | `max_retry_on_error` count | Nudge loop + `maxNudgesPerTask` + auto-decompose |
| **Human gate** | `human_input=True` | `HumanCheckpointRequested` event (after diff validation exhaustion) |
| **Failure feedback** | Generic retry | Structured reason string injected into next prompt |
| **Extensible verifiers** | Single callable | Registry of named verifiers (`checkbox`, `tsc`, `vitest`, `fileExists`, `fileContains`, `commandExitCode`, `custom`) |

**Key difference**: CrewAI's gates are **sequential** (validator runs first, then LLM grades). ralph-loop's gate is an **AND** — both the model signal AND the machine verification must pass. If the model says "done" but machine checks fail, ralph-loop explicitly rejects with a structured reason message. CrewAI would retry but without the clear diagnostic feedback.

**Key similarity**: Both frameworks require the deterministic gate to pass before accepting completion. Neither trusts the LLM alone.

---

## 2. Semantic Kernel `IFunctionInvocationFilter` vs ralph-loop `IRalphHookService`

### 2.1 Semantic Kernel's Middleware Pattern

```csharp
// Semantic Kernel — IFunctionInvocationFilter
public class VerificationFilter : IFunctionInvocationFilter
{
    public async Task OnFunctionInvocationAsync(
        FunctionInvocationContext context,
        Func<FunctionInvocationContext, Task> next)
    {
        // PRE-EXECUTION: validate inputs, can block
        if (!IsValid(context.Arguments)) {
            context.Result = new FunctionResult("Invalid input");
            return;  // Block execution entirely
        }

        await next(context);  // Execute the function

        // POST-EXECUTION: verify output, can modify result
        if (!context.Result.IsValid()) {
            context.Result = new FunctionResult("Verification failed");
        }
    }
}

// Registration via DI
kernel.FunctionInvocationFilters.Add(new VerificationFilter());
```

Semantic Kernel provides three filter types:
- **`IFunctionInvocationFilter`** — wraps any kernel function call (pre + post); can block or modify
- **`IPromptRenderFilter`** — fires before prompt rendering; can modify the prompt
- **`IAutoFunctionInvocationFilter`** — for auto-invoked tool calls; can terminate the auto-invocation loop

### 2.2 ralph-loop's `IRalphHookService` — Side-by-Side

```typescript
// ralph-loop — src/types.ts (lines 454-511)
export type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'PreComplete' | 'TaskComplete';

export interface IRalphHookService {
    onSessionStart(input: SessionStartInput): Promise<HookResult>;   // Session lifecycle
    onPreCompact(input: PreCompactInput): Promise<HookResult>;       // Before context compaction
    onPostToolUse(input: PostToolUseInput): Promise<HookResult>;     // After tool execution
    onPreComplete(input: PreCompleteInput): Promise<HookResult>;     // Before task completion
    onTaskComplete(input: TaskCompleteInput): Promise<HookResult>;   // After task completion
}

export interface HookResult {
    action: 'continue' | 'retry' | 'skip' | 'stop';  // Control flow decision
    reason?: string;                                    // Diagnostic info
    additionalContext?: string;                         // Inject into next prompt
    chatSend?: ChatSendRequest;                        // Trigger follow-up chat
    blocked?: boolean;                                  // Safety block indicator
}
```

**Implementation — ShellHookProvider** (`src/shellHookProvider.ts`):
```typescript
export class ShellHookProvider implements IRalphHookService {
    constructor(
        private readonly scriptPath: string,
        private readonly logger: ILogger,
    ) {}

    private executeHook(hookType: RalphHookType, input: unknown): Promise<HookResult> {
        // Defense-in-depth: reject shell metacharacters
        if (containsDangerousChars(this.scriptPath)) {
            return Promise.resolve({ action: 'continue', blocked: true, reason: '...' });
        }

        return new Promise<HookResult>((resolve) => {
            const child = spawn(this.scriptPath, [hookType], { ... });
            // Exit 0 → continue, Exit 1 → warning, Exit 2 → block
            // stdout parsed as JSON HookResult
        });
    }
}
```

**Chain execution via `runPreCompleteChain`** (`src/orchestrator.ts`, lines 143-156):
```typescript
export async function runPreCompleteChain(
    hooks: PreCompleteHookConfig[],
    hookService: IRalphHookService,
    baseInput: Omit<PreCompleteInput, 'previousResults'>,
): Promise<{ action: 'continue' | 'retry' | 'stop'; results: PreCompleteHookResult[] }> {
    const results: PreCompleteHookResult[] = [];
    for (const hook of hooks) {
        if (!hook.enabled) { continue; }
        const input: PreCompleteInput = { ...baseInput, previousResults: [...results] };
        const result = await hookService.onPreComplete(input);
        results.push({ ...result, hookName: hook.name });
        if (result.action === 'retry') { return { action: 'retry', results }; }
        if (result.action === 'stop') { return { action: 'stop', results }; }
    }
    return { action: 'continue', results };
}
```

### 2.3 Structural Comparison

| Aspect | Semantic Kernel Filter | ralph-loop Hook Service |
|--------|----------------------|------------------------|
| **Pattern** | Middleware (wrap execution) | Lifecycle events (pre/post phases) |
| **Can block?** | Yes (skip `next()`) | Yes (`action: 'stop'`) |
| **Can modify output?** | Yes (modify `context.Result`) | Yes (`additionalContext`, `chatSend`) |
| **Can retry?** | Via `MaxAutoInvokeAttempts` | Yes (`action: 'retry'`) |
| **Chaining** | Sequential filter pipeline | Sequential hook chain (`runPreCompleteChain`) |
| **Registration** | DI: `kernel.Filters.Add()` | Constructor injection (`new ShellHookProvider(...)`) |
| **Transport** | In-process C# | Shell subprocess (JSON stdin/stdout) |
| **Hook count** | 3 filter types | 5 hook types |
| **Safety** | Type-safe context | Dangerous char rejection + timeout + process kill |

**Key similarity**: Both use a **sequential pipeline** where each filter/hook runs in order and can short-circuit the chain (Semantic Kernel by not calling `next()`, ralph-loop by returning `action: 'retry'` or `'stop'`). Both provide pre-execution and post-execution interception points.

**Key difference**: Semantic Kernel's filter wraps a single function invocation. ralph-loop's hooks span the entire task lifecycle (session → compact → tool use → pre-complete → task complete), covering orchestration-level concerns rather than single-function concerns.

---

## 3. Does ralph-loop Combine Both Patterns?

### 3.1 What's Fully Implemented (Production-Ready)

| Pattern | Source | Status |
|---------|--------|--------|
| **`dualExitGateCheck`** — AND-gate of model signal + machine verification | `src/verify.ts:188` | ✅ **Active** — runs every task completion in orchestrator |
| **`VerifierRegistry`** — pluggable deterministic verifiers (7 built-in types) | `src/verify.ts:8-86` | ✅ **Active** — `checkbox`, `tsc`, `vitest`, `fileExists`, `fileContains`, `commandExitCode`, `custom` |
| **`IRalphHookService`** — 5-event lifecycle hooks | `src/types.ts:505-511` | ✅ **Active** — interface implemented by `ShellHookProvider` and `NoOpHookService` |
| **`ShellHookProvider`** — shell-based hook execution with safety | `src/shellHookProvider.ts` | ✅ **Active** — dangerous char rejection, 30s timeout, process tree kill |
| **`runPreCompleteChain`** — sequential pipeline with short-circuit | `src/orchestrator.ts:143` | ✅ **Active** — runs after verifiers pass, before `TaskComplete` hook |
| **`computeConfidenceScore`** — weighted confidence from check results | `src/verify.ts:159-183` | ✅ **Active** — checkbox(100) + vitest(20) + tsc(20) + diff(20) + no_errors(10) + progress(10) |
| **`DeterministicConsistencyChecker`** — post-task state verification | `src/consistencyChecker.ts` | ✅ **Active** — checkbox state, progress mtime, file path existence |

### 3.2 What's Aspirational (Stubbed / Feature-Flagged Off)

| Pattern | Source | Status |
|---------|--------|--------|
| **LLM-as-judge verification** | `IConsistencyChecker.runLlmVerification()` | ⚠️ **Stub** — returns `{ passed: true }` always. Both `DeterministicConsistencyChecker` and `LlmConsistencyCheckerStub` skip LLM verification |
| **`useLlmConsistencyCheck` feature flag** | `src/types.ts:143` | ⚠️ **Defaults to `false`** — the flag exists but LLM path is unimplemented |
| **Review-after-execute (LLM judge)** | `ReviewAfterExecuteConfig` | ⚠️ **Defaults to `disabled`** — when enabled, sends review prompt to Copilot for verdict, but `parseReviewVerdict` is a simple parser |

### 3.3 Combination Architecture Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                    RALPH-LOOP VERIFICATION PIPELINE           │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────┐    ┌─────────────────────────────┐      │
│  │ onSessionStart  │───▶│ Hook: session initialization │      │
│  └─────────────────┘    └─────────────────────────────┘      │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────┐    ┌─────────────────────────────┐      │
│  │ Bearings Check   │───▶│ Pre-flight: tsc + tests     │      │
│  └─────────────────┘    └─────────────────────────────┘      │
│           │                                                   │
│           ▼                                                   │
│  ╔═════════════════════════════════════════════════════╗      │
│  ║              TASK EXECUTION LOOP                    ║      │
│  ║                                                     ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 1. Execute task via Copilot          │          ║      │
│  ║  │    (onPostToolUse hook fires)         │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 2. DUAL EXIT GATE (CrewAI parallel)  │          ║      │
│  ║  │    modelSignal: Copilot task_complete │ LLM gate║      │
│  ║  │    machineVerify: checkbox + diff     │ Det.gate║      │
│  ║  │    → BOTH must pass (AND gate)        │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 3. Consistency Checker               │          ║      │
│  ║  │    runDeterministic: ✅ active        │          ║      │
│  ║  │    runLlmVerification: ⚠️ stub       │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 4. Diff Validation                   │          ║      │
│  ║  │    Requires actual file changes       │          ║      │
│  ║  │    → Up to N retries with nudge       │          ║      │
│  ║  │    → HumanCheckpoint on exhaustion    │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 5. Confidence Score (weighted)       │          ║      │
│  ║  │    checkbox:100 vitest:20 tsc:20     │          ║      │
│  ║  │    diff:20 no_errors:10 progress:10  │          ║      │
│  ║  │    → Must meet threshold             │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 6. PreComplete Chain (SK parallel)   │          ║      │
│  ║  │    Sequential hook pipeline           │          ║      │
│  ║  │    Each hook: continue/retry/stop     │          ║      │
│  ║  │    Short-circuits on retry/stop       │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 7. TaskComplete Hook                 │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 8. Review-After-Execute (optional)   │          ║      │
│  ║  │    LLM-as-judge: ⚠️ disabled default │          ║      │
│  ║  └───────────────┬──────────────────────┘          ║      │
│  ║                  ▼                                  ║      │
│  ║  ┌──────────────────────────────────────┐          ║      │
│  ║  │ 9. Atomic Git Commit                 │          ║      │
│  ║  └──────────────────────────────────────┘          ║      │
│  ╚═════════════════════════════════════════════════════╝      │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. Concrete Code Comparison Matrix

### 4.1 Dual-Gate: CrewAI vs ralph-loop

```python
# ══════════ CrewAI ══════════
# Gate 1: Deterministic
output_validator=lambda output: "metrics" in output.lower()

# Gate 2: LLM
expected_output="A summary report with key metrics"
# CrewAI internally runs: LLM.grade(actual_output, expected_output)

# Gate logic: SEQUENTIAL — validator first, then LLM grades
# Retry: max_retry_on_error=3
```

```typescript
// ══════════ ralph-loop ══════════
// Gate 1: Model signal (LLM)
const modelSignal = waitResult.completed;  // Did Copilot call task_complete?

// Gate 2: Deterministic (machine verification)
const dualGateChecks: VerifyCheck[] = [
    { name: 'checkbox', result: prdCheckboxTicked ? Pass : Fail },
    { name: 'diff',     result: hadFileChanges ? Pass : Fail },
];

// Gate logic: AND — BOTH must pass simultaneously
const gateResult = dualExitGateCheck(modelSignal, dualGateChecks);

// Retry: nudge with structured reason, up to maxNudgesPerTask
if (!gateResult.canComplete) {
    additionalContext = gateResult.reason;  // Injected into next prompt
}
```

**Verdict**: ralph-loop's gate is **stricter** (AND vs sequential) and provides **richer failure feedback** (structured reason string vs generic retry). CrewAI's gate is **simpler to configure** (lambdas vs registry).

### 4.2 Middleware/Hooks: Semantic Kernel vs ralph-loop

```csharp
// ══════════ Semantic Kernel ══════════
public class MyFilter : IFunctionInvocationFilter {
    public async Task OnFunctionInvocationAsync(
        FunctionInvocationContext context,
        Func<FunctionInvocationContext, Task> next) {
        // PRE: Can inspect/block
        await next(context);
        // POST: Can modify result
    }
}
kernel.FunctionInvocationFilters.Add(new MyFilter());
```

```typescript
// ══════════ ralph-loop ══════════
// Hook interface — 5 lifecycle events
interface IRalphHookService {
    onSessionStart(input: SessionStartInput): Promise<HookResult>;
    onPreCompact(input: PreCompactInput): Promise<HookResult>;
    onPostToolUse(input: PostToolUseInput): Promise<HookResult>;
    onPreComplete(input: PreCompleteInput): Promise<HookResult>;
    onTaskComplete(input: TaskCompleteInput): Promise<HookResult>;
}

// HookResult controls flow
interface HookResult {
    action: 'continue' | 'retry' | 'skip' | 'stop';
    additionalContext?: string;  // Inject into next prompt
    blocked?: boolean;           // Safety block
}

// Chain execution — sequential pipeline with short-circuit
async function runPreCompleteChain(hooks, hookService, baseInput) {
    for (const hook of hooks) {
        const result = await hookService.onPreComplete({ ...baseInput, previousResults });
        if (result.action === 'retry') return { action: 'retry', results };
        if (result.action === 'stop')  return { action: 'stop', results };
    }
    return { action: 'continue', results };
}
```

**Verdict**: Semantic Kernel wraps a **single function call** (fine-grained). ralph-loop hooks span the **task lifecycle** (coarse-grained, orchestration-level). Semantic Kernel uses in-process DI; ralph-loop uses shell subprocess isolation with safety guards (dangerous char rejection, 30s timeout, process tree kill).

---

## 5. What ralph-loop Gets That Neither Framework Has

| Feature | CrewAI | Semantic Kernel | ralph-loop |
|---------|--------|----------------|------------|
| **Dual exit gate** (AND logic) | ✅ Sequential | ❌ | ✅ AND gate |
| **Middleware hooks** (lifecycle) | ❌ Post-only | ✅ Pre+Post | ✅ 5-event lifecycle |
| **Confidence scoring** (weighted) | ❌ | ❌ | ✅ 6 weighted signals |
| **Stagnation detection** | ❌ | ❌ | ✅ File hash tracking |
| **Struggle detection** | ❌ | ❌ | ✅ Short iteration + no-progress |
| **Circuit breaker chain** | ❌ | ❌ | ✅ Composable chain |
| **Auto-decomposition** on failure | ❌ | ❌ | ✅ After N failures |
| **Diff validation** with re-entry | ❌ | ❌ | ✅ Retry with nudge |
| **Shell hook safety** | N/A | N/A | ✅ Dangerous char, timeout, kill |
| **Atomic git commit** per task | ❌ | ❌ | ✅ Per-task commits |
| **Human checkpoint** escalation | ✅ `human_input` | ❌ | ✅ After diff exhaustion |

---

## 6. Aspirational Gaps

### 6.1 LLM-as-Judge (Not Yet Implemented)

The `IConsistencyChecker.runLlmVerification()` method exists as a stub in both implementations:

```typescript
// src/consistencyChecker.ts — DeterministicConsistencyChecker
async runLlmVerification(_input: ConsistencyCheckInput): Promise<ConsistencyCheckResult> {
    return {
        passed: true,
        checks: [{ name: 'llm_verification', passed: true, detail: 'LLM verification skipped (stub)' }],
    };
}
```

The feature flag `useLlmConsistencyCheck` defaults to `false`. When implemented, this would add CrewAI-style LLM grading to the existing deterministic pipeline.

### 6.2 Review-After-Execute (Disabled by Default)

```typescript
// src/types.ts
export const DEFAULT_REVIEW_AFTER_EXECUTE: ReviewAfterExecuteConfig = {
    enabled: false,     // ← Disabled
    mode: 'same-session',
};
```

When enabled, this sends a structured review prompt to Copilot asking for `APPROVED` or `NEEDS-RETRY`. This is the closest analog to CrewAI's `expected_output` LLM grading, but it's disabled by default.

---

## 7. Conclusions

1. **CrewAI's dual-gate is partially mirrored**: ralph-loop's `dualExitGateCheck` implements the *structural pattern* (deterministic + model signal gate) but with AND logic instead of sequential evaluation. The deterministic side is richer (registry of 7 verifier types vs single callable). The LLM side is **aspirational** (stub).

2. **Semantic Kernel's middleware is fully mirrored**: `IRalphHookService` with `runPreCompleteChain` is architecturally equivalent to Semantic Kernel's `IFunctionInvocationFilter` pipeline — sequential chain, short-circuit on block/retry, pre/post lifecycle coverage. ralph-loop adds shell subprocess isolation that Semantic Kernel doesn't need (in-process vs out-of-process).

3. **ralph-loop already combines both** at the orchestrator level: the verification pipeline runs dual-gate → consistency check → diff validation → confidence score → hook chain → review → git commit. No single framework matches this depth.

4. **The main gap is LLM verification**: Both the consistency checker's `runLlmVerification` and the review-after-execute feature are stubbed/disabled. Implementing these would complete the CrewAI parallel and add a quality-of-completion signal that the current deterministic-only pipeline lacks.
