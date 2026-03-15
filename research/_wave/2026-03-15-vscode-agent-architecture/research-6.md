# Q6: Subagent Nesting Constraints

## Findings

### Depth Limit: Strictly One Level (Parent → Child Only)

VS Code Copilot Chat enforces a **hard single-level nesting constraint**. There is no numeric `depth` or `maxDepth` parameter — nesting is blocked via a **binary presence check** on `subAgentInvocationId`.

### Blocking Mechanism

The nesting prevention is implemented at two critical points:

**1. CodebaseTool — Prevents nested tool calling loops (`codebaseTool.tsx:154-156`)**
```typescript
// Don't trigger nested tool calling loop if we're already in a subagent
if (this._input?.tools?.subAgentInvocationId) {
    return false;  // _isCodebaseAgentCall returns false, skipping the agentic search loop
}
```
When the `Codebase` tool detects it's running inside a subagent (via `subAgentInvocationId` on the prompt context's `tools` object), it falls back to basic semantic search instead of spawning its own tool calling loop. This prevents recursive agent spawning.

**2. SearchSubagentToolCallingLoop — Tool restriction (`searchSubagentToolCallingLoop.ts:126-137`)**
```typescript
protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
    const allowedSearchTools = new Set([
        ToolName.Codebase,      // Semantic search (with nesting guard above)
        ToolName.FindFiles,     // File glob search
        ToolName.FindTextInFiles, // Text/regex search
        ToolName.ReadFile       // File reading
    ]);
    return allTools.filter(tool => allowedSearchTools.has(tool.name as ToolName));
}
```
Subagents only get **4 read-only tools**. Critically, neither `runSubagent` nor `search_subagent` is in the allowed set, so subagents **cannot call other subagents** — the tool simply isn't available.

### How `subAgentInvocationId` Propagates

1. **Parent agent** calls `search_subagent` tool → `SearchSubagentTool.invoke()` generates a UUID (`subAgentInvocationId`)
2. `SearchSubagentToolCallingLoop.createPromptContext()` sets `context.tools.subAgentInvocationId` and `context.tools.subAgentName = 'search'`
3. Every tool invocation within the subagent receives this ID via `LanguageModelToolInvocationOptions.subAgentInvocationId`
4. The `CapturingToken` carries `subAgentInvocationId` for trajectory/telemetry linking
5. `defaultIntentRequestHandler.ts:142` uses `request.subAgentInvocationId` as the trajectory session ID, explicitly linking parent tool call → child trajectory

### Two Subagent Tool Types

| Tool | Name | Purpose |
|------|------|---------|
| `CoreRunSubagent` | `runSubagent` | Core VS Code built-in subagent (registered in VS Code core) |
| `SearchSubagent` | `search_subagent` | Extension-level search subagent (implemented in `searchSubagentTool.ts`) |

Both are recognized as subagent invocations by the debug/trajectory system: `entry.name === 'runSubagent' || entry.name === 'search_subagent'`

### Context That Propagates to Subagents

**Propagated:**
- Parent session ID (for trajectory linking)
- Workspace folders / CWD
- The query/instruction text (passed as conversation turn)
- Tool invocation token (for VS Code API auth)
- Cancellation token
- Output stream (filtered to only `ChatToolInvocationPart`, `TextEditPart`, `NotebookEditPart`)
- Model endpoint (configurable, defaults to parent's model or agentic proxy)

**NOT propagated:**
- Parent conversation history (subagent gets fresh `Conversation` with single user turn)
- Parent's tool references (`toolReferences: []` — explicitly cleared)
- Full parent tool set (restricted to 4 search tools)
- Editing capabilities (no `edit_file`, `replace_string`, `run_in_terminal`, etc.)
- Billing interaction (subagent sets `userInitiatedRequest: false`)

### Tool Call Limits

Subagent tool calls are bounded by `ConfigKey.Advanced.SearchSubagentToolCallLimit`, an experiment-gated configuration value passed as `toolCallLimit` to the loop.

## Patterns

### Single-Level Fan-Out Tree

```
Parent Agent (full tool set: ~30+ tools)
├── search_subagent("find auth code")    → 4 tools only
├── search_subagent("find API routes")   → 4 tools only (parallel OK)
└── search_subagent("find tests")        → 4 tools only
    ├── ReadFile
    ├── FindFiles
    ├── FindTextInFiles
    └── Codebase (degrades to non-agentic when in subagent)
```

- `runSubagent` / `search_subagent` are in `toolsCalledInParallel` set, so parent can dispatch multiple subagents concurrently
- Each subagent runs its own `ToolCallingLoop` with its own model calls
- Results bubble up via `LanguageModelTextPart` returned to the parent

### Tool Restriction as Nesting Guard

The architecture uses **tool restriction** (allowlist of 4 tools) rather than a depth counter. Even if `subAgentInvocationId` checks were somehow bypassed, subagents simply don't have access to the `search_subagent` or `runSubagent` tools.

## Applicability

### Implications for Wave Architecture

1. **No recursive decomposition**: VS Code's architecture explicitly prevents recursive agent trees. A "wave" pattern requiring depth > 1 must use an alternative coordination mechanism outside the native subagent system.

2. **Workarounds for deeper nesting**:
   - **Sequential chaining**: Parent calls subagent A, gets results, then calls subagent B with A's findings as input. This remains depth-1 but simulates depth through iteration.
   - **External orchestration**: An external process (CLI, MCP server) manages multi-level dispatch, using VS Code's single-level subagents as leaf workers.
   - **Prompt-level nesting**: Pack sub-subtask context into the subagent's instruction text, letting one subagent handle what would otherwise require nesting.

3. **Subagents are read-only explorers**: They cannot edit files, run terminals, or make modifications. This is by design — subagents are scoped to information gathering.

4. **Model flexibility**: Subagents can use a different model than the parent (via `SearchSubagentModel` config), enabling cost optimization (e.g., cheaper model for search, expensive model for reasoning).

## Open Questions

1. **Could nesting be enabled?** Technically yes — remove the `subAgentInvocationId` check in `codebaseTool.tsx` and add `search_subagent`/`runSubagent` to the `allowedSearchTools` set. But this risks:
   - Runaway cost (each level multiplies LLM calls)
   - Unbounded recursion without a depth counter
   - Context explosion (each subagent gets its own conversation)

2. **What would break?** The trajectory tracking system assumes a flat parent→child model (maps of `subAgentInvocationId → sessionId`). Multi-level nesting would require tree-structured session tracking. The billing system (`userInitiatedRequest: false`) also assumes single-level.

3. **Alternative approaches:**
   - **Iterative deepening**: Parent calls subagent, reviews result, calls again with refined query — staying at depth 1 but achieving depth-like behavior through iteration
   - **Tool expansion**: Give subagents more tools (e.g., terminal, edit) rather than more nesting — wider not deeper
   - **MCP bridge**: Use an MCP server as an intermediary that can orchestrate complex multi-level workflows while VS Code subagents remain single-level leaf nodes
