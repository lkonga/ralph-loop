# Q3: VS Code Handoff Mechanism Internals

## Findings

### 1. Frontmatter Schema (`IHandOff` interface)

Handoffs are declared in `.agent.md` YAML frontmatter under the `handoffs:` key. The parser lives in `src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts`.

**Interface** (`IHandOff`):
```typescript
interface IHandOff {
  readonly agent: string;        // target agent/mode id (e.g., "agent")
  readonly label: string;        // button text (e.g., "Start Implementation")
  readonly prompt: string;       // text injected into the new agent's input
  readonly send?: boolean;       // if true, auto-submit the prompt immediately
  readonly showContinueOn?: boolean; // equivalent to send — optional boolean
  readonly model?: string;       // qualified model name to switch to (e.g., "GPT-5 (copilot)")
}
```

**Parsing**: `PromptHeader.handOffs` getter iterates `handoffsAttribute.value.items` (YAML array of objects), extracting `agent`, `label`, `prompt`, `send`, `showContinueOn`, and `model` properties. All three required fields (`agent`, `label`, `prompt`) must be present or the entry is silently skipped.

### 2. Programmatic Agent Config (`AgentConfig` / `AgentHandoff`)

The TypeScript-side mirror lives at `src/extension/agents/vscode-node/agentTypes.ts`:

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

`buildAgentMarkdown(config)` serializes `AgentConfig` (including `handoffs[]`) into valid `.agent.md` YAML frontmatter via string templates — no YAML library needed. Handoffs are emitted in block style with properly escaped single-quoted prompts.

### 3. Dynamic Handoff Generation (Plan Agent)

`PlanAgentProvider` (`src/extension/agents/vscode-node/planAgentProvider.ts`) generates handoffs dynamically at runtime:

- **"Start Implementation"** — hands off to `agent` mode with `send: true` (auto-submit). Optionally includes a `model` override from the `chat.implementAgent.model` setting.
- **"Open in Editor"** — hands off to `agent` mode with a prompt to create an untitled `plan-*.prompt.md` file, with `showContinueOn: false` and `send: true`.

These are rebuilt each time `provideCustomAgents()` is called, responding to setting changes (`PlanAgentAdditionalTools`, `PlanAgentModel`, `ImplementAgentModel`).

### 4. Edit Mode Handoff

`EditModeAgentProvider` (`src/extension/agents/vscode-node/editModeAgentProvider.ts`) has a static handoff:

```yaml
handoffs:
  - label: Continue with Agent Mode
    agent: agent
    prompt: 'You are now switching to Agent Mode...'
    send: true
```

This lets users escape Edit Mode's file-allowlist restrictions into full Agent Mode.

### 5. SwitchAgentTool (Programmatic Handoff)

`SwitchAgentTool` (`src/extension/tools/vscode-node/switchAgentTool.ts`) enables **model-initiated** agent switching:

- **Tool names**: `switch_agent` (internal) / `copilot_switchAgent` (contributed)
- **Parameters**: `{ agentName: string }` — currently **only "Plan" is supported**
- **Mechanism**: Calls `vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', { modeId, sessionResource })`
- **Session behavior**: Passes `sessionResource` from the tool invocation options, meaning the switch happens **in the same chat session/pane** (not a new window)
- **Response**: Returns the full Plan agent body as context so the model can immediately adopt the Plan persona
- **Feature gate**: Behind `chat.switchAgent.enabled` (experiment-based, default false)
- **Anthropic allowlist**: `switch_agent` is in the Anthropic core tool allowlist (`src/platform/networking/common/anthropic.ts`)

### 6. UI Rendering

Handoff buttons are rendered by VS Code core (not the extension). The extension provides the `IHandOff[]` data through the parsed `.agent.md` frontmatter. VS Code core reads the `handoffs:` metadata and renders them as clickable buttons in the chat response. Key behaviors:

