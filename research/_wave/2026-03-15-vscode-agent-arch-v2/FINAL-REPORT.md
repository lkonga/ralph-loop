# FINAL REPORT: VS Code Agent Architecture v2 — Handoffs, Subagents, Tool Config, Async & Integration

> **Wave**: 2026-03-15-vscode-agent-arch-v2 | **Sources**: 12 research reports, 4 aggregation reports | **Scope**: VS Code Copilot Chat extension internals

## Executive Summary

**The most critical finding of this investigation is a correction**: previous research incorrectly stated that "subagents get 4 read-only tools only." This is wrong for custom agents dispatched via `runSubagent`. The 4-tool restriction applies exclusively to the internal `SearchSubagentToolCallingLoop` mechanism (`search_subagent` tool), which has a hardcoded allowlist. Custom agents invoked through VS Code core's `runSubagent` operate with their own frontmatter `tools:` configuration and can have full tool access — including edit, terminal, web, and any MCP tools. This distinction fundamentally changes what wave coder agents can do.

The architecture enforces a strict depth-1 nesting limit through three coordinated structural mechanisms — tool allowlist filtering, `subAgentInvocationId` boolean gating, and platform-level tool stripping. No depth counter exists; no configuration can override it. The canonical multi-agent pattern is single-level parallel fan-out from an orchestrator, which aligns perfectly with wave's decompose→research→aggregate pipeline.

Handoffs and subagents are complementary, not competing. Handoffs are declarative, user-facing transition buttons for inter-phase navigation (Plan→Implement). Subagents are model-invoked parallel workers for intra-phase delegation. A third mechanism, `SwitchAgentTool`, enables programmatic agent switching but is currently hardcoded to Plan-only and feature-gated. Handoffs cannot replace subagent dispatch for parallel work — they are 1:1 sequential with no return path, no fan-out, and no result aggregation.

Parallelism is model-driven via an "eager promise" pattern: the LLM emits multiple tool calls per round, and tools in a hardcoded `toolsCalledInParallel` set (including `CoreRunSubagent` and all MCP tools) get their promises started immediately. No scheduler, no concurrency cap, no fan-out/fan-in primitive exists. Coordination between parallel workers happens only through prompt rendering or the file system.

The hook system provides async lifecycle interception with 10 canonical event types, JSON stdin/stdout protocol, and exit-code-based enforcement (0=success, 2=blocking error). Ralph-loop's Stop hook (`onPreComplete`) is the primary task verification gate — yet it has **zero test coverage**, making the most safety-critical code path completely unverified. This is the highest-priority fix identified.

The three-layer stack — VS Code runtime (tool calling loop) → ralph-loop (PRD lifecycle) → wave (fan-out research) — provides clean separation of concerns, with each layer adding autonomy controls. No automated bridge exists between wave research output and ralph-loop PRD input; building this converter is the key enabler for end-to-end workflows.

---

## Critical Correction: Subagent Tool Access

### Two Distinct Subagent Mechanisms

| Mechanism | Invocation Tool | Tool Set | Nesting |
|-----------|----------------|----------|---------|
| **`runSubagent`** (VS Code core) | `CoreRunSubagent` | Agent's own frontmatter `tools:` — **full access** | Blocked at depth 1 by platform stripping `runSubagent` from subagent requests |
| **`SearchSubagentToolCallingLoop`** | `search_subagent` | Hardcoded 4 read-only tools: `semantic_search`, `file_search`, `grep_search`, `read_file` | Structurally impossible — `runSubagent` not in allowlist |

### Why This Matters

A custom `.agent.md` with `tools: [search, read, edit, terminal, web]` will have those tools available when invoked as a subagent via `runSubagent`. The flow:

1. VS Code core reads frontmatter `tools:` list
2. Maps tool names to `request.tools` entries (enabled=true)
3. `getEnabledTools()` returns those tools through the priority chain
4. The subagent uses them — including destructive tools like edit and terminal

