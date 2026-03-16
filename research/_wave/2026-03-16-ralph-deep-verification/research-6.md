# Research Report 6: IBM's 5-Tier Circuit Breaker Model vs. Ralph-Loop's 6-Breaker Chain

> **Wave**: 2026-03-16-ralph-deep-verification  
> **Question**: Detail IBM's 5-tier circuit breaker model for agent systems. How does ralph-loop's nudge vs retry separation compare? Why is this unique? Map ralph-loop's 6 breakers against IBM's tiers. What does "novel" mean here — is there really nothing else like this in OSS?  
> **Date**: 2026-03-16  
> **Sources**: `src/circuitBreaker.ts`, `src/stagnationDetector.ts`, `src/struggleDetector.ts`, `src/decisions.ts`, `research/AI_AGENT_ORCHESTRATION_COMPARISON.md`, `research/_wave/2026-03-16-ralph-verification-patterns/research-9.md`, comparative analysis of 7 OSS agent frameworks

---

## 1. IBM's 5-Tier Circuit Breaker Model

IBM's agent safety research defines a hierarchical, defense-in-depth model for autonomous agent systems. The five tiers are ordered from most granular (action-level) to most drastic (system-level):

| Tier | Name | Mechanism | Scope | Example |
|------|------|-----------|-------|---------|
| **1** | Agent-level kill switch | Boolean flag stored externally (Redis, feature flags, DynamoDB) | Entire agent | Set `agent_X_enabled = false` → agent hard-stops immediately |
| **2** | Action-level circuit breakers | Token bucket rate limiting per agent | Individual actions | Max 100 API calls/minute per agent; exceeding = trip |
| **3** | Objective-based circuit breakers | Sliding window pattern detection | Behavioral patterns | >5 identical actions in 2 seconds = circular behavior detected |
| **4** | Policy-level hard stops | OPA/Rego rules for semantic conditions | Domain constraints | File size limits, action budgets, data boundary enforcement |
| **5** | System-level kill switch | Revoke SPIFFE identity | Entire system | Cryptographic shutdown — agent loses all credentials |

**Key architectural principle**: Per-agent state isolation. Each agent gets its own circuit breaker history and rate limits, preventing one noisy agent from cascading failures to others.

### AWS Complementary Framework

AWS's Agentic AI Security Matrix defines four **agency scopes** that determine which IBM tiers are relevant:

| Scope | Agency Level | Circuit Breakers Needed |
|-------|-------------|------------------------|
| Scope 1 | No agency (read-only) | None |
| Scope 2 | Prescribed (human approval) | Human = the breaker |
| Scope 3 | Supervised (autonomous within bounds) | Tiers 1–3 minimum |
| Scope 4 | Full agency (self-initiating) | All 5 tiers + behavioral monitoring |

Ralph-loop operates at **Scope 3** (supervised autonomy within bounds), with aspirations toward Scope 4 via autopilot mode.

---

## 2. Ralph-Loop's 6 Circuit Breakers

Ralph-loop implements a **composable chain** of 6 pure-function breakers in `src/circuitBreaker.ts`. The `CircuitBreakerChain` evaluates all breakers in priority order and returns the **first-tripped result** (first-priority-wins):

| # | Breaker | Trip Condition | Action | Default Threshold |
|---|---------|---------------|--------|-------------------|
| 1 | `MaxRetriesBreaker` | `retryCount >= maxRetries` | `stop` | 3 retries |
| 2 | `MaxNudgesBreaker` | `nudgeCount >= maxNudges` | `stop` | 3 nudges |
| 3 | `StagnationBreaker` | `consecutiveNudgesWithoutFileChanges >= threshold` | `skip` | 2 consecutive |
| 4 | `RepeatedErrorBreaker` | Same normalized error hash ≥ threshold times | `skip` | 3 occurrences |
| 5 | `ErrorRateBreaker` | Error rate in sliding window > threshold | `stop` | 60% in last 5 |
| 6 | `TimeBudgetBreaker` | `elapsedMs > timeBudgetMs` | `skip` | 600 seconds |

### Supporting Infrastructure

- **`ErrorHashTracker`** (in `circuitBreaker.ts`): Normalizes errors by stripping ANSI codes, timestamps, line numbers, and stack frames, then computes MD5 hashes. Detects "same error in different clothes" via deduplication.
- **`StagnationDetector`** (in `stagnationDetector.ts`): SHA-256 hashes tracked files (`progress.txt`, `PRD.md`) between iterations. If all hashes remain identical for ≥ N iterations → stagnation.
- **`StruggleDetector`** (in `struggleDetector.ts`): Three-signal composite detector:
  - `no-progress`: 0 file changes for N consecutive iterations
  - `short-iteration`: Iteration completes in < 30s for N times (agent giving up quickly)
  - `repeated-error`: Same error hash appearing ≥2 times