- **`send: true`** → clicking the button auto-submits the prompt to the target agent
- **`send: false` / omitted** → the prompt is placed in the input box for user review before sending
- **`model` override** → the target agent launches with the specified model instead of the default
- **Button staleness**: The comment in `planAgentProvider.ts` warns that "handoff buttons already rendered may not work as these capture the model at render time" — meaning settings changes after render don't update existing buttons

### 7. Session Behavior

- Handoffs via `SwitchAgentTool` use `workbench.action.chat.toggleAgentMode` with the **same `sessionResource`**, so the switch happens **in the same pane** — the conversation continues rather than opening a new session.
- There is **no explicit return-to-previous mechanism** in the codebase. The switch is one-directional: Plan → Agent, Edit → Agent. There's no "back" button or stack.
- The Plan agent's body says "the user can now use handoff buttons" after approval — suggesting handoffs are presented as rendered buttons the user clicks, not automatic transitions.

### 8. Subagent Restrictions

- Plan agent sets `agents: ['Explore']` — it can only dispatch Explore subagents
- Edit agent sets `agents: []` — no subagents allowed
- Ask agent sets `agents: []` — no subagents allowed
- The `switch_agent` tool is distinct from subagents — it changes the active mode entirely rather than spawning a child agent

## Patterns

### Dual-Mode Architecture (UI + Programmatic)
1. **UI path**: `handoffs:` in frontmatter → VS Code core renders buttons → user clicks → mode switch with optional auto-submit
2. **Programmatic path**: Model calls `switch_agent` tool → `SwitchAgentTool.invoke()` → `toggleAgentMode` command → mode switch in same session

### Context Transfer
- Prompt-based: the `prompt` field carries instructions/context to the target agent
- Model-based: the `model` field allows switching the underlying LLM alongside the mode
- Session-based: `sessionResource` keeps the switch within the same conversation, preserving chat history

### Dynamic vs Static Configuration
- **Static**: Edit agent has hardcoded handoffs in its config object
- **Dynamic**: Plan agent rebuilds handoffs on each `provideCustomAgents()` call, incorporating user settings for model overrides

### No YAML Library Dependency
The entire handoff serialization uses string templates (`buildAgentMarkdown`). Parsing uses the existing `promptFileParser` YAML infrastructure. This keeps the extension lightweight.

## Applicability

### Wave/Ralph-Loop Integration Opportunities

1. **Wave orchestrator could use handoff-style transitions** between research phases (decompose → explore → aggregate) by defining each phase as a mode with `handoffs:` pointing to the next phase.

2. **The `send: true` pattern** is directly useful for automated workflows — when a phase completes, it can auto-submit to the next agent without user intervention.

3. **Model override per handoff** enables using different models for different phases (e.g., a fast model for exploration, a reasoning model for synthesis).

4. **The `showContinueOn` field** could control whether intermediate phase results are shown to the user or just passed through.

5. **Ralph-loop's extension** already tracks `activeChatPanelSessionResource` — it could use this to trigger `toggleAgentMode` programmatically, implementing wave phase transitions as mode switches.

## Open Questions

1. **Can handoffs return?** No — the current implementation is strictly one-directional. There's no back-stack or return mechanism. The user would need to manually switch back.

2. **Auto-submit behavior**: `send: true` auto-submits the prompt. Without it, the prompt lands in the input box for review. There's no middle ground (e.g., "confirm then send").

3. **SwitchAgentTool limitation**: Currently hardcoded to only support switching to "Plan" agent. Other agents must use UI handoff buttons.

4. **Button staleness**: Handoff buttons capture configuration at render time. If settings (like model override) change between render and click, the button uses stale values.

5. **Feature gate**: `chat.switchAgent.enabled` is experiment-based and defaults to `false` — the programmatic path may not be available to all users.

6. **Anthropic-specific**: The `switch_agent` tool is in the Anthropic core tool allowlist, suggesting it's part of the Claude agent SDK integration but may not be exposed to all model providers.
