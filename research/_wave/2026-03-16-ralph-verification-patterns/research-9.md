# Research Report 9: Circuit Breakers, Retry/Nudge Strategies, and Error Classification in Agent Loops

> **Wave**: 2026-03-16-ralph-verification-patterns  
> **Question**: What blog posts, conference talks, or engineering write-ups document real-world experiences with circuit breakers in agent loops, configurable retry/nudge strategies, or auto-classification of transient vs fatal errors in autonomous coding workflows?  
> **Date**: 2026-03-16  
> **Sources**: Local workspace (`ralph-loop/research/`, `ralph-loop/src/`), comparative analysis of 7+ agent orchestration systems, 13 ralph ecosystem repositories

---

## Findings

### 1. Circuit Breaker Patterns in Agent Loops

#### 1.1 IBM Research — "Kill Switches and Circuit Breakers" for AI Agents

The most comprehensive external framework comes from IBM's agent safety research (referenced in `AI_AGENT_ORCHESTRATION_COMPARISON.md`). IBM defines **five tiers** of circuit breakers for autonomous agents:

1. **Agent-level kill switch**: Boolean flag stored externally (Redis, feature flags, DynamoDB) — hard stop for an entire agent.
2. **Action-level circuit breakers**: Token bucket rate limiting per agent — prevents runaway API calls.
3. **Objective-based circuit breakers**: Sliding window pattern detection — e.g., >5 identical actions in 2 seconds triggers a trip.
4. **Policy-level hard stops**: OPA/Rego rules for semantic conditions (file size limits, action budgets, data boundaries).
5. **System-level kill switch**: Revoke SPIFFE identity for cryptographic shutdown — ultimate fallback.

Key insight: **Per-agent state isolation** prevents one noisy agent from affecting others. Each agent gets its own circuit breaker history and rate limits.

#### 1.2 AWS Agentic AI Security Matrix

AWS defines four **agency scopes** that determine which circuit breakers are appropriate:
- **Scope 1 (No agency)**: Read-only, no breaker needed.
- **Scope 2 (Prescribed agency)**: Human approval required — the circuit breaker is the human.
- **Scope 3 (Supervised agency)**: Autonomous within bounds — needs automated circuit breakers.
- **Scope 4 (Full agency)**: Self-initiating — needs all five IBM tiers plus behavioral monitoring and anomaly detection.

Ralph-loop operates at Scope 3 with aspirations toward Scope 4 (via autopilot mode).

#### 1.3 CrewAI — Built-in Loop Prevention with Real-Time Tracing

CrewAI is notable for combining **real-time tracing of every agent step** (tool calls, validation results) with **built-in tools for infinite loop prevention**. Every decision point is logged, enabling post-hoc debugging of why a circuit breaker tripped. This is the strongest observable circuit breaker implementation among production agent frameworks.

#### 1.4 ralph-loop's Composable Circuit Breaker Chain (Local Implementation)

Ralph-loop's `src/circuitBreaker.ts` implements a **composable chain** of six pure-function breakers:

| Breaker | Trip Condition | Action | Default |
|---------|---------------|--------|---------|
| `MaxRetriesBreaker` | `retryCount >= maxRetries` | `stop` | 3 retries |
| `MaxNudgesBreaker` | `nudgeCount >= maxNudges` | `stop` | 3 nudges |
| `StagnationBreaker` | `consecutiveNudgesWithoutFileChanges >= threshold` | `skip` | 2 consecutive |
| `RepeatedErrorBreaker` | Same normalized error hash seen ≥ threshold times | `skip` | 3 occurrences |
| `ErrorRateBreaker` | Error rate in sliding window > threshold | `stop` | 60% in last 5 |
| `TimeBudgetBreaker` | `elapsedMs > timeBudgetMs` | `skip` | 600s |

The `CircuitBreakerChain` runs all breakers in priority order and returns the **first tripped result**. This is a first-priority-wins design. Additionally, an `ErrorHashTracker` normalizes errors (strips ANSI codes, timestamps, line numbers, stack frames) and computes MD5 hashes for deduplication — enabling detection of the **same error recurring** even when surface details change.

#### 1.5 mikeyobrien/ralph-orchestrator — Loop Thrashing & Stale Detection

This Rust-based orchestrator detects two specific failure modes beyond basic stagnation:
- **Loop thrashing**: Same "hat" (persona) repeatedly blocked on the same event.
- **Stale loop**: Same event signature emitted 3+ times consecutively, indicating circular behavior.
- **Output validation**: 3+ consecutive malformed JSONL events trigger `ValidationFailure` termination.

Ralph-loop adopted this as **circular behavior detection** in `src/stagnationDetector.ts` and **output validation** in `src/diffValidator.ts`.

---

### 2. Configurable Retry/Nudge Strategies

#### 2.1 Ralph-loop's Dual-Track System: Nudges vs. Retries

