# Q4: Handoffs for Wave-Explore-Fast Pipeline

## Findings

VS Code handoffs are **UI-level agent transitions**, not programmatic subagent orchestration. The implementation lives in three key locations:

1. **`IHandOff` interface** (promptFileParser.ts L342-349): Fields are `agent`, `label`, `prompt`, `send`, `showContinueOn`, `model`. The `prompt` field is a plain string — no structured data support (no JSON, no variable interpolation).

2. **`AgentHandoff` type** (agentTypes.ts L9-17): Mirror of `IHandOff` used by provider classes. Handoffs are rendered as clickable buttons in the chat UI after an agent completes its response.

3. **`send: true` behavior**: When set, clicking the handoff button automatically submits the prompt to the target agent without user confirmation. This is the closest thing to "auto-chaining." Used in Plan→Agent ("Start Implementation") and Edit→Agent ("Continue with Agent Mode") transitions.

**Critical limitation**: Handoffs are **one-shot, user-triggered transitions** between exactly two agents. There is no mechanism for:
- Chaining A→B→C automatically (no handoff-from-handoff)
- Parallel fan-out (handoffs are sequential, one button per transition)
- Returning results to the caller (it's a one-way transfer, not a call-return)
- Passing structured data (prompt is a flat string, no templating)

The wave pipeline's `runSubagent` tool is fundamentally different: it's a **programmatic call-return** mechanism where the orchestrator dispatches N agents in parallel, waits for all results, and processes them.

## Patterns

| Dimension | Handoffs | Subagent Dispatch (wave) |
|-----------|----------|--------------------------|
| **Topology** | Sequential A→B (one-way) | Fan-out N agents, fan-in results |
| **Parallelism** | None — single transition | Mandatory parallel batch |
| **Context flow** | Flat string prompt, no return | Structured prompt + file-based results |
| **Human involvement** | Button click required (even with `send: true`, it renders in UI) | Fully automated within orchestrator turn |
| **Return path** | None — target agent takes over conversation | Agent returns summary to orchestrator |
| **Model switching** | Supported via `model` field | Not natively supported per-subagent |

The Plan agent demonstrates the canonical handoff pattern: Plan researches → renders "Start Implementation" button → user clicks → Agent mode takes over with `send: true`. This is a **two-phase workflow with human checkpoint**, not automated orchestration.

## Applicability

### Where handoffs COULD enhance wave-explore-fast:

1. **Post-pipeline review checkpoint**: After FINAL-REPORT.md is written, a handoff button could transition to a "coder" agent with `send: true` to begin implementing findings. This adds a natural human-in-the-loop checkpoint between research and action.

2. **Model escalation**: The `model` field in handoffs could trigger a more capable model for the aggregation phase (e.g., research with fast model → aggregate with Opus). Wave currently can't switch models per-stage.

3. **Error recovery**: If the pipeline fails mid-way, a handoff to a repair agent could be offered as a UI button, rather than requiring the user to re-invoke the full pipeline.

### Where handoffs would be DETRIMENTAL:

1. **Decompose→Research fan-out**: This is the core of wave — dispatching N parallel agents. Handoffs are inherently sequential and single-target. Replacing subagent dispatch with handoffs would serialize the entire research phase.

2. **Research→Aggregate transition**: This requires collecting results from all researchers before dispatching aggregators. Handoffs have no "wait for N completions" semantic.

3. **Any automated multi-step chain**: Wave's power is zero-human-intervention from decompose through final report. Handoffs require UI interaction at each transition point, breaking full automation.

4. **Structured data passing**: Wave researchers write to specific file paths (`research-{I}.md`) and aggregators read them. Handoff prompts are flat strings — no file references, no structured payloads.

## Open Questions

1. **Hybrid approach**: Could wave use handoffs as an *optional* exit ramp? E.g., after FINAL-REPORT.md, offer "Implement Findings" and "Deep Dive on Topic X" handoff buttons. The pipeline runs fully automated via subagents, but the *output* presents handoff buttons for next actions. This preserves wave's parallelism while adding guided follow-up.

2. **`showContinueOn` for gating**: The `showContinueOn: false` pattern (used in Plan's "Open in Editor" handoff) suppresses the continue button. Could this be used to create "fire-and-forget" handoffs that don't expect continuation? Potentially useful for wave's file-writing agents.

3. **Handoffs for review steps**: A wave variant could insert a human checkpoint between research and aggregation: researchers complete → handoff button "Review & Aggregate" appears → user clicks → aggregation runs. This trades full automation for quality control. Worth considering for high-stakes research topics.

4. **Future API evolution**: If VS Code adds programmatic handoff triggering (no UI button required) or parallel handoff dispatch, the calculus changes entirely. Currently, handoffs are strictly a UI affordance, not an orchestration primitive.