The previous wave's claim that "subagents are limited to 4 read-only tools" was conflating the internal `search_subagent` mechanism with the general `runSubagent` capability. Wave coder agents designed with explicit `tools:` frontmatter can perform full implementation work as subagents.

### Tool Resolution Priority Chain

```
request.tools (frontmatter) → getEnabledTools() filter:
  1. Model-specific overrides (highest priority)
  2. Explicit disable (frontmatter tools: false) → BLOCK
  3. Consumer filter (agent-specific logic) → explicit allow/block
  4. Cross-enablement tags → enable
  5. Frontmatter enabled (tools: true) → ALLOW
  6. Default: excluded
```

No tool inheritance occurs between parent and child — each agent must declare its complete tool set.

---

## Consolidated Findings

### 1. Subagent Architecture

**Nesting: Depth-1 Hard Enforcement**

Three coordinated mechanisms enforce single-level fan-out:

1. **Tool allowlist**: `SearchSubagentToolCallingLoop.getAvailableTools()` whitelists only 4 read-only tools
2. **Boolean gate**: `subAgentInvocationId` presence check in `codebaseTool.tsx` degrades `Codebase` to non-agentic search
3. **Platform filtering**: VS Code core strips `runSubagent` from subagent tool sets

Not configurable. No `maxDepth`, no experiment flag, no frontmatter override. The constraint is binary and per-process — a separate VS Code instance resets to depth 0.

**Parallel Dispatch**

`toolsCalledInParallel` includes `CoreRunSubagent` — multiple `runSubagent` calls in a single model response execute concurrently via the eager promise pattern. This is the canonical multi-agent pattern.

**`subAgentInvocationId` Triple Duty**

The single UUID serves as: (a) nesting prevention boolean gate, (b) trajectory linking for parent↔child tracing, (c) billing classification (`userInitiatedRequest: false`).

**Built-in Agent Tool Profiles**

| Agent | Tools | Notable |
|-------|-------|---------|
| Explore | `DEFAULT_READ_TOOLS` | Read-only; `userInvocable: false` |
| Plan | `DEFAULT_READ_TOOLS` + `agent` | Can dispatch subagents |
| Ask | `DEFAULT_READ_TOOLS` | Read-only |
| Agent (main) | Full set via `getAgentTools()` | edit, terminal, etc. |

### 2. Handoff Mechanism

**Schema**: Frontmatter `handoffs:` array with required `{agent, label, prompt}` + optional `{send, showContinueOn, model}`.

**Behavior**:
- Same-session transitions via `toggleAgentMode` with `sessionResource` — conversation history preserved
- **No return path** — no `returnTo`, `previousAgent`, or undo mechanism
- `send: true` auto-submits the prompt; `send: false` (default) pre-fills for user review
- `model` field enables LLM switching between phases

**Three Agent Transition Mechanisms**:

| Mechanism | Trigger | Scope | Concurrency |
|-----------|---------|-------|-------------|
| Handoffs | User button click | Inter-phase transition | Sequential 1:1 |
| `SwitchAgentTool` | Model-invoked | Programmatic mode switch | Sequential 1:1 |
| `runSubagent` | Model-invoked | Intra-phase delegation | Parallel 1:N |

**`SwitchAgentTool` Limitations**: Hardcoded to Plan-only target, behind `chat.switchAgent.enabled` experiment flag (default false), blocked for Claude models.

### 3. Handoffs vs Subagents — Decision Framework

**Use handoffs when:**
- Natural phase boundary requiring user review (plan → implement)
- Model switching between phases (cheap planning, expensive implementation)
- One-way transition — target doesn't report back
- User needs explicit control over whether to proceed

**Use subagents when:**
- Parent needs results back to continue
- Multiple independent tasks can run in parallel
- Delegated work is autonomous and bounded
- Cheaper/faster models for subtasks
- Work is invisible to user's workflow

