# Research Report: Search Subagent Configuration Options

**Wave**: 2026-03-16-search-subagent-deep-analysis
**Report**: research-9
**Question**: What are all configuration options for search_subagent and what does each control?

---

## Findings

### 1. Configuration Definitions

All four settings are defined in `src/platform/configuration/common/configurationService.ts` (lines 718–724) under the `ConfigKey.Advanced` namespace using `defineSetting()` with `ConfigType.ExperimentBased`, meaning each setting supports both user-configured values (VS Code settings) and experiment-based overrides (A/B treatment variables).

| Setting Constant | VS Code Setting Key | Type | Default | Tags |
|---|---|---|---|---|
| `SearchSubagentToolEnabled` | `github.copilot.chat.searchSubagent.enabled` | `boolean` | `false` | `advanced`, `experimental`, `onExp` |
| `SearchSubagentUseAgenticProxy` | `github.copilot.chat.searchSubagent.useAgenticProxy` | `boolean` | `false` | `advanced` |
| `SearchSubagentModel` | `github.copilot.chat.searchSubagent.model` | `string` | `''` (empty) | `advanced`, `experimental`, `onExp` |
| `SearchSubagentToolCallLimit` | `github.copilot.chat.searchSubagent.toolCallLimit` | `number` | `4` | `advanced`, `experimental`, `onExp` |

### 2. What Each Setting Controls

#### `SearchSubagentToolEnabled` (boolean, default: false)

**Purpose**: Master feature gate for the search subagent tool.

**Consumed at**: `src/extension/intents/node/agentIntent.ts` line 106.

**Behavior**: When building the allowed-tools map for agent mode, this setting is read along with a model family check. The tool is only enabled if:
1. This setting is `true`, AND
2. The current model is a GPT or Anthropic family model (`isGptFamily(model) || isAnthropicFamily(model)`)

```ts
const searchSubagentEnabled = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.SearchSubagentToolEnabled, experimentationService);
const isGptOrAnthropic = isGptFamily(model) || isAnthropicFamily(model);
allowTools[ToolName.SearchSubagent] = isGptOrAnthropic && searchSubagentEnabled;
```

If disabled, the `search_subagent` tool is never offered to the model, and the model cannot invoke it.

#### `SearchSubagentUseAgenticProxy` (boolean, default: false)

**Purpose**: Controls whether the search subagent uses a dedicated server-side "agentic proxy" endpoint rather than making direct model calls.

**Consumed at**: `src/extension/prompt/node/searchSubagentToolCallingLoop.ts` line 81.

**Behavior**: When `true`, the subagent creates a `ProxyAgenticSearchEndpoint` instance (`src/platform/endpoint/node/proxyAgenticSearchEndpoint.ts`) instead of resolving a standard chat endpoint. The agentic proxy is a specialized server-side endpoint that handles the model+tools loop remotely, potentially with a purpose-built model.

The proxy endpoint creates a `ChatEndpoint` with hardcoded capabilities: 128K prompt tokens, 16K output tokens, `o200k` tokenizer, parallel tool calls support, streaming support.

When `false`, the subagent makes direct LLM API calls from the client, using either the model specified by `SearchSubagentModel` or falling back to the parent agent's model.

#### `SearchSubagentModel` (string, default: '' empty)

**Purpose**: Specifies which model the search subagent should use for its LLM calls.

**Consumed at**: `src/extension/prompt/node/searchSubagentToolCallingLoop.ts` line 80.

**Behavior**: Resolution logic in `getEndpoint()`:

