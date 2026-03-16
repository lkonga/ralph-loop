# Research Report: Vercel-Labs Feedback Injection Pattern (Self-Learning Within a Session)

> **Wave ID:** 2026-03-16-ralph-deep-verification
> **Report:** 1
> **Date:** 2026-03-16
> **Question:** How does vercel-labs implement "feedback injection" — where verification failure reasons are structured and injected into the next LLM prompt so the model learns from its mistakes within a session?
> **Sources:** `vercel-labs/ralph-loop-agent` (GitHub, via prior analysis in `research/12-detailed-source-analysis.md`, `research/09-ecosystem-patterns-synthesis.md`, `research/10-adoption-priority-matrix.md`), `research/_wave/2026-03-16-ralph-verification-patterns/research-3.md`, `research/_wave/2026-03-16-ralph-verification-patterns/research-5.md`, `research/_wave/2026-03-16-ralph-verification-patterns/research-9.md`, Vercel AI SDK `generateText` loop pattern, Reflexion (Shinn et al., 2023), Self-Refine (Madaan et al., 2023)

---

## Findings

### 1. The Core Pattern: `verifyCompletion` Callback → Reason Injection

The `vercel-labs/ralph-loop-agent` repo implements feedback injection through a **verification callback** that returns structured failure reasons, which are then **appended as user messages** to the next iteration's prompt.

The callback signature:

```typescript
verifyCompletion: async ({ result, iteration, allResults, originalPrompt }) => {
  return { complete: boolean, reason?: string };
}
```

When `complete: false`, the `reason` string is injected into the next LLM call as a prefixed user message:

```
Feedback: ${reason}
```

This creates a **closed-loop correction cycle**: the model receives specific, structured feedback about *why* its previous output was insufficient, rather than simply being told "try again."

### 2. How This Differs from Simple Retry

| Aspect | Simple Retry | Feedback Injection |
|--------|-------------|-------------------|
| **What the model receives** | Same prompt again (or generic "try again") | Original prompt + structured failure reason |
| **Model behavior** | Repeats same approach, may produce identical output | Adjusts approach based on specific failure feedback |
| **Convergence** | Random walk — may or may not fix the issue | Directed convergence — each iteration refines based on prior failure |
| **Information flow** | One-way (model → verifier → discard) | Closed-loop (model → verifier → structured feedback → model) |
| **Session learning** | None — same context on each retry | Cumulative — model sees history of failures and their reasons |
| **Academic analog** | Naive retry / random restart | Reflexion (Shinn et al., 2023), Self-Refine (Madaan et al., 2023) |

The critical difference: **Simple retry discards the verification signal. Feedback injection preserves and structures it.** The model receives actionable information about what failed, enabling within-session learning without any weight updates.

### 3. The Vercel AI SDK Loop Mechanism

The vercel-labs agent uses the Vercel AI SDK's `generateText` with an agentic loop pattern. The core iteration loop:

```typescript
import { generateText } from 'ai';

async function agentLoop(config: AgentLoopConfig) {
  const messages: CoreMessage[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: config.task },
  ];

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    const result = await generateText({
      model: config.model,
      messages,
      tools: config.tools,
      maxSteps: config.maxStepsPerIteration,
    });

    // Append assistant's response to message history
    messages.push(...result.responseMessages);

    // Run verification callback
    const verification = await config.verifyCompletion({
      result: result.text,
      iteration,
      allResults: messages,
      originalPrompt: config.task,
    });

    if (verification.complete) {
      return { success: true, result: result.text, iterations: iteration + 1 };
    }

    // FEEDBACK INJECTION: failure reason becomes next user message
    if (verification.reason) {
      messages.push({
        role: 'user',
        content: `Feedback: ${verification.reason}`,
      });
    }

    // Check stop conditions
    if (shouldStop(config.stopConditions, { iteration, usage: result.usage })) {
      return { success: false, reason: 'stop_condition_reached' };
    }
  }
}
```

**Key architectural choice**: The feedback is injected as a **user message**, not a system message. This keeps it in the conversation flow and allows the model to "see" the progression of its failures over time. The full message history (including prior feedback) accumulates, creating a trajectory the model can reason about.

### 4. The Judge Agent — A Specialized Verification Source

Beyond simple verification callbacks, vercel-labs implements a **Judge Agent** as a sophisticated feedback source:

