## Research Report 5: Online Documentation

**Date**: 2026-03-15
**Topic**: VS Code .prompt.md frontmatter properties and hidden/internal visibility

### Findings

#### 1. Official Prompt File Frontmatter Schema (Definitive)

**Source**: https://code.visualstudio.com/docs/copilot/customization/prompt-files (updated 2026-03-09)

The official `.prompt.md` frontmatter has exactly **6 documented fields**:

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Short description of the prompt |
| `name` | No | Name used after typing `/` in chat. Defaults to filename |
| `argument-hint` | No | Hint text shown in chat input field |
| `agent` | No | Agent for running: `ask`, `agent`, `plan`, or custom agent name. Default: current agent (or `agent` if tools specified) |
| `model` | No | Language model to use. Defaults to model picker selection |
| `tools` | No | List of tool/tool set names. Supports `<server>/*` for MCP servers |

**There is NO `hidden`, `internal`, `private`, `visibility`, or `exclude` property for prompt files.**

#### 2. Custom Agent (.agent.md) Visibility Controls — Key Comparison

**Source**: https://code.visualstudio.com/docs/copilot/customization/custom-agents (updated 2026-03-09)

Unlike prompts, `.agent.md` files **DO** have visibility controls:

| Field | Description |
|-------|-------------|
| `user-invocable` | Boolean (default `true`). Set to `false` to hide from agents dropdown — agent only accessible as subagent or programmatically |
| `disable-model-invocation` | Boolean (default `false`). Prevents agent from being invoked as a subagent by other agents |
| `infer` | **Deprecated**. Previously `infer: false` hid agent from both picker and subagent use. Replaced by independent `user-invocable` and `disable-model-invocation` fields |

This is the closest the VS Code customization system gets to "hidden" — but it only applies to agents, NOT prompt files.

#### 3. No Prompt-to-Prompt Chaining

The official docs confirm:
- Prompt files can reference an **agent** via the `agent` field
- Prompt files can reference **workspace files** via Markdown links
- Prompt files can reference **tools** via `#tool:<name>` syntax
- **There is NO mechanism for one prompt to invoke another prompt**

The only cross-invocation pattern is through agents: prompts → agents (via `agent` field), agents → subagents (via `agents` field + `agent` tool).

#### 4. Feature Requests for New Frontmatter Properties

**Source**: https://github.com/microsoft/vscode/issues/288838

- Request for `newChat: true` frontmatter to open prompts in fresh sessions
- Status: Moved to Backlog (accepted, 20+ upvotes)
- Shows the community wants MORE frontmatter properties, not that hidden ones exist

**Source**: https://github.com/microsoft/vscode-copilot-release/issues/12836

- Request for `model` specification in prompt files — this was subsequently implemented

**Source**: https://github.com/Microsoft/vscode-docs/issues/9119

- Confusion about tools notation (`#edit` vs `edit/edit_file`)
- Acknowledged as doc-bug, confirms the schema is still evolving

#### 5. Prompt File Locations & Scoping

Prompts can be stored in:
- **Workspace**: `.github/prompts` folder (shared with team via repo)
- **User profile**: `prompts` folder of current VS Code profile (personal, synced via Settings Sync)
- **Additional paths**: Configurable via `chat.promptFiles.locations` setting

There is a `chat.promptFilesRecommendations` setting to suggest prompts when starting new sessions (source: https://github.com/microsoft/vscode/issues/292579), but no way to **hide** prompts from the `/` command list.

#### 6. Community Workarounds for "Hiding" Prompts

No documented community patterns found for hiding prompts. The search `vscode prompt.md frontmatter "hidden" OR "internal" OR "private" OR "visibility" OR "exclude"` returned zero results.

### Patterns

1. **Prompt files have a minimal frontmatter schema** — 6 fields, all optional, focused on runtime behavior (model, tools, agent). No metadata/lifecycle fields.

2. **Agent files have a richer schema** — includes `user-invocable`, `disable-model-invocation`, `handoffs`, `hooks`, `agents`, `target`, `mcp-servers`. The agent schema is clearly more mature.

3. **The visibility gap is intentional** — prompt files are designed to be user-facing slash commands. The docs explicitly say "you invoke prompt files manually in chat." Hiding them contradicts their design purpose.

4. **The agent system provides the hiding mechanism** — if you need hidden/internal prompts, the intended path is to use `.agent.md` with `user-invocable: false` for subagent-only access.

5. **Schema is evolving** — `model` was added after initial release, `infer` was deprecated in favor of two separate fields. More properties may come.

### Applicability

**HIGH** — This research definitively answers the visibility question:
- `.prompt.md` files have NO hidden/internal mechanism
- `.agent.md` files DO via `user-invocable: false`
- For truly internal prompts, the agent system is the correct abstraction

### Open Questions

1. **Will prompt files get visibility controls?** — No open issues requesting this were found. The gap may be intentional (use agents instead).
2. **Can `chat.promptFiles.locations` be used creatively?** — Could a separate folder with prompts be conditionally loaded? Not documented.
3. **Extension-contributed prompts** — Extensions can contribute prompts; do they have additional metadata? Need source code analysis.
4. **Does the VS Code source code support undocumented frontmatter fields?** — The parser might accept fields not yet documented. Needs codebase investigation.
