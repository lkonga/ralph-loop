# Q7: Handoff vs Subagent Use Cases — Decision Framework

## Findings

### What Handoffs Are

Handoffs are **user-facing transition buttons** rendered at the end of an agent response. They are defined in `.agent.md` YAML frontmatter and produce clickable UI elements that start a *new request* in a different (or same) agent context.

**Schema** (from `IHandOff` interface in `promptFileParser.ts`):
- `agent`: target agent identifier (e.g., `agent` for default Agent mode)
- `label`: button text shown to user (e.g., "Start Implementation")
- `prompt`: message sent to target agent
- `send`: auto-send vs populate-only (boolean)
- `showContinueOn`: whether to show as continue-on button
- `model`: **qualified model name override** (e.g., `GPT-4.1 (copilot)`)

**Key example**: Plan agent defines two handoffs dynamically:
1. **"Start Implementation"** → hands off to Agent mode (`send: true`), optionally switching model via `ImplementAgentModel` setting
2. **"Open in Editor"** → creates plan as untitled file (`showContinueOn: false`)

### What Subagents Are

Subagents are **model-invoked child agents** dispatched programmatically within a parent agent's turn. They run as tool calls (`agent` tool / `runSubagent`), execute autonomously, and return results to the parent.

**Key example**: Explore agent is a read-only research subagent:
- `userInvocable: false` — cannot be called by user directly
- `agents: []` — no nested subagents
- Has its own `model` field (defaults to `Claude Haiku 4.5`, `Gemini 3 Flash`, fallback `Auto`)
- Runs in parallel (Plan can launch 2-3 Explore agents concurrently)

### Use Case Matrix

| Dimension | Handoffs | Subagents |
|---|---|---|
| **Invocation** | User clicks button | Model calls `agent` tool |
| **Control flow** | Sequential-checkpoint (human gate) | Parallel-automated (model-driven) |
| **Conversation** | Starts new turn in target agent | Nested within parent turn |
| **Visibility** | Explicit to user (rendered buttons) | Shown as tool call in chat |
| **Model switching** | `model` field in handoff config | `model` field in agent config |
| **State transfer** | Via `prompt` field (text only) | Via tool parameters |
| **Concurrency** | One at a time (user picks) | Multiple in parallel |
| **User involvement** | Required (click to proceed) | None (autonomous) |

## Patterns

### Sequential-Checkpoint (Handoffs)
**Pattern**: Plan → [USER REVIEWS] → Implement  
**Use when**: Work requires human judgment between phases. The Plan agent researches, builds a plan, presents it, then offers handoff buttons. User reviews and decides whether to proceed.

This is a **triage/routing pattern** — the current agent completes its work and offers the user choices for what comes next, potentially with different model configurations.

### Parallel-Automated (Subagents)
**Pattern**: Plan → [Explore(area1) || Explore(area2) || Explore(area3)] → synthesize  
**Use when**: Agent needs research/context that can be gathered concurrently without user input. The parent delegates search-heavy work to cheaper/faster models.

This is a **divide-and-conquer pattern** — decompose work across specialized workers that report back.

### Hybrid: SwitchAgent Tool
A third mechanism (`SwitchAgentTool`) switches the *current* agent mode mid-conversation (currently only supports switching to Plan). This is model-initiated but changes the active mode rather than spawning a child.

## Applicability

### Decision Framework

**Use handoffs when:**
1. There's a natural **phase boundary** requiring user review (plan→implement)
2. You want to **switch models** for the next phase (e.g., cheaper model for planning, expensive for implementation)
3. The transition is **one-way** — the target agent doesn't need to report back
4. User should have **explicit control** over whether to proceed
5. The target agent needs **full conversation context** (new turn, not nested)

**Use subagents when:**
1. The parent needs **results back** to continue its work
2. Multiple independent tasks can run **in parallel** for speed
3. The delegated work is **autonomous and bounded** (search, read, analyze)
4. You want to use **cheaper/faster models** for specific subtasks
5. The work is **invisible to the user's workflow** (implementation detail)

**Use both when:**
- Complex workflows need both autonomous research (subagents for discovery) AND user checkpoints (handoffs for phase transitions). The Plan agent exemplifies this: it uses Explore subagents for research, then offers handoff buttons to proceed to implementation.

### Are Handoffs Redundant With Subagents?

**No. They serve fundamentally different needs:**
- Handoffs = **user-controlled inter-phase transitions** (human-in-the-loop)
- Subagents = **model-controlled intra-phase delegation** (autonomous workers)

They operate at different levels of the control hierarchy. A subagent is a function call within a turn; a handoff is a state transition between turns.

### Is the `model` Field Unique to Handoffs?

**No, but the use case is different.** Both agents and handoffs support `model`:
- **Agent `model` field**: Sets the model for the agent itself (e.g., Explore uses Haiku by default)
- **Handoff `model` field**: Overrides the *target agent's* model when the handoff is triggered

The handoff `model` field enables a unique capability: **context-sensitive model switching at transition time**. For example, Plan might normally hand off to Agent mode's default model, but a settings-configured `ImplementAgentModel` can force a specific model (e.g., Opus for complex implementation) via the handoff's `model` field.

## Open Questions

1. **No handoff-from-subagent**: Subagents currently cannot trigger handoffs — they only report text results. Could a subagent recommend a handoff?
2. **No subagent model override at call site**: When a parent calls a subagent, it uses the subagent's configured model. There's no way to override the model per-invocation from the caller side.
3. **SwitchAgent limited**: The `SwitchAgentTool` only supports switching to Plan. Generalizing it could enable model-initiated handoffs without user clicking.
4. **Handoff state is text-only**: The `prompt` field carries context as plain text. Richer structured state passing could improve handoff quality.
5. **No conditional handoffs**: Handoffs are statically defined in agent config. Dynamic handoffs based on conversation state would enable more sophisticated workflows.
