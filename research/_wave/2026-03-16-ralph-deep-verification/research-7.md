# Research-7: Verification Feedback Injection — Does ralph-loop Already Have It?

**Question:** Does ralph-loop ALREADY have any form of verification feedback injection? When verifiers fail, what happens to the failure message? Is it logged only, or does it flow back into the next prompt? What do external projects (Reflexion, Self-Refine, Aider auto-fix, giocaizzi fix-instruction forwarding) do differently?

**Date:** 2026-03-16
**Method:** Full codebase trace of failure-to-prompt data flow + synthesis of prior wave research (research-3, research-4, research-5)

---

## Part 1: Ralph-Loop's Existing Feedback Injection Paths

### Summary Verdict

**Yes, ralph-loop already has verification feedback injection — at least 6 distinct paths.** However, the feedback is **coarse-grained** (generic messages, not structured failure details from verifier output). The verifier *detail* strings (e.g., tsc/vitest stderr) are **never** injected into the next prompt.

---

### Path 1: Confidence Score Failure → `additionalContext` (orchestrator.ts L905-908)

When `computeConfidenceScore()` returns below threshold:
```typescript
additionalContext = `Verification confidence: ${confidence.score}/180. Missing: ${failing}. Complete the remaining items.`;
this.completedTasks.delete(task.id);
continue;
```
**Mechanism:** Sets `additionalContext` string, which is appended to the next iteration's prompt via `prompt += '\n\n' + additionalContext` (orchestrator.ts L685).

**Data flow:** `verify.ts:computeConfidenceScore()` → failing check *names* (e.g., "checkbox, progress_updated") → string injection → next `buildPrompt()` call.

**Gap:** Only check *names* are forwarded ("Missing: checkbox, progress_updated"), not the *detail* strings ("Checkbox not marked", "progress.txt not recently modified"). The agent knows *what* failed but not *why* or *how*.

---

### Path 2: Dual Exit Gate Rejection → `additionalContext` (orchestrator.ts L945-948)

When the model signals completion but the dual gate rejects:
```typescript
additionalContext = gateResult.reason ?? 'Dual exit gate check failed';
this.completedTasks.delete(task.id);
continue;
```
**Mechanism:** `dualExitGateCheck()` returns a `reason` string (e.g., "Machine checks failing: checkbox, diff"). This is injected verbatim into the next prompt.

**Gap:** Similar to Path 1 — the reason is a summary of failing check *names*, not the underlying error output.

---

### Path 3: Stagnation Detection → `additionalContext` (orchestrator.ts L755)

When `StagnationDetector.evaluate()` detects Tier 1 stagnation:
```typescript
additionalContext = 'You appear to be stuck. Progress file has not changed. Try a different approach.';
```
**Data flow:** File-hash comparison → boolean stagnation signal → generic message injection.

**Gap:** Completely generic. No information about *what* the agent was stuck on or *what* it should try differently.

---

### Path 4: Struggle Detection → `additionalContext` (orchestrator.ts L768-770)

When `StruggleDetector.isStruggling()` fires:
```typescript
additionalContext = `Struggle detected: ${struggle.signals.join(', ')}. Try a completely different approach. If tests keep failing, check your assumptions.`;
```
**Data flow:** Iteration metrics (duration, file changes, repeated errors) → signal names (e.g., "no-progress, short-iteration, repeated-error") → message injection.

**Gap:** Signal names are forwarded, but not the actual error content. The `StruggleDetector` tracks error hashes via `ErrorHashTracker` but the matched error *text* is never included in the injected context.

---

### Path 5: Diff Validation Failure → Nudge Re-entry (orchestrator.ts L838-860)

When `DiffValidator.validateDiff()` finds no code changes:
```typescript
const nudge = diffResult.nudge ?? 'No code changes detected. Review the task requirements and make the necessary code modifications.';
// ...
retryPrompt += '\n\n' + nudge;
const retryExec = await this.executionStrategy.execute(task, retryPrompt, this.executionOptions);
```
**Data flow:** `git diff --stat HEAD` → empty diff → generic nudge message → appended to retry prompt → re-execute.

**Gap:** The nudge is a static string. It doesn't tell the agent what the expected diff *should* look like or what files it should have modified.

---

### Path 6: Hook System → `additionalContext` (orchestrator.ts L920-932, L1001-1010)

Both `onTaskComplete` and `onSessionStart` hooks can return `additionalContext`:
```typescript
const completeHook = await this.hookService.onTaskComplete({ ... });
if (completeHook.additionalContext) { additionalContext = completeHook.additionalContext; }
```
And the `blocked` path:
```typescript
additionalContext = `Shell command blocked: ${completeHook.reason}. Provide a safe alternative that does not use shell metacharacters or chaining.`;
```
**Data flow:** External hook script → JSON result with optional `additionalContext` field → injection into next prompt.

