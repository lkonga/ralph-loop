# Research Report: Human-in-the-Loop Patterns in Agent Orchestration Systems

**Wave**: 2026-03-17-ralph-checkpoint-patterns
**Report**: research-8
**Date**: 2026-03-17
**Question**: What do robust agent orchestration systems do for human-in-the-loop patterns?
**Sources**: `research/AI_AGENT_ORCHESTRATION_COMPARISON.md`, `research/09-ecosystem-patterns-synthesis.md`, `research/07-ralph-playbook-analysis.md`, `research/07-ralph-wiggum-playbook.md`, `research/07-ralph-starter-architecture.md`, `research/07-frankbria-ralph-claude-code-analysis.md`, `research/08-ralph-orchestrator-analysis.md`

---

## Findings

### System-by-System Human-in-the-Loop Analysis

#### 1. Aider — **Human-Directed** (fully reactive)
- **When human gets involved**: Every turn. User drives each interaction; the agent never acts autonomously.
- **Proactive vs reactive**: Purely reactive — no autonomous loop exists.
- **Mandatory vs optional**: Mandatory — no work happens without explicit user input.
- **Patterns**: Git diff review before each commit serves as an implicit approval gate. Pre-commit hooks for linting/testing add automated validation but these are mechanical, not human approval.
- **Key trait**: Strongest human control at the cost of zero autonomy.

#### 2. Continue.dev — **Approval-Gated** (permission prompts + CI gates)
- **When human gets involved**: Permission prompts before tool use; CI pipeline checks on PRs.
- **Proactive vs reactive**: Reactive per-action (prompts) + proactive at integration boundary (CI status checks).
- **Mandatory vs optional**: Configurable via tool policies — can auto-approve, deny, or require permission per tool.
- **Patterns**: Tool policies (allow/auto-approve/deny lists), checks-as-code (markdown agent definitions in `.continue/checks/`), CI-level enforcement.
- **Key trait**: Three-tier permission model — tools can be fully trusted, partially trusted, or blocked.

#### 3. Cursor — **Human-Monitored** (autonomous with approval)
- **When human gets involved**: Permissioned actions (terminal commands, file operations) require approval.
- **Proactive vs reactive**: Reactive — agent requests permission as needed.
- **Mandatory vs optional**: Mandatory for destructive actions; optional for read operations.
- **Patterns**: Human-in-the-loop approvals for permissioned actions, git-smart diffs for review.
- **Key trait**: "Autonomy with oversight" — proprietary implementation details largely undocumented.

#### 4. Cline — **Approval-Gated** (per-action permission buttons)
- **When human gets involved**: Every tool use requires permission button click. Token/cost tracking alerts user to runaway behavior.
- **Proactive vs reactive**: Reactive (permission prompts) + proactive cost alerting.
- **Mandatory vs optional**: Mandatory per-action approval is the default; Plan Mode provides read-only exploration without approval needs.
- **Patterns**: Permission buttons before each tool use, token/cost tracking per request, Plan vs Act mode separation.
- **Key trait**: Most granular per-action human involvement, but can cause "approval fatigue."

#### 5. AutoGen (Microsoft) — **Human-Monitored** (configurable involvement)
- **When human gets involved**: `max_turns` parameter acts as a mandatory checkpoint. Human-in-the-loop support via message audit.
- **Proactive vs reactive**: Reactive — relies on termination conditions rather than proactive escalation.
- **Mandatory vs optional**: Optional — `max_turns` is the main guardrail, human review is opt-in.
- **Patterns**: GroupChat orchestrator with all messages flowing through single auditable point, `max_turns` as hard iteration cap, message flow audit logs.
- **Key trait**: Multi-agent conversation with centralized audit, but no built-in approval gates.

#### 6. CrewAI — **Human-Monitored** (callbacks + guardrails)
- **When human gets involved**: Human-in-the-loop callbacks at designated points; real-time tracing provides visibility.
- **Proactive vs reactive**: Both — callbacks are proactive triggers, real-time tracing is proactive observability.
- **Mandatory vs optional**: Optional — callbacks must be explicitly configured; guardrails are built-in.
- **Patterns**: Role-based agents with callbacks, real-time step-by-step tracing, built-in guardrails, circuit breakers for infinite loop prevention.
- **Key trait**: Best observability — every agent step traced for human review, but review is post-hoc by default.