- **`AutoDecomposer`** (in `stagnationDetector.ts`): When a task fails ≥ 3 times, splits it into sub-tasks at natural boundaries (numbered steps, semicolons).

### The Action Vocabulary

Each breaker returns one of four actions, forming a graduated response:

| Action | Meaning |
|--------|---------|
| `continue` | No trip — proceed normally |
| `nudge` | Agent stalled — re-send prompt with continuation message |
| `skip` | Task is stuck — move to next task |
| `stop` | Critical failure — halt the entire loop |
| `retry` | Transient error — wait and re-attempt |

---

## 3. Mapping Ralph-Loop's Breakers to IBM's Tiers

| IBM Tier | IBM Description | Ralph-Loop Implementation | Coverage |
|----------|----------------|--------------------------|----------|
| **Tier 1: Agent-level kill switch** | External boolean flag for hard stop | `MaxRetriesBreaker` + `MaxNudgesBreaker` → `stop` action halts the entire loop. Also: `stopRequested` flag in `LoopDecisionState` acts as an external kill switch set by user cancellation. | ✅ Covered (local equivalent) |
| **Tier 2: Action-level rate limiting** | Token bucket per agent | `TimeBudgetBreaker` — caps total elapsed time. `ErrorRateBreaker` — sliding window rate limit on error frequency. Combined, these prevent runaway API calls by bounding both time and failure rate. | ✅ Covered (time + error-rate variant) |
| **Tier 3: Objective-based pattern detection** | Sliding window for repeated actions | `RepeatedErrorBreaker` — detects same normalized error hash recurring 3+ times. `StagnationBreaker` — detects consecutive nudges without file changes. `StruggleDetector` — composite signal (no-progress, short-iteration, repeated-error). These are ralph-loop's strongest tier. | ✅✅ Covered (exceeds IBM) |
| **Tier 4: Policy-level hard stops** | OPA/Rego semantic rules | **Not implemented.** Ralph-loop does not use OPA or formal policy engines. However, the `PreCompleteHookChain` (tsc + vitest gates) and `DiffValidator` (validates file changes before commit) serve a similar semantic-constraint role — they're domain-specific policies enforced procedurally rather than declaratively. | ⚠️ Partial (hooks serve policy role) |
| **Tier 5: System-level kill switch** | SPIFFE identity revocation | **Not applicable.** Ralph-loop is a single-agent VS Code extension, not a distributed multi-agent system. There is no SPIFFE identity to revoke. The closest analog is `vscode.commands.executeCommand('workbench.action.chat.cancel')` — forcibly cancelling the Copilot session. | ❌ N/A (single-agent scope) |

### Where Ralph-Loop Exceeds IBM

IBM's model was designed for **general-purpose multi-agent cloud systems**. Ralph-loop specializes for **autonomous coding agent loops**, adding domain-specific breakers that IBM doesn't define:

1. **Nudge vs. Retry separation** (no IBM equivalent — see Section 4)
2. **Stagnation detection via file-hash comparison** (IBM uses action-pattern detection; ralph-loop detects *absence* of productive output)
3. **Error hash normalization and deduplication** (IBM discusses pattern detection but not error-specific deduplication with ANSI/timestamp stripping)
4. **Graduated action vocabulary** (`continue` → `nudge` → `retry` → `skip` → `stop`) vs. IBM's binary trip/no-trip

---

## 4. Nudge vs. Retry: Why the Separation Is Unique

### The Core Distinction

Ralph-loop separates two fundamentally different failure modes that every other examined system conflates:

| | **Nudge** | **Retry** |
|---|-----------|-----------|
| **Trigger** | Agent stalls (inactivity timeout fires, task not complete) | Transient error (network, timeout, ECONNRESET) |
| **Root Cause** | Agent is confused, distracted, or stuck in planning | Infrastructure/API failure |
| **Recovery** | Re-send task prompt: "Continue. Pick up where you left off." | Wait 2 seconds, re-enter task body |
| **Counter Reset** | Resets when agent produces productive file changes | Never resets |
| **Escalation** | Final nudge: "Wrap it up NOW — produce partial result" | After 3 retries → `stop` |
| **Implementation** | `shouldNudge()` in `decisions.ts` | `shouldRetryError()` in `decisions.ts` |

### Why This Matters

