# Research Report: Checkpoint/Pause Patterns in Existing Ralph-Loop Research

**Wave ID**: 2026-03-17-ralph-checkpoint-patterns
**Report Index**: 6
**Date**: 2026-03-17
**Question**: How do existing ralph-loop research files and ecosystem analysis describe checkpoint/pause patterns?

---

## Findings

### 1. Inter-Task Cooldown (Human Review Window)

**Sources**: `research/10-adoption-priority-matrix.md` (P11), `research/09-ecosystem-patterns-synthesis.md` (§3.3)

The `aymenfurter/ralph` implementation introduces a **configurable 5-second pause between tasks** for human review. Documented in the ecosystem synthesis as "Inter-Task Cooldown" — a simple but effective oversight mechanism. The adoption priority matrix classifies it as Tier 3 (Medium Impact, Low Effort) and targets `orchestrator.ts`. This is the closest the existing research comes to an explicit checkpoint/pause primitive — a timed window where a human can observe and potentially intervene between autonomous iterations.

### 2. Dual Exit Gate / Layered Priority Halts

**Sources**: `research/07-frankbria-ralph-claude-code-analysis.md` (§3, §10), `research/09-ecosystem-patterns-synthesis.md` (§2.3)

The `frankbria/ralph-claude-code` system implements a **dual exit gate** requiring corroboration from multiple signals before halting. Permission denials trigger an immediate halt after just 2 consecutive occurrences — the highest-priority "checkpoint." The layered priority system (permission denial → test saturation → completion signals → safety breaker → project complete → plan complete) functions as a series of graduated gates. The key design insight: `EXIT_SIGNAL` in structured output takes **precedence** over heuristic signals, giving the AI agent explicit veto power over exit decisions.

### 3. Yield Requests (Graceful Pause Signals)

**Source**: `research/02-autopilot-deep-dive.md` (§4)

VS Code's autopilot mode handles "yield requests" — graceful pause signals sent when the user types a new message. In autopilot mode, these are **explicitly suppressed** unless `taskCompleted` is true. This represents a platform-level pause mechanism that ralph-loop inherits but cannot control: the VS Code host decides when to send yield requests, and autopilot ignores them to maintain autonomous execution.

### 4. Signs & Gates Methodology

**Sources**: `research/_parsed-links-2026-03-14.md`, `research/09-ecosystem-patterns-synthesis.md` (§6.3), `research/10-adoption-priority-matrix.md` (P20)

The `ClaytonFarr/ralph-playbook` introduces "Signs & Gates" as a core architectural pattern:
- **Signs** (upstream): Deterministic setup — allocate first ~5K tokens for specs, guidance, and guardrails
- **Gates** (downstream): Tests, typechecks, lints, builds that **reject invalid work**

Gates function as automated checkpoints — they don't pause execution but rather create backpressure that forces the agent to correct course. The "Don't Assume Not Implemented" gate (P20 in adoption matrix) is a specific pre-implementation search gate. This is a reactive checkpoint pattern: the gate fires only when verification fails, rather than pausing proactively.

### 5. Backpressure as a Checkpoint Mechanism

**Sources**: `research/09-ecosystem-patterns-synthesis.md` (§2.6, §7.6), `research/08-ralph-orchestrator-analysis.md` (§9.6), `research/13-phase9-deep-research.md` (§6)

