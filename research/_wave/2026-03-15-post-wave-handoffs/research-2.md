# Q2: Coder Subagent Tool Access for Implementation

## Findings

### coder.agent.md Tools Configuration
The coder agent at `llm-rules/vscode/Default/agents/coder.agent.md` declares a comprehensive `tools:` frontmatter:

```yaml
tools: [vscode, execute/getTerminalOutput, execute/awaitTerminal, execute/killTerminal,
        execute/runInTerminal, read/terminalSelection, read/terminalLastCommand, read/problems,
        read/readFile, agent, 'crawl4ai/*', 'time/*', edit/createDirectory, edit/createFile,
        edit/editFiles, edit/rename, search, web/githubRepo, 'searxng-search/*', todo]
```

**Full implementation tool access confirmed:**
- **File editing**: `edit/editFiles`, `edit/createFile`, `edit/createDirectory`, `edit/rename`
- **Terminal**: `execute/runInTerminal`, `execute/getTerminalOutput`, `execute/awaitTerminal`, `execute/killTerminal`
- **Reading**: `read/readFile`, `read/problems`, `read/terminalSelection`, `read/terminalLastCommand`
- **Search**: `search`, `web/githubRepo`, `searxng-search/*`, `crawl4ai/*`
- **Delegation**: `agent` (can spawn its own sub-subagents)
- **Task management**: `todo`

### runSubagent vs search_subagent — Two Different Tools

| Aspect | `runSubagent` (CoreRunSubagent) | `search_subagent` (SearchSubagent) |
|--------|-------------------------------|-----------------------------------|
| Category | `ToolCategory.Core` — VS Code built-in | Extension-implemented in `searchSubagentTool.ts` |
| Tool access | Full per `.agent.md` frontmatter | Read-only (grep, glob, semantic search) |
| Implementation | VS Code core platform | `SearchSubagentToolCallingLoop` with filtered tools |
| Session model | Launches new agent chat session | Inline tool-calling loop within parent |

### How tools: Frontmatter Maps to Runtime

1. **VS Code core** parses `.agent.md` YAML frontmatter into `ChatRequestModeInstructions.toolReferences`
2. When `runSubagent` launches, the request carries `modeInstructions2` with `toolReferences` from the agent file
3. The extension resolves: `customAgent.tools = (request.modeInstructions2.toolReferences || []).map(t => t.name)` (copilotCLIChatSessionsContribution.ts:1132)
4. `getEnabledTools()` uses `request.tools` map to filter available tools — tools declared in frontmatter are enabled; unlisted tools are disabled
5. **No tool stripping for runSubagent** — the subagent gets exactly the tools its frontmatter specifies. There is no code that restricts `runSubagent` children beyond what the frontmatter declares

### Evidence of No Tool Restriction on runSubagent

- Searched for `subagent.*restrict`, `subagent.*strip`, `subagent.*tools.*filter` — **zero matches**
- `runSubagent` simply stores trace context and delegates to VS Code core (toolsService.ts:145)
- The subagent runs as a full `ChatRequest` with `subAgentInvocationId` set — same request pipeline as a top-level agent

## Patterns

1. **Frontmatter → toolReferences → request.tools → getEnabledTools()**: The tool pipeline is: YAML parse → VS Code core attaches as `toolReferences` → extension maps to `customAgent.tools` → `getEnabledTools()` filters based on this list
2. **runSubagent = full session**: It creates a new chat session with its own conversation, trajectory, and tool access. Not a restricted sandbox
3. **search_subagent = restricted loop**: In contrast, `SearchSubagentToolCallingLoop` explicitly filters to search-only tools and runs inline
4. **agent tool enables nesting**: The coder agent's `agent` tool means it can dispatch further subagents (Explore, etc.)

## Applicability

**Yes — coder subagents dispatched via `runSubagent` have full implementation capabilities:**

- ✅ **Edit files**: `edit/editFiles`, `edit/createFile` — can apply code changes
- ✅ **Run terminal**: `execute/runInTerminal` — can run tests, build commands, scripts
- ✅ **Create files**: `edit/createFile`, `edit/createDirectory`
- ✅ **Read and diagnose**: `read/readFile`, `read/problems`
- ✅ **Delegate further**: `agent` tool allows sub-delegation to Explore agents
- ✅ **Web research**: `crawl4ai/*`, `searxng-search/*` for documentation lookups

**For wave handoffs**: A wave orchestrator using `runSubagent` with `coder.agent.md` can fully implement changes, run verification, and create files — not just research. The key is using `runSubagent` (not `search_subagent`).

## Open Questions

1. **Token limits**: The coder agent has an 8k output token cap in its instructions. Can VS Code core enforce a different limit for subagents?
2. **Parallelism**: Can multiple `runSubagent` calls execute concurrently, or are they serialized by VS Code core?
3. **Approval flow**: Does `permissionLevel: 'autoApprove'` from the parent propagate to `runSubagent` children for file edits and terminal commands?
4. **Context inheritance**: How much of the parent's conversation context (files read, edits made) is visible to the subagent?