**Gap:** This is the most *flexible* path because external scripts can put anything into `additionalContext`. However, the built-in hook scripts (`generateStopHookScript` in hookBridge.ts) output `{ resultKind: 'error', stopReason: 'Verification failed: ...' }` — the `stopReason` is **not** extracted into `additionalContext`. It triggers a stop, not a retry with feedback.

---

### Path 7: Operator Context Injection (orchestrator.ts L349-352, extension.ts L271-282)

Manual mid-loop context injection via VS Code command:
```typescript
injectContext(text: string): void {
    this.pendingContext = text;
}
```
Consumed in `buildPrompt()` via `renderOperatorContext()` which wraps it in an `OPERATOR CONTEXT (injected mid-loop)` section.

**Data flow:** Human → VS Code input box → `pendingContext` → prompt section.

**This is not automated feedback** — it's manual human-in-the-loop injection.

---

### Path 8: Nudge Loop Continuation (orchestrator.ts L710-735)

When a task times out (but isn't done), the nudge loop sends a continuation prompt:
```typescript
const continuationSuffix = finalNudge
    ?? 'Continue with the current task. You have NOT marked the checkbox yet. Do NOT repeat previous work — pick up where you left off. If you encountered errors, resolve them.';
```
**Data flow:** Timeout → generic continuation message → new prompt.

**Gap:** No information about *what* errors were encountered. The message says "resolve them" but doesn't say what "them" is.

---

## Part 2: What's NOT Injected (Critical Gaps)

### Gap A: Verifier Output Details Never Reach the Prompt

The `VerifyCheck` type includes a `detail` field:
```typescript
// verify.ts
return { name: 'tsc', result: VerifyResult.Fail, detail: 'TypeScript errors' };
return { name: 'vitest', result: VerifyResult.Fail, detail: 'Tests failed' };
```

But these `detail` strings are:
1. **Never forwarded to `buildPrompt()`** — `buildPrompt` has no parameter for verification failure context
2. **Only logged** — `this.logger.warn()` or emitted as `LoopEvent` objects for the UI
3. **Not even captured from verifier execution** — The tsc/vitest verifiers catch errors but discard stderr/stdout content

The verifiers return "Tests failed" but not "Test X in file Y failed with assertion error Z." This is the single largest feedback injection gap.

### Gap B: Circuit Breaker Reasons Are Emitted, Not Injected

When a circuit breaker trips, the reason goes to `LoopEvent`:
```typescript
yield { kind: LoopEventKind.CircuitBreakerTripped, breakerName: '', reason: cbResult.reason ?? 'unknown', action: cbResult.action, taskInvocationId };
```
The reason string (e.g., "Retry limit reached (3/3)") goes to the UI/event stream but **never** into `additionalContext`.

### Gap C: ConsistencyChecker Results Are Logged, Not Injected

```typescript
this.onEvent({ kind: LoopEventKind.ConsistencyCheckFailed, phase: 'post_task', checks: ccResult.checks, failureReason: ccResult.failureReason });
this.logger.warn(`Consistency check failed: ${ccResult.failureReason}`);
```
The `failureReason` (e.g., "checkbox_state: Expected unchecked tasks...") goes to the event stream but never into `additionalContext`.

### Gap D: hookBridge's Stop Script Captures Failure Details But Stops

The `generateStopHookScript()` in hookBridge.ts captures detailed failure info:
```javascript
failures.push('TypeScript compilation errors: ' + (tsc.stdout || tsc.stderr || 'see tsc output'));
failures.push('Test failures: ' + (vitest.stdout || vitest.stderr || 'see vitest output'));
```
But it outputs `{ resultKind: 'error', stopReason: ... }` which triggers a **stop**, not a retry with feedback. The failure details die in the stop reason.

---

## Part 3: External Project Patterns

### Reflexion (Shinn et al., NeurIPS 2023)

**Pattern:** act → evaluate → **self-reflect** → retry. After binary failure (test fails), the LLM generates a natural-language *reflection* on why it failed. This reflection is injected as an additional memory into the next attempt's prompt.

**Key difference from ralph-loop:** Reflexion uses a **separate reflection step** where the LLM analyzes the failure and produces structured feedback. Ralph-loop skips this step — failure signals go directly to generic nudge messages without LLM-mediated analysis.

**Injection format:** Reflexion stores reflections in a memory buffer appended to the system prompt. Each reflection is a paragraph like: "In my previous attempt, I failed because I miscalculated the edge case where the input is empty. The function should return 0, not throw."

### Self-Refine (Madaan et al., NeurIPS 2023)

**Pattern:** generate → **critique** → refine (iterative). The same LLM generates output, then critiques it (identifying specific issues), then generates a refined version incorporating the critique.

**Key difference from ralph-loop:** Self-Refine's critique step produces *specific, actionable feedback* ("Line 3 has an off-by-one error; the loop should iterate to n-1, not n"). Ralph-loop's failure signals are categorical ("Tests failed") not specific.

**Injection format:** The critique is concatenated directly with the original output in the next refinement prompt: "Here is your previous output: {output}. Here is the feedback: {critique}. Generate an improved version."

### Aider's Auto-Fix Loop

**Pattern:** When linting/tests fail after an edit, Aider automatically:
1. Captures the full error output (lint warnings, test failures with stack traces)
2. Formats them into a structured prompt section
3. Sends a follow-up message: "Fix these errors:\n```\n{full error output}\n```"
4. Uses the **same chat session** so the LLM has full edit history context

**Key difference from ralph-loop:** Aider forwards the **complete error output** (stderr, stack traces, assertion messages). Ralph-loop's verifiers return "Tests failed" — a 2-word summary that discards all diagnostic value.

**Injection format:** Raw error output in a code fence within the chat session.

### giocaizzi/ralph-copilot: Fix-Instruction Forwarding

**Pattern:** Parses test runner output to extract **specific** fix instructions:
- "Test `test_calculate_tax` failed: expected 0.08, got 0.05. The tax rate constant on line 42 needs updating."
- Transforms generic "test failed" into actionable, file-specific guidance

**Key difference from ralph-loop:** giocaizzi *parses* the test output to extract structured fix instructions. Ralph-loop's verifiers don't even capture the test output.

**Injection format:** Structured fix instructions embedded in the `.agent.md` file or appended to the next prompt.

---

## Part 4: Feedback Injection Quality Ladder

| Level | Description | Ralph-Loop Status | Example |
|-------|------------|-------------------|---------|
| L0 | No feedback — just retry | N/A | (no path uses this) |
| L1 | Binary signal ("failed/passed") | Nudge loop continuation | "Continue with the current task" |
| L2 | Category signal ("what failed") | Confidence/dual-gate | "Missing: checkbox, tsc" |
| L3 | Reason signal ("why failed") | ❌ Not implemented | "tsc: error TS2345 in src/foo.ts:42" |
| L4 | Actionable instruction ("how to fix") | ❌ Not implemented | "Change param type from `string` to `number` on line 42" |
| L5 | LLM-mediated reflection | ❌ Not implemented | "I failed because I missed the edge case..." (Reflexion) |

**Ralph-loop currently operates at L1-L2.** External projects achieving state-of-the-art operate at L3-L5.

---

## Part 5: Exact Code Locations for Enhancement

### Where to Capture Verifier Output

1. **verify.ts verifier functions** — Currently discard stderr/stdout from `execSync`. Need to capture and include in `VerifyCheck.detail`:
   - `tsc` verifier (L60-63): Catch block should capture `err.stdout + err.stderr`
   - `vitest` verifier (L69-72): Same pattern
   - `custom` verifier (L78-81): Same pattern

2. **VerifyCheck type** (types.ts): Already has `detail?: string` field — just needs richer content

### Where to Inject Feedback Into Prompt

1. **orchestrator.ts L905-908** (confidence failure path): Currently injects check *names* → should inject check *details*
2. **orchestrator.ts L945-948** (dual gate rejection): Same improvement
3. **prompt.ts `buildPrompt()`**: Add an optional `verificationFeedback?: string` parameter, rendered in a dedicated `VERIFICATION FEEDBACK` section
4. **orchestrator.ts nudge loop** (L710-735): Inject last failure context instead of generic "resolve them"

### Proposed Data Flow (L3 Enhancement)

```
execSync('npx vitest run') → catch(err) → err.stdout + err.stderr
  → VerifyCheck.detail = "FAIL src/foo.test.ts > should handle empty input\n  Expected: 0, Received: undefined\n  at line 42"
  → orchestrator collects failing check details
  → additionalContext = `## Verification Failures\n${failingDetails.join('\n')}`
  → buildPrompt() includess this in VERIFICATION FEEDBACK section
  → next LLM call receives specific failure information
```

---

## References

| Source | Location | Key Finding |
|--------|----------|-------------|
| orchestrator.ts L905-908 | Confidence failure injection | L2: check names, not details |
| orchestrator.ts L945-948 | Dual gate rejection injection | L2: reason string, generic |
| orchestrator.ts L755 | Stagnation injection | L1: generic "try different approach" |
| orchestrator.ts L768 | Struggle injection | L2: signal names only |
| orchestrator.ts L838-860 | Diff validation nudge | L1: generic nudge |
| verify.ts L60-72 | tsc/vitest verifiers | Discard stderr/stdout |
| hookBridge.ts L130-140 | Stop hook captures details | Details in stopReason, triggers stop not retry |
| types.ts L485-489 | HookResult interface | Has `additionalContext` field - hook extensibility point |
| prompt.ts `buildPrompt()` | Prompt construction | No verification feedback parameter |
| Prior research-5 | Reflexion/Self-Refine patterns | L3-L5 feedback outperforms L1-L2 |
| Prior research-3 | giocaizzi fix-instruction forwarding | L4 parsed fix instructions |
| Prior research-4 | Aider auto-fix pattern | L3 raw error output injection |
