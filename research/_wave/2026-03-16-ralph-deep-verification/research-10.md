# Research Report 10: LLM-as-Judge Verifier for ralph-loop

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Extract detailed implementation examples of LLM-as-Judge for task verification in agent loops. How does CrewAI's `expected_output` pattern work? What prompt template does the judge use? How is it supplementary to deterministic gates? Design a concrete `llmJudge` verifier for ralph-loop's VerifierRegistry.
**Date**: 2026-03-16

---

## 1. CrewAI's `expected_output` Pattern

### 1.1 How It Works

CrewAI tasks have an `expected_output` field — a natural language description of what the output should look like. When a task completes, CrewAI passes the agent's actual output and the `expected_output` to a validation step.

```python
# CrewAI task definition
task = Task(
    description="Analyze the company's Q3 financial data",
    expected_output="A detailed financial report with revenue, expenses, "
                    "profit margins, and quarter-over-quarter trends",
    agent=financial_analyst
)
```

The validation flow:
1. Agent produces output for the task
2. CrewAI constructs a **judge prompt** comparing actual output vs `expected_output`
3. Judge LLM returns a structured verdict (acceptable/needs-improvement)
4. If unacceptable, the agent is given feedback and retries (up to `max_retry_limit`)

### 1.2 The Judge Prompt Template (Reconstructed)

CrewAI's internal judge prompt follows this pattern:

```
You are a quality assurance evaluator. Assess whether the following output
satisfactorily meets the expected output criteria.

## Task Description
{task.description}

## Expected Output
{task.expected_output}

## Actual Output
{agent_output}

## Evaluation
Does the actual output meet the expected output criteria?
Consider: completeness, accuracy, format compliance, and relevance.

Respond with ONLY one of:
- "APPROVED" if the output meets the criteria
- "NEEDS_IMPROVEMENT: <specific feedback>" if it does not
```

Key design properties:
- **Binary verdict** — pass or fail, no grading scale
- **Feedback on failure** — specific issues fed back for retry
- **Natural language criteria** — not regex or schema validation
- **Separated concerns** — the working agent never sees the judge prompt

### 1.3 CrewAI's Judge vs Deterministic Gates

CrewAI treats `expected_output` as a **soft gate**. It runs AFTER the agent claims completion, not instead of execution. Hard gates (file existence, syntax checks) would be separate validation tools. The `expected_output` judge catches semantic gaps: "The report exists but doesn't mention profit margins."

---

## 2. Other LLM-as-Judge Implementations

### 2.1 Vercel Labs — Judge Agent (from ecosystem research)

From the ralph ecosystem (research-09, §2.2):
- When coding agent calls `markComplete`, a **separate Judge Agent** reviews using read-only tools
- Returns `approveTask` or `requestChanges({ issues, suggestions })`
- Rejection feedback flows back to coding agent
- Key: Judge has **read-only access** — it can inspect files but cannot edit

### 2.2 Ralph Playbook — `createReview()` (research-07, §14)

```typescript
interface ReviewResult {
  pass: boolean;
  feedback?: string;
}

function createReview(config: {
  criteria: string;      // What to evaluate
  artifact: string;      // Text content or screenshot path
  intelligence?: "fast" | "smart";
}): Promise<ReviewResult>;
```

- **Multimodal**: text or vision evaluation
- **Intelligence tiers**: `fast` (cheap model) vs `smart` (capable model)
- **Binary outcome**: pass/fail with optional feedback string

### 2.3 OpenAI Evals — LLM Grading Pattern

OpenAI's evals framework uses a similar pattern for grading model outputs:

```
You are grading a response. The expected behavior is:
{criteria}

The response to grade is:
{response}

Grade: [PASS/FAIL]
Reason: [brief explanation]
```

Key insight: The grading prompt should be **much simpler** than the task prompt. A complex judge prompt defeats the purpose — the judge should make a quick, focused assessment.

### 2.4 SWE-bench — Execution + LLM Verification

SWE-bench combines deterministic test execution with LLM review for edge cases. Tests verify functional correctness; LLM review verifies code quality, style, and architectural decisions that tests can't catch.

---

## 3. Relationship to Deterministic Gates

### 3.1 Layered Verification Model

