# Q4: Handoff Return Path and Session Behavior

## Findings

### 1. Handoffs Stay in the Same Session (Not New Session)

The `SwitchAgentTool` ([switchAgentTool.ts](src/extension/tools/vscode-node/switchAgentTool.ts)) explicitly passes `sessionResource` to `toggleAgentMode`:

```typescript
await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', {
    modeId: agentName,
    sessionResource: options.chatSessionResource
});
```

This means handoffs are **inline mode switches within the same chat pane**, not `workbench.action.chat.newSession`. The conversation history carries over. The `sessionResource` parameter ties the switch to the current session, preserving context.

### 2. No Return Path Exists

There is **no "back" button, undo, or return mechanism** after a handoff. Evidence:
- No `returnTo`, `previousAgent`, `restoreMode`, or `backAgent` references exist in the codebase
- `SwitchAgentTool` only supports `agentName === 'Plan'` — a single hardcoded direction (Agent → Plan)
- The handoff response text says: *"This tool may no longer be available in the new agent"* — confirming the switch is one-way within a given tool context

Handoffs are **unidirectional fire-and-forget transitions**. The only way "back" is defining a reverse handoff button on the target agent (e.g., Edit Mode defines a "Continue with Agent Mode" handoff back to Agent).

### 3. `send: true` Auto-Submits the Prompt

When a handoff has `send: true`, the prompt string is automatically submitted to the target agent without user intervention. This is distinct from simply pre-filling the input box:
- `send: true` = switch agent + submit prompt immediately (auto-execute)
- `send: false` or omitted = switch agent + pre-fill prompt for user review

Example from Plan agent's "Start Implementation" handoff:
```typescript
{ label: 'Start Implementation', agent: 'agent', prompt: 'Start implementation', send: true }
```
This switches to Agent mode and immediately sends "Start implementation" — no user click needed after pressing the handoff button.

### 4. `showContinueOn` Controls Button Visibility

The `showContinueOn` field (typed as `boolean | undefined` in `IHandOff` at [promptFileParser.ts L347](src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts)) controls whether a "Continue on..." affordance is shown. When `false`, the handoff button appears without the continue-on badge. The Plan agent's "Open in Editor" handoff uses `showContinueOn: false` to suppress this UI element.

### 5. Feature-Gated and Agent-Restricted

- `SwitchAgentTool` is behind `chat.switchAgent.enabled` (experiment-based, default `false`)
- Only `'Plan'` target is supported programmatically — other agents use YAML `handoffs:` buttons
- The tool is registered in the Anthropic tool blocklist (`switch_agent`), meaning it's excluded from Claude-based flows

### 6. Two Invocation Paths

Handoffs have dual invocation:
1. **UI path**: YAML `handoffs:` in `.agent.md` frontmatter → rendered as clickable chat buttons
2. **Programmatic path**: `SwitchAgentTool` → `toggleAgentMode` command → same-session switch (model-initiated, not user-click)

Both paths use the same underlying `toggleAgentMode` command with `sessionResource`.

## Patterns

| Aspect | Behavior |
|--------|----------|
| Session scope | **Same session** — `sessionResource` preserved |
| Direction | **One-way** per handoff; bidirectional requires explicit reverse handoff definition |
| History | **Preserved** — conversation continues in same pane |
| `send: true` | Auto-submit prompt to target agent (no user review) |
| `send: false`/omitted | Pre-fill prompt, user must submit |
| `showContinueOn: false` | Hide "continue on" badge from button |
| Return mechanism | **None** — must define reverse handoff on target agent |
| Nesting | Not possible — handoffs are flat A→B transitions |

### Existing Bidirectional Examples

- **Edit → Agent**: Edit Mode defines `{ label: 'Continue with Agent Mode', agent: 'agent', prompt: '...', send: true }` — an explicit reverse handoff
- **Plan → Agent**: Plan defines "Start Implementation" → Agent. But Agent has **no handoff back to Plan** except via `SwitchAgentTool` (programmatic, gated)

## Applicability

### Can handoffs chain phases with return?

**Partially.** You can simulate A→B→A by:
1. Agent A defines handoff to Agent B
2. Agent B defines handoff back to Agent A

But this is **stateless** — Agent A has no awareness it was "returned to." The conversation history is preserved (same session), but there's no structured state machine tracking phase transitions.

### Implications for ralph-loop

- Handoffs are useful as **exit ramps** (e.g., research → implement), not as orchestration primitives
- Phase chaining (Plan → Implement → Verify → Done) requires each phase agent to define the next handoff explicitly
- No programmatic loop possible — each transition requires user button click (unless `send: true`)
- `send: true` can simulate automation within a single direction but not round-trips

## Open Questions

1. **Why is `SwitchAgentTool` restricted to "Plan" only?** Likely because bidirectional switching without state tracking creates confusion. Expanding to arbitrary agents is presumably planned but not shipped.
2. **Will `toggleAgentMode` get a `returnTo` parameter?** No evidence of this being planned. The current design treats mode switches as permanent within a turn.
3. **Can `send: true` + reverse handoffs create an automated loop?** Theoretically yes (A sends to B, B auto-sends back to A), but this would create an infinite loop with no termination condition — the framework has no guard against this.
4. **GitHub issue #301697**: No references found in the codebase. This issue may exist in the VS Code core repo (microsoft/vscode) rather than the extension.
5. **`showContinueOn` semantics**: The comment says "treated exactly like send (optional boolean)" but it controls UI visibility, not submission behavior. The exact VS Code core rendering logic is outside this extension's codebase.