#### 7. LangGraph — **Human-Monitored** (interrupt-based)
- **When human gets involved**: At graph `interrupt` nodes, state checkpoints, or middleware hooks.
- **Proactive vs reactive**: Proactive — interrupts are designed into the graph topology; developer decides where humans must intervene.
- **Mandatory vs optional**: Developer-defined — interrupts are architecturally mandatory at their insertion points.
- **Patterns**: Graph-based state machines with interrupt nodes, state checkpointing for resume, middleware for cross-cutting concerns, human-in-the-loop at any graph edge.
- **Key trait**: Most flexible — human checkpoints are first-class graph primitives, not bolted on.

### Ralph Ecosystem Human-in-the-Loop Patterns

#### Ralph Playbook (ClaytonFarr) — **Human Over the Loop** (observation, not intervention)
- **Philosophy**: "Human oversight is OVER the loop, not IN it." Human engineers the setup/environment, observes, and course-corrects between loop runs — never within a running iteration.
- **Patterns**: Signs & gates (reactive guardrails added when failures observed), disposable plans (human can regenerate), inter-run tuning ("tune it like a guitar"), backpressure as automated human proxy (tests/builds reject work mechanistically).
- **Key insight**: Replaces per-action human approval with deterministic quality gates. Human's role shifts from approver to systems designer.

#### Ralph-Starter (multivmlabs) — **Approval-Gated + Autonomous** (configurable)
- **Patterns**: Session pause/resume with `pauseReason`, exit reason taxonomy (6 reasons including `paused`), preset-based strictness (migration-safety = 1-failure stop vs feature = 3-failure tolerance), cost ceiling as automatic human-proxy gate.
- **Key trait**: Human involvement is preset-driven — strict presets approximate mandatory human review, loose presets approximate full autonomy.

#### Ralph-Orchestrator (mikeyobrien) — **Escalation-Based** (hook-driven)
- **Patterns**: `human.interact` lifecycle hook, `WaitForResume` suspend policy (pause until human signal), `RetryBackoff` (exponential retry before escalation), confidence protocol 0-100 for agent self-assessment, `inject_fallback_event()` as automated pre-escalation, `TaskAbandoned` after 3 failed interventions as final escalation.
- **Key trait**: Graduated escalation — automated recovery attempts before involving human.

#### Frankbria/ralph-claude-code — **Dual-Gate + Autonomous**
- **Patterns**: Dual exit gate (orchestrator heuristics + agent EXIT_SIGNAL must agree), permission denial circuit breaker (2 denials = halt → implicit human review), RALPH_STATUS protocol gives agent explicit veto over exit decisions.
- **Key insight**: The agent itself is a human-in-the-loop proxy — its EXIT_SIGNAL prevents premature termination even when orchestrator heuristics say "done."

### AWS Security Scoping Model (from IBM/AWS research cited in comparison)

Four agency scopes directly map to human-in-the-loop intensity:

| Scope | Agency Level | Human Involvement |
|-------|-------------|-------------------|
| Scope 1 | No agency (read-only) | N/A — agent cannot act |
| Scope 2 | Prescribed agency | Human approval required for every action |
| Scope 3 | Supervised agency | Autonomous within bounds, human sets bounds |
| Scope 4 | Full agency | Self-initiating, advanced controls needed |

---

## Patterns

### Pattern 1: Permission Granularity Spectrum

Systems fall on a spectrum from per-action approval to no approval:

```
Per-action          Per-tool-class       Per-task           Per-run           Never
(Cline)             (Continue.dev)       (Cursor)           (Ralph Playbook)  (loop.sh --yolo)
```

**Trade-off**: Finer granularity = more safety but more "approval fatigue" and slower execution.

### Pattern 2: Approval Fatigue → Policy-Based Delegation

Every system that starts with per-action approval evolves toward policy-based delegation:
- Continue.dev: Tool policies (auto-approve read operations, require approval for writes)
- Cline: Plan Mode (read-only exploration needs no approval)
- Ralph-Starter: Presets encode trust levels (incident-response = strict, feature = relaxed)

### Pattern 3: Graduated Escalation Chain

The most mature systems use a graduated chain before involving humans:

```
Automated retry → Fallback injection → Strategy change → Circuit breaker → PAUSE (human)
```

- Ralph-Orchestrator: `RetryBackoff` → `inject_fallback_event()` → `TaskAbandoned` → `WaitForResume`
- Frankbria: Retry → dual-gate check → permission denial detection → halt
- CrewAI: Built-in retry → real-time tracing alert → callback to human

### Pattern 4: Deterministic Gates as Human Proxy

