# Aggregation B: Handoffs, Ralph-Loop Integration & Nesting Constraints

## Deduplicated Findings

### 1. Handoffs Are UI Transitions, Not Orchestration Primitives

Handoffs (`IHandOff`/`AgentHandoff`) are one-shot, user-triggered agent-to-agent transitions rendered as chat buttons. They carry a flat string prompt, support optional model override and auto-send (`send: true`), but have **no return path, no parallelism, no structured data, and no programmatic invocation API**. Canonical example: Plan → "Start Implementation" → Agent mode.

### 2. Ralph-Loop Is an External Process-Level Orchestrator

Ralph-loop drives Copilot Chat via `vscode.commands.executeCommand()`, treating it as a black box. It provides capabilities entirely absent from the agent framework: multi-task PRD iteration, stagnation detection, circuit breakers, pre-complete hook verification (tsc + vitest), auto-commit, and fresh-session-per-task isolation.

### 3. Subagent Nesting Is Hard-Capped at Depth 1

Nesting prevention uses a **dual mechanism**: (a) binary `subAgentInvocationId` presence check in `codebaseTool.tsx` degrades the Codebase tool to non-agentic search, and (b) subagent tool allowlist (ReadFile, FindFiles, FindTextInFiles, Codebase) **excludes** `runSubagent`/`search_subagent` entirely. No depth counter exists — tool restriction is the guard.

### 4. Subagents Are Read-Only Explorers

Subagents get 4 search tools only. No `edit_file`, `replace_string`, `run_in_terminal`, or write capabilities. They receive a fresh conversation (no parent history), cleared tool references, and `userInitiatedRequest: false` for billing. Results return as `LanguageModelTextPart` to the parent.

### 5. Parallel Dispatch Is Supported at Depth 0→1

Both `runSubagent` and `search_subagent` are in the `toolsCalledInParallel` set, enabling concurrent fan-out from the parent. This is the **only** level where parallelism works natively.

### 6. Model Switching Exists in Both Handoffs and Subagents

Handoffs support `model` field override (e.g., `ImplementAgentModel`). Subagents support `SearchSubagentModel` config. Neither wave's `runSubagent` tool nor ralph-loop currently exploit per-dispatch model routing.

## Cross-Report Patterns

### Pattern A: Orchestration Layer Mismatch

All three reports converge on a fundamental architectural gap: VS Code's agent framework provides **UI-level transitions** (handoffs) and **read-only leaf workers** (subagents), but no **programmatic multi-step orchestrator**. Wave fills this gap externally; ralph-loop fills it at the process level. Both work around the same limitation from different directions.

### Pattern B: The Automation–Human-Control Spectrum

| Mechanism | Automation Level | Human Involvement |
|-----------|-----------------|-------------------|
| Handoffs | Low — button click required | Every transition |
| Ralph-loop | High — PRD-driven loop | Task selection only |
| Wave subagents | Medium — parent-automated fan-out | None within pipeline |

Handoffs add human checkpoints; wave removes them; ralph-loop operates above both. A hybrid could use wave for automated research, handoffs for review gates, and ralph-loop for task lifecycle.

### Pattern C: Context Boundary as Design Constraint

All reports document a shared problem — context does not flow freely:
- Handoffs carry flat string prompts (no structured data)
- Subagents get fresh conversations (no parent history)
- Ralph-loop creates fresh sessions per task (no cross-task memory)

File-system artifacts (PRD files, `research-{I}.md`) are the **de facto shared context bus** across all three mechanisms.

### Pattern D: Depth-1 Constraint Shapes All Architecture

The hard nesting limit forces wave's orchestrator to remain the parent agent. It cannot delegate decomposition or aggregation to subagents that themselves dispatch sub-subagents. This pushes complexity into the orchestrator prompt and into sequential chaining (call A, then call B with A's results), which Q4 confirms handoffs also cannot solve (no chaining A→B→C).

### Pattern E: Complementary Safety Layers

Ralph-loop's circuit breakers and stagnation detection (Q5) solve a problem that the agent framework ignores entirely — runaway cost and stuck agents. The subagent `toolCallLimit` (Q6) is a weak analog. A production wave pipeline needs ralph-loop-style guard rails even if orchestration happens inside the agent framework.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| **High** | Handoffs cannot replace subagent fan-out — wave's parallel dispatch is architecturally incompatible with sequential handoffs | Q4 | Keep wave's `runSubagent` for research dispatch; do not attempt handoff-based fan-out |
| **High** | Depth-1 nesting is hard-enforced — wave orchestrator must stay at parent level | Q6 | Design wave prompts to handle all orchestration in one agent turn; use sequential chaining for depth simulation |
| **High** | Subagents are read-only — wave researchers cannot write files natively | Q6 | Wave researchers must return results as text to parent, which writes files; or use MCP bridge for write access |
| **Medium** | Handoffs as post-pipeline exit ramps — offer "Implement Findings" / "Deep Dive" buttons after FINAL-REPORT.md | Q4 | Implement handoff buttons in wave's final output phase for guided follow-up |
| **Medium** | Ralph-loop's verification hooks (tsc + vitest) have no agent-framework equivalent | Q5 | Port hook verification as a custom tool or MCP server callable within agent sessions |
| **Medium** | Model routing per-subagent is supported but unexploited | Q4, Q6 | Configure `SearchSubagentModel` for cost optimization (cheap search model, expensive aggregation model) |
| **Medium** | Ralph-loop could generate `.agent.md` files with handoff configs for task-specific agents | Q5 | Prototype: ralph-loop creates task agent → handoff to verify → handoff to commit |
| **Low** | `showContinueOn: false` could create fire-and-forget handoffs | Q4 | Investigate for wave's file-writing agents — low urgency |
| **Low** | Programmatic handoff invocation API does not exist | Q4, Q5 | Monitor VS Code API evolution; file feature request if needed |
| **Low** | Trajectory tracking assumes flat parent→child — multi-level would break billing and session linking | Q6 | No action needed unless nesting is enabled upstream |

## Gaps

### 1. MCP Server as Orchestration Bridge
All three reports mention MCP as a potential intermediary (Q4 suggests MCP for write access, Q5 suggests MCP for hook verification, Q6 suggests MCP bridge for multi-level workflows), but none investigate **how** an MCP server would actually implement wave-style orchestration. Key unknowns: Can an MCP tool call back into Copilot's subagent system? What are the latency/timeout constraints?

### 2. Token Budget and Cost Modeling
Q6 mentions `toolCallLimit` and runaway cost risks, but no report quantifies the actual token cost of wave's fan-out pattern (N parallel subagents × M tool calls each × model pricing). This is critical for deciding cheap-model-for-search vs. expensive-model-for-all.

### 3. Error Propagation in Subagent Fan-Out
None of the reports address what happens when one subagent in a parallel batch fails. Does the parent receive a partial result? Does the entire batch fail? How should wave handle partial research completion?

### 4. Conversation History Compression
Q6 notes subagents get fresh conversations. None of the reports explore whether parent conversation history could be compressed/summarized and injected into subagent prompts to improve result quality without violating the architecture.

### 5. Ralph-Loop + Wave Integration Path
Q5 analyzes ralph-loop vs. handoffs in detail, but the specific integration of ralph-loop as wave's outer loop (ralph-loop drives task selection → wave handles research per task) is not explored. This is the most natural complementary architecture.

### 6. Concurrent Subagent Limits
Q6 confirms parallel dispatch is supported but does not investigate whether there's a practical concurrency ceiling — rate limits, memory pressure, or API quota exhaustion when dispatching many subagents simultaneously.
