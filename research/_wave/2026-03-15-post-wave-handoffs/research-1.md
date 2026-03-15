# Q1: Handoff Context Transfer Mechanics

## Findings

### 1. Handoffs stay in the same chat session — full history preserved

The critical evidence is in `SwitchAgentTool.invoke()` ([switchAgentTool.ts](src/extension/tools/vscode-node/switchAgentTool.ts#L31-L34)):

```typescript
await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', {
    modeId: agentName,
    sessionResource: options.chatSessionResource
});
```

The `sessionResource` URI is explicitly passed to `toggleAgentMode`. This is the VS Code core command that switches agent modes **within the same session**. Since `sessionResource` identifies the specific chat session, the conversation history is NOT lost — the new agent inherits the full conversation context.

### 2. Handoff prompt is injected as a new user message, not a replacement

After switching agents, `SwitchAgentTool` returns a `LanguageModelToolResult` containing:
```
"Switched to {agentName} agent. You are now the {agentName} agent. This tool may no longer be available in the new agent.\n\n{planAgentBody}"
```

This becomes part of the tool result in the conversation. Separately, the **handoff `prompt`** field (e.g., `"Start implementation"`) from the frontmatter gets typed into the chat input. When `send: true`, it auto-submits immediately.

### 3. The `IHandOff` interface defines the full handoff contract

From `promptFileParser.ts` (`IHandOff` interface):
- **`agent`**: Target agent/mode ID (e.g., `"agent"` for Agent mode, `"Plan"`)
- **`label`**: Button text displayed to user
- **`prompt`**: Text injected into chat input when clicked
- **`send`** (optional): If `true`, auto-submits the prompt immediately
- **`showContinueOn`** (optional): Controls whether a "Continue on" button appears
- **`model`** (optional): Override model for the target agent (e.g., `"GPT-4.1 (copilot)"`)

### 4. `sessionResource` is a URI identifying the chat session on disk

`ChatDiskSessionResources` manages a storage directory keyed by session ID under `chat-session-resources/`. The `sessionResource` URI:
- Is a **per-session** identifier (each chat tab has a unique one)
- Allows tools to persist data (large payloads, files) to disk scoped to a session
- Has an 8-hour retention period with periodic cleanup
- Is passed through `LanguageModelToolInvocationOptions.chatSessionResource` to every tool call

When `toggleAgentMode` receives this URI, it switches the mode **within that session**, preserving the full conversation thread.

### 5. Real-world handoff examples in the codebase

**Plan → Agent (Start Implementation)**:
```typescript
{ label: 'Start Implementation', agent: 'agent', prompt: 'Start implementation', send: true }
```
The Plan agent produces a plan, user approves, then clicks "Start Implementation" which auto-sends to Agent mode in the **same session** — Agent mode sees all the plan discussion.

**Edit → Agent (Continue with Agent Mode)**:
```typescript
{ label: 'Continue with Agent Mode', agent: 'agent',
  prompt: 'You are now switching to Agent Mode...Continue with the task without the previous restrictions...', send: true }
```

**Plan → Agent (Open in Editor)**:
```typescript
{ label: 'Open in Editor', agent: 'agent',
  prompt: '#createFile the plan as is into an untitled file...', showContinueOn: false, send: true }
```

### 6. Two handoff paths exist

1. **Frontmatter `handoffs:` (UI buttons)**: Parsed from `.agent.md` files, rendered as clickable buttons in chat. When clicked, they switch agent mode and inject the prompt. This is the **user-facing** path.

2. **`SwitchAgentTool` (programmatic)**: Called by the LLM as a tool. Currently only supports switching to "Plan" agent. This is the **LLM-driven** path.

Both use `workbench.action.chat.toggleAgentMode` with `sessionResource` — same session continuity mechanism.

## Patterns

| Aspect | Behavior |
|--------|----------|
| **Session continuity** | Same session — `sessionResource` URI is passed, history preserved |
| **Conversation history** | Full history visible to new agent (all prior turns remain) |
| **Handoff prompt** | Injected as new user message in the chat input |
| **`send: true`** | Auto-submits the prompt immediately (no user interaction needed) |
| **`send: false/omitted`** | Prompt placed in input box, user must press Enter |
| **System prompt** | Changes to the new agent's `.agent.md` body (new persona/rules loaded) |
| **Model override** | Optional per-handoff model switching via `model` field |
| **Disk session resources** | Survive the handoff — same `sessionResource` URI, same storage dir |
| **Tool availability** | Changes per-agent — new agent's `tools:` frontmatter controls available tools |

## Applicability

**Impact on wave post-research handoff (FINAL-REPORT context survival):**

1. **YES — context survives handoff.** A wave researcher agent could produce a FINAL-REPORT, then a handoff button with `send: true` and a prompt like `"Summarize the research findings and create implementation tasks"` would auto-send to the next agent. The target agent would see the FULL conversation including all research turns and the final report.

2. **Disk session resources also survive.** If the researcher writes files via `ChatDiskSessionResources.ensure()`, those files persist for 8 hours and the target agent can read them via the same `sessionResource` scope.

3. **Prompt is additive, not replacing.** The handoff prompt becomes a NEW turn on top of existing history. The target agent's system prompt changes (different `.agent.md` body), but all prior conversation remains visible.

4. **Practical consideration**: While history survives, the **context window** still has finite capacity. Long research sessions with many tool calls may cause older turns to be truncated by the token budgeting system, not by the handoff mechanism itself.

## Open Questions

1. **Token budgeting across handoff**: Does the new agent's prompt-tsx rendering re-budget the context window, potentially dropping older turns that the source agent had access to?
2. **`showContinueOn` semantics**: The comment says "treated exactly like send" but it controls a different UI surface ("Continue on...") — unclear if behavior differs from `send` in VS Code core.
3. **Multi-hop handoffs**: Can an agent hand off to another agent that also has handoffs? Is there a depth limit?
4. **Session state beyond history**: Tools like `vscode/memory` write to session-scoped memory — does this survive handoffs? (Likely yes, since sessionResource is preserved.)
5. **`toggleAgentMode` internals**: The actual implementation is in VS Code core (not in this extension) — the exact mechanism for carrying history during mode switch is not visible in this codebase.
