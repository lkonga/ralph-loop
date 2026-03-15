# Research 2: Agent Tool System

## Findings

### Tool Registration Architecture

Tools are registered via a **three-layer** system:

1. **`package.json` contribution** — declares tool metadata (`languageModelTools` array) with `name`, `toolReferenceName`, `modelDescription`, `inputSchema`. Each tool has a `copilot_*` prefixed internal name and a short `toolReferenceName` used in agent frontmatter.
   - Source: [package.json](../../vscode-copilot-chat/package.json#L151) — ~40 tools declared

2. **`ToolRegistry` singleton** — in-code registration via `ToolRegistry.registerTool(ctor)` for Copilot-owned tools with custom `invoke`/`prepareInvocation`/`resolveInput` logic.
   - Source: [src/extension/tools/common/toolsRegistry.ts](../../vscode-copilot-chat/src/extension/tools/common/toolsRegistry.ts#L105)
   - Constructor pattern: each tool class has `static toolName: ToolName` and gets instantiated via `IInstantiationService`

3. **`ToolsService`** — merges contributed tools (from `vscode.lm.tools`) with Copilot-owned tools, normalizes names, sorts builtins first.
   - Source: [src/extension/tools/vscode-node/toolsService.ts](../../vscode-copilot-chat/src/extension/tools/vscode-node/toolsService.ts#L22)

### ToolName Enum (Canonical Internal Names)

Defined in [src/extension/tools/common/toolNames.ts](../../vscode-copilot-chat/src/extension/tools/common/toolNames.ts#L21):

| ToolName Enum | Runtime Value | toolReferenceName | Category |
|---|---|---|---|
| `ApplyPatch` | `apply_patch` | `applyPatch` | Core |
| `Codebase` | `semantic_search` | `codebase` | Core |
| `FindFiles` | `file_search` | `fileSearch` | Core |
| `FindTextInFiles` | `grep_search` | `textSearch` | Core |
| `ReadFile` | `read_file` | `readFile` | Core |
| `ListDirectory` | `list_dir` | `listDirectory` | Core |
| `CreateFile` | `create_file` | `createFile` | Core |
| `CreateDirectory` | `create_directory` | — | Core |
| `EditFile` | `insert_edit_into_file` | — | Core |
| `ReplaceString` | `replace_string_in_file` | — | Core |
| `MultiReplaceString` | `multi_replace_string_in_file` | — | Core |
| `CoreRunInTerminal` | `run_in_terminal` | — | Core |
| `CoreGetTerminalOutput` | `get_terminal_output` | — | Core |
| `CoreTerminalSelection` | `terminal_selection` | — | Core |
| `CoreTerminalLastCommand` | `terminal_last_command` | — | Core |
| `CoreRunSubagent` | `runSubagent` | — | Core |
| `SearchSubagent` | `search_subagent` | `searchSubagent` | Core |
| `GetErrors` | `get_errors` | `problems` | VSCode |
| `GetScmChanges` | `get_changed_files` | `changes` | VSCode |
| `VSCodeAPI` | `get_vscode_api` | `vscodeAPI` | VSCode |
| `InstallExtension` | `install_extension` | `installExtension` | VSCode |
| `CreateNewWorkspace` | `create_new_workspace` | `newWorkspace` | VSCode |
| `GetProjectSetupInfo` | `get_project_setup_info` | `getProjectSetupInfo` | VSCode |
| `RunVscodeCmd` | `run_vscode_command` | `runCommand` | VSCode |
| `FetchWebPage` | `fetch_webpage` | `fetch` | Web |
| `GithubRepo` | `github_repo` | `githubRepo` | Web |
| `Memory` | `memory` | `memory` | VSCode |
| `CreateNewJupyterNotebook` | `create_new_jupyter_notebook` | — | Notebook |
| `EditNotebook` | `edit_notebook_file` | — | Notebook |
| `RunNotebookCell` | `run_notebook_cell` | — | Notebook |
| `GetNotebookSummary` | `copilot_getNotebookSummary` | — | Notebook |
| `ReadCellOutput` | `read_notebook_cell_output` | — | Notebook |
| `CoreAskQuestions` | `vscode_askQuestions` | — | Testing |
| `CoreRunTest` | `runTests` | — | Testing |
| `FindTestFiles` | `test_search` | — | Testing |
| `TestFailure` | `test_failure` | `testFailure` | Testing |
| `SearchViewResults` | `get_search_view_results` | `searchResults` | VSCode |
| `ToolSearch` | `tool_search` | — | Core |
| `SwitchAgent` | `switch_agent` | `switchAgent` | VSCode |
| `CoreManageTodoList` | `manage_todo_list` | — | Core |

### Tool Sets (Short Names for `tools:` Frontmatter)

Defined in `package.json` `languageModelToolSets` ([package.json L1153](../../vscode-copilot-chat/package.json#L1153)):

| Toolset Name | Tools Included |
|---|---|
| **`edit`** | `createDirectory`, `createFile`, `createJupyterNotebook`, `editFiles`, `editNotebook`, `rename` |
| **`execute`** | `runNotebookCell`, `testFailure` |
| **`read`** | `getNotebookSummary`, `problems`, `readFile`, `readNotebookCellOutput` |
| **`search`** | `changes`, `codebase`, `fileSearch`, `listDirectory`, `searchResults`, `textSearch`, `searchSubagent`, `usages` |
| **`vscode`** | `getProjectSetupInfo`, `installExtension`, `memory`, `newWorkspace`, `runCommand`, `switchAgent`, `vscodeAPI` |
| **`web`** | `fetch`, `githubRepo` |

In `.agent.md` frontmatter, you can use:
- **Toolset names**: `'read'`, `'edit'`, `'search'`, `'web'`, `'execute'`, `'vscode'`
- **Slash-qualified**: `'vscode/memory'`, `'vscode/askQuestions'`, `'execute/getTerminalOutput'`
- **Individual tool referenceName**: `'github_repo'`, etc.
- **External tools**: `'github.vscode-pull-request-github/issue_fetch'`
- **Wildcard**: `'*'` = all tools (no restrictions)

### How Tool Restrictions Work

1. **`.agent.md` (VS Code native agents)**: The `tools:` frontmatter YAML array is parsed by the prompt file parser ([promptFileParser.ts L208](../../vscode-copilot-chat/src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L208)). Supports both array format `tools: ['read', 'edit']` and object format with boolean values. VS Code core resolves toolset names → individual `toolReferenceName` values and only makes those tools available to the agent's LM request.

2. **Claude `.claude/agents/*.md`**: Uses `allowedTools:` YAML frontmatter (list format). Parsed by [agentsCommand.ts L932](../../vscode-copilot-chat/src/extension/chatSessions/claude/vscode-node/slashCommands/agentsCommand.ts#L932). Maps tool names like `Read`, `Grep`, `Glob` to Claude-specific tool names. `'*'` wildcard = all tools. The `disallowedTools` field exists for negative filtering (e.g., `disallowedTools: ['WebSearch']` in [claudeCodeAgent.ts L473](../../vscode-copilot-chat/src/extension/chatSessions/claude/node/claudeCodeAgent.ts#L473)).

3. **Edit Tool Learning System**: A progressive system that restricts which edit tools are available based on model learning state. Controls transitions between `EditFile`, `ReplaceString`, `MultiReplaceString`, and `ApplyPatch`.
   - Source: [editToolLearningStates.ts](../../vscode-copilot-chat/src/extension/tools/common/editToolLearningStates.ts)

4. **Model-specific tools**: `ToolRegistry.registerModelSpecificTool()` allows tools that only activate for specific model families/versions via `modelSpecificToolApplies()` check.

### Built-in Agent Tool Configurations

| Agent | Tools | Source |
|---|---|---|
| **Plan** | `DEFAULT_READ_TOOLS` + `'agent'` + `'vscode/askQuestions'` | [planAgentProvider.ts L26](../../vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts#L26) |
| **Ask** | `DEFAULT_READ_TOOLS` + `'vscode.mermaid-chat-features/renderMermaidDiagram'` | [askAgentProvider.ts L28](../../vscode-copilot-chat/src/extension/agents/vscode-node/askAgentProvider.ts#L28) |
| **Explore** | `DEFAULT_READ_TOOLS` | [exploreAgentProvider.ts L37](../../vscode-copilot-chat/src/extension/agents/vscode-node/exploreAgentProvider.ts#L37) |
| **Edit** | `['read', 'edit']` | [editModeAgentProvider.ts L21](../../vscode-copilot-chat/src/extension/agents/vscode-node/editModeAgentProvider.ts#L21) |

`DEFAULT_READ_TOOLS` = `['search', 'read', 'web', 'vscode/memory', 'github/issue_read', 'github.vscode-pull-request-github/issue_fetch', 'github.vscode-pull-request-github/activePullRequest', 'execute/getTerminalOutput', 'execute/testFailure']`
   - Source: [agentTypes.ts L41](../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#L41)

### Name Mapping System

Two parallel name systems exist:
- **`ToolName`** enum: internal runtime values (e.g., `semantic_search`)
- **`ContributedToolName`** enum: `copilot_*` prefixed VS Code API names (e.g., `copilot_searchCodebase`)
- Bidirectional maps created at module load in [toolNames.ts L123-L130](../../vscode-copilot-chat/src/extension/tools/common/toolNames.ts#L123)
- `getToolName()` converts contributed→internal, `getContributedToolName()` converts internal→contributed

## Patterns

1. **Toolset-based scoping**: Agents declare high-level toolset names in frontmatter (`'read'`, `'edit'`). VS Code core expands these to individual `toolReferenceName` values and only includes matching tools in the LM request. This is declarative, not programmatic filtering.

2. **Additive configuration**: Built-in agents start with `DEFAULT_READ_TOOLS` and add specific tools. Settings like `planAgent.additionalTools` allow user extension. Tools are deduplicated via `Set`.

3. **Separation of concerns**: Tool *definition* (package.json) → tool *registration* (ToolRegistry) → tool *implementation* (ICopilotTool classes) → tool *scoping* (agent frontmatter) → tool *resolution* (ToolsService).

4. **Virtual tool grouping**: A separate system (`ToolGroupingService`) handles dynamic tool grouping with embeddings for optimizing tool selection at runtime — distinct from the static toolset system.

## Applicability

For building/customizing agents:

- Use toolset short names (`'read'`, `'edit'`, `'search'`, `'web'`) for broad categories
- Use slash-qualified names (`'vscode/memory'`) for individual tools from a toolset
- Use `'*'` for unrestricted access (default agent mode)
- Empty `tools:` array = no tools (pure conversational)
- `agents:` frontmatter controls which subagents are available (e.g., `agents: ['Explore']`)
- External extension tools use full qualified name: `'publisher.extension/toolName'`

## Open Questions

1. **How does VS Code core resolve toolset names?** The mapping from `languageModelToolSets[].name` + `languageModelToolSets[].tools[]` → actual `vscode.lm.tools` entries happens in VS Code core, not the Copilot extension. The exact resolution logic is in `microsoft/vscode`, not this repo.

2. **`tool_search` tool**: Listed in `ToolName` enum but not in `package.json` `languageModelTools` — appears to be a deferred/dynamic tool discovery mechanism. How is it registered?

3. **BYOK edit tool mapping**: `byokEditToolNamesToToolNames` maps alternative edit tool names (`'find-replace'`, `'apply-patch'`) — unclear when this mapping is used vs the standard toolsets.

4. **Tool `tags`**: Several tools have `tags` arrays (e.g., `["vscode_codesearch"]`). These might be used for dynamic grouping or model-specific tool selection, but the consumption path wasn't traced.
