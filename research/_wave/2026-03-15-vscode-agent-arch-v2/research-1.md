# Q1: Subagent Tool Configuration via Frontmatter

## Findings

### 1. Frontmatter `tools:` Parsing

The `tools:` key in `.agent.md` frontmatter is a first-class parsed attribute. In `promptFileParser.ts` (lines 207–233), the parser extracts tools from both array and object formats:

```typescript
// src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts:207
public get tools(): string[] | undefined {
    const toolsAttribute = this._parsedHeader.attributes.find(
        attr => attr.key === PromptHeaderAttributes.tools
    );
    // Supports both array format: tools: [read, search]
    // and object format: tools: { read: true, search: true }
}
```

The `PromptHeaderAttributes.tools = 'tools'` constant (line 73) confirms this is part of the official schema.

### 2. Frontmatter → `request.tools` → Tool Enablement Pipeline

The pipeline works as follows:

1. **VS Code core** reads `.agent.md` frontmatter `tools:` list
2. Populates `request.tools` (a `Map<ToolRef, boolean>`) — the "tool picker" map
3. Also populates `request.modeInstructions2.toolReferences`
4. Extension's `getEnabledTools()` checks this map to filter tools

In `toolsService.ts` (lines 222–280), the resolution logic:

```typescript
// Step 0: Check tool picker (from frontmatter tools:)
const toolPickerSelection = requestToolsByName.get(getContributedToolName(tool.name));
if (toolPickerSelection === false) { return false; }  // Explicitly disabled
// ...
// Step 1: Check consumer filter (agent-specific logic)
const explicit = filter?.(tool);
if (explicit !== undefined) { return explicit; }
// ...
// Final: Tool was enabled via tool picker (frontmatter)
if (toolPickerSelection === true) { return true; }
```

**Key insight**: Tools listed in frontmatter `tools:` appear as `toolPickerSelection === true`, which passes through the filter chain and enables the tool.

### 3. Built-in Agent Tool Configuration

Built-in agents (Plan, Ask, Explore) use `AgentConfig.tools` that gets serialized to frontmatter via `buildAgentMarkdown()`:

| Agent | Tools | Source |
|-------|-------|--------|
| **Explore** | `DEFAULT_READ_TOOLS` (search, read, web, memory, github issues, terminal output, test failure) | `exploreAgentProvider.ts:38` |
| **Plan** | `DEFAULT_READ_TOOLS + 'agent'` (adds subagent invocation) | `planAgentProvider.ts:27-28` |
| **Ask** | `DEFAULT_READ_TOOLS` | `askAgentProvider.ts:28` |
| **Agent** (main) | Full tool set via `getAgentTools()` including edit, terminal, etc. | `agentIntent.ts:66-150` |

`DEFAULT_READ_TOOLS` is defined in `agentTypes.ts:40-51`:
```typescript
export const DEFAULT_READ_TOOLS: readonly string[] = [
    'search', 'read', 'web', 'vscode/memory',
    'github/issue_read', 'github.vscode-pull-request-github/issue_fetch',
    'github.vscode-pull-request-github/activePullRequest',
    'execute/getTerminalOutput', 'execute/testFailure'
];
```

### 4. Two Distinct Subagent Mechanisms

**A) `runSubagent` (VS Code core built-in tool)**
- Used by Plan agent to invoke Explore, and for custom agent-to-agent invocation
- The invoked subagent gets its **OWN** tool set from its frontmatter `tools:` config
- VS Code core creates a new `ChatRequest` with the subagent's tools populated in `request.tools`
- The subagent runs through the same `getEnabledTools()` pipeline with its own tools
- **NOT limited to 4 read-only tools** — it gets whatever tools its frontmatter declares

