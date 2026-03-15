# Q5: Handoffs for Wave-Explore-Fast Pipeline

## Findings

### How Handoffs Work in VS Code

Handoffs are declared in agent/prompt YAML frontmatter as an array of `{label, agent, prompt, send?, showContinueOn?, model?}` objects ([agentTypes.ts](src/extension/agents/vscode-node/agentTypes.ts#L10-L17)). The `IHandOff` interface is parsed by [promptFileParser.ts](src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L342-L350).

Key behaviors:
- **`send: true`** causes the handoff prompt to be **automatically submitted** to the target agent — no user click required beyond the initial button. This is how Plan Agent chains to Agent Mode: `{label: "Start Implementation", agent: "agent", prompt: "Start implementation", send: true}`.
- **Context inheritance**: Handoffs operate within the **same conversation thread**. The target agent receives the full conversation history (all prior turns) plus the handoff's `prompt` string as a new user message. This is NOT a fresh session — it's a continuation.
- **Model switching**: The `model` property allows changing the LM between phases (e.g., use a cheap model for planning, expensive for implementation).
- **1:1 sequential**: A handoff transitions from exactly one source agent to exactly one target agent. There is no fan-out mechanism — you cannot handoff to N agents simultaneously.

### How Wave's Pipeline Works

Wave-explore-fast uses a **decompose → parallel research → tiered aggregation** pipeline:
1. **wave-orchestrator** dispatches **wave-decompose** (1 subagent) → gets N questions
2. Dispatches **N coder subagents in ONE parallel batch** via `runSubagent` tool calls
3. Dispatches **wave-aggregate** (1 subagent) → which internally spawns ceil(N/K) group aggregators + 1 master aggregator

The critical property: Step 2 requires **parallel fan-out** — N independent agents running simultaneously, all returning results to one coordinator that waits for all of them.

### Fundamental Mismatch

Handoffs are **serial transitions** between agents in a conversation. `runSubagent` is a **parallel dispatch primitive** — the orchestrator makes N tool calls in one batch, the runtime executes them concurrently, and all results flow back to the orchestrator's context.

| Dimension | Handoffs | Subagent Dispatch |
|-----------|----------|-------------------|
| Topology | 1:1 sequential | 1:N parallel |
| Context flow | Full conversation history forwarded | Orchestrator context stays; subagent gets only its prompt |
| Return path | No return — target owns conversation | Results return to orchestrator |
| Model switching | Yes (`model` property) | Yes (via agent definition) |
| Auto-submission | Yes (`send: true`) | Implicit (tool call) |
| Orchestration | None — fire-and-forget | Orchestrator waits, aggregates |

The core issue: **handoffs transfer control**, while wave needs to **retain control** at the orchestrator level to coordinate parallel workers and aggregate results.

## Patterns

### Pattern 1: Sequential-with-Auto-Submit
A chain of handoffs `A → B → C` with `send: true` creates an automatic pipeline. This works for Plan → Implement (the existing use case). But it **cannot express** "dispatch N workers, wait for all, then aggregate" because:
- There's no way to handoff to N agents simultaneously
- There's no "return to sender" — once you handoff, the target agent owns the conversation
- The source agent cannot collect results from multiple targets

### Pattern 2: Context Flow Differences
- **Handoff**: Target sees the ENTIRE prior conversation (all decomposition output, all prior agent responses). This is context-rich but potentially overwhelming for large wave runs.
- **Subagent**: Each worker gets ONLY its specific question. Clean isolation. Orchestrator aggregates returns.

### Pattern 3: `send: true` Auto-Chaining
Could `send: true` auto-chain decompose → research → aggregate? Only if each phase is a single agent:
```
decompose (send: true) → research-single (send: true) → aggregate-single
```
This works for a **sequential** pipeline but defeats wave's purpose — the parallel fan-out in Step 2 is the entire performance win.

## Applicability

### Viable Hybrid: Handoffs as Exit Ramps

Handoffs work well as **post-completion transitions**, not as pipeline stages:

1. **Pipeline completion → Handoff to implementation**: After wave produces a FINAL-REPORT.md, a handoff button could transition to `coder` agent with `send: true` and prompt "Implement the recommendations from research/_wave/{WAVE_ID}/FINAL-REPORT.md". This is exactly the Plan Agent pattern.

2. **Model switching between phases**: If decomposition needs a reasoning model but research needs a fast model, handoffs can't help mid-pipeline (subagents already support model switching via agent definitions). But a handoff FROM wave-explore-fast TO a different agent with a different model works for the final step.

3. **Escape hatches**: Edit Mode's handoff to Agent Mode is a good pattern. Wave could offer "Continue in Agent Mode" after presenting findings — letting the user seamlessly transition from research to implementation.

### Not Viable: Replacing Subagent Dispatch

Handoffs cannot replace `runSubagent` for the parallel research phase because:
- No fan-out (1:1 only)
- No return path (control transfers permanently)
- No wait-for-all semantics
- No result aggregation at the source

### Partial Hybrid: Wrapping the Pipeline

A handoff chain could wrap the macro phases if each phase is a single agent:
```yaml
handoffs:
  - label: "Start Research Wave"
    agent: wave-orchestrator
    prompt: "5 {topic}"
    send: true
```
This already works — it's what the `agent:` attribute in wave-explore-fast.prompt.md does (routes to wave-orchestrator). The orchestrator then uses `runSubagent` internally. So **handoffs ARE already the entry mechanism**, but the internal parallelism uses subagent dispatch.

## Open Questions

1. **Could handoffs gain fan-out?** If VS Code added `agents: [a, b, c]` (dispatch to multiple targets with return), handoffs become subagent dispatch. This would blur the distinction entirely. Currently no evidence of this in the codebase.

2. **Post-pipeline handoff chains**: Could wave-orchestrator declare a handoff that auto-fires after its Stop hook? E.g., `{agent: "coder", prompt: "implement FINAL-REPORT.md", send: true}`. Currently handoffs are rendered as UI buttons by the agent's response — if the orchestrator includes them in its final output, this works today.

3. **Could `showContinueOn` enable multi-step?** The `showContinueOn` property (parsed identically to `send`) might control whether a "Continue on..." button appears. If extended to support chaining, this could enable sequential phase transitions. But it still wouldn't address parallelism.

4. **Conversation context bloat**: If handoffs were used (hypothetically), Step 2's N research outputs would all be in conversation history when Step 3 runs. For N=12, this could be 12 full reports in context — potentially exceeding model context windows. Subagent dispatch avoids this by isolating each worker and returning only summaries.
