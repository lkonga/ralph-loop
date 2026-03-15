# Q6: Existing Post-Analysis Implementation Patterns

## Findings

### Pattern 1: Plan → Agent Handoff (Primary Pattern)

The `PlanAgentProvider` ([planAgentProvider.ts](src/extension/agents/vscode-node/planAgentProvider.ts)) is the canonical "research complete, now implement" pattern in the codebase.

**Mechanics:**
- Plan agent is read-only — `tools: [search, read, web, agent, ...]` + `disableModelInvocation: true`
- It dispatches `Explore` subagents for context gathering (parallel fan-out supported)
- After iterative research/alignment/design, it renders **handoff buttons** in the chat UI
- Two built-in handoffs:
  1. **"Start Implementation"** → `{agent: 'agent', prompt: 'Start implementation', send: true}` — auto-sends to Agent mode
  2. **"Open in Editor"** → `{agent: 'agent', prompt: '#createFile the plan...', showContinueOn: false, send: true}` — exports plan as editable `.prompt.md`

**Key insight:** The plan is persisted to `/memories/session/plan.md` via the `vscode/memory` tool. The handoff button sends "Start implementation" as a new message to the default `agent` — the plan context is implicitly carried via conversation history and the memory file.

### Pattern 2: Edit Mode → Agent Mode Handoff

The `EditModeAgentProvider` ([editModeAgentProvider.ts](src/extension/agents/vscode-node/editModeAgentProvider.ts)) demonstrates scope-expansion handoffs:

- Edit mode is restricted: `tools: ['read', 'edit'], agents: []`
- Single handoff: **"Continue with Agent Mode"** → `{agent: 'agent', prompt: 'You are now switching to Agent Mode...', send: true}`
- The prompt explicitly contextualizes the transition: "Continue with the task without the previous restrictions"

### Pattern 3: Claude Agent SDK ExitPlanMode Tool

For Claude-based agents, transitions use a dedicated tool call (`ExitPlanMode`) rather than UI buttons:
- Claude calls `ExitPlanMode` with a `plan` parameter
- `ExitPlanModeToolHandler` shows a confirmation dialog: "Ready to code? Here is Claude's plan: ..."
- User confirms → agent exits plan mode and enters implementation mode within the same session

### Pattern 4: Prompt File `handoffs:` Frontmatter

The YAML frontmatter parser (`promptFileParser.ts`) supports `handoffs:` as a first-class attribute on any `.agent.md` or `.prompt.md` file. The `IHandOff` interface:
```typescript
interface IHandOff {
  agent: string;      // target agent name
  label: string;      // button text
  prompt: string;     // message sent to target agent
  send?: boolean;     // auto-send (true) or pre-fill (false)
  showContinueOn?: boolean;  // show "Continue on" button
  model?: string;     // optional model override for target
}
```

## Patterns

### "Research → Implement" Workflow Mechanics

1. **Button-gated transition (Plan agent):** Research completes → handoff buttons render → user clicks → new message sent to Agent mode. Human-in-the-loop gate.

2. **Tool-gated transition (Claude SDK):** Research completes → agent calls `ExitPlanMode(plan)` → confirmation dialog → mode switch within session.

3. **Implicit context carry:** Neither pattern passes structured data. Instead:
   - Conversation history provides context
   - Memory tool persists structured artifacts (`plan.md`)
   - Handoff prompt is a natural-language instruction

4. **No "auto-implement" pipeline exists.** Every transition is human-gated (button click or confirmation dialog). There is no built-in "research complete → automatically start implementing" flow.

5. **wave-orchestrator has NO handoffs defined.** The agent file at `wave-orchestrator.agent.md` uses `hooks:` (SubagentStart, Stop) but declares zero `handoffs:`. After research completes, the orchestrator just outputs the FINAL-REPORT and stops. Post-wave action is entirely manual.

## Applicability

### What wave-explore-fast can borrow:

| Pattern | Directly Usable? | How |
|---------|-------------------|-----|
| `handoffs:` frontmatter | **Yes** | Add to `wave-orchestrator.agent.md` or `wave-explore-fast.prompt.md` |
| Plan's "Start Implementation" handoff | **Yes, as template** | `{label: 'Implement Findings', agent: 'coder', prompt: 'Implement based on FINAL-REPORT at {path}', send: true}` |
| Plan's "Open in Editor" handoff | **Yes** | Export FINAL-REPORT as `.prompt.md` for refinement |
| `model:` override in handoff | **Yes** | Can route implementation to a different model than research |
| `showContinueOn: false` | **Yes** | Suppress "Continue on" for one-shot handoffs |
| `ExitPlanMode` tool | **No** | Claude SDK-specific, not available for custom agents |

### Recommended Implementation:

Add `handoffs:` to `wave-orchestrator.agent.md`:
```yaml
handoffs:
  - label: Implement Findings
    agent: coder
    prompt: 'Read the FINAL-REPORT and implement the recommended changes.'
    send: true
  - label: Open Report
    agent: agent
    prompt: '#createFile the FINAL-REPORT into an untitled file for review.'
    showContinueOn: false
    send: true
```

This requires no code changes — it's pure YAML frontmatter, already parsed by `promptFileParser.ts`.

## Open Questions

1. **Context passing**: Handoff prompts are plain text. How does the target agent know where FINAL-REPORT lives? Must be baked into the prompt string (path interpolation would need a hook or template engine).
2. **Auto-send vs. user-gated**: `send: true` still renders a button the user must click. There's no mechanism for auto-fire after the Stop hook validates.
3. **Multi-step handoff chains**: Can a handoff target itself define handoffs? Yes — the parser supports it on any agent. But there's no evidence of chained handoffs being used in practice.
4. **Session memory bridging**: Plan agent uses `vscode/memory` to persist `plan.md`. Wave orchestrator writes files directly. The coder handoff target would need to know to read those files — this isn't automatic.