**B) `SearchSubagentToolCallingLoop` (hardcoded search subagent)**
- Used by the `search_subagent` tool for background search operations
- Has a **HARDCODED allowlist** of exactly 4 tools (`searchSubagentToolCallingLoop.ts:126-137`):
  ```typescript
  const allowedSearchTools = new Set([
      ToolName.Codebase,      // semantic_search
      ToolName.FindFiles,     // file_search
      ToolName.FindTextInFiles, // grep_search
      ToolName.ReadFile       // read_file
  ]);
  return allTools.filter(tool => allowedSearchTools.has(tool.name as ToolName));
  ```
- This is **NOT overridable** via frontmatter — it's a hardcoded filter in the extension code

### 5. Verification: Custom Agents CAN Have Full Tool Sets

The claim is **CONFIRMED**. A custom `.agent.md` file with:
```yaml
---
tools: [search, read, edit, terminal, web]
---
```

Will have those tools available when invoked, including as a subagent via `runSubagent`. The flow:
1. VS Code core reads the frontmatter `tools:` list
2. Maps tool names to `request.tools` entries (enabled=true)
3. `getEnabledTools()` returns those tools
4. The agent (or subagent) can use them

The `PlanAgentAdditionalTools` and `AskAgentAdditionalTools` settings (`configurationService.ts:1035-1041`) also allow extending built-in agents' tool sets dynamically.

## Patterns

### Tool Resolution Priority Chain

```
request.tools (frontmatter) → getEnabledTools() filter:
  1. Model-specific overrides (highest priority)
  2. Tool picker disabled (frontmatter tools: false) → BLOCK
  3. Consumer filter (agent-specific: getAgentTools()) → explicit allow/block
  4. toolReferences cross-enablement → enable via tags
  5. Tool picker enabled (frontmatter tools: true) → ALLOW
  6. Default: not included
```

### Subagent Tool Inheritance

```
Parent Agent (e.g., Plan)
  ├── tools: [search, read, web, agent]  ← from its own frontmatter
  └── calls runSubagent → Child Agent (e.g., Explore)
       └── tools: [search, read, web]    ← from child's own frontmatter
                                            NOT inherited from parent
```

Each agent in the chain uses its OWN frontmatter tools. There is no inheritance.

## Applicability

### Impact on Wave Architecture

1. **Custom coder subagents CAN have full tool access**: A `.agent.md` with `tools: [search, read, edit, terminal, web]` will have edit + terminal capabilities even when invoked as a subagent. This means wave's coder agents are NOT limited to the 4 read-only tools of `SearchSubagentToolCallingLoop`.

2. **The 4-tool limitation applies ONLY to `search_subagent`**: This is a separate, specialized tool with hardcoded restrictions. Custom agents via `runSubagent` bypass this entirely.

3. **Tool names in frontmatter use short-form identifiers**: `search`, `read`, `edit`, `terminal`, `web`, `agent`, `vscode/memory`, etc. These are mapped to internal `ToolName` enums by VS Code core.

4. **Wave coder agents should specify their tool set explicitly**: Since there's no inheritance, each agent must declare all tools it needs in its frontmatter.

## Open Questions

1. **Tool name mapping**: What is the exact mapping between frontmatter short names (e.g., `edit`, `terminal`) and internal `ToolName` values? The `getContributedToolName()` function handles this but the full mapping table isn't in the extension code — it's in VS Code core.

2. **Permission levels**: Does `request.permissionLevel` (e.g., `autopilot`) propagate to subagents? The `task_complete` tool is gated on `permissionLevel === 'autopilot'` — unclear if subagents inherit this.

3. **`agents:` frontmatter key**: The `agents:` key in frontmatter (e.g., `agents: ['Explore']`) appears to control which subagents an agent can invoke. Setting `agents: []` blocks subagent calls. The interaction between `agents:` and `tools:` containing `'agent'` needs clarification.

4. **MCP tools in subagents**: Can frontmatter reference MCP-provided tools? The `GithubPromptHeaderAttributes.mcpServers` attribute suggests MCP server configuration exists but its interaction with the tool pipeline is unclear.