```
┌─────────────────────────────────────────────────┐
│ Layer 3: LLM Judge (semantic/subjective)        │
│   "Does the output meet expected criteria?"     │
│   "Is the code idiomatic and well-structured?"  │
├─────────────────────────────────────────────────┤
│ Layer 2: Deterministic tools (syntax/structure) │
│   tsc, vitest, fileExists, fileContains         │
├─────────────────────────────────────────────────┤
│ Layer 1: State gates (loop mechanics)           │
│   checkbox marked, progress.txt updated         │
└─────────────────────────────────────────────────┘
```

LLM Judge is **always the last layer**, running only after deterministic checks pass. This prevents wasting LLM tokens judging code that doesn't compile.

### 3.2 What LLM Judge Catches That Deterministic Gates Miss

| Gap | Deterministic | LLM Judge |
|-----|--------------|-----------|
| Code compiles but is wrong | ❌ misses | ✅ catches |
| Tests pass but miss edge cases | ❌ misses | ✅ catches |
| Implementation ignores task requirements | ❌ misses | ✅ catches |
| Agent marked checkbox without doing work | ❌ misses (checkbox checks pass) | ✅ catches via diff review |
| Code works but is unmaintainable | ❌ misses | ✅ catches |
| Security vulnerability introduced | ❌ unless specific test | ✅ catches |

### 3.3 What LLM Judge Should NOT Replace

- **tsc / vitest**: Compilation and test execution are always faster, cheaper, and more reliable
- **checkbox state**: Deterministic — no reason to ask an LLM
- **File existence**: `fs.existsSync` is instantaneous and correct
- **Git diff presence**: Deterministic check

---

## 4. Concrete Design: `llmJudge` Verifier for ralph-loop

### 4.1 Where It Fits in the Architecture

Ralph-loop already has TWO LLM-feedback mechanisms:
1. **`reviewAfterExecute`** (`copilot.ts` L101–118) — sends a review prompt via Copilot Chat after task execution. Currently returns the prompt text (not the LLM response) because VS Code's chat API doesn't return response text programmatically.
2. **`IConsistencyChecker.runLlmVerification()`** (`consistencyChecker.ts` L95–100) — currently a **stub** returning `passed: true` always.

The `llmJudge` verifier would be a **third path**, registered in `VerifierRegistry` and composable with other verifiers via `→ Verify:` DSL or `verificationTemplates`.

### 4.2 Implementation Constraint: No Direct LLM API

Ralph-loop operates as a VS Code extension that drives Copilot Chat via commands (`workbench.action.chat.openEditSession`, `workbench.action.chat.open`). It does **not** call LLM APIs directly. The `sendReviewPrompt` function sends a prompt to Copilot Chat and logs it, but cannot read the response programmatically.

This means a true `llmJudge` verifier has two possible implementation strategies:

**Strategy A: Hook-based (current architecture)**
Use the existing hook system. After deterministic verifiers pass, inject a judge prompt into the chat. The LLM's response triggers a hook (e.g. PostToolUse) that parses the verdict. This is how `reviewAfterExecute` works today.

**Strategy B: VS Code Language Model API**
Use `vscode.lm.selectChatModels()` and `model.sendRequest()` to make a direct LLM call within the extension, bypassing Copilot Chat. This provides programmatic access to the response. This is the cleaner approach.

### 4.3 Concrete Implementation: `llmJudge` Verifier

```typescript
// src/verify.ts — new verifier registration

registry.register('llmJudge', async (task, workspaceRoot, args) => {
    const criteria = args?.criteria ?? task.description;
    const artifactPath = args?.artifact;
    
    let artifact: string;
    if (artifactPath) {
        const fullPath = path.join(workspaceRoot, artifactPath);
        if (!fs.existsSync(fullPath)) {
            return {
                name: 'llmJudge',
                result: VerifyResult.Fail,
                detail: `Artifact file not found: ${artifactPath}`,
            };
        }
        artifact = fs.readFileSync(fullPath, 'utf-8');
        if (artifact.length > 10000) {
            artifact = artifact.slice(0, 10000) + '\n... [truncated]';
        }
    } else {
        // Default artifact: recent git diff
        try {
            artifact = execSync('git diff HEAD~1 --stat', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch {
            artifact = '[No git diff available]';
        }
    }

    const verdict = await callLlmJudge(criteria, artifact);
    return {
        name: 'llmJudge',
        result: verdict.pass ? VerifyResult.Pass : VerifyResult.Fail,
        detail: verdict.pass
            ? 'LLM judge: criteria met'
            : `LLM judge: ${verdict.feedback ?? 'criteria not met'}`,
    };
});
```