Most agent frameworks (Aider, Cline, AutoGen, LangGraph) have a single "retry" concept that handles both stalls and errors identically. This creates two problems:

1. **Wasted retries on stalls**: If an agent stalls (common in LLM-based agents), using a retry wastes one of the limited retry budget on what is actually a *prompting* failure, not a *system* failure.
2. **No reset semantics**: If the agent makes progress then stalls again, it should get fresh nudges. A unified retry counter would have already consumed budget on the first stall.

The separation enables:
- **Nudge budget is independent of retry budget**: An agent can stall 3 times, make progress, stall 3 more times — as long as it produces file changes between stall periods.
- **Final nudge creates graceful degradation**: `buildFinalNudgePrompt()` changes the message from "continue" to "wrap it up NOW" when `nudgeCount >= maxNudges - 1`. This mirrors VS Code's `isLastTurn` pattern in its search subagent.
- **Retry targets specific error patterns**: `shouldRetryError()` checks for known transient patterns (`network`, `timeout`, `econnreset`, etc.). Non-transient errors fail immediately rather than wasting retry budget.

### Uniqueness Claim

Among the 7 systems analyzed in `AI_AGENT_ORCHESTRATION_COMPARISON.md` (Aider, Continue.dev, Cursor, Cline, AutoGen, CrewAI, LangGraph):
- **None** implement separate nudge and retry counters
- **None** reset nudge budgets on productive work
- **None** have a "final nudge" graceful degradation pattern
- AutoGen has `max_turns` but treats all failures uniformly
- CrewAI has loop prevention but not nudge/retry separation

This is confirmed by the research-9 report: *"Ralph-loop's distinction between nudges (agent stalled) and retries (transient error) is unique among the examined systems. Most frameworks conflate these."*

---

## 5. Novelty Assessment: Is There Really Nothing Else Like This in OSS?

### What "Novel" Means Here

The claim is not that circuit breakers are novel (they're a standard distributed systems pattern from Michael Nygard's 2007 *Release It!*). The claim is that **composable, multi-dimensional circuit breaker chains purpose-built for autonomous coding agent loops** are novel. Specifically:

1. **6 orthogonal breakers in a priority chain** — no other OSS coding agent has this
2. **Separate nudge/retry semantics** — unique to ralph-loop
3. **Error hash normalization for recurrence detection** — not found in any examined system
4. **Stagnation-via-file-hash** — unique approach to detecting "agent is doing something but accomplishing nothing"

### OSS Landscape Comparison

| System | Circuit Breakers | Multi-dimensional? | Nudge/Retry Split? | Error Dedup? |
|--------|-----------------|--------------------|--------------------|-------------|
| **Aider** | ❌ None (user-driven) | N/A | ❌ | ❌ |
| **Continue.dev** | ⚠️ Tool policies only | ❌ | ❌ | ❌ |
| **Cursor** | ⚠️ Proprietary (unknown) | Unknown | Unknown | Unknown |
| **Cline** | ⚠️ Human-in-the-loop only | ❌ | ❌ | ❌ |
| **AutoGen** | `max_turns` only | ❌ Single threshold | ❌ | ❌ |
| **CrewAI** | ✅ Loop prevention + tracing | ⚠️ Partial | ❌ | ❌ |
| **LangGraph** | ⚠️ User-defined via graph | Depends on user | ❌ | ❌ |
| **ralph-loop** | ✅ 6-breaker composable chain | ✅ Yes | ✅ Yes | ✅ Yes |

### Ralph Ecosystem Variants

Approximately 13 ralph-ecosystem implementations exist (per `research-9.md`). Some notable variants:

- **mikeyobrien/ralph-orchestrator** (Rust): Detects "loop thrashing" (same persona blocked on same event) and "stale loop" (same event 3+ times). Closer to ralph-loop's approach but implemented as ad-hoc checks, not a composable chain.
- **agrimsingh/ralph-wiggum-cursor**: Implements exponential backoff for rate-limit errors specifically — a feature ralph-loop lacks.
- **vercel-labs/ralph-loop-agent**: Has a verification feedback injection loop and a separate "Judge Agent" — different architecture (uses a second LLM for validation rather than deterministic breakers).

### What's Genuinely Novel

1. **The composable chain pattern itself**: Pure-function breakers with a `CircuitBreakerChain` runner, configurable via YAML, individually enable/disable-able via a `disabled` set. This is a software engineering pattern (strategy pattern + chain of responsibility), but its application to coding agent safety is new.