Backpressure is the most extensively documented checkpoint-like pattern across the research base:
- **Acceptance-driven backpressure** (ralph-playbook): Three-phase connection (specs → plan → tests) where acceptance criteria create natural checkpoints
- **Backpressure verification gate** (ralph-orchestrator): Before accepting task completion, require evidence — at least one file modified, test files modified if task mentions "test," progress.txt updated. Rejection sends the agent back with specific missing-evidence feedback
- **Backpressure classification** (research-13): Distinguish productive backpressure (agent fixing test failures = good, don't interrupt) from stagnation (repeating same fix = bad, intervene). This creates an adaptive checkpoint that only triggers intervention when the agent is unproductive

### 6. Circuit Breaker as State-Machine Checkpoint

**Sources**: `research/07-frankbria-ralph-claude-code-analysis.md` (§1, §8), `research/09-ecosystem-patterns-synthesis.md` (§3.2)

The circuit breaker pattern (CLOSED → HALF_OPEN → OPEN) functions as an automated checkpoint system:
- **HALF_OPEN** is effectively a checkpoint state — a single iteration runs to probe whether recovery is possible
- **Cooldown period** (default 30 min) is a forced pause before retry
- **Auto-recovery** (`CB_AUTO_RESET=true`) can bypass cooldown entirely
- The pattern is **self-healing** — OPEN is never terminal, unlike a hard halt

### 7. Hook Suspend Policies (Human-in-the-Loop)

**Sources**: `research/08-ralph-orchestrator-analysis.md` (§9.10, Area 6)

The `ralph-orchestrator` documents three **hook suspend policies** that function as explicit pause mechanisms:
- `WaitForResume`: Pause execution until an external signal resumes it (true checkpoint)
- `RetryBackoff`: Exponential retry with configurable delays (automated pause)
- `WaitThenRetry`: Fixed wait then retry (timed pause)

These are the most explicit "pause" primitives documented in the research, but they exist only in the ralph-orchestrator's Rust implementation — not yet adopted into ralph-loop's TypeScript codebase.

### 8. State Checkpointing for Long-Running Workflows

**Source**: `research/AI_AGENT_ORCHESTRATION_COMPARISON.md` (§10, Recommendations)

The orchestration comparison explicitly recommends **state checkpointing** as a short-term enhancement for ralph-loop, drawing from LangGraph's pattern:
- Resume after interruption
- Audit trail recovery
- LangGraph's graph-based state machines provide "state checkpointing" and "memory persistence" as core features
- Cursor's "human-in-the-loop approvals" and LangGraph's "interrupts for human-in-the-loop" are identified as patterns ralph-loop lacks

### 9. Session Isolation as Implicit Checkpoint

**Sources**: `research/07-frankbria-ralph-claude-code-analysis.md` (§5), `research/09-ecosystem-patterns-synthesis.md` (§3.5)

Session isolation creates implicit checkpoints through natural session boundaries:
- Each session has a 24-hour expiration window
- Circuit breaker open triggers session reset (forced checkpoint)
- `session_id` comparison prevents cross-session interference
- Ralph-loop's "fresh session per task" design creates a natural checkpoint between every task

---

## Patterns

| Pattern | Type | Source System | Automation Level | Ralph-Loop Status |
|---------|------|---------------|-----------------|-------------------|
| Inter-task cooldown | Timed pause | aymenfurter/ralph | Semi-automated | Not implemented |
| Dual exit gate | Multi-signal halt | frankbria/ralph-claude-code | Fully automated | Partially adopted (stagnation detector) |
| Yield requests | Platform pause | VS Code autopilot | Platform-controlled | Suppressed in autopilot mode |
| Signs & Gates | Reactive gate | ClaytonFarr/ralph-playbook | Fully automated | Partially adopted (verifier chain) |
| Backpressure verification | Evidence gate | ralph-orchestrator | Fully automated | Not implemented |
| Circuit breaker states | State-machine checkpoint | frankbria/ralph-claude-code | Self-healing | Partially adopted |
| Hook suspend policies | Explicit pause | ralph-orchestrator | Configurable | Not implemented |
| State checkpointing | Resume/recover | LangGraph | Framework-provided | Not implemented |
| Session boundaries | Implicit checkpoint | anthropics official | Automatic | Implemented (fresh session per task) |

### Pattern Categories

1. **Proactive pauses**: Inter-task cooldown, hook `WaitForResume` — pause before something happens
2. **Reactive gates**: Signs & Gates, backpressure verification, dual exit gate — pause/reject when something fails
3. **State transitions**: Circuit breaker states, session boundaries — checkpoint as a side effect of state changes
4. **Platform signals**: Yield requests — external pause signals that the loop can honor or ignore

---

## Applicability

### Immediately Applicable to Ralph-Loop

1. **Inter-task cooldown** (P11): Simple `setTimeout` between task completions. Low effort, high oversight value. Already scoped in adoption matrix.
2. **Backpressure verification gate** (9.6): Require evidence (git diff non-empty, progress.txt updated) before accepting completion. Already designed in research-08.
3. **Backpressure classification**: Distinguish productive backpressure from stagnation in the existing `StagnationDetector`. Prevents premature intervention.

### Requires Architecture Work

4. **Hook suspend policies**: Need iteration-level hooks (9.10) first, then suspend policies on top. Medium effort.
5. **State checkpointing**: Need serializable loop state and resume logic. Enables recovery from crashes/interruptions. Higher effort but recommended by orchestration comparison.
6. **Human-in-the-loop interrupt**: Expose a mechanism for users to inject feedback mid-loop (beyond typing a new chat message). Would complement yield request handling.

### Not Directly Applicable

7. **LangGraph's graph-based checkpointing**: Too architecturally different — ralph-loop is a linear loop, not a state graph.
8. **CrewAI's real-time tracing**: Useful for observability but not a checkpoint pattern per se.

---

## Open Questions

1. **Should inter-task cooldown be configurable or a hard default?** Research says configurable (default 5s), but should it be skippable in "fast" preset?
2. **How should ralph-loop handle VS Code yield requests?** Currently suppressed in autopilot mode — should the orchestrator honor them as a checkpoint opportunity?
3. **Is backpressure verification (`requireVerificationEvidence`) a verifier or a separate gate?** It could be a new verifier type in the `VerifierRegistry` or a pre-accept check in the orchestrator.
4. **What state needs checkpointing for crash recovery?** Minimum viable: current task index, iteration count, circuit breaker state. Full: entire session state including verification history and knowledge entries.
5. **Should hook suspend policies support user-configurable timeouts?** The `WaitForResume` pattern from ralph-orchestrator blocks indefinitely — does ralph-loop need a timeout-bounded variant?
6. **How do checkpoint patterns interact with the existing escalation chain (nudge → decompose → regenerate → skip → stop)?** Should a checkpoint be a new action in the chain, or orthogonal to it?
7. **Is there a use case for mid-task checkpoints (within an iteration)?** All documented patterns operate at task boundaries or iteration boundaries — none pause mid-execution within a single LLM call.