Ralph-loop separates two fundamentally different recovery mechanisms:

- **Nudges**: Used when the agent **stalls** (inactivity timeout fires but the task isn't complete). The orchestrator re-sends the task prompt with a continuation message. Nudge count resets when the agent produces productive file changes — allowing re-nudging if the agent stalls again later.
- **Retries**: Used when a **transient error** occurs (network, timeout). The orchestrator waits 2 seconds and re-enters the task body. Retry count does NOT reset.

The `shouldNudge()` and `shouldRetryError()` functions in `decisions.ts` are **pure functions** taking plain state objects — no VS Code dependencies. This makes them unit-testable in isolation.

#### 2.2 Forced Conclusion Nudge (VS Code `isLastTurn` Pattern)

Ralph-loop's `buildFinalNudgePrompt()` mirrors VS Code's search subagent `isLastTurn` pattern: when `nudgeCount >= maxNudges - 1`, the nudge message changes from "continue" to "wrap it up NOW — produce your final result, commit partial work, mark done anyway." This degrades gracefully from "keep trying" to "produce SOMETHING."

#### 2.3 agrimsingh/ralph-wiggum-cursor — DEFER with Exponential Backoff

For rate limit errors specifically, this implementation uses exponential backoff: `backoff_delay = base * 2^attempt`. Most agent frameworks handle errors but don't explicitly handle **transient rate-limit retries with calculated delays**. This is a gap in many implementations including ralph-loop's current design.

#### 2.4 ClaytonFarr/ralph-playbook — Acceptance-Driven Backpressure

The playbook approach treats verification as a **backpressure mechanism**: specs define acceptance criteria as behavioral outcomes → plan derives test requirements → tests verify WHAT works, not HOW. The loop can reject task "completion" if acceptance criteria aren't met, creating a closed-loop correction cycle. The key principle: **"the plan is disposable, regeneration cost is one planning loop."**

#### 2.5 vercel-labs/ralph-loop-agent — Verification Feedback Injection

After each iteration, `verifyCompletion({ result, iteration })` returns `{ complete: boolean, reason?: string }`. On failure, the `reason` is **injected as feedback into the next prompt** — not just "tests failed" but why and how to fix. A separate **Judge Agent** reviews completion claims using read-only tools, providing approval or rejection with specific issues.

#### 2.6 Phase 9 Refined Tasks — Plan Regeneration as a New Breaker Action

The latest design adds `'regenerate'` to the circuit breaker action vocabulary. When decomposition has been tried and the agent still fails, instead of skipping, the loop **regenerates the plan** — re-runs bearings/planning with the message "Previous approach failed. Take a completely different approach." This extends the escalation chain: `nudge → decompose → regenerate → skip → stop`.

---

### 3. Auto-Classification of Transient vs. Fatal Errors

#### 3.1 Ralph-loop's `shouldRetryError()` — Pattern-Based Classification

In `src/decisions.ts`, error classification is done by substring matching against the error message:

```typescript
const transientPatterns = ['network', 'timeout', 'econnreset', 'econnrefused', 
  'etimedout', 'socket hang up', 'fetch failed', 'abort'];
return transientPatterns.some(p => msg.includes(p));
```

**Fatal conditions** (immediate abort, no retry):
- `stopRequested` is true (user cancellation)
- `retryCount >= MAX_RETRIES_PER_TASK` (exhausted retries)

This is a simple but effective heuristic. No external framework documentation was found that shows a more sophisticated error classifier for coding agent loops specifically.

#### 3.2 Phase 9 — BackpressureClassifier (Planned)

Task 61 in `research/14-phase9-refined-tasks.md` designs a three-way classification system:
- **Productive**: Error count decreasing over last 3 snapshots OR test pass count increasing — continue normally.
- **Stagnant**: Error count flat (±0), same errors repeating (unique/total ratio < 0.3) — inject guidance nudge.
- **Thrashing**: Delegates to `ThrashingDetector.isThrashing()` — escalate to circuit breaker.

This classifies not individual errors but **error trajectories** — a more nuanced approach than single-error classification.

#### 3.3 ErrorHashTracker — Deduplication-Based Recurrence Detection

Ralph-loop's `ErrorHashTracker` goes beyond classifying error types to tracking **whether the same error keeps recurring**. Normalization strips surface noise (timestamps, line numbers, ANSI codes, stack frames), then MD5 hashes the remainder. If the same hash appears ≥3 times, the `RepeatedErrorBreaker` trips. This catches the case where an error is technically "transient" (by pattern) but is practically **persistent** because the underlying cause hasn't been resolved.

---

## Patterns

### Pattern 1: Multi-Dimensional Circuit Breaker Chains
All mature agent orchestrators (ralph-loop, CrewAI, IBM research) converge on **composable chains** rather than single-threshold stops. The chain evaluates multiple orthogonal signals (retries, nudges, time, error rate, stagnation) and returns the first-tripped result. Priority ordering determines which breaker "wins" when multiple trip simultaneously.

### Pattern 2: Separate Nudge vs. Retry Semantics
Ralph-loop's distinction between nudges (agent stalled) and retries (transient error) is unique among the examined systems. Most frameworks conflate these. The separation enables different policies: nudges reset on productive work, retries don't. This avoids wasting retries on an agent that simply needs prompting.

### Pattern 3: Error Trajectory Classification Over Single-Error Classification
The most sophisticated approach is classifying **trends in error patterns** (productive/stagnant/thrashing) rather than individual errors. This handles the case where each error is transient but the agent is clearly stuck in a loop of transient failures.

### Pattern 4: Escalation Chains with Graceful Degradation
Best practice is a graduated escalation: nudge → retry → decompose → regenerate plan → skip → stop. Each level is more disruptive but more likely to break the deadlock. The forced conclusion nudge ("wrap it up NOW") is a particularly elegant degradation — get partial value rather than nothing.

### Pattern 5: Backpressure as Verification
The ralph-playbook and ralph-orchestrator pattern of requiring **evidence** before accepting task completion (file changes, test results) is a form of backpressure. This prevents the agent from claiming completion without doing work.

### Pattern 6: Error Hash Normalization for Recurrence Detection
Stripping volatile details (timestamps, line numbers, stack frames) before hashing enables detection of the "same error in different clothes." This bridges the gap between transient classification (by error type) and practical persistence (by recurrence).

---

## Applicability

### Directly Applicable to Ralph-loop (Already Implemented)
- Composable circuit breaker chain with 6 breakers — ✅ in `src/circuitBreaker.ts`
- Separate nudge/retry counters with reset semantics — ✅ in `src/decisions.ts`
- Error hash deduplication — ✅ in `src/circuitBreaker.ts` (`ErrorHashTracker`)
- Forced conclusion nudge — ✅ in `src/prompt.ts`
- Circular behavior detection — ✅ in `src/stagnationDetector.ts`

### Applicable but Not Yet Implemented
- **Exponential backoff for rate limits** (from ralph-wiggum-cursor): Ralph-loop's retry uses a flat 2-second delay. Exponential backoff would handle API rate limiting more gracefully.
- **BackpressureClassifier** (Task 61): Error trajectory analysis (productive/stagnant/thrashing) adds nuance to single-signal breakers.
- **Plan regeneration breaker** (Task 62): The `'regenerate'` action provides a mid-escalation recovery option between "keep trying" and "give up."
- **Verification feedback injection** (vercel-labs): Currently ralph-loop doesn't inject *why* verification failed into the next prompt.
- **Real-time tracing** (CrewAI): Every decision point should be observable for post-hoc debugging.

### Not Directly Applicable
- **OPA/Rego policy enforcement** (IBM Scope 4): Over-engineered for a VS Code extension that operates within a controlled environment.
- **SPIFFE identity revocation** (IBM Scope 5): Designed for distributed multi-agent systems, not single-agent loops.
- **Multi-agent GroupChat** (AutoGen): Ralph-loop uses a single Copilot backend; multi-agent patterns don't apply directly.

---

## Open Questions

1. **Should exponential backoff replace flat delay for retries?** The 2-second flat delay in `shouldRetryError` works for general transient errors, but API rate limits benefit from exponential backoff. Should ralph-loop detect rate-limit errors specifically and use a different delay strategy?

2. **How should error trajectory classification interact with circuit breakers?** The planned `BackpressureClassifier` (productive/stagnant/thrashing) operates at a higher abstraction level than individual breakers. Should it be a meta-breaker in the chain, or a separate decision layer that influences breaker thresholds?

3. **Is there a risk of over-recovery?** With nudge + retry + decompose + regenerate + skip in the escalation chain, could the system spend too many resources trying to recover a fundamentally impossible task? What's the optimal total recovery budget (time/iterations) before giving up?

4. **Can error classification be learned rather than hard-coded?** The current `transientPatterns` list is a static heuristic. Could a lightweight classifier trained on historical error data improve accuracy — or is the complexity not worth it for the marginal gain?

5. **No external blog posts or conference talks found specifically on circuit breakers in coding agent loops.** The primary sources are: IBM research papers on agent safety, AWS security matrix documentation, and ~13 open-source ralph ecosystem implementations. This appears to be a novel enough domain that practitioner write-ups specifically targeting "circuit breakers for autonomous coding agents" don't yet exist. The closest external material is the IBM/AWS agent safety frameworks, which treat coding agents as a special case of general autonomous agents.

6. **What's the right granularity for error hash normalization?** Over-normalization collapses genuinely different errors into the same hash. Under-normalization fails to detect recurrence. The current approach (strip timestamps, line numbers, ANSI, stack frames) is reasonable but hasn't been validated empirically against a corpus of real agent error logs.