### 4.4 The Judge Prompt Template

```typescript
// src/llmJudge.ts

const JUDGE_PROMPT_TEMPLATE = `You are a strict code review judge. Evaluate whether the work meets the criteria.

## Criteria
{criteria}

## Artifact (code changes or output to evaluate)
{artifact}

## Instructions
1. Check if the artifact satisfies each aspect of the criteria
2. Be strict — partial completion is a fail
3. Respond with EXACTLY one line in this format:

VERDICT: PASS
or
VERDICT: FAIL | <one-sentence reason>

Do not include any other text.`;

export interface JudgeVerdict {
    pass: boolean;
    feedback?: string;
}

export function buildJudgePrompt(criteria: string, artifact: string): string {
    return JUDGE_PROMPT_TEMPLATE
        .replace('{criteria}', criteria)
        .replace('{artifact}', artifact);
}

export function parseJudgeVerdict(response: string): JudgeVerdict {
    const line = response.split('\n').find(l => l.trim().startsWith('VERDICT:'));
    if (!line) {
        return { pass: false, feedback: 'Judge produced no verdict — treating as fail' };
    }
    const verdict = line.replace('VERDICT:', '').trim();
    if (verdict.startsWith('PASS')) {
        return { pass: true };
    }
    const pipeIdx = verdict.indexOf('|');
    const feedback = pipeIdx >= 0 ? verdict.slice(pipeIdx + 1).trim() : 'Criteria not met';
    return { pass: false, feedback };
}
```

### 4.5 LLM Call Implementation (Strategy B)

```typescript
// src/llmJudge.ts — continued

import * as vscode from 'vscode';

export async function callLlmJudge(
    criteria: string,
    artifact: string,
): Promise<JudgeVerdict> {
    const prompt = buildJudgePrompt(criteria, artifact);
    
    const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o',
    });
    
    if (models.length === 0) {
        // Fallback: skip judge if no model available
        return { pass: true, feedback: 'No LLM model available — judge skipped' };
    }
    
    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    
    let responseText = '';
    for await (const chunk of response.text) {
        responseText += chunk;
    }
    
    return parseJudgeVerdict(responseText);
}
```

### 4.6 PRD.md DSL Integration (`→ Verify:`)

Following the pattern from research-9 (the `→ Verify:` DSL):

```markdown
- [ ] Implement user authentication → Verify: tsc + vitest + llmJudge(criteria="OAuth flow handles token refresh and expiry correctly")
- [ ] Write API documentation → Verify: fileExists(path="docs/api.md") + llmJudge(criteria="Documentation covers all endpoints with examples")
- [ ] Refactor payment module → Verify: tsc + vitest + llmJudge(artifact="src/payments/", criteria="Code follows single responsibility principle")
```

### 4.7 Config Integration

```typescript
// In RalphConfig (types.ts)
export interface LlmJudgeConfig {
    enabled: boolean;
    modelFamily?: string;      // default: 'gpt-4o'
    maxArtifactLength?: number; // default: 10000
    retryOnFail?: boolean;     // feed feedback back for retry
}

export const DEFAULT_LLM_JUDGE_CONFIG: LlmJudgeConfig = {
    enabled: false,
    modelFamily: 'gpt-4o',
    maxArtifactLength: 10000,
    retryOnFail: true,
};
```

---

## 5. Interaction with Existing Verification Pipeline

### 5.1 Execution Order in Orchestrator

Current flow (orchestrator.ts ~L885–950):
```
1. Wait for task execution (file changes, chat idle)
2. Diff validation (deterministic)
3. Confidence scoring (checkbox + tsc + vitest + progress)
4. PreComplete hooks
5. TaskComplete hook
6. Review-after-execute (LLM via chat)
7. Atomic git commit
```

