## Research Report 3: Handoff Click and Mode Transition

### Findings

#### 1. Handoff Data Model (`AgentHandoff` interface)

The handoff system is defined in [agentTypes.ts](../../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#L9-L16):

```ts
export interface AgentHandoff {
    readonly label: string;
    readonly agent: string;    // target agent name, e.g. "agent"
    readonly prompt: string;
    readonly send?: boolean;   // auto-send the prompt on click
    readonly showContinueOn?: boolean;
    readonly model?: string;
}
```

The extension-side `AgentHandoff` is serialized to YAML frontmatter via `buildAgentMarkdown()` at [agentTypes.ts L62-L113](../../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#L62). The key serialization lines for handoffs:

```ts
lines.push('handoffs:');
for (const handoff of config.handoffs) {
    lines.push(`  - label: ${handoff.label}`);
    lines.push(`    agent: ${handoff.agent}`);
    lines.push(`    prompt: '${handoff.prompt}'`);
    if (handoff.send !== undefined) lines.push(`    send: ${handoff.send}`);
    if (handoff.showContinueOn !== undefined) lines.push(`    showContinueOn: ${handoff.showContinueOn}`);
    if (handoff.model !== undefined) lines.push(`    model: ${handoff.model}`);
}
```

#### 2. Concrete Handoff Definitions with `agent: agent` and `send: true`

Two providers define handoffs with `agent: agent` + `send: true`:

**Plan Agent** — [planAgentProvider.ts L206-L222](../../../vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts#L206):
```ts
const startImplementationHandoff: AgentHandoff = {
    label: 'Start Implementation',
    agent: 'agent',
    prompt: 'Start implementation',
    send: true,
    ...(implementAgentModelOverride ? { model: implementAgentModelOverride } : {})
};

const openInEditorHandoff: AgentHandoff = {
    label: 'Open in Editor',
    agent: 'agent',
    prompt: '#createFile the plan as is into an untitled file...',
    showContinueOn: false,
    send: true
};
```

**Edit Mode Agent** — [editModeAgentProvider.ts L23-L29](../../../vscode-copilot-chat/src/extension/agents/vscode-node/editModeAgentProvider.ts#L23):
```ts
handoffs: [{
    label: 'Continue with Agent Mode',
    agent: 'agent',
    prompt: 'You are now switching to Agent Mode...',
    send: true,
}]
```

#### 3. YAML Parsing: `IHandOff` on the Core Side

The handoff YAML is parsed by `PromptHeader.handOffs` getter in [promptFileParser.ts L235-L289](../../../vscode-copilot-chat/src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L235):

```ts
public get handOffs(): IHandOff[] | undefined {
    // Parses array of {agent, label, prompt, send?, showContinueOn?, model?}
}
```

The `IHandOff` interface at [promptFileParser.ts L342-L350](../../../vscode-copilot-chat/src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L342):
```ts
export interface IHandOff {
    readonly agent: string;
    readonly label: string;
    readonly prompt: string;
    readonly send?: boolean;
    readonly showContinueOn?: boolean;
    readonly model?: string;
}
```

#### 4. What "agent: agent" Resolves To

The string `"agent"` in the handoff does NOT reference a well-known constant directly in the extension. Instead, **VS Code core** maps this string to a chat mode/participant. Here's the relationship:

- `editsAgentName = 'editsAgent'` is the internal name for Agent Mode, registered at [chatParticipants.ts L141-L148](../../../vscode-copilot-chat/src/extension/conversation/vscode-node/chatParticipants.ts#L141):
  ```ts
  private registerEditsAgent(): IDisposable {
      const editingAgent = this.createAgent(editsAgentName, Intent.Agent);
      editingAgent.iconPath = new vscode.ThemeIcon('tools');
      // ...
  }
  ```
- Participant ID becomes `github.copilot.editsAgent` via `getChatParticipantIdFromName()` at [chatAgents.ts L28-L29](../../../vscode-copilot-chat/src/platform/chat/common/chatAgents.ts#L28).
- The string `"agent"` in the handoff YAML is a **VS Code core-level mode alias** — core maps it to the Agent Mode participant. This mapping is NOT in the extension code; it is handled inside `microsoft/vscode` core when the handoff button is rendered and clicked.

#### 5. The Click Flow (Extension ↔ Core Boundary)

The click handling is **entirely in VS Code core**, not the extension. Here's the flow:

1. **Extension emits handoff metadata**: `.agent.md` files with `handoffs:` YAML frontmatter are provided via `ChatCustomAgentProvider.provideCustomAgents()`.
2. **Core parses**: `PromptHeader.handOffs` extracts `IHandOff[]` from YAML.
3. **Core renders buttons**: Based on the parsed handoffs, core renders clickable buttons in the chat UI with the `label` text.
4. **User clicks**: Core handles the click:
   - Sets the **target agent/mode** based on `handoff.agent` (e.g., `"agent"` → Agent Mode).
   - Fills the chat input with `handoff.prompt`.
   - If `send: true`, **auto-submits** the prompt to the target agent.
   - If `send: false` or undefined, simply populates the input and switches mode, letting the user submit manually.
   - If `model` is specified, overrides the model for the new request.
5. **Extension receives request**: The target participant handler (e.g., `editsAgent` handler) receives the request as a normal `ChatRequest`. It does NOT know it came from a handoff.

#### 6. The `nextQuestion` Mechanism (Distinct from Handoffs)

`nextQuestion` in `ChatResult` at [chatParticipantAdditions.d.ts L850-L854](../../../vscode-copilot-chat/src/extension/vscode.proposed.chatParticipantAdditions.d.ts#L850) is a **different mechanism** for participant re-routing:

```ts
nextQuestion?: {
    prompt: string;
    participant?: string;
    command?: string;
};
```

Used in [remoteAgents.ts L497](../../../vscode-copilot-chat/src/extension/conversation/vscode-node/remoteAgents.ts#L497) for re-sending after authorization. This is NOT the handoff button mechanism — it's for programmatic re-routing within a single turn.

#### 7. Telemetry: `participantIdToModeName`

For telemetry, [intents.ts L11-L30](../../../vscode-copilot-chat/src/extension/intents/common/intents.ts#L11) maps participant IDs to mode names:

```ts
export function participantIdToModeName(participantId: string): string {
    const name = getChatParticipantNameFromId(participantId);
    switch (name) {
        case editsAgentName: return 'agent';  // "editsAgent" → "agent"
        case editingSessionAgentName: return 'edit';
        case defaultAgentName:
        case vscodeAgentName: return 'ask';
        // ...
    }
}
```

This confirms the mapping: `editsAgentName` ("editsAgent") corresponds to "agent" mode in telemetry, which is the same string used in `handoff.agent: agent`.

#### 8. ExitPlanMode (Claude Agent SDK Path)

For the Claude Agent SDK integration, there's a distinct `ExitPlanMode` tool at [exitPlanModeHandler.ts](../../../vscode-copilot-chat/src/extension/chatSessions/claude/common/toolPermissionHandlers/exitPlanModeHandler.ts) that shows a confirmation dialog before transitioning from plan mode. This is parallel to but distinct from the YAML handoff mechanism — it handles Claude's tool-based plan-to-agent transition.

### Patterns

1. **Declarative handoff definition**: Handoffs are declared in YAML frontmatter as data, not code. The extension serializes `AgentHandoff → YAML`, and core deserializes `YAML → IHandOff → UI button`. Zero extension-side click handling logic.

2. **Extension/Core boundary for UI actions**: The extension defines *what* transitions are possible (handoff metadata) and core handles *how* they're executed (button rendering, mode switching, prompt auto-submission). This is a clean separation of concerns.

3. **Mode ≈ Participant aliasing**: "agent" in handoff YAML maps to `editsAgentName` ("editsAgent") participant, which is the Agent Mode. The string "agent" is a well-known alias at the VS Code core level.

4. **`send: true` = auto-submit**: When a handoff has `send: true`, the clicked button both switches the chat mode AND auto-sends the prompt. Without `send: true`, it only populates the input box and switches mode.

5. **Dynamic handoff generation**: `PlanAgentProvider.buildCustomizedConfig()` generates handoffs dynamically based on settings (`ImplementAgentModel`), allowing model overrides per-handoff.

6. **`showContinueOn: false`**: Controls whether the "Continue On" UI is shown (used by "Open in Editor" handoff to suppress it).

### Applicability

**HIGH** — This research is directly applicable for understanding how to add custom handoff buttons in `.agent.md` files and how mode transitions work. The `agent: agent` + `send: true` pattern is the canonical way to transition from a custom agent (Plan, Edit Mode) to Agent Mode with auto-execution. Any Ralph Loop orchestration that needs to trigger mode switches should follow this declarative pattern.

### Open Questions

1. **Where exactly does VS Code core map `"agent"` → `editsAgent` participant?** The mapping lives in `microsoft/vscode` repository, not this extension. The extension only knows the output side (receives requests as `editsAgent`).

2. **What happens to conversation history during a handoff?** When `send: true` fires, does the new agent receive the full conversation context from the previous agent, or does it start fresh?

3. **Can custom handoffs target non-built-in participants?** The `agent` field accepts strings like `"agent"`, `"edit"`, etc. — can it target user-defined `.agent.md` agents by name?

4. **Race condition with settings changes**: The code at [planAgentProvider.ts L60](../../../vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts#L60) notes: "handoff buttons already rendered may not work as these capture the model at render time." This suggests handoff buttons are snapshots — what happens if the model changes between render and click?
