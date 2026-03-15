# Q5: Handoff vs Subagent for Post-Research Implementation — Tradeoff Analysis

## Findings

### 1. Context Preservation

| Dimension | Handoff | Subagent |
|-----------|---------|----------|
| **Conversation history** | Full — same session continues, target agent sees all prior turns | Isolated — subagent gets only the prompt string passed via `agent` tool call |
| **What the target sees** | Complete chat history + handoff `prompt` string appended as new user message | Only the invocation prompt + optional `additionalContext` from SubagentStart hooks |
| **Context mechanism** | Same `sessionId`, `conversation.turns` array carries forward | New tool-calling loop with `subAgentInvocationId`, `parentRequestId` for trace linking only |

**Evidence**: `planAgentProvider.ts` L206-213 shows the handoff prompt is simply `'Start implementation'` — all the real context comes from the continuing conversation. Subagent context is explicitly isolated per `chatParticipantPrivate.d.ts` L105: the `subAgentInvocationId` is for tool call grouping, not context sharing.

### 2. Tool Access

| Dimension | Handoff | Subagent |
|-----------|---------|----------|
| **Tool set** | Determined by the **target agent's** config (e.g., `coder.agent.md` tools list) | Determined by the **subagent's** own config (e.g., Explore gets only `DEFAULT_READ_TOOLS`) |
| **Write tools** | ✅ Full — handoff to default `agent` mode gets all tools including edit, terminal, create | ⚠️ Depends on subagent — Explore is read-only; a custom coder subagent could have write tools |
| **Agent nesting** | Target can invoke its own subagents (e.g., coder dispatches Explore) | Subagents can be restricted via `agents: []` (Explore cannot spawn sub-subagents) |

**Evidence**: `agentTypes.ts` L43-56 shows `DEFAULT_READ_TOOLS` (search, read, web only). `coder.agent.md` tools list includes `edit/*`, `execute/*`, `agent`, `search`, `web` — full write access.

### 3. User Control

| Dimension | Handoff | Subagent |
|-----------|---------|----------|
| **Visibility** | Button rendered in chat — user clicks to trigger, can choose not to | Automatic — parent dispatches without user approval (unless tool confirmation is on) |
| **Interruptibility** | User can stop, edit, or redirect the new agent normally | Parent waits; user can cancel the subagent but loses parent's in-flight state |
| **Review point** | Natural pause — user sees plan, decides whether to handoff | No pause — orchestrator dispatches immediately based on its own judgment |

**Evidence**: `AgentHandoff.send` (L14) controls auto-send behavior. `showContinueOn` (L15) controls UI rendering. Plan agent uses `send: true` for "Start Implementation" handoff.

### 4. Automation Level

| Dimension | Handoff | Subagent |
|-----------|---------|----------|
| **Orchestrator survival** | ❌ Original agent dies — no verification loop possible | ✅ Parent survives, can verify results and iterate |
| **Multi-step coordination** | One-shot — handoff is terminal for the source agent | Multi-shot — parent can dispatch N subagents, collect results, decide next steps |
| **Error recovery** | User must manually re-invoke or fix | Parent can inspect subagent output and retry/adjust |

### 5. Token Cost

| Dimension | Handoff | Subagent |
|-----------|---------|----------|
| **Context duplication** | No duplication — conversation continues linearly | Prompt content must be serialized into the subagent invocation (duplicates key info) |
| **History accumulation** | Full history grows monotonically — prior research + implementation in one window | Subagent has compact context (just the task prompt); parent retains its own history |
| **Model flexibility** | Handoff supports `model` override (L16, L211) — can switch to cheaper/faster model | Subagent uses its own configured model (Explore defaults to Haiku 4.5/Gemini Flash) |
| **Net cost** | Higher per-turn (large context) but fewer total turns | Lower per-subagent-turn but more total turns if parent needs to re-summarize |

### 6. Conversation Flow

| Dimension | Handoff | Subagent |
|-----------|---------|----------|
| **Flow shape** | Linear: Agent A → (handoff) → Agent B (no return) | Tree: Parent → Subagent → Parent continues |
| **State management** | Clean — one agent at a time, no coordination needed | Complex — parent must track subagent results, merge into its own reasoning |
| **User experience** | Seamless — looks like one continuous conversation | Nested — subagent work appears as tool call output within parent conversation |

## Patterns

### Decision Framework

```
Choose HANDOFF when:
  ├── Research phase is fully complete (no verification needed)
  ├── Implementation is the terminal goal
  ├── Full conversation context is critical for implementation
  └── User wants explicit control over the transition point

Choose SUBAGENT when:
  ├── Orchestrator needs to verify implementation results
  ├── Multiple implementation steps need coordination
  ├── Implementation is one part of a larger workflow
  └── Context can be compressed into a focused prompt
```

### Hybrid Pattern (Best of Both)

The Plan agent already demonstrates this: it uses **subagents for research** (Explore) and **handoff for implementation** ("Start Implementation" button). This is the optimal pattern because research benefits from orchestrator-controlled iteration, while implementation benefits from full context.

## Applicability

**For `wave-explore-fast`**: The handoff approach is strongly recommended for post-research implementation because:

1. **Wave research produces rich context** — the FINAL-REPORT contains findings, patterns, and applicability analysis that benefit from being in the full conversation history rather than serialized into a prompt string.

2. **Implementation is terminal** — there's no meaningful "return to orchestrator" step after implementing research findings. The coder doesn't need an orchestrator to verify its work; the user does that.

3. **Natural review point** — the handoff button creates a user-controlled gate between research and implementation, matching wave's philosophy of structured phases.

4. **Model switching** — handoff supports `model` override, letting wave use a fast model for research and switch to a stronger model for implementation.

**Recommended handoff config**:
```yaml
handoffs:
  - label: "Implement Changes"
    agent: agent
    prompt: 'Implement the changes described in the FINAL-REPORT above. Follow the plan exactly.'
    send: false  # Let user review before sending
    model: Claude Opus 4.6 (fast mode) (Preview) (copilot)
```

Setting `send: false` gives user control; they can edit the prompt or add constraints before dispatching implementation.

## Open Questions

1. **Can handoff prompt be dynamically generated?** — Plan agent uses static strings. Could wave inject FINAL-REPORT content into the handoff prompt for cases where the target agent doesn't see full history?
2. **Subagent context limits** — What's the max token budget for a subagent prompt? If it's small, serializing a full research report may be lossy.
3. **Hybrid verification** — Could a post-handoff coder agent use Explore subagents to verify its own changes, compensating for the lack of orchestrator verification?
4. **Session memory persistence** — Does handoff preserve `vscode/memory` entries from the research phase? If so, the coder could read `/memories/session/plan.md` saved by a wave-like orchestrator.