```typescript
const judgeAgent = {
  model: anthropic('claude-opus-4-5-20250414'),
  tools: {
    // Read-only tools — judge cannot modify code
    readFile: readOnlyReadFile,
    listDirectory: readOnlyListDir,
    // Decision tools
    approveTask: tool({
      description: 'Approve the task as complete',
      parameters: z.object({ reasoning: z.string() }),
      execute: async ({ reasoning }) => ({ approved: true, reasoning }),
    }),
    requestChanges: tool({
      description: 'Request changes to the implementation',
      parameters: z.object({
        issues: z.array(z.string()),
        suggestions: z.array(z.string()),
      }),
      execute: async ({ issues, suggestions }) => ({
        approved: false,
        issues,
        suggestions,
      }),
    }),
  },
};
```

When the coding agent calls `markComplete`, the Judge Agent reviews the work with **read-only** tools. If it calls `requestChanges`, the structured issues and suggestions become the feedback injected into the next iteration. This separation enforces objectivity — the implementer cannot evaluate its own work.

### 5. Multi-Dimensional Stop Conditions (Complementary Pattern)

Feedback injection is bounded by stop conditions that prevent infinite correction loops:

```typescript
// Combined stop conditions — any one can terminate the loop
iterationCountIs(10),        // Hard cap on iterations
tokenCountIs(500_000),       // Token budget across all iterations
costIs(5.00, 'claude-opus-4-5-20250414'),  // Dollar cost cap
```

These check `totalUsage` accumulated across iterations, preventing the feedback loop from consuming unbounded resources.

### 6. Academic Foundations: Reflexion and Self-Refine

The vercel-labs pattern independently converges with two academic approaches:

**Reflexion** (Shinn et al., 2023): Uses "verbal reinforcement" — the agent generates a natural-language reflection on its failure, which is stored in a memory buffer and prepended to future attempts. Key finding: structured verbal feedback yields 91% accuracy on HumanEval vs. 80% for simple retry.

**Self-Refine** (Madaan et al., 2023): Iterates on the model's own output using self-generated feedback. The pattern: generate → evaluate → refine, where the evaluation produces specific critique that drives the refinement. Both papers confirm the same insight: **specific, structured feedback dramatically outperforms generic retry.**

---

## Implementation Pattern