**Use both when:**
- Complex workflows need autonomous research (subagents) AND user checkpoints (handoffs)
- Example: Plan agent uses Explore subagents for research, then offers handoff buttons for implementation

**They are not redundant**: Handoffs = user-controlled inter-phase transitions. Subagents = model-controlled intra-phase delegation. Different levels of the control hierarchy.

### 4. Handoffs vs Ralph-Loop

**Layer Analysis**:

| Dimension | Handoffs | Ralph-Loop |
|-----------|----------|------------|
| Layer | Declarative YAML in `.agent.md` | Imperative `executeCommand` API |
| Trigger | User click / `send: true` | `LoopOrchestrator.runLoop()` |
| Scope | Intra-session persona transition | Cross-session lifecycle orchestration |
| Verification | None | tsc + vitest gates, circuit breakers |
| Automation | Requires human (except `send: true` one-shot) | Fully autonomous |

**Verdict**: Complementary layers with zero overlap. Handoffs = identity routing ("which agent handles the next turn"). Ralph-loop = lifecycle management ("what tasks get done, in what order, with what verification"). Ralph-loop cannot trigger handoffs programmatically; handoffs cannot replace ralph-loop's orchestration.

**Integration Strategy**: Handoffs work as **exit ramps** post-pipeline (research → implement), not as orchestration primitives. Ralph-loop could generate task-specific `.agent.md` files with custom handoffs for human-in-the-loop verification steps.

### 5. Async & Parallelism

**Eager Promise Pattern**: Tools in `toolsCalledInParallel` get promises started immediately with `tokenBudget: 1`. Non-parallel tools are deferred for sequential rendering. No scheduler, no concurrency cap.

**Parallel-eligible tools**: `CoreRunSubagent`, all read-only tools (`ReadFile`, `FindFiles`, `FindTextInFiles`, etc.), `Codebase`, all MCP tools.

**Token budget trade-off**: Parallel tools receive trivial `tokenBudget: 1`, sacrificing output size optimization for concurrent execution. Parent cannot control how much context children consume.

**No fan-out/fan-in primitive**: Parallel tools race independently. Coordination happens implicitly through prompt rendering (results collected during sequential await) or explicitly through the file system. Works for independent tasks, fails for dependent workflows.

**No ACP**: No Agent Communication Protocol exists. Inter-agent communication is solely through the tool-call interface.

### 6. Distributed Patterns

| Approach | Complexity | Nesting Bypass | Cost | Verdict |
|----------|-----------|----------------|------|---------|
| MCP coordination bus | Medium | Yes — each instance at depth 0 | N× API | **Most viable** |
| SSH remote workers | High | Yes — independent instances | N× API + servers | Heavy workloads |
| code-server farm | High | Yes | N× API + hosting | Redundant with SSH |
| Single instance tricks | Low | No — binary limit | 1× API | Cannot bypass |

**MCP as coordination bus**: An MCP server exposes `submit_task`/`poll_result` tools. Instance A's agent calls these (auto-parallel). Instance B picks up work at depth 0. ~100 lines of code, leverages existing MCP infrastructure.

**Resource costs**: Each additional VS Code instance costs ~500-800MB RAM and 1× API rate. N instances = N× API cost.

**File system is the de facto coordination medium**: No shared DB, message queue, or distributed lock exists between instances. PRD files, `progress.txt`, and markdown files are the only cross-instance medium.

### 7. Hook Systems & Test Coverage

**VS Code Hook Lifecycle**: 10 canonical `ChatHookType` events. JSON stdin/stdout protocol. Exit code semantics: 0=success, 2=blocking error, other=warning. 30s default timeout with SIGTERM→SIGKILL escalation.

**Two enforcement modes**:
- **Soft** (context injection): SessionStart, SubagentStart — inject `additionalContext`, don't block
- **Hard** (completion blocking): Stop hook `decision: "block"` prevents agent from stopping; PreToolUse `deny` blocks tool execution

**Ralph-loop hook mapping**:

