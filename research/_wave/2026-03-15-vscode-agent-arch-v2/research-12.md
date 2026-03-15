# Q12: Complete Orchestration Stack — Wave + Ralph-Loop + Handoffs

## Findings

### Three-Layer Architecture

The stack composes into three distinct layers, each operating at a different abstraction level:

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: WAVE ORCHESTRATOR (Agent-level fan-out)       │
│  wave-explore-fast / wave-orchestrator.agent.md         │
│  Scope: Single conversation turn                        │
│  Operates: Inside VS Code's agent mode                  │
│  Mechanism: runSubagent tool → parallel coder dispatch  │
│  Output: research files + FINAL-REPORT.md               │
└───────────────────┬─────────────────────────────────────┘
                    │ dispatches via runSubagent
┌───────────────────▼─────────────────────────────────────┐
│  Layer 2: RALPH-LOOP (Extension-level task sequencer)   │
│  VS Code extension, async generator loop                │
│  Scope: Multi-task PRD execution across sessions        │
│  Mechanism: PRD parse → prompt build → Copilot command  │
│             → file watcher → verify → next task         │
│  Hooks: chatHooks API (Stop, PostToolUse, PreCompact)   │
│  Output: completed PRD checkboxes + progress.txt        │
└───────────────────┬─────────────────────────────────────┘
                    │ sends prompts via VS Code commands
┌───────────────────▼─────────────────────────────────────┐
│  Layer 1: VS CODE COPILOT CHAT (Runtime substrate)      │
│  chatParticipants, chatHooks, subAgentInvocationId      │
│  Scope: Individual agent turns, tool calls, hooks       │
│  Mechanism: LLM ↔ tool loop, hook command execution     │
│  APIs: chatParticipantPrivate, chatHooks, chatDebug     │
└─────────────────────────────────────────────────────────┘
```

### Data Flow Between Layers

**Wave → Ralph-Loop integration point**: Wave's coder subagents could BE ralph-loop tasks. A wave decomposition produces N questions; these map directly to PRD checkboxes. Wave currently dispatches via `runSubagent` (single-turn, in-memory). Ralph-loop dispatches via Copilot commands (multi-turn, persistent). The bridge: wave decomposes → writes PRD.md → ralph-loop executes sequentially with full hook/retry/nudge guardrails.

**Ralph-Loop → VS Code Copilot integration points**:
- `hookBridge.ts` generates Stop/PostToolUse hook scripts registered via `chat.hooks` configuration
- `copilot.ts` uses 3-level fallback: `openEditSession` (agent) → `chat.open` (panel) → clipboard
- `strategies.ts` provides `CopilotCommandStrategy` (command-based) and placeholder `DirectApiStrategy` (future chatProvider API)
- `permissionLevel: 'autopilot'` via `chatParticipantPrivate` enables Copilot's internal autonomy mode

**VS Code Copilot internal plumbing**:
- `ChatHookType`: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop, ErrorOccurred
- `subAgentInvocationId` on `ChatRequest` links parent↔child for tracing
- `ChatHookResult.resultKind`: success (continue), error (block+show to model), warning (log only)

### Key Interface Contracts

Ralph-loop's hook system (`IRalphHookService`) maps 1:1 to VS Code's `ChatHookType`:

| Ralph Hook | VS Code ChatHookType | Purpose |
|---|---|---|
| `onSessionStart` | `SessionStart` | Initialize tracking |
| `onPreCompact` | `PreCompact` | Inject context before compaction |
| `onPostToolUse` | `PostToolUse` | Reset inactivity timer |
| `onPreComplete` | `Stop` | Validate task completion (PRD checkbox, tests, tsc) |
| `onTaskComplete` | `SessionEnd` | Cleanup, commit, advance |

## Patterns

### Pattern 1: Hierarchical Decomposition Pipeline
Wave decomposes broad topics into focused questions (fan-out), ralph-loop sequences their execution with guardrails (sequential with retries), Copilot executes individual coding tasks (fan-in per task). This is a **DAG pipeline**: `decompose(1→N) → execute(N×sequential) → aggregate(N→1)`.

### Pattern 2: Layered Autonomy Escalation
Each layer adds autonomy controls:
- **Copilot**: tool auto-approval (`permissionLevel: autopilot`)
- **Ralph-loop**: nudge on stall, retry on transient error, circuit breaker on repeated failure, struggle detection → decompose/skip
- **Wave**: parallel dispatch with mandatory aggregation, N-capped fan-out

### Pattern 3: Hook-Mediated Control Flow
All three layers use hooks as control points. VS Code provides the hook execution runtime (`ChatHookCommand` → stdin/stdout JSON protocol). Ralph-loop generates hook scripts that enforce task-level gates. Wave's orchestrator agent has `SubagentStart`/`Stop` hooks for lifecycle tracking. The hook protocol is uniform: JSON in on stdin → `{resultKind, stopReason?, systemMessage?}` out on stdout.

### Pattern 4: Handoff as State Transition
Handoffs (`.prompt.md` files) encode agent-to-agent transitions. In the stack: wave-orchestrator hands off to coder subagents (via `runSubagent`), each coder could hand off to ralph-loop (via PRD generation), ralph-loop hands off to Copilot (via command execution). Handoff files carry context: what was done, what remains, verification criteria.

## Applicability

### Recommended Stack Configuration

**For broad codebase research** (read-heavy, no edits):
```
wave-explore-fast → N coder subagents (parallel) → aggregation → FINAL-REPORT
```
Wave alone suffices. No ralph-loop needed. Single-turn, in-memory.

**For multi-task implementation** (edit-heavy, sequential dependencies):
```
ralph-loop orchestrator → Copilot agent mode per task → hook-gated completion
```
Ralph-loop alone suffices. PRD-driven, persistent, with full retry/nudge/circuit-breaker guardrails.

**For complex projects** (research + implement + verify):
```
wave-explore-fast (research phase)
    → produces architectural analysis / implementation plan
    → human reviews, creates PRD.md from findings