### The Feedback Injection Architecture (4 Components)

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│ 1. Execute  │────▶│ 2. Verify    │────▶│ 3. Structure  │────▶│ 4. Inject    │
│    Task     │     │    Result    │     │    Feedback   │     │    Into Next │
│             │     │              │     │              │     │    Prompt    │
│ generateText│     │ verifyCompl. │     │ Format reason │     │ messages.push│
│ with tools  │     │ returns      │     │ as actionable │     │ { role: user │
│             │     │ {complete,   │     │ guidance      │     │   content:   │
│             │     │  reason}     │     │              │     │   Feedback:..│
└─────────────┘     └──────────────┘     └───────────────┘     └──────────────┘
       ▲                                                              │
       └──────────────────────────────────────────────────────────────┘
                              Next iteration loop
```

### Design Principles

1. **Feedback is a user message, not a system override** — preserves conversation flow
2. **Feedback accumulates** — the model sees its full failure trajectory across iterations
3. **Feedback is specific** — "TypeScript compilation failed: Property 'foo' does not exist on type 'Bar'" not just "tests failed"
4. **Verification is separated from execution** — the verifier is a callback, not inline logic
5. **Stop conditions bound the loop** — feedback injection never runs unbounded

---

## Code Example: Concrete Implementation for ralph-loop

The gap in ralph-loop: `verify.ts` runs checks and produces `VerifyCheck[]` with pass/fail results and `detail` strings, but these details **never flow back into the next prompt**. The orchestrator yields events and nudges, but the nudge prompt is generic.

### Current ralph-loop flow (no feedback injection):

```typescript
// orchestrator.ts (simplified)
const checks = await runVerifierChain(task, workspaceRoot, configs, registry, logger);
const allPassed = allChecksPassed(checks);

if (!allPassed) {
  // Generic nudge — model doesn't know WHY it failed
  yield { kind: LoopEventKind.VerificationFailed, checks };
  // Next iteration uses same prompt template without failure details
}
```

### Proposed feedback injection for ralph-loop:

```typescript
// New function in verify.ts
export function formatVerificationFeedback(checks: VerifyCheck[]): string | undefined {
  const failures = checks.filter(c => c.result === VerifyResult.Fail);
  if (failures.length === 0) { return undefined; }

  const lines = [
    '=== VERIFICATION FEEDBACK ===',
    `${failures.length} check(s) failed:`,
    ...failures.map((f, i) => `${i + 1}. [${f.name}] ${f.detail}`),
    '',
    'Fix these issues before marking the task complete.',
    '=== END FEEDBACK ===',
  ];
  return lines.join('\n');
}
```

```typescript
// In orchestrator.ts loop, after verification fails:
const feedback = formatVerificationFeedback(checks);

// Inject into next iteration's prompt via operatorContext
const nextPrompt = buildPrompt(
  taskDescription,
  prdContent,
  progressContent,
  maxProgressLines,
  promptBlocks,
  capabilities,
  learnings,
  iterationNumber + 1,
  contextTrimming,
  feedback,  // ← injected as operatorContext parameter
  taskId,
);
```

This maps to ralph-loop's existing `operatorContext` parameter in `buildPrompt()`, which already renders an `OPERATOR CONTEXT (injected mid-loop)` section. The verification failures slot directly into this existing mechanism — no new prompt infrastructure needed.

### The difference from giocaizzi's Fix-Instruction Forwarding (P2):

| Approach | What's Injected | Source |
|----------|----------------|--------|
| **Feedback Injection (P1, vercel-labs)** | Structured failure reasons from verification checks | Machine verification output (tsc, vitest, checkbox) |
| **Fix-Instruction Forwarding (P2, giocaizzi)** | Parsed actionable fix instructions from test/lint output | Deeper parsing of stderr/stdout to extract specific fix guidance |

Both are complementary — P1 provides the structured "what failed" signal, P2 enhances it with "how to fix it." The ideal implementation layers P2 on top of P1.

---

## Applicability to ralph-loop

### Direct Applicability: HIGH

Ralph-loop already has all the building blocks:

1. **`VerifyCheck[]` with `detail` strings** — the failure reasons already exist in `verify.ts`
2. **`operatorContext` parameter in `buildPrompt()`** — the injection point already exists in `prompt.ts`
3. **`LoopEventKind.VerificationFailed` event** — the orchestrator already knows when verification fails
4. **Dual exit gate** (`dualExitGateCheck`) — already separates model signal from machine verification

### What's Missing (The Gap)

The pipeline is **broken at one point**: verification failure details are yielded as events and logged, but never fed back into the next iteration's prompt. The `operatorContext` parameter exists but is only used for user-injected mid-loop context, never for machine-generated verification feedback.

### Implementation Effort: LOW (< 1 task)

1. Add `formatVerificationFeedback()` to `verify.ts` (~15 lines)
2. In the orchestrator's verification-failed path, call `formatVerificationFeedback()` and pass result as `operatorContext` to the next `buildPrompt()` call
3. Tests: verify the feedback string contains failure names and details

### Expected Impact: HIGHEST of all pending improvements

Per the adoption priority matrix (`research/10-adoption-priority-matrix.md`), this is **P1 — the single highest-impact change for loop convergence**. It transforms ralph-loop from a blind retry loop into a self-correcting convergence system. Academic evidence (Reflexion) shows ~11 percentage point improvement in task completion from this pattern alone.

### Risks

- **Context bloat**: Accumulated feedback across many iterations can fill the context window. Mitigate using the existing `contextTrimming` tiers (full → abbreviated → minimal).
- **Feedback noise**: Verbose verification output may confuse the model. Mitigate by keeping feedback structured and concise (the `formatVerificationFeedback` function above).
- **Circular feedback**: If the same failures repeat, the model sees duplicate feedback. Mitigate by deduplicating feedback across iterations using `ErrorHashTracker` (already exists in `circuitBreaker.ts`).

---

## Open Questions

1. **Optimal feedback format for Copilot Agent Mode**: The vercel-labs pattern uses plain `Feedback: ${reason}` as a user message. For VS Code Copilot, should this be XML-structured (`<verification-feedback>...</verification-feedback>`), markdown sections, or inline text? The `operatorContext` renderer uses `=== OPERATOR CONTEXT ===` delimiters which may work well.

2. **Should feedback accumulate or replace?**: Vercel-labs accumulates all feedback in the message history. Ralph-loop's prompt is reconstructed each iteration. Should the feedback only include the most recent verification failure, or accumulate failures across iterations?

3. **Judge Agent cost-benefit for VS Code**: The vercel-labs Judge Agent uses claude-opus-4.5 — an expensive model. In a VS Code extension where every model call goes through Copilot's quota, is a separate judge LLM call justifiable? The deterministic verification (tsc, vitest) may be sufficient without LLM judgment.

4. **Interaction with `StagnationDetector`**: If feedback injection doesn't fix the issue after N iterations, the stagnation detector should escalate (decompose → regenerate → skip). How does the feedback injection interact with the existing stagnation detection thresholds?
