# Q3: VS Code Handoff Mechanism Internals

## Findings

### 1. Frontmatter Schema (`IHandOff` / `AgentHandoff`)

Handoffs are defined in `.agent.md` YAML frontmatter under the `handoffs:` key. Two mirror interfaces exist:

**Parser-level** (`src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts`):
```typescript
interface IHandOff {
  readonly agent: string;        // target agent/mode ID (e.g., "agent")
  readonly label: string;        // button text shown to user
  readonly prompt: string;       // message injected when handoff fires
  readonly send?: boolean;       // auto-send the prompt (default: user clicks)
  readonly showContinueOn?: boolean; // show "Continue on" affordance
  readonly model?: string;       // qualified model override (e.g., "GPT-5 (copilot)")
}
```

**Agent-config level** (`src/extension/agents/vscode-node/agentTypes.ts`):
```typescript
interface AgentHandoff {
  readonly label: string;
  readonly agent: string;
  readonly prompt: string;
  readonly send?: boolean;
  readonly showContinueOn?: boolean;
  readonly model?: string;
}
```

Required fields: `agent`, `label`, `prompt`. All others optional.

### 2. Frontmatter Parsing

In `promptFileParser.ts`, the `PromptHeader` class has a `handOffs` getter that:
1. Finds the `handoffs` attribute in parsed YAML header
2. Expects an **array of objects**, each with string/boolean properties
3. Iterates each object's properties, extracting `agent`, `label`, `prompt`, `send`, `showContinueOn`, `model` by key name and type
4. Only pushes valid entries where `agent && label && prompt !== undefined`
5. Returns `IHandOff[]` or `undefined`

The `handoffs` attribute is registered in `PromptHeaderAttributes` namespace alongside `name`, `description`, `tools`, `model`, etc.

### 3. Agent-Side Generation (`buildAgentMarkdown`)

The `buildAgentMarkdown(config: AgentConfig)` function in `agentTypes.ts` serializes handoffs into YAML block style:
```yaml
handoffs:
  - label: Start Implementation
    agent: agent
    prompt: 'Start implementation'
    send: true
    model: claude-sonnet-4-20250514
```

Single quotes in prompts are escaped by doubling (`''`). Optional fields (`send`, `showContinueOn`, `model`) are only emitted when defined.

### 4. Concrete Handoff Examples

**PlanAgentProvider** (`planAgentProvider.ts`) builds two dynamic handoffs:
- **"Start Implementation"** → switches to `agent` mode with `send: true` and optional model override from `ImplementAgentModel` config
- **"Open in Editor"** → switches to `agent` mode, creates an untitled prompt file, `showContinueOn: false`, `send: true`

**EditModeAgentProvider** (`editModeAgentProvider.ts`) defines one static handoff:
- **"Continue with Agent Mode"** → switches to `agent` with `send: true`, injecting a prompt about expanded permissions

### 5. SwitchAgentTool

`SwitchAgentTool` (`src/extension/tools/vscode-node/switchAgentTool.ts`) is a **programmatic** agent-switching mechanism (distinct from handoff buttons):
- Tool name: `switch_agent` / `copilot_switchAgent`
- Only supports switching to `"Plan"` agent currently
- Calls `vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', { modeId, sessionResource })`
- Returns the Plan agent body as text so the model adopts the new persona
- Feature-gated: `chat.switchAgent.enabled` (experiment-based, default `false`)

### 6. UI Rendering

Handoff buttons are **rendered by VS Code core**, not this extension. The flow:
1. Extension provides `.agent.md` files via `ChatCustomAgentProvider.provideCustomAgents()`
2. Core parses the file using `PromptHeader.handOffs` getter (shared parser in `src/util/vs/`)
3. Core renders handoff entries as **clickable buttons** after the agent's chat response
4. Clicking a button: switches the chat mode to `handoff.agent`, injects `handoff.prompt`, optionally auto-sends if `send: true`, and may override the model

The PlanAgentProvider notes a limitation: "handoff buttons already rendered may not work as these capture the model at render time" — meaning if settings change after rendering, stale buttons reference the old model.

### 7. Prompt File Context Integration

In `promptFileContextService.ts`, the `handOffs` attribute is listed among valid `.agent.md` frontmatter attributes for IntelliSense/completion purposes — confirming it's a first-class frontmatter attribute.

## Patterns

### Dual-Mode Agent Switching
1. **Declarative (handoffs)**: Defined in frontmatter, rendered as UI buttons by core. User-initiated, supports model override and auto-send. This is the primary user-facing mechanism.
2. **Programmatic (SwitchAgentTool)**: Model-invoked tool call. Currently only supports Plan agent. Feature-gated behind experiment flag.

### Context Transfer
- Handoff prompt strings carry instruction context for the target agent ("You are now switching to Agent Mode...")
- No explicit state/memory transfer — the conversation history provides continuity
- `SwitchAgentTool` injects the full agent body text so the model immediately adopts the new persona

### Generation Strategy
- Agent providers dynamically generate `.agent.md` content (including handoffs) based on user settings
- Content is written to extension cache directories and served as `ChatResource` URIs
- No runtime YAML parsing needed — the extension generates valid YAML strings directly

## Applicability

1. **Agent composition**: Handoffs enable a pipeline pattern (Plan → Agent, Edit → Agent) where specialized agents delegate to general-purpose ones
2. **User control**: `send: false` (default) lets users review/edit the handoff prompt before sending; `send: true` enables one-click transitions
3. **Model routing**: The `model` field enables agent-specific model selection (e.g., use a fast model for planning, powerful model for implementation)
4. **Extension point**: Any `ChatCustomAgentProvider` can define handoffs, making this an extensible pattern for custom agent workflows

## Open Questions

1. **Core rendering details**: The button rendering, click handling, and mode-switching logic live in VS Code core (`microsoft/vscode`), not in this extension — full UI implementation requires core source inspection
2. **SwitchAgentTool scope**: Currently hardcoded to only support `"Plan"` — unclear if this will be generalized
3. **Stale button problem**: Settings changes invalidate rendered handoff buttons (model captured at render time) — no refresh mechanism documented
4. **showContinueOn semantics**: Comment says "treated exactly like send" but it's a separate field — likely controls a "Continue on [agent]" UI affordance vs. `send` which controls auto-submission
5. **Feature gate**: `SwitchAgentTool` gated behind `chat.switchAgent.enabled` (experiment, default false) — may not be available to all users