2. **Error hash normalization**: `ErrorHashTracker.normalizeError()` strips ANSI escape codes, ISO 8601 timestamps, stack frame paths, and line numbers before hashing. This solves a real problem — the same compilation error looks different on each run due to timestamps and line numbers, but it's fundamentally the same error. No other examined system does this.

3. **Stagnation as file-hash delta**: `StagnationDetector.snapshot()` computes SHA-256 of tracked files. If hashes don't change across iterations, stagnation is triggered. This is philosophically different from action-pattern detection (IBM Tier 3) — it detects the *absence of productive output* rather than the *presence of repetitive actions*.

4. **The nudge/retry/skip/stop action vocabulary**: IBM's model is binary (tripped or not). Ralph-loop's 4-action vocabulary enables graduated responses: a stagnation trip says "skip this task" while a retry exhaustion says "stop everything."

### What's NOT Novel (Honest Assessment)

- Circuit breakers themselves (pre-date this by decades)  
- Max retry counters (every HTTP client has these)
- Time budgets (standard in job schedulers)
- Error rate windows (standard in service meshes like Istio)
- The concept of per-agent isolation (IBM, Kubernetes)

### Conclusion on Novelty

**The composition is novel, not the individual components.** Each breaker type has precedent in distributed systems. What's new is:
- Combining 6 orthogonal signals into a single evaluable chain for a *coding agent*
- Separating nudge (LLM stall) from retry (infra error) as distinct failure modes
- Error hash normalization for LLM-specific error recurrence detection
- File-hash-based stagnation detection as an output-quality signal

No other open-source coding agent orchestrator implements all four of these together. The closest is CrewAI (which has loop prevention and real-time tracing) but without the nudge/retry split, error dedup, or composable chain architecture.

The research-9 report confirms: *"No external blog posts or conference talks found specifically on circuit breakers in coding agent loops. This appears to be a novel enough domain that practitioner write-ups specifically targeting 'circuit breakers for autonomous coding agents' don't yet exist."*

---

## 6. Architectural Quality of the Implementation

### Design Strengths

1. **Pure functions**: All 6 breakers are pure functions taking `CircuitBreakerState` and returning `CircuitBreakerResult`. No side effects, no VS Code dependency. Fully unit-testable (confirmed: `test/circuitBreaker.test.ts` exists).

2. **Configurable via YAML**: `CircuitBreakerConfig[]` allows enabling/disabling individual breakers and setting thresholds. Default config enables MaxRetries, MaxNudges, and Stagnation; disables RepeatedError, ErrorRate, and TimeBudget.

3. **Factory pattern**: `createDefaultChain()` builds the chain from config, handling type narrowing for optional parameters with sensible defaults.

4. **Separation of detection and response**: The breaker only reports *what* tripped and suggests an action. The orchestrator decides *how to respond* (e.g., the `skip` action in StagnationBreaker means "move to next task" but the orchestrator implements that).

### Design Gaps

1. **No observability/tracing**: When a breaker trips, there's no structured telemetry event emitted. CrewAI's approach (real-time tracing of every decision point) would improve debuggability.

2. **Flat priority ordering**: The chain is first-priority-wins. If MaxRetries and TimeBudget trip simultaneously, only MaxRetries fires. There's no mechanism to compose or report multiple simultaneous trips.

3. **No exponential backoff**: Retries use a flat 2-second delay. Rate-limit errors from LLM APIs would benefit from exponential backoff (as implemented in ralph-wiggum-cursor).

---

## Open Questions

1. **Should ralph-loop add a formal policy engine (IBM Tier 4)?** The `PreCompleteHookChain` and `DiffValidator` serve this role informally. OPA/Rego would be over-engineered for a VS Code extension, but a lightweight policy DSL could formalize constraints like "max file size per edit" or "no changes to files matching `.env*`".

2. **Is 6 breakers the right number?** The planned `BackpressureClassifier` (productive/stagnant/thrashing) would be a 7th. At what point does the chain become too complex to reason about?

3. **Could error trajectory classification replace individual error breakers?** The planned BackpressureClassifier analyzes error *trends* (is the error count improving, flat, or worsening?) rather than individual error signals. Should it subsume `ErrorRateBreaker` and `RepeatedErrorBreaker`?

4. **Are there non-coding agent systems worth studying?** Service meshes (Istio, Linkerd) implement sophisticated circuit breaker chains for microservices. Their patterns (half-open state, gradual recovery) might apply to agent recovery strategies.

5. **How do proprietary systems handle this?** Cursor is closed-source. Devin (Cognition) likely has sophisticated safety mechanisms but they're not publicly documented. The novelty claim applies only to the *examined open-source* landscape.
