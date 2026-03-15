## Research Report 2: Handoff Button Rendering Position

### Findings

#### 1. Handoff Interface Definition

Handoffs are defined at two levels with identical shape:

**Extension-side** ([agentTypes.ts](../../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts) L9-16):
```typescript
export interface AgentHandoff {
	readonly label: string;
	readonly agent: string;
	readonly prompt: string;
	readonly send?: boolean;
	readonly showContinueOn?: boolean;
	readonly model?: string;
}
```

**VS Code core parser** ([promptFileParser.ts](../../../vscode-copilot-chat/src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts) L342-349):
```typescript
export interface IHandOff {
	readonly agent: string;
	readonly label: string;
	readonly prompt: string;
	readonly send?: boolean;
	readonly showContinueOn?: boolean; // treated exactly like send (optional boolean)
	readonly model?: string;
}
```

#### 2. How Handoffs Reach the UI

The flow is entirely **declarative via YAML frontmatter**:

1. Extension creates `AgentConfig` with handoffs array (e.g., `planAgentProvider.ts` L206-237)
2. `buildAgentMarkdown()` serializes to YAML frontmatter in `.agent.md` content (`agentTypes.ts` L96-112)
3. Written to cache file and returned via `provideCustomAgents()` as a `ChatResource` URI
4. **VS Code core** reads the `.agent.md`, parses frontmatter via `PromptHeader.handOffs` getter (`promptFileParser.ts` L235-280)
5. VS Code core renders the buttons — **rendering logic is NOT in this extension**

#### 3. Properties That Control Button Behavior

| Property | Effect | Used By |
|----------|--------|---------|
| `send: true` | Auto-sends the handoff prompt when clicked (no user editing) | Plan → "Start Implementation", Edit → "Continue with Agent Mode" |
| `send: false` / omitted | Populates the chat input for the user to review before sending | (default) |
| `showContinueOn: false` | Suppresses the "Continue On" display context | Plan → "Open in Editor" |
| `showContinueOn: true` / omitted | Shows button in "Continue On" section | (default) |
| `model` | Overrides the target agent's model | Plan → "Start Implementation" (when `ImplementAgentModel` setting is set) |

#### 4. Position Control: START vs END of Response

**There is NO explicit position parameter** in the handoff interface. The extension does not control where buttons render — that is hardcoded in VS Code core.

Key evidence:
- `IHandOff` and `AgentHandoff` have no `position`, `placement`, `location`, or similar property
- No code in the extension sets button position — grep for `position.*handoff`, `handoff.*start`, `handoff.*end`, `afterResponse`, `beforeResponse` returned zero matches in extension code
- The extension only provides metadata; VS Code core decides placement

**Handoff buttons are rendered at the END of the response** as follow-up action buttons, alongside standard VS Code `ChatFollowup` items. This is confirmed by the Plan agent's workflow comment at `planAgentProvider.ts` L162:
```
- Approval given → acknowledge, the user can now use handoff buttons
```
This implies buttons appear after the response completes, not at the start.

#### 5. Concrete Handoff Configurations in the Codebase

**Plan Agent** (`planAgentProvider.ts` L206-237) — 2 handoffs, built dynamically:
```typescript
// "Start Implementation" - sends immediately, optional model override
{ label: 'Start Implementation', agent: 'agent', prompt: 'Start implementation', send: true, model?: implementAgentModelOverride }

// "Open in Editor" - sends immediately, no continue-on
{ label: 'Open in Editor', agent: 'agent', prompt: '#createFile the plan...', showContinueOn: false, send: true }
```

**Edit Mode Agent** (`editModeAgentProvider.ts` L23-29) — 1 handoff, static:
```typescript
{ label: 'Continue with Agent Mode', agent: 'agent', prompt: 'You are now switching to Agent Mode...', send: true }
```

**Ask Agent** — Confirmed to have **no handoffs** (`askAgentProvider.spec.ts` L249: `'does not include handoffs section'`).

#### 6. Settings Change and Button Invalidation

`planAgentProvider.ts` L58-61 contains a critical note:
```
// Note: When settings change, we fire onDidChangeCustomAgents which causes VS Code to re-fetch
// the agent definition. However, handoff buttons already rendered may not work as
// these capture the model at render time.
```

This confirms handoff buttons are **rendered once** at response time and are **not dynamically updated** if settings change afterward.

### Patterns

1. **Declarative-only rendering**: Extension provides data, VS Code core handles all rendering. No imperative button creation for handoffs (unlike `ChatResponseCommandButtonPart` used for other buttons).
2. **Dynamic construction**: Plan agent builds handoffs at `provideCustomAgents()` time based on current settings, allowing runtime customization.
3. **Separation of concerns**: Handoff metadata (what) is cleanly separated from rendering (how/where) — the extension cannot influence position.
4. **`showContinueOn` as display hint**: Not a position control but a visibility flag for a specific "Continue On" context in the VS Code UI.
5. **All handoffs use `send: true`**: Every concrete handoff in this codebase auto-sends. No handoff uses the "populate input box" mode.

### Applicability

**HIGH** — This is directly relevant for understanding how to add custom handoff buttons to custom agents. The pattern is clear:
- Define handoffs in `AgentConfig.handoffs[]`
- The extension has no control over START vs END positioning — buttons always appear at the END
- To influence button location, changes would need to happen in VS Code core (microsoft/vscode), not in this extension

### Open Questions

1. **Where exactly does VS Code core render handoff buttons?** The rendering code lives in the microsoft/vscode repo (not in this extension's `src/util/vs/` copy). The specific renderer likely lives in `workbench/contrib/chat/browser/` in the VS Code repo.
2. **Can `ChatResponseCommandButtonPart` be used inline for handoff-like buttons at the START of a response?** The extension uses `stream.button()` for other purposes (e.g., `newIntent.ts` L560, `claudeChatSessionContentProvider.ts` L230) — could a similar approach create handoff-equivalent buttons at arbitrary positions?
3. **What does `showContinueOn` actually control in the VS Code core UI?** The comment says "treated exactly like send" but it's a separate property — the precise rendering difference is unclear without reading VS Code core.
4. **Are there plans for a `position` property in future `IHandOff` versions?** The proposed API (`vscode.proposed.chatPromptFiles.d.ts`) doesn't expose handoff rendering details.