| Ralph Hook | ChatHookType | Enforcement | Test Coverage |
|---|---|---|---|
| `onSessionStart` | `SessionStart` | Soft | 1 blocked-path test |
| `onPreCompact` | `PreCompact` | Soft | Script generation only |
| `onPostToolUse` | `PostToolUse` | Soft | 1 blocked-path test |
| `onPreComplete` | `Stop` | **Hard** | **ZERO tests** |
| `onTaskComplete` | `SessionEnd` | Cleanup | **ZERO tests** |

**Critical finding**: The Stop hook is ralph-loop's primary verification gate (PRD checkbox detection, progress freshness, tsc/vitest gates) and uses hard enforcement. Yet `generateStopHookScript` has **zero tests**. The most safety-critical path is completely unverified.

**Total hook tests**: 26 across 2 files. All use string-contains assertions on generated scripts — no execution testing against the actual JSON I/O contract.

### 8. Architecture Stack

```
┌────────────────────────────────────────────────────────┐
│  Wave (fan-out research)                               │
│  Scope: Single conversation turn                       │
│  Mechanism: runSubagent → parallel coder dispatch      │
│  Output: research files + FINAL-REPORT.md              │
├────────────────────────────────────────────────────────┤
│  Ralph-Loop (PRD lifecycle sequencer)                  │
│  Scope: Multi-task execution across sessions           │
│  Mechanism: PRD parse → prompt → command → verify      │
│  Hooks: Stop (completion gate), PostToolUse (timer)    │
├────────────────────────────────────────────────────────┤
│  VS Code Copilot Chat (runtime substrate)              │
│  Scope: Individual agent turns, tool calls, hooks      │
│  Mechanism: LLM ↔ tool calling loop                    │
│  APIs: chatParticipantPrivate, chatHooks               │
└────────────────────────────────────────────────────────┘
```

**Recommended configurations**:
- **Read-heavy research**: Wave alone (parallel fan-out, single-turn)
- **Edit-heavy implementation**: Ralph-loop alone (PRD-driven, persistent, hook-gated)
- **Complex projects**: Wave (research) → human review → ralph-loop (implement) → wave (verify)

---

## Pattern Catalog

| Pattern | Description |
|---------|-------------|
| **Structural Security** | Invalid operations prevented by tool absence, not runtime checks. Allowlists, platform stripping, and UI rendering prevent invalid states. |
| **Explicit Declaration** | No inheritance. Each agent declares its complete tool set, nesting permissions, and handoff targets. |
| **Eager Promise** | Parallel tools get promises started immediately with trivial token budget; results collected during sequential prompt rendering. |
| **Single-Level Fan-Out** | Depth-1 + parallel dispatch = orchestrator dispatches N leaf workers. No deep chains. |
| **Exit Ramp** | Handoffs as post-completion transitions, not orchestration primitives. Research→implement, plan→execute. |
| **Hook-Mediated Control** | Uniform JSON stdin/stdout protocol across all layers. Soft (context inject) vs hard (completion block) enforcement. |
| **File-System Coordination** | Cross-instance/cross-layer coordination via PRD files, progress.txt, markdown — no shared DB or message queue. |
| **Three-Tier Control** | Macro (handoffs, user-gated) → Meso (SwitchAgent, model-initiated) → Micro (subagents, parallel workers). |

---

## Priority Matrix

