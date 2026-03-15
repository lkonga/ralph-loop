## Research Report 4: Handoff Auto-Execution Mechanisms

### Findings

#### 1. Handoff Data Model — Two Parallel Interfaces

The handoff system defines two parallel interfaces: one at the extension agent layer and one at the parser/core layer.

**Extension layer** — [`AgentHandoff`](../../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#L9-L16):
```ts
export interface AgentHandoff {
	readonly label: string;
	readonly agent: string;
	readonly prompt: string;
	readonly send?: boolean;
	readonly showContinueOn?: boolean;
	readonly model?: string;
}
```

**Parser/core layer** — [`IHandOff`](../../../vscode-copilot-chat/src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L342-L349):
```ts
export interface IHandOff {
	readonly agent: string;
	readonly label: string;
	readonly prompt: string;
	readonly send?: boolean;
	readonly showContinueOn?: boolean; // treated exactly like send (optional boolean)
	readonly model?: string;
}
```

Key observation: The inline comment on `showContinueOn` in `IHandOff` says "treated exactly like send" — they serve the same conceptual role as boolean flags governing auto-behavior.

#### 2. `send: true` Semantics — Where It's Produced vs. Consumed

**Produced in extension code — serialized into YAML frontmatter:**

In [`buildAgentMarkdown()`](../../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#L96-L112), handoffs are serialized to YAML block style. The `send` property is conditionally emitted:
```ts
if (handoff.send !== undefined) {
    lines.push(`    send: ${handoff.send}`);
}
```

This writes into `.agent.md` frontmatter:
```yaml
handoffs:
  - label: Start Implementation
    agent: agent
    prompt: Implement the plan
    send: true
```

**Consumed in VS Code core (not in this repo):**

The `IHandOff` interface parsed by `promptFileParser.ts` is consumed by the VS Code core editor (microsoft/vscode repo). The handoff buttons are rendered by VS Code's chat widget, not by this extension. **The actual UI behavior of `send: true` is implemented in the vscode repo's chat contribution, not here.** This repo only parses and produces the data.

**Based on the architecture pattern:** `send: true` means "auto-submit the handoff prompt to the target agent" (i.e., clicking the handoff button both fills AND sends the message). When `send` is `false` or absent, clicking the button only pre-fills the chat input, requiring the user to press Enter.

#### 3. Concrete Handoff Examples in the Codebase

**Plan Agent** ([planAgentProvider.ts L206-L221](../../../vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts#L206-L221)):
```ts
const startImplementationHandoff: AgentHandoff = {
    label: 'Start Implementation',
    agent: 'agent',
    prompt: 'Start implementation',
    send: true, // ← auto-submits when clicked
    ...(implementAgentModelOverride ? { model: implementAgentModelOverride } : {})
};

const openInEditorHandoff: AgentHandoff = {
    label: 'Open in Editor',
    agent: 'agent',
    prompt: '#createFile the plan as is into an untitled file...',
    showContinueOn: false, // ← hides "continue" affordance
    send: true // ← auto-submits when clicked
};
```

**Edit Mode Agent** ([editModeAgentProvider.ts L23-L29](../../../vscode-copilot-chat/src/extension/agents/vscode-node/editModeAgentProvider.ts#L23-L29)):
```ts
handoffs: [{
    label: 'Continue with Agent Mode',
    agent: 'agent',
    prompt: 'You are now switching to Agent Mode...',
    send: true // ← auto-submits when clicked
}]
```

All built-in handoffs use `send: true` — none use `send: false` or omit `send`.

#### 4. `nextQuestion` — A Separate Auto-Fill Mechanism

[`ChatResult.nextQuestion`](../../../vscode-copilot-chat/src/extension/vscode.proposed.chatParticipantAdditions.d.ts#L850-L854) is a different API:
```ts
export interface ChatResult {
    nextQuestion?: {
        prompt: string;
        participant?: string;
        command?: string;
    };
}
```

Used only in remote agents ([remoteAgents.ts L497](../../../vscode-copilot-chat/src/extension/conversation/vscode-node/remoteAgents.ts#L497)):
```ts
return { metadata, nextQuestion: { prompt: request.prompt, participant: participantId, command: request.command } };
```

This is returned on `AgentUnauthorized` responses — it auto-fills the chat input with the original prompt so the user can re-send after authorizing. Unlike handoffs, `nextQuestion` does NOT auto-submit; it fills the input and waits.

#### 5. `autoSend` — A Third Mechanism (Inline Chat Only)

The `autoSend: true` property exists only in the inline chat (editor chat) command API:
```ts
await vscode.commands.executeCommand('vscode.editorChat.start', {
    message: `/${Intent.Fix} the #testFailure`,
    autoSend: true,
});
```

Found in:
- [`fixTestFailureContributions.ts L76`](../../../vscode-copilot-chat/src/extension/intents/vscode-node/fixTestFailureContributions.ts#L76)
- [`inlineChatCommands.ts L145, L251, L260`](../../../vscode-copilot-chat/src/extension/inlineChat/vscode-node/inlineChatCommands.ts#L145)
- [`inlineChatCodeActions.ts L116`](../../../vscode-copilot-chat/src/extension/inlineChat/vscode-node/inlineChatCodeActions.ts#L116)
- [`inlineChatNotebookActions.ts L54, L97`](../../../vscode-copilot-chat/src/extension/inlineChat/vscode-node/inlineChatNotebookActions.ts#L54)

This `autoSend` is a full auto-execute (fills prompt AND sends immediately). But it's only for inline chat — completely separate from panel chat handoffs.

#### 6. Can a Handoff Fire Without User Click?

**No.** Based on the codebase:

- Handoffs are rendered as **buttons** in the chat UI (referred to as "handoff buttons" in [planAgentProvider.ts L60](../../../vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts#L60))
- They require a user click to trigger
- There is no mechanism in this extension to programmatically fire a handoff
- The `nextQuestion` mechanism pre-fills the input but does NOT auto-send
- The `autoSend` mechanism only exists for inline chat commands, not panel chat handoffs

The only way to create a fully automated agent chain would be through `vscode.commands.executeCommand` with the chat command (like `vscode.editorChat.start` does for inline chat), but no such mechanism exists for panel chat handoffs in this codebase.

#### 7. `showContinueOn` — Handoff Visibility Control

`showContinueOn: false` suppresses a "continue" affordance in the handoff UI. Example from the `openInEditorHandoff`:
```ts
showContinueOn: false, // Don't show "continue working" after opening in editor
```
The comment in `IHandOff` says it's "treated exactly like send (optional boolean)" — meaning both are optional boolean flags parsed identically, though they control different UI behaviors.

### Patterns

| Pattern | Mechanism | User Action Required | Scope |
|---------|-----------|---------------------|-------|
| `send: true` on handoff | Auto-fill + auto-submit on button click | Click button | Panel chat |
| `send: false` / omitted | Auto-fill only on button click (user must hit Enter) | Click button + Enter | Panel chat |
| `nextQuestion` | Auto-fill chat input after response | User must hit Enter | Panel chat (remote agents) |
| `autoSend: true` | Full auto-execute | None (programmatic) | Inline chat only |
| `showContinueOn` | Controls "continue" UI visibility | N/A (UI configuration) | Panel chat |

**Architecture pattern**: The extension writes `.agent.md` files with YAML frontmatter → VS Code core (`microsoft/vscode`) parses them via `PromptFileParser` → core renders handoff buttons and handles `send` behavior. The boundary between extension and core is at the `IHandOff` interface.

### Applicability

**HIGH** — This is directly relevant for understanding how to build agent-to-agent transitions.

Key takeaways for implementation:
1. `send: true` is a "click-to-auto-execute" — it requires user initiation (button click) but then auto-submits. It is NOT a "fire without user action" mechanism.
2. There is **no programmatic auto-fire** for handoffs in panel chat. All handoffs require a user click.
3. For fully automated chains, the only current mechanism is the inline chat `autoSend: true` via `vscode.commands.executeCommand`.
4. To build a fully auto-executing handoff chain (no user clicks), you would need to either:
   - Use the `vscode.commands.executeCommand` API to programmatically send chat messages
   - Or extend the VS Code core to support an auto-fire mode for handoffs

### Open Questions

1. **VS Code core `send` handling**: The actual UI behavior of `send: true` is implemented in `microsoft/vscode`, not in this extension. What does VS Code core do when `send` is not set? Does it default to `false` (fill only) or `true` (fill and send)?
2. **Can `nextQuestion` be combined with handoffs?** The `ChatResult` interface supports `nextQuestion` — could a participant return both handoffs and `nextQuestion` to chain agent calls?
3. **Programmatic chat submission**: Is there a VS Code API equivalent to `vscode.editorChat.start` for panel chat that supports `autoSend`? (e.g., `workbench.action.chat.send` or similar)
4. **`showContinueOn` exact behavior**: The comment says "treated exactly like send" but it's used with `false` value alongside `send: true` in `openInEditorHandoff`. Does it override `send` or control a separate UI element?
5. **Custom agent handoff parsing**: Are custom `.agent.md` files from workspace `.github/agents/` directory parsed the same way as built-in agents, including handoff support?
