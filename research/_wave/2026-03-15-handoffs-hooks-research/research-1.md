## Research Report 1: IHandOff Interface and `send:true` Parser Behavior

### Findings

#### 1. `IHandOff` Interface Definition

**File:** `src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts` (line 342–348)

```typescript
export interface IHandOff {
	readonly agent: string;
	readonly label: string;
	readonly prompt: string;
	readonly send?: boolean;
	readonly showContinueOn?: boolean; // treated exactly like send (optional boolean)
	readonly model?: string; // qualified model name to switch to (e.g., "GPT-5 (copilot)")
}
```

**Required fields:** `agent`, `label`, `prompt` — all three must be present for a handoff to be valid (see validation at line 266).
**Optional fields:** `send`, `showContinueOn`, `model` — only included in the parsed object when explicitly set in YAML.

#### 2. YAML Header Attribute Registration

**File:** `src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts` (line 74)

```typescript
export const handOffs = 'handoffs';
```

The `handoffs` key is a first-class YAML frontmatter attribute alongside `name`, `description`, `tools`, `model`, etc.

#### 3. Parser-Level Parsing Logic

**File:** `src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts` (lines 235–280)

The `handOffs` getter on the `PromptFileParser` class does the following:

1. Looks up the `handoffs` attribute in the parsed YAML header
2. Requires it to be of type `'array'` — returns `undefined` otherwise
3. Iterates each array item, expecting `'object'` type items
4. For each object, extracts properties by key name:
   - `'agent'` → string
   - `'label'` → string
   - `'prompt'` → string
   - `'send'` → boolean (strict type check: `prop.value.type === 'boolean'`)
   - `'showContinueOn'` → boolean
   - `'model'` → string
5. **Validation gate:** Only constructs an `IHandOff` if `agent && label && prompt !== undefined` — i.e., all three required fields present
6. Optional fields are spread-merged conditionally:
   ```typescript
   ...(send !== undefined ? { send } : {}),
   ...(showContinueOn !== undefined ? { showContinueOn } : {}),
   ...(model !== undefined ? { model } : {})
   ```

**Key detail:** The parser does NOT default `send` to any value. If omitted from YAML, it is absent from the parsed object entirely.

#### 4. What `send: true` Means at the Consumer Level

The parser itself is **purely structural** — it extracts and validates the YAML into typed objects. The `send` field has **no parser-level side effects**. Its semantics are defined downstream.

**Consumer 1: `AgentHandoff` type and YAML serialization** — `src/extension/agents/vscode-node/agentTypes.ts` (lines 10–17)

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

This mirrors `IHandOff` exactly. The `buildAgentMarkdown()` function at line 96–113 serializes it back to YAML frontmatter, conditionally including `send:` and `showContinueOn:` only when defined.

**Consumer 2: Plan Agent — `send: true` means auto-send on button click** — `src/extension/agents/vscode-node/planAgentProvider.ts` (lines 205–221)

```typescript
const startImplementationHandoff: AgentHandoff = {
	label: 'Start Implementation',
	agent: 'agent',
	prompt: 'Start implementation',
	send: true,  // ← clicking the button immediately sends the prompt
};

const openInEditorHandoff: AgentHandoff = {
	label: 'Open in Editor',
	agent: 'agent',
	prompt: '#createFile the plan as is...',
	showContinueOn: false,
	send: true  // ← also auto-sends
};
```

**Consumer 3: Edit Mode Agent — `send: true` for mode transition** — `src/extension/agents/vscode-node/editModeAgentProvider.ts` (lines 25–30)

```typescript
handoffs: [
	{
		label: 'Continue with Agent Mode',
		agent: 'agent',
		prompt: 'You are now switching to Agent Mode...',
		send: true,  // ← auto-sends on click
	},
],
```

**Semantic meaning of `send: true`:** When a handoff button is rendered in the chat UI, `send: true` causes the handoff prompt to be **automatically submitted** to the target agent when the user clicks the button. Without `send: true` (or with `send: false`), the prompt text is placed in the chat input for the user to review/edit before sending.

**`showContinueOn: false`:** Per the inline comment in the interface, this is "treated exactly like send (optional boolean)". It controls whether the handoff button appears as a "Continue on..." suggestion. Setting it to `false` suppresses the continue-on affordance.

#### 5. Schema Documentation for Custom Agents

**File:** `src/extension/promptFileContext/vscode-node/promptFileContextService.ts` (line 184)

The handoffs schema is documented as:
> `handoffs` is optional and is a sequence of mappings with `label`, `agent`, `prompt`, `send`, and `model` properties

The example always shows `send: true`, indicating it is the expected default for handoff buttons that should act immediately.

### Patterns

| Pattern | Description |
|---------|-------------|
| **Mirror interfaces** | `IHandOff` (parser output) and `AgentHandoff` (agent config input) are structurally identical but defined separately, maintaining layer separation |
| **Conditional spread** | Optional fields use `...(x !== undefined ? { x } : {})` instead of `x ?? undefined`, keeping the parsed object clean |
| **Round-trip serialization** | `promptFileParser.ts` parses YAML→objects; `agentTypes.ts` serializes objects→YAML. Both handle `send` identically |
| **No defaults** | The parser never defaults optional booleans — consumers decide behavior when the field is absent |
| **Strict type checking** | Each property is validated by both key name AND value type (e.g., `prop.value.type === 'boolean'`) — malformed values silently ignored |
| **Three-field validation gate** | `agent && label && prompt !== undefined` — missing any required field silently drops the entire handoff entry |

### Applicability

**HIGH** — This is directly relevant to understanding how custom `.agent.md` handoffs work and how to configure them for ralph-loop's wave orchestration. The `send: true` flag is the critical difference between a "type into input box" handoff and an "execute immediately" handoff, which is essential for automated agent-to-agent transitions.

### Open Questions

1. **VS Code core handling:** The ultimate consumer of `send` is the VS Code chat widget (in `microsoft/vscode` repo, not this extension). The extension writes `send: true` into `.agent.md` frontmatter, and VS Code's prompt file parser reads it back via `IHandOff`. The exact VS Code core code that reads `send` and decides whether to auto-submit vs. pre-fill the input is in the vscode repo, not inspectable here.

2. **`showContinueOn` vs `send` distinction:** The comment says `showContinueOn` is "treated exactly like send (optional boolean)" but their names suggest different UX affordances. The Plan Agent uses them on different handoffs (`send: true` alone for "Start Implementation", both `showContinueOn: false` + `send: true` for "Open in Editor"). The exact rendering difference is unclear from this codebase alone.

3. **Default when `send` is omitted:** No code in this repo defaults `send`. The effective default behavior (pre-fill input vs. auto-send) is determined by VS Code core. Based on usage patterns, omitting `send` likely means "pre-fill but don't auto-send."

4. **Silent validation failures:** If a handoff YAML entry is missing `agent`, `label`, or `prompt`, it is silently dropped with no error or warning. This could cause confusing behavior for custom agent authors.