| Priority | Item | Impact | Effort | Recommendation |
|----------|------|--------|--------|----------------|
| **P0** | `generateStopHookScript` has zero tests | Safety-critical verification gate unverified | S | Write tests covering PRD checkbox detection, progress mtime, tsc/vitest gates |
| **P0** | `registerHookBridge` has zero tests | Hook registration could silently fail | S | Test temp file creation, config update, dispose cleanup |
| **P0** | `ShellHookProvider.executeHook` minimal tests | Only blocked path tested; success/timeout/json untested | M | Test spawn, JSON parsing, exit codes 0/1/2, timeout+kill |
| **P0** | Custom agents via `runSubagent` get full tools | Previous architecture assumed read-only | — | Design wave coder agents with explicit `tools:` including edit+terminal |
| **P1** | No execution tests for generated hook scripts | String-contains misses runtime contract bugs | M | Fixture-based tests: write script to disk, run against mock PRD |
| **P1** | Stop hook `decision:"block"` → continuation untested | Core completion gate flow unverified | M | Integration test: hook returns block → verify reason injected |
| **P1** | Wave→PRD bridge missing | No automated path from research output to PRD input | M | Build converter: research findings → checkbox PRD tasks |
| **P1** | Handoffs work as exit ramps post-pipeline | Useful but not urgent | S | Add "Start Implementation" handoff button on wave FINAL-REPORT output |
| **P2** | MCP coordination bus for distribution | Enables multi-instance parallelism | L | Phase 1: single-machine MCP coordinator; Phase 2: SSH remote |
| **P2** | Unified tracing across layers | `taskInvocationId` ↔ `subAgentInvocationId` unlinked | M | Link IDs for end-to-end observability |
| **P2** | `DirectApiStrategy` unimplemented | ChatProvider-based dispatch as alternative to commands | M | Implement when chatProvider API stabilizes |
| **P3** | `SwitchAgentTool` Plan-only | Monitor for generalization | — | Don't depend on it yet |
| **P3** | Hook script security audit | Generated scripts embed shell commands | S | Verify PRD paths with special chars don't cause injection |

---

## Recommended Plan

1. **Immediate (P0 tests)**: Write unit tests for `generateStopHookScript`, `registerHookBridge`, and `ShellHookProvider.executeHook` success paths. These are the highest-risk gaps — the core verification gate is untested.

2. **Short-term (P1 integration)**: Build fixture-based execution tests for generated hook scripts. Create "Wave→PRD bridge" converter that maps research findings into checkbox tasks. Add exit-ramp handoff buttons to wave output.

3. **Medium-term (P2 infrastructure)**: Implement MCP coordination bus for multi-instance dispatch. Link `taskInvocationId` ↔ `subAgentInvocationId` for unified tracing. Prototype `Stop` hook as task-not-done detector in ralph-loop.

4. **Long-term (P3 monitoring)**: Track `SwitchAgentTool` generalization, `toggleAgentMode` API expansion, handoff event APIs (`onDidSwitchAgent`), and `sessionResource` access for extensions.

---

## Gaps & Future Research

| Gap | Description | Blocking? |
|-----|-------------|-----------|
| **Tool name mapping table** | Exact mapping between frontmatter short names (`edit`, `terminal`) and internal `ToolName` enum values lives in VS Code core — not documented in extension source | Yes, for writing correct frontmatter |
| **`permissionLevel` propagation** | Whether `autopilot` permission propagates to subagents is undocumented. Affects whether subagents can autonomously complete tasks | Partially |
| **MCP tools in subagent frontmatter** | Interaction between MCP tool references and subagent tool pipeline undocumented | No |
| **Empirical concurrency data** | No report tested actual parallel execution timings, throughput, or failure rates. All findings from static code analysis | No |
| **Multi-instance session identity** | Can multiple VS Code instances share one GitHub auth token? Separate Copilot seats? | Yes, for cost modeling |
| **Git conflict resolution** | Parallel instances writing to same repo create merge conflicts. Worktree-per-instance suggested but unvalidated | Yes, for distribution |
| **Hook performance budget** | 30s timeout may be insufficient for Stop hooks running `tsc` + `vitest` on large codebases | Partially |
| **Error recovery across layers** | Hook failure cascading from VS Code → ralph-loop → circuit breaker untested | No |
| **Hook concurrency under parallel tasks** | If `useParallelTasks` enabled, multiple tasks could trigger hooks simultaneously — concurrency behavior undefined | No |
| **Handoff→subagent bridge** | Subagents cannot trigger handoffs; handoffs cannot spawn subagents. The two mechanisms are isolated | No |