ralph-loop (implementation phase)
    → executes PRD tasks sequentially with hooks
    → each task gets fresh Copilot session
    → hook bridge validates: tsc, tests, checkbox, progress
wave-explore-fast (verification phase)
    → N parallel reviewers check different aspects
    → aggregated quality report
```

### What Each Layer Handles

| Concern | Owner |
|---|---|
| Topic decomposition | Wave (wave-decompose) |
| Parallel research dispatch | Wave (runSubagent) |
| Tiered aggregation | Wave (wave-aggregate) |
| Task sequencing from PRD | Ralph-loop (orchestrator) |
| Nudge/retry/circuit-breaker | Ralph-loop (decisions, circuitBreaker) |
| Stagnation/struggle detection | Ralph-loop (stagnationDetector, struggleDetector) |
| Prompt construction with gates | Ralph-loop (prompt.ts) |
| Hook script generation | Ralph-loop (hookBridge.ts) |
| Hook execution runtime | VS Code (chatHooks API) |
| Tool call loop | VS Code (agent mode) |
| Subagent lifecycle | VS Code (subAgentInvocationId) |
| Permission escalation | VS Code (chatParticipantPrivate) |

### Handoff Integration Points

1. **Wave → PRD**: Wave's decomposed questions could auto-generate a `PRD.md` with checkbox tasks, bridging research output to ralph-loop input
2. **Ralph-loop → Handoff files**: After completing a PRD, ralph-loop could emit a handoff `.prompt.md` summarizing what was done + remaining work for the next agent/human
3. **Handoff → Wave**: A handoff file could trigger a new wave exploration for verification or next-phase research

## Open Questions

1. **Missing glue: Wave → PRD bridge**: No automated path exists from wave's research output to ralph-loop's PRD input. A `wave-to-prd` converter that maps research findings into actionable checkbox tasks would close this gap.

2. **Subagent vs. command dispatch**: Wave uses `runSubagent` (in-process, single-turn, parallel). Ralph-loop uses VS Code commands (out-of-process, multi-turn, sequential). Could ralph-loop tasks be dispatched as subagents instead of command-based prompts? This would require the `chatProvider` API (currently unimplemented in `DirectApiStrategy`).

3. **Shared invocation tracing**: Ralph-loop has `taskInvocationId`, VS Code has `subAgentInvocationId`. These aren't linked. A unified trace ID flowing from wave → ralph-loop → Copilot would enable end-to-end observability across all three layers.

4. **Hook script lifecycle**: Ralph-loop generates hook scripts to temp files. These scripts need the PRD path baked in at generation time. If wave dynamically creates PRDs, the hook scripts need regeneration per PRD — currently manual.

5. **Parallel task execution**: Ralph-loop has `useParallelTasks` feature flag (default false). Wave is inherently parallel. Enabling ralph-loop parallelism would let it handle wave-style fan-out natively, but the sequential-with-dependencies model may be more reliable for implementation tasks.

6. **Implementation priority**: (a) Wave-to-PRD bridge converter, (b) unified tracing across layers, (c) `DirectApiStrategy` using chatProvider API, (d) dynamic hook script regeneration.