1. **If `useAgenticProxy` is true**: The model name is used as the agentic proxy model identifier. If empty, defaults to `'agentic-search-v3'` (the `DEFAULT_AGENTIC_PROXY_MODEL` constant).
2. **If `useAgenticProxy` is false AND model name is non-empty**: Attempts to resolve the named model via `endpointProvider.getChatEndpoint(modelName)`. If that fails (model unavailable or doesn't support tool calls), falls back to the main agent's model with a logged warning.
3. **If `useAgenticProxy` is false AND model name is empty**: Uses the parent request's model (the main agent model), resolved via `endpointProvider.getChatEndpoint(this.options.request)`.

This allows experiments to test different models (e.g., smaller/faster/cheaper models) for the search subagent without changing the main agent model.

#### `SearchSubagentToolCallLimit` (number, default: 4)

**Purpose**: Caps the number of tool calls the search subagent can make in a single invocation.

**Consumed at**: Two locations:
- `src/extension/tools/node/searchSubagentTool.ts` line 69 — read when creating the `SearchSubagentToolCallingLoop` instance, passed as the `toolCallLimit` option.
- `src/extension/prompt/node/searchSubagentToolCallingLoop.ts` line 106 — read again in `buildPrompt()` and passed to the `SearchSubagentPrompt` renderer as `maxSearchTurns`.

**Behavior**: This value constrains how many iterative tool-calling rounds the subagent can perform. The subagent has access to 4 tools: `Codebase` (semantic search), `FindFiles`, `FindTextInFiles`, and `ReadFile`. Each invocation of any of these tools counts toward this limit. With the default of 4, the subagent can do at most 4 search/read operations before it must synthesize its findings and return.

The value flows into two places:
1. The `ToolCallingLoop` base class uses it to enforce a hard stop after N tool calls.
2. The prompt template receives it as `maxSearchTurns` to inform the model of its budget (so the model can plan its search strategy accordingly).

### 3. Configuration Resolution Chain

All four settings use `ConfigType.ExperimentBased`, which means the value is resolved via `getExperimentBasedConfig()` with the following priority cascade (first match wins):

1. **User-configured value** — Set explicitly in VS Code settings (user, workspace, or folder level)
2. **Experiment treatment variable** — Looked up under multiple key patterns:
   - `key.experimentName` (if defined — not used for these settings)
   - `copilotchat.config.{key.id}` (legacy pattern)
   - `config.{fullyQualifiedId}` (VS Code `onExp` tag pattern)
3. **Default value** — The hardcoded default from `defineSetting()`

The `onExp` tag in `package.json` enables VS Code's built-in experiment infrastructure to override these values server-side without client code changes.

### 4. Tool Registration & Available Tools

When the search subagent runs, it is restricted to exactly 4 tools (defined in `searchSubagentToolCallingLoop.ts` `getAvailableTools()`):

| Tool | Purpose |
|---|---|
| `Codebase` (semantic_search) | Semantic search across workspace |
| `FindFiles` | File glob pattern search |
| `FindTextInFiles` | Text/regex search in files |
| `ReadFile` | Read file contents |

This restricted toolset prevents the subagent from performing edits, running commands, or invoking nested subagents (the `Codebase` tool checks for `inSubAgent` context to prevent recursion).

### 5. JSON Schema Definition

The `package.json` schema (lines 4446–4488) defines the VS Code settings UI for these options. All four are under `github.copilot.chat.searchSubagent.*` with descriptions sourced from `package.nls.json` (lines 459–462). Three of the four carry both `experimental` and `onExp` tags; `useAgenticProxy` only has `advanced` (it's managed purely via experiment treatment, not surfaced as experimental in UI).

---

## Patterns

1. **Feature-gated experiment rollout**: The `enabled` setting is the master gate, while the other three settings fine-tune behavior once enabled. This follows the standard Copilot Chat pattern of experiment-gated features with progressive rollout.

2. **Dual-mode endpoint strategy**: The `useAgenticProxy` + `model` combination creates a 2×N matrix of possible configurations — proxy vs. direct, with N possible model choices. This allows comparing server-side agentic loop vs. client-side loop performance.

3. **Budget-constrained autonomy**: The `toolCallLimit` default of 4 is deliberately conservative, giving the subagent enough room for a focused search (e.g., 1 semantic search + 2 file reads + 1 grep) while preventing runaway token consumption.

4. **Redundant reading of `toolCallLimit`**: The setting is read in both `searchSubagentTool.ts` (to configure the loop) and again inside `searchSubagentToolCallingLoop.ts` (to configure the prompt). This double-read is benign but slightly redundant — the prompt renderer could receive the value from the loop options instead.

---

## Applicability

- **For Ralph**: Understanding the search subagent configuration is directly relevant for implementing similar configurable, budget-constrained subagent patterns. The `toolCallLimit` approach (informing the model of its budget via prompt AND enforcing it in the loop) is a best practice worth replicating.

- **For experimentation**: The `ExperimentBased` config type + `onExp` tag pattern enables server-side A/B testing of subagent parameters without shipping new code. Ralph could adopt a similar pattern for tuning subagent behavior.

- **For model selection**: The fallback chain (configured model → main agent model) with error handling provides graceful degradation when a preferred model is unavailable.

---

## Open Questions

1. **How does `maxSearchTurns` interact with the loop's `toolCallLimit`?** The prompt tells the model its budget, but is there a mismatch risk if the prompt value and loop enforcement value diverge? (Currently they're the same value, but the double-read pattern could lead to drift.)

2. **What is `agentic-search-v3`?** The default proxy model name suggests there are v1/v2 predecessors. What changed across versions, and is the proxy model a specialized fine-tuned model for code search, or just a routing identifier?

3. **Why is `useAgenticProxy` only tagged `advanced` (not `onExp`)?** This means it can't be overridden via the standard VS Code experiment infrastructure's `onExp` mechanism — it relies on the `copilotchat.config.*` or `config.*` fallback patterns instead. Is this intentional?

4. **Are there telemetry events that track subagent configuration values at invocation time?** This would allow correlating configuration choices with search quality outcomes.
