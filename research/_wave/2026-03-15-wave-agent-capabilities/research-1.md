# Research 1: Agent Frontmatter Schema

## Findings

All `.agent.md` (and `.prompt.md`, `.instructions.md`) files share a single YAML frontmatter parser: `PromptFileParser` copied from `microsoft/vscode` core.

### Source Files

- **Parser**: `src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts` — `PromptFileParser`, `PromptHeader`, `PromptHeaderAttributes` namespace
- **AgentConfig interface**: `src/extension/agents/vscode-node/agentTypes.ts` — `AgentConfig`, `AgentHandoff`, `buildAgentMarkdown()`
- **GitHub org agents**: `src/extension/agents/vscode-node/githubOrgCustomAgentProvider.ts` — `generateAgentMarkdown()`, `CustomAgentDetails`
- **CustomAgentDetails type**: `src/platform/github/common/githubService.ts:140-175`

### Canonical Frontmatter Properties

From `PromptHeaderAttributes` namespace (promptFileParser.ts:66-87):

| Property | YAML Key | Type | Purpose |
|---|---|---|---|
| `name` | `name` | `string` | Display name of the agent |
| `description` | `description` | `string` | Short description shown in agent picker |
| `agent` | `agent` | `string` | Which agent/mode to route to (alias: `mode`) |
| `mode` | `mode` | `string` | Alias for `agent` — fallback if `agent` absent |
| `model` | `model` | `string \| string[]` | LM model(s) to use; array = priority list |
| `applyTo` | `applyTo` | `string` | Glob pattern for files this applies to (instructions files) |
| `tools` | `tools` | `string[]` or `object` (nested booleans) | Tool allowlist; array of tool IDs or object with boolean leaves |
| `handoffs` | `handoffs` | `array<IHandOff>` | Agent-to-agent transition configs |
| `advancedOptions` | `advancedOptions` | (declared but no typed getter) | Reserved — defined in namespace but no accessor on `PromptHeader` |
| `argument-hint` | `argument-hint` | `string` | Placeholder text for agent input box |
| `excludeAgent` | `excludeAgent` | (declared but no typed getter) | Reserved — defined in namespace but no accessor |
| `target` | `target` | `string` (`'vscode'` or `'github-copilot'`) | Which platform this agent targets |
| `infer` | `infer` | `boolean` | Whether to enable inference/auto-detection |
| `license` | `license` | (declared but no typed getter) | Reserved — in namespace, no accessor |
| `compatibility` | `compatibility` | (declared but no typed getter) | Reserved — in namespace, no accessor |
| `metadata` | `metadata` | (declared but no typed getter) | Reserved — in namespace, no accessor |
| `agents` | `agents` | `string[]` | Subagent allowlist — which agents this agent can delegate to |
| `user-invokable` | `user-invokable` | `boolean` | Whether users can directly invoke this agent (default: true) |
| `disable-model-invocation` | `disable-model-invocation` | `boolean` | If true, agent doesn't make its own LM calls |

From `GithubPromptHeaderAttributes` namespace (promptFileParser.ts:88-90):

| Property | YAML Key | Type | Purpose |
|---|---|---|---|
| `mcp-servers` | `mcp-servers` | `object` | MCP server definitions — `{serverName: {type, command?, args?, tools?, env?, headers?}}` |

### Handoff Sub-Schema (`IHandOff`)

From promptFileParser.ts:347-353:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `agent` | `string` | Yes | Target agent name |
| `label` | `string` | Yes | Button label shown to user |
| `prompt` | `string` | Yes | Prompt text sent to target agent |
| `send` | `boolean` | No | Whether to auto-send (vs. pre-fill) |
| `showContinueOn` | `boolean` | No | Show "Continue on" UI affordance |
| `model` | `string` | No | Override model for the target agent |

### AgentConfig Interface (agentTypes.ts:23-37)

Used by built-in agents (Plan, Ask, Explore) to programmatically build `.agent.md` content:

```typescript
interface AgentConfig {
  name: string;
  description: string;
  argumentHint: string;
  tools: string[];
  model?: string | readonly string[];
  target?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  agents?: string[];
  handoffs?: AgentHandoff[];
  body: string;
}
```

### CustomAgentDetails (githubService.ts:140-163)

Server-side schema for GitHub org/repo agents:

```typescript
interface CustomAgentDetails {
  display_name: string;
  description: string;
  tools: string[];
  argument_hint?: string;
  metadata?: Record<string, string>;
  target?: string;
  model?: string;
  disable_model_invocation?: boolean;
  user_invocable?: boolean;
  'mcp-servers'?: { [serverName: string]: { type, command?, args?, tools?, env?, headers? } };
}
```

## Patterns

### Parsing Flow

1. `PromptFileParser.parse(uri, content)` splits content into YAML header (between `---` delimiters) and markdown body
2. Header YAML is parsed using a custom lightweight YAML parser (`src/util/vs/.../yaml.ts`) — **not** a full YAML spec parser (no multi-line block scalars)
3. Each YAML key-value pair becomes an `IHeaderAttribute` with typed `IValue` (string, number, boolean, null, array, object)
4. Named getters on `PromptHeader` provide typed access: `.name`, `.description`, `.tools`, `.model`, `.handOffs`, `.agents`, `.userInvokable`, `.disableModelInvocation`, `.infer`, `.target`, `.argumentHint`, `.applyTo`, `.agent`
5. Generic `getAttribute(key)` allows access to any attribute (including reserved ones like `advancedOptions`, `license`, `compatibility`, `metadata`)

### Tools Format Flexibility

The `tools` property accepts two formats:
- **Array format**: `tools: ['search', 'read', 'web']`
- **Object format**: `tools: { search: true, github: { issue_read: true } }` — nested booleans, leaf keys collected

### Model Priority Lists

`model` can be a single string or array. When array, it represents a priority list (first available model wins):
```yaml
model: ['Claude Opus 4 (copilot)', 'GPT-4o (copilot)']
```

### Note on Naming Inconsistency

The `PromptHeaderAttributes` namespace uses `userInvokable` (with 'k'), while `AgentConfig` uses `userInvocable` (with 'c'). The YAML key is `user-invokable`. The `githubOrgCustomAgentProvider` writes it as `user-invocable` (with 'c'). Both forms likely work due to the generic `getAttribute()` fallback in VS Code core.

## Applicability

- **Custom agents**: Use `name`, `description`, `tools`, `model`, `agents`, `handoffs`, `user-invokable` to define agent capabilities
- **Agent routing**: `agent`/`mode` field routes prompt files to specific agent implementations
- **Tool restriction**: `tools` array acts as an allowlist — agents can only use listed tools
- **Subagent restriction**: `agents` array restricts which subagents this agent can invoke
- **Handoffs**: Enable structured agent-to-agent workflows with labeled transitions
- **MCP integration**: `mcp-servers` allows agents to bring their own MCP server definitions

## Open Questions

1. **`advancedOptions`, `license`, `compatibility`, `metadata`, `excludeAgent`**: Declared in `PromptHeaderAttributes` namespace but have no typed getters on `PromptHeader`. Likely consumed by VS Code core (not the copilot-chat extension). Their exact semantics need VS Code core source investigation.
2. **`hooks`**: Not present in the parser at all. The `hooks` concept in ralph-loop and Claude Code is separate from VS Code's agent.md schema.
3. **Validation**: The parser does not validate property names — any YAML key is accepted and stored as an `IHeaderAttribute`. Unknown keys are silently ignored by the typed getters.
4. **`user-invokable` vs `user-invocable`**: Spelling inconsistency between parser namespace and agent config interface. Unclear which spelling VS Code core actually matches on.
