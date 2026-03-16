## Aggregation Report 1

### Source Reports

1. **research-1.md** — Core identity, value proposition, ecosystem positioning, and what makes ralph-loop unique among 20+ Ralph implementations. Key finding: ralph-loop is the most feature-rich VS Code-native variant, self-hosting since Phase 1, with defense-in-depth guardrails and compounding knowledge. [source: research-1.md#L1-L5]

2. **research-2.md** — Deep dive into the `LoopOrchestrator` async generator architecture, its 9-phase execution cycle, supporting subsystems (circuit breakers, stagnation/struggle detection, diff validation), and the strategy/hook extension points. Key finding: the loop is an `AsyncGenerator<LoopEvent>` with dual exit gates, tiered escalation, and adaptive nudging. [source: research-2.md#L1-L5]

3. **research-3.md** — PRD-as-database task management system: two-pass parsing, DAG-aware task selection, auto-decomposition, dual-file state (PRD.md + progress.txt), and invocation ID traceability. Key finding: the PRD.md file simultaneously serves as spec, task queue, and completion ledger with no external state store. [source: research-3.md#L1-L5]

### Deduplicated Findings

#### F1: Core Identity & Elevator Pitch
Ralph-loop is a VS Code extension that drives Copilot Agent Mode in a deterministic loop from PRD tasks. It activates on `workspaceContains:PRD.md` (zero-config), parses checkbox tasks, opens fresh Copilot sessions per task, and loops until all tasks are done. Version 0.4.1, MIT license, 21 source modules, 361+ Vitest tests, 9 development phases completed. [source: research-1.md#L5-L12]

#### F2: The Fundamental Insight
> Context rot is unsolvable within a session, so nuke the context and persist state in files.

This drives the entire architecture: fresh session per task, PRD.md as state, progress.txt as audit log, knowledge.md as compounding learnings. [source: research-1.md#L10-L11]

#### F3: Ecosystem Positioning
Ralph-loop is the most mature VS Code-native variant among 20+ Ralph implementations (vs. snarktank/ralph 113-line bash, frankbria/ralph-claude-code 1900-line bash for Claude CLI). Unique differentiators: deep VS Code integration, richest guardrail system (5 circuit breaker types, 3 struggle signals), compounding knowledge, mandatory TDD gate, self-hosting. [source: research-1.md#L14-L23]

#### F4: Orchestrator Architecture — Async Generator Loop
The `LoopOrchestrator` class has 3 states (Idle, Running, Paused) and uses an `AsyncGenerator<LoopEvent>` as its core execution engine. The generator yields 30+ event kinds consumed by a `for await` loop, cleanly separating loop logic from side effects. Constructor takes `RalphConfig`, `ILogger`, `onEvent` callback, and optional hook service + consistency checker. [source: research-2.md#L5-L18]

#### F5: The 9-Phase Execution Cycle
Each iteration of the generator proceeds through:
- **Phase 0** — Initialization: resolve paths, create linked cancellation, initialize detectors (stagnation, struggle, auto-decomposer, knowledge manager), run `onSessionStart` hook [source: research-2.md#L22-L26]
- **Phase 1** — Guard checks: abort signal, pause polling, circuit breaker pre-check, iteration limit with auto-expand (50% increase if tasks remain, capped at `hardMaxIterations`) [source: research-2.md#L28-L32]
- **Phase 2** — Task selection: parse PRD, pick next task (sequential) or ready tasks (DAG-aware parallel with concurrency cap) [source: research-2.md#L34-L38]
- **Phase 3** — Bearings: optional pre-flight health check (`tsc --noEmit` + `vitest run`); injects fix task or pauses if unhealthy [source: research-2.md#L40-L43]
- **Phase 4** — Task execution: UUID invocation ID, stagnation snapshot, prompt building (task + PRD + progress + knowledge + operator context), parallel monitor, execution via strategy pattern [source: research-2.md#L45-L50]
- **Phase 5** — Nudge loop: timeout-based continuation prompts, adaptive reset on productive file changes, circuit breaker checks [source: research-2.md#L52-L55]
- **Phase 6** — Post-execution evaluation: stagnation detection (3-tier escalation), struggle detection (thrashing patterns), dual exit gate (model signal AND machine verification) [source: research-2.md#L57-L60]
- **Phase 7** — Completion pipeline: confidence scoring → preComplete hooks → taskComplete hook → optional LLM review → atomic git commit → deferred yield [source: research-2.md#L62-L68]
- **Phase 8** — Failure path: auto-decomposition after N failures, error retry (max 3) for transient errors [source: research-2.md#L70-L73]
- **Phase 9** — Cooldown: dialog or countdown timer, session state persistence [source: research-2.md#L75-L77]

#### F6: PRD-as-Database Task Management
PRD.md is simultaneously spec, task queue, and completion ledger. Two-pass parsing: Pass 1 scans checkboxes (`- [ ]`/`- [x]`) capturing indentation, description, line number, skipping `[DECOMPOSED]` markers. Pass 2 assigns sequential IDs (`Task-001`…) and infers dependency DAG from indentation (explicit `depends:` annotations take priority). Output: `PrdSnapshot { tasks, total, completed, remaining }`. [source: research-3.md#L5-L18]

#### F7: Dual-File State System
Two files work in lockstep: PRD.md (structured current state, checkbox mutations at exact line numbers) and progress.txt (append-only audit log with ISO 8601 timestamps). UUID `taskInvocationId` threads through all entries for end-to-end traceability. The orchestrator re-reads PRD.md every iteration (no in-memory cache), tolerating concurrent edits by the agent. [source: research-3.md#L25-L35]

#### F8: Dual Exit Gate & Confidence Scoring
Task completion requires BOTH model self-report (checkbox marked) AND machine verification (tsc + vitest pass + file changes detected). Confidence scoring is weighted across checkbox, vitest, tsc, no_errors, progress_updated dimensions. Below-threshold scores re-enter the task with feedback. [source: research-2.md#L57-L68] [source: research-1.md#L19-L20]

#### F9: Tiered Escalation & Self-Healing
Problems escalate: inject context → circuit breaker → auto-decompose → human checkpoint. Auto-decomposition (after 3+ consecutive failures) marks parent with `[DECOMPOSED]`, inserts 2-3 sub-tasks below in PRD.md, which the parser picks up naturally. Five circuit breaker types: MaxRetries, MaxNudges, Stagnation, ErrorHash, WallClock. Three struggle detection signals: short iterations, thrashing patterns, no productive changes. [source: research-2.md#L85-L90] [source: research-3.md#L42-L48]

#### F10: Compounding Knowledge System
`[LEARNING]`/`[GAP]` tags extracted from task outputs and persisted to `knowledge.md`. Relevant learnings re-injected into future task prompts via keyword matching. This gives the system memory across the session boundary imposed by fresh-session-per-task. [source: research-1.md#L20-L21]

#### F11: Prompt Architecture
Defense-in-depth prompting: ROLE & BEHAVIOR → DO NOT STOP IF → TDD GATE → prompt blocks (security/safety/discipline/brevity) → AVAILABLE CAPABILITIES. Context trimming reduces progress lines progressively (20 → 5 by iteration 9+). PRD content filtered to show only unchecked tasks + completion count. [source: research-1.md#L36] [source: research-3.md#L53-L57]

#### F12: Execution Strategies
`ITaskExecutionStrategy` abstracts Copilot interaction: `CopilotCommandStrategy` (3-level fallback: agent mode → chat → clipboard, uses VS Code workbench commands) and `DirectApiStrategy` (direct Language Model API). Both use file watchers for completion detection. [source: research-2.md#L79-L83]

#### F13: Extension & Hook Points
`IRalphHookService` with NoOp default provides hooks: session start, pre-compact, post-tool-use, pre-complete, task-complete. Hook bridge uses proposed `chat.hooks` API. Extension registers commands: `ralph-loop.start`, `.stop`, `.pause`, etc. [source: research-2.md#L93-L95]

#### F14: Dual Delivery Model
VS Code extension (the actual loop — requires extension host for Copilot commands) + CLI companion (`npx ralph init/status/next` — PRD management from any terminal). [source: research-1.md#L28-L30]

### Cross-Report Patterns

**P1: PRD.md as Single Source of Truth** (all 3 reports, highest confidence)
Every report converges on this: PRD.md is the spec, task queue, state machine, and completion ledger. The orchestrator re-reads it every iteration. The agent writes to it. Auto-decomposition rewrites it. The parser adapts. No external DB needed.
[source: research-1.md#L33] [source: research-2.md#L34-L38] [source: research-3.md#L5-L10]

**P2: Fresh-Session-Per-Task as Context Rot Solution** (reports 1, 2)
The fundamental architectural decision — nuke context, persist to files — drives the fresh Copilot session per task, the file-based state system, and the knowledge compounding. Both the identity report and architecture report emphasize this.
[source: research-1.md#L10-L11] [source: research-2.md#L45-L50]

**P3: Dual Exit Gate Pattern** (reports 1, 2, 3)
All reports identify the model-claim + machine-verify pattern as a key differentiator. Report 1 names it, report 2 details its implementation (confidence scoring pipeline), report 3 describes the file-level mechanics (checkbox mutation + diff validation).
[source: research-1.md#L19-L20] [source: research-2.md#L57-L68] [source: research-3.md#L36-L40]

**P4: Tiered Escalation with Self-Healing** (reports 1, 2, 3)
Progressive escalation (nudge → retry → decompose → human) appears in all three reports. Auto-decomposition is the self-healing mechanism connecting the orchestrator's failure path to the PRD parser's `[DECOMPOSED]` handling.
[source: research-1.md#L22] [source: research-2.md#L70-L73] [source: research-3.md#L42-L48]

**P5: Invocation ID Traceability** (reports 2, 3)
UUID `taskInvocationId` threading through progress entries, events, hooks, and commits enables full end-to-end traceability per task attempt. Consistent pattern across orchestrator and PRD subsystems.
[source: research-2.md#L45-L46] [source: research-3.md#L30-L32]

**P6: Adaptive Behavior** (reports 1, 2)
Multiple adaptive mechanisms: nudge counters reset on productive changes, iteration limits auto-expand when tasks remain, context trimming becomes more aggressive in later iterations. The system adjusts its behavior based on observed progress.
[source: research-1.md#L34] [source: research-2.md#L30-L32] [source: research-2.md#L52-L55]

### Priority Matrix

| Pattern | Impact | Effort to Document | Sources |
|---------|--------|---------------------|---------|
| PRD-as-single-source-of-truth | **Critical** — defines the mental model | Low | [research-1.md#L33](research-1.md#L33), [research-2.md#L34-L38](research-2.md#L34-L38), [research-3.md#L5-L10](research-3.md#L5-L10) |
| Fresh-session-per-task (context rot solution) | **Critical** — the "why" behind the architecture | Low | [research-1.md#L10-L11](research-1.md#L10-L11), [research-2.md#L45-L50](research-2.md#L45-L50) |
| Dual exit gate + confidence scoring | **High** — key differentiator | Medium | [research-1.md#L19-L20](research-1.md#L19-L20), [research-2.md#L57-L68](research-2.md#L57-L68), [research-3.md#L36-L40](research-3.md#L36-L40) |
| Tiered escalation + auto-decomposition | **High** — self-healing capability | Medium | [research-1.md#L22](research-1.md#L22), [research-2.md#L70-L73](research-2.md#L70-L73), [research-3.md#L42-L48](research-3.md#L42-L48) |
| 9-phase orchestrator cycle | **High** — architecture overview | High | [research-2.md#L22-L77](research-2.md#L22-L77) |
| Compounding knowledge system | **Medium** — cross-session memory | Low | [research-1.md#L20-L21](research-1.md#L20-L21) |
| Ecosystem positioning (20+ Ralphs) | **Medium** — README credibility | Low | [research-1.md#L14-L18](research-1.md#L14-L18) |
| Dual delivery (extension + CLI) | **Medium** — user-facing | Low | [research-1.md#L28-L30](research-1.md#L28-L30) |
| Prompt architecture | **Low** — implementation detail | Medium | [research-1.md#L36](research-1.md#L36), [research-3.md#L53-L57](research-3.md#L53-L57) |
| Hook/extension points | **Low** — advanced users only | Low | [research-2.md#L93-L95](research-2.md#L93-L95) |

### Gaps

1. **Configuration reference**: All three reports mention config knobs (`maxIterations`, `maxNudgesPerTask`, `countdownSeconds`, `maxParallelTasks`, feature flags) but none provide a complete enumeration with defaults. A README needs this.
2. **Installation & quickstart**: No report covers how to install the extension (marketplace vs. source), minimum setup steps, or first-run experience beyond "drop a PRD.md".
3. **Visual assets**: The existing README has an architecture diagram mentioned in research-1 but no report captures or evaluates it. Screenshots/GIFs of the loop in action are not addressed.
4. **Error/failure UX**: Reports describe internal failure handling (circuit breakers, decomposition) but not what the user sees — status bar states, output channel messages, notification prompts.
5. **Model compatibility**: `modelHint` config is mentioned but no report clarifies which Copilot models work best or whether model selection affects loop behavior.
6. **Parallel execution details**: DAG-aware parallel tasks are described architecturally but practical usage (how to structure PRD for parallel execution, performance implications) is not covered.
7. **PRD contention / race conditions**: Research-3 raises this as an open question but provides no answer — the agent and orchestrator both write to PRD.md during execution.
8. **Comparison table**: Research-1 describes ecosystem differences qualitatively but no structured comparison table exists for the README.

### Sources
- research-1.md — Core identity, value proposition, ecosystem positioning, architecture summary
- research-2.md — Orchestrator loop architecture, execution phases, strategies, subsystems
- research-3.md — PRD parsing, task selection, progression tracking, auto-decomposition, dual-file state
