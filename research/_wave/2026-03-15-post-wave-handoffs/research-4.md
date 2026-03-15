# Q4: Mode Restoration After Agent Chains

## Findings

### How Mode State Works
- VS Code chat has a **mode dropdown** (top of chat panel) with builtin modes: `Agent`, `Ask`, `Edit`, `Plan`.
- Custom `.agent.md` files register as **additional modes** (non-builtin, `isBuiltin: false` in `ChatRequestModeInstructions`).
- Mode is **per-session and sticky**: once you select a mode (or a custom agent switches into it), it stays for the duration of that session until explicitly changed.
- The mode is passed on each request as `request.modeInstructions2.name` — the chat panel sends the current mode with every turn.

### What Happens When a Custom Agent Completes
- **Nothing automatic.** The mode stays wherever it was set. If wave-explore-fast is a custom `.agent.md` mode, the session remains in that mode after the response completes.
- There is **no auto-restore** mechanism. Custom agent completion does not trigger a mode switch back to "Agent".
- The `switchAgentTool` (`copilot_switchAgent`) only supports switching to `Plan` — it explicitly rejects other agent names with `Only "Plan" agent is supported`.

### Handoff Mechanism (The Official Way to Return)
- The `.agent.md` frontmatter supports a `handoffs:` field — buttons rendered after the agent completes its response.
- Built-in agents use this pattern:
  - **Plan** agent → handoff with `agent: 'agent'`, label "Start Implementation" (auto-sends, switches to Agent mode)
  - **Edit** agent → handoff with `agent: 'agent'`, label "Continue with Agent Mode"
- Handoffs call `workbench.action.chat.toggleAgentMode` with `{ modeId: agentName, sessionResource }` to switch modes within the same session.

### Manual Ways to Restore Agent Mode
1. **Mode dropdown**: Click the mode selector at the top of the chat panel and choose "Agent".
2. **Command**: `workbench.action.chat.open` with `{ mode: 'agent' }` — this opens/focuses chat in Agent mode.
3. **New chat**: `workbench.action.chat.newChat` starts a fresh session (defaults to the user's preferred mode, typically Agent).
4. **Handoff in .agent.md**: Add a `handoffs:` entry pointing back to `agent`.

## Patterns

### Mode Lifecycle
```
User selects mode (dropdown or command) → Mode is stored per-session
→ Every request carries modeInstructions2 with mode name + content
→ Mode persists across all turns in that session
→ Only changes via: dropdown click, handoff button, or toggleAgentMode command
```

### Auto-Restore vs Manual
- **No auto-restore exists.** This is intentional — VS Code treats mode as a user choice that persists.
- **Handoffs are the declarative solution**: agents define buttons that offer transitions to other modes.
- **Starting a new chat** is the simplest user-facing reset — it creates a fresh session with default mode.

### Session Scope
- Mode is scoped to the **chat session** (a single conversation thread), not globally.
- Opening a new chat panel / starting a new conversation resets to the default mode.
- The same panel can have its mode changed mid-conversation via handoffs or the dropdown.

## Applicability

### How to Get Back to "Agent" After wave-explore-fast Ends

**Option A: Add handoffs to the .agent.md** (recommended)
```yaml
handoffs:
  - label: Continue with Agent Mode
    agent: agent
    prompt: 'Continue with the task in full Agent Mode.'
    send: true
```
This renders a button after the agent response that auto-switches back.

**Option B: Manual dropdown**
User clicks the mode dropdown and selects "Agent".

**Option C: New chat**
`Cmd/Ctrl+Shift+I` or `workbench.action.chat.newChat` — starts fresh in default mode.

**Option D: Programmatic command (from extension/tool)**
```typescript
vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent' });
```

**For wave-orchestrator workflows**: The most robust approach is defining `handoffs:` in the custom agent's frontmatter with `agent: agent` and `send: true`. This gives the user a one-click return to Agent mode after the chain completes.

## Open Questions

1. Can `workbench.action.chat.toggleAgentMode` accept custom agent names beyond `Plan`, or is that restriction only in the `switchAgentTool` wrapper?
2. Is there a setting to configure the default mode for new chats (e.g., always start in Agent vs Ask)?
3. Can handoffs be chained (agent A → agent B → agent C → agent) or only single-hop?
4. Does the `send: true` flag on handoffs auto-execute, or does the user still need to click?