Ralph Playbook's core insight: Replace most human approval with deterministic backpressure:
- Tests reject invalid work (no human needed to say "this is wrong")
- Typechecks enforce interfaces (no human needed to review signatures)
- Lints enforce style (no human needed for formatting)

Only escalate to human for genuinely subjective or novel decisions.

### Pattern 5: Confidence-Based Escalation

Several systems use confidence thresholds to decide when human involvement is needed:
- Ralph-Orchestrator: Confidence protocol 0-100, low confidence → escalate
- LLM-as-Judge (Ralph Playbook): Binary pass/fail for subjective criteria
- CrewAI: Real-time tracing visibility — human monitors but doesn't block

### Pattern 6: State Checkpointing for Resume

Systems that support pause/resume need state persistence:
- LangGraph: State checkpointing at graph nodes (most robust)
- Ralph-Starter: `.ralph-session.json` with full loop state
- Frankbria: `.ralph/.circuit_breaker_state` + `.ralph/.exit_signals`

### Pattern 7: Dual-Condition Gating

No single signal should trigger a critical decision:
- Frankbria: `completion_indicators >= 2` AND `EXIT_SIGNAL: true` (both required)
- Ralph-Playbook: Checkbox audit + deterministic gates (not just agent's claim)
- Vercel Judge Agent: Coding agent claims done THEN separate Judge Agent verifies

---

## Applicability

### For ralph-loop's Checkpoint System

1. **Adopt the graduated escalation pattern** (Pattern 3): Don't immediately pause for human — try automated recovery first (retry, nudge, strategy change), then pause only when automated recovery is exhausted. Currently ralph-loop has nudges and circuit breakers; the missing piece is *explicit pause-for-human* as the terminal escalation step.

2. **Implement deterministic gates as human proxy** (Pattern 4): Ralph-loop already has bearings (tsc + vitest). Extend this to be the primary "human approval substitute" — if tests and types pass, the task is approved. Only escalate truly novel failures (new error patterns, confidence below threshold) to human.

3. **Add preset-driven trust levels** (Pattern 2): Different tasks warrant different human involvement levels. A `careful` preset could add iteration-level pause points; a `fast` preset could run fully autonomous with only circuit-breaker stops. Map this to VS Code quickpick or settings.

4. **State checkpointing for pause/resume** (Pattern 6): When the loop pauses for human review, persist full state (current task, iteration count, circuit breaker state, uncommitted changes). Allow resuming from exactly where paused. Ralph-Starter's `.ralph-session.json` is the reference implementation.

5. **Dual-gate for completion** (Pattern 7): Don't trust a single signal that tasks are done. Require both: (a) PRD checkbox checked AND (b) all deterministic gates pass. If either disagrees, loop continues or escalates.

6. **Follow AWS Scope 3 by default** (Supervised Agency): ralph-loop should operate autonomously within bounds (iteration limits, circuit breakers, test gates) with human setting bounds, not approving each action. Scope 2 (per-action approval) should be available as a strict mode but not the default.

### What NOT to Adopt

- **Per-action approval** (Cline-style): Too granular for an autonomous loop; causes approval fatigue.
- **Fully autonomous with no human checkpoints** (bare loop.sh): Too risky for non-sandboxed VS Code extension.
- **Complex multi-agent negotiation** (AutoGen GroupChat): Over-engineered for single-agent Copilot integration.

---

## Open Questions

1. **Where exactly should checkpoint pauses fire in ralph-loop?** Between tasks? After N iterations? Only on circuit breaker trip? All three?

2. **What UI surface for human review?** VS Code notification? Output channel with "Resume" button? Modal dialog? Information message with actions?

3. **Should the agent be able to request human input proactively?** (e.g., "I'm unsure about this architectural choice — should I proceed?") Ralph-Orchestrator's confidence protocol enables this, but it requires the LLM to self-assess reliably.

4. **How to handle VS Code lifecycle?** If user closes VS Code during a pause, state must persist. If user opens a different workspace, the paused loop shouldn't resume. Session isolation (frankbria pattern) is relevant here.

5. **Cooldown vs explicit resume?** Frankbria auto-resumes after 30-minute cooldown. Ralph-Starter requires explicit resume. Which model fits VS Code UX better?

6. **Pre-task vs post-task checkpoints?** Pre-task: "About to work on Task X, proceed?" Post-task: "Completed Task X, review before continuing?" Post-task is more informative but slightly delayed.

7. **Should different task types have different checkpoint policies?** Implementation tasks might be safe to auto-approve if tests pass, but deletion/refactoring tasks might always require human review.