With `llmJudge` as a verifier, it slots into step 3 — the confidence scoring phase — as a check in the `VerifierConfig[]` chain. It runs AFTER tsc and vitest (deterministic gates) but BEFORE PreComplete hooks.

### 5.2 Confidence Score Integration

Current weights (`verify.ts` L154–159):
```typescript
const CONFIDENCE_WEIGHTS: Record<string, number> = {
    checkbox: 100,
    vitest: 20,
    tsc: 20,
    diff: 20,
    no_errors: 10,
    progress_updated: 10,
};
// Total possible: 180
```

Proposed addition:
```typescript
const CONFIDENCE_WEIGHTS: Record<string, number> = {
    checkbox: 100,
    vitest: 20,
    tsc: 20,
    diff: 20,
    no_errors: 10,
    progress_updated: 10,
    llmJudge: 30,  // significant weight but not blocking alone
};
// Total possible: 210
```

### 5.3 Relationship to `reviewAfterExecute`

`reviewAfterExecute` and `llmJudge` serve different purposes:

| Aspect | `reviewAfterExecute` | `llmJudge` verifier |
|--------|---------------------|---------------------|
| When | After confidence passes | During confidence scoring |
| How | Sends prompt to Copilot Chat | Direct `vscode.lm` API call |
| Response | Cannot read response programmatically | Reads response programmatically |
| Verdict | Parses from chat (fragile) | Structured parsing of direct LLM response |
| Scope | General code review | Task-specific criteria evaluation |
| Retry | Loops on NEEDS-RETRY verdict | Feeds back via confidence score failure |

The `llmJudge` verifier **subsumes** most of what `reviewAfterExecute` does, with better programmatic control. If `llmJudge` is enabled, `reviewAfterExecute` becomes redundant for the same task.

---

## 6. Design Decisions & Trade-offs

### 6.1 Why Binary (Pass/Fail), Not Scored

- Scoring (1-10) introduces calibration problems — is 6/10 a pass?
- Binary forces the judge to commit to a clear verdict
- Feedback string on failure provides the nuance that scoring would give
- Matches the existing `VerifyResult.Pass | VerifyResult.Fail` enum

### 6.2 Why Separate Verifier, Not Inline in Orchestrator

- **Composability**: Can be combined with other verifiers via `→ Verify:` DSL
- **Configurability**: Per-task criteria via args, not global
- **Testability**: Can unit test the judge prompt builder and verdict parser independently
- **Opt-in**: Disabled by default, zero cost when not used

### 6.3 Cost Considerations

Each `llmJudge` call costs ~500-1000 tokens (prompt) + ~50 tokens (response). At $0.01/1K tokens (GPT-4o), that's ~$0.005-0.01 per judgment. For a 20-task PRD with 1 retry average, total cost is ~$0.10-0.20. Acceptable for quality assurance.

### 6.4 Fallback Behavior

If `vscode.lm.selectChatModels()` returns no models (user not authenticated, model unavailable):
- **Default**: Skip judge, return `VerifyResult.Pass` — don't block the loop
- **Strict mode** (`llmJudge.required: true`): Return `VerifyResult.Fail` — block until model available

---

## 7. Summary

The `llmJudge` verifier adds semantic verification to ralph-loop's existing deterministic pipeline. It:
1. **Registers** as a standard verifier in `VerifierRegistry` — no special infrastructure needed
2. **Uses** the VS Code Language Model API for programmatic LLM access (not Copilot Chat commands)
3. **Accepts** per-task criteria via `args.criteria` and optional `args.artifact`
4. **Parses** a simple `VERDICT: PASS/FAIL` format from the LLM response
5. **Integrates** with confidence scoring (weight: 30/210) and the `→ Verify:` DSL
6. **Complements** deterministic gates — never replaces tsc/vitest, always runs after them
7. **Fails gracefully** — skips if no LLM model is available, doesn't block the loop by default

The implementation requires ~3 files: `src/llmJudge.ts` (prompt builder + verdict parser + LLM caller), an addition to `createBuiltinRegistry()` in `src/verify.ts`, and a config type in `src/types.ts`. Estimated ~150 lines of production code.
