# Q7: Handoff vs Subagent Use Cases

## Findings

Handoffs and subagents serve **fundamentally different interaction patterns** in the VS Code agent architecture. They are not redundant — they solve orthogonal problems.

### Use Case Matrix

| Dimension | Handoffs | Subagents |
|-----------|----------|-----------|
| **Execution model** | Sequential, human-in-the-loop | Parallel or sequential, fully automated |
| **Control flow** | User-initiated transition (button click) | Model-initiated (tool call `runSubagent`) |
| **Context transfer** | Full conversation context + injected prompt | Scoped context via tool call arguments |
| **Who decides when** | Human decides timing via UI buttons | Parent agent decides timing programmatically |
| **Model switching** | Native (`model` field on handoff) | Inherited from parent or agent definition |
| **Result aggregation** | N/A — it's a full agent switch | Parent receives return value and aggregates |
| **Visibility** | Renders as clickable buttons in chat UI | Renders as nested tool invocations in chat |
| **Hook system** | No specific hooks | `SubagentStart` / `SubagentStop` hooks |
| **Trace propagation** | New conversation turn | Linked spans via `storeTraceContext`/`getStoredTraceContext` |

### When Handoffs Win

1. **Plan → Implement transitions**: The canonical example. `PlanAgentProvider` creates two handoffs: "Start Implementation" (with optional model override via `implementAgentModelOverride`) and "Open in Editor". The human reviews the plan, then clicks the button — the handoff carries the approved plan as context to the implementing agent.

2. **Model switching at transition points**: Handoffs natively support `model` field, enabling patterns like "plan with thinking model → implement with fast model". This is built into the `IHandOff` interface and rendered in YAML frontmatter.

3. **Checkpoint-based workflows**: Where human judgment gates the transition. The Plan agent explicitly says "Keep iterating until explicit approval or handoff" — the handoff button IS the approval mechanism.

4. **UI-rendered action buttons**: `showContinueOn` and `send` control whether the handoff auto-sends or waits for the user. `showContinueOn: false` on "Open in Editor" means it fires once without a "Continue" button — a one-shot action.

### When Subagents Win

1. **Parallel fan-out exploration**: The wave-orchestrator dispatches N `coder` subagents in ONE parallel batch for research. Each writes to a separate file and returns a summary. This pattern is impossible with handoffs (which are sequential and human-gated).

2. **Automated tool-chain execution**: Subagents are invoked via `runSubagent` tool calls — the parent agent decides when and how many to dispatch without human intervention. The `agents: ['Explore']` field in Plan agent config allows it to spawn Explore subagents programmatically.

3. **Scoped, disposable workers**: Subagents get a focused prompt and return a result. They don't take over the conversation — they're subordinate to the parent. The parent aggregates results from multiple subagents.

4. **Lifecycle hooks**: `SubagentStart` and `SubagentStop` hooks (defined in `ChatHookType`) allow injecting context or running commands when subagents launch/complete. The wave-orchestrator uses `SubagentStart` hooks to run setup scripts.

### When Neither Fits

- **Simple tool calls**: If the task is "read a file and summarize", a plain tool call suffices — no agent delegation needed.
- **Streaming edits**: Inline chat and code actions bypass both mechanisms entirely.
- **Cross-extension delegation**: MCP servers and extension-provided tools handle cross-boundary work without agent-level delegation.

## Patterns

### Pattern 1: Sequential-with-Checkpoints (Handoffs)

```
User → Plan Agent → [plan iterates] → User clicks "Start Implementation" → Agent Mode
                                     → User clicks "Open in Editor" → File created
```

The Plan agent's handoffs encode a **state machine with human gates**:
- `send: true` — auto-sends the prompt on click (immediate transition)
- `showContinueOn: false` — one-shot action, no continuation button
- `model: implementAgentModelOverride` — switches to a potentially different model

This pattern is ideal for **phased workflows** where each phase needs human sign-off.

### Pattern 2: Parallel Fan-Out (Subagents)

```
Orchestrator → [dispatches N subagents in parallel]
            → Each subagent: researches + writes file + returns summary
            → Orchestrator aggregates results
```

Subagents use `agents` frontmatter to whitelist allowed subagent types. The parent calls `runSubagent` (or `search_subagent`) as tool calls. Results flow back to the parent's context.

### Pattern 3: Triage-to-Specialist (Hybrid)

```
User → Triage Agent → identifies domain → Handoff button to specialist agent
                                         → OR subagent for quick lookup
```

Not yet implemented in the codebase but architecturally supported. An agent could use subagents for quick information gathering and handoffs for full delegation to specialists.

### Pattern 4: Plan-Explore-Implement Pipeline

The actual codebase pattern:
```
Plan Agent ──subagent──→ Explore (read-only discovery)
    │                        └─returns context─┘
    │
    └──handoff button──→ Agent Mode (implementation, human-gated)
```

Subagents handle the **automated discovery** phase; handoffs handle the **human-approved transition** to implementation.

## Applicability

### Concrete Scenario 1: Code Review Workflow
- **Subagents**: Fan out to analyze different aspects (security, performance, style) in parallel
- **Handoff**: After review summary, button to "Apply Suggested Fixes" transitions to editing agent

### Concrete Scenario 2: Bug Triage
- **Subagent**: Quick Explore subagent to gather stack traces, recent changes, related issues
- **Handoff**: "Investigate in Debug Mode" button transitions to a debugging-focused agent with appropriate tools

### Concrete Scenario 3: Multi-Repo Refactoring
- **Subagents**: Parallel discovery across repos to find all affected callsites
- **Handoff**: Sequential transitions between repo-specific implementation agents (human reviews each repo's changes before proceeding)

### Concrete Scenario 4: Model-Aware Task Routing
- **Handoff with `model` field**: Plan with Claude Opus (reasoning) → handoff to implement with GPT-5 (speed). The `model` field on handoffs is the primary mechanism for deliberate model switching at phase boundaries.
- **Subagents**: Inherit parent model. No per-subagent model override in the `agents` frontmatter (model is set at agent definition level, not invocation level).

## Open Questions

1. **Could handoffs become async?** Currently handoffs are synchronous UI buttons. An async handoff (agent A queues work for agent B, user reviews later) would bridge the gap with subagents while preserving human oversight. Not currently supported.

2. **Subagent model override at invocation time?** The `model` field exists on handoffs but not on subagent dispatch. If a parent could say "run this subagent with model X", it would unlock cost-optimized fan-out (cheap model for simple subtasks, expensive model for complex ones).

3. **Hybrid handoff-subagent chains?** An agent could use subagents for discovery, present findings, then offer handoff buttons to different specialists based on what was discovered. The Plan agent already does a version of this (Explore subagent → handoff buttons), but more complex routing trees aren't supported.

4. **Handoff state persistence?** Handoffs carry the prompt string but not structured state. If the Plan agent could serialize its plan data structure (not just markdown) into the handoff, the receiving agent could parse it programmatically. Currently, context transfer is prompt-text only.

5. **`disableModelInvocation` interaction**: The Plan agent uses `disableModelInvocation: true` to prevent being auto-invoked as a subagent (it should only be user-invoked or handoff-target). This creates an asymmetry — some agents are handoff-only, others are subagent-only, and the `user-invocable` and `disableModelInvocation` flags control this. A unified visibility/invocability model would clarify these interactions.

6. **Missing: subagent-to-subagent handoffs**: A subagent cannot currently hand off to another subagent — it can only return results to its parent. If subagent A discovers it needs specialist subagent B, it must return to the parent and let the parent dispatch B. This adds latency in multi-hop reasoning chains.
