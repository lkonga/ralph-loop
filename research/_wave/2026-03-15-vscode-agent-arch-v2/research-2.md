# Q2: Subagent Nesting Constraints — Depth Analysis

## Findings

### 1. The blocking mechanism: `subAgentInvocationId` as a boolean-like flag

Nesting is prevented through three coordinated mechanisms, none of which use a depth counter:

**Mechanism A — Tool set restriction via `SearchSubagentToolCallingLoop.getAvailableTools()`**
([searchSubagentToolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/prompt/node/searchSubagentToolCallingLoop.ts#L118-L133))

```typescript
protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
    const allTools = this.toolsService.getEnabledTools(this.options.request, endpoint);
    const allowedSearchTools = new Set([
        ToolName.Codebase,
        ToolName.FindFiles,
        ToolName.FindTextInFiles,
        ToolName.ReadFile
    ]);
    return allTools.filter(tool => allowedSearchTools.has(tool.name as ToolName));
}
```

The search subagent receives only 4 read-only tools. `CoreRunSubagent` (`runSubagent`) and `SearchSubagent` (`search_subagent`) are **never in the allowed set**, making it structurally impossible for a search subagent to spawn another subagent.

**Mechanism B — `subAgentInvocationId` presence check in `codebaseTool.tsx`**
([codebaseTool.tsx](../../../vscode-copilot-chat/src/extension/tools/node/codebaseTool.tsx#L154-L156))

```typescript
// Don't trigger nested tool calling loop if we're already in a subagent
if (this._input?.tools?.subAgentInvocationId) {
    return false;
}
```

The `Codebase` tool (semantic search) has an internal agentic loop (`CodebaseToolCallingLoop`). When invoked inside a subagent context, this check detects `subAgentInvocationId` presence on `context.tools` and forces a non-agentic code path — preventing a nested tool-calling loop within a tool-calling loop.

**This is not a depth counter — it's a boolean presence check.** Any truthy `subAgentInvocationId` blocks nesting.

**Mechanism C — VS Code core platform tool filtering**

The `CoreRunSubagent` tool (name: `runSubagent`) is registered in VS Code core (`ToolName.CoreRunSubagent = 'runSubagent'` at [toolNames.ts](../../../vscode-copilot-chat/src/extension/tools/common/toolNames.ts#L64)), not in the Copilot Chat extension. VS Code core controls which tools are provided to subagent invocations via `request.subAgentInvocationId`. When a chat request has `subAgentInvocationId` set (meaning it IS a subagent), the platform does not provide `runSubagent` in the available tools.

### 2. The `subAgentInvocationId` propagation chain

1. **Parent agent** calls `runSubagent` tool → VS Code core creates a new chat request with `request.subAgentInvocationId = <uuid>`
2. **Extension** receives request in `chatParticipants.ts:204`: `const isSubAgent = !!request.subAgentInvocationId` — used for billing, interaction tracking, hook selection
3. **`SearchSubagentToolCallingLoop.createPromptContext()`** at line 63-68 sets `context.tools.subAgentInvocationId` on the prompt context, propagating it to all tools within the subagent
4. **`defaultIntentRequestHandler.ts:149`** passes the `subAgentInvocationId` to the `CapturingToken` for trajectory linking

### 3. The `agents:` frontmatter key in `.agent.md`

Custom agents support an `agents:` key in frontmatter ([agentTypes.ts](../../../vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#L33)):
```typescript
readonly agents?: string[];
```
This controls **which other agents a parent agent can dispatch as subagents** — it acts as an allowlist for the `runSubagent` tool. But it does NOT enable deeper nesting. When agent A dispatches agent B as a subagent, agent B runs with `subAgentInvocationId` set, which means:
- Agent B won't have `runSubagent` in its tool set (VS Code core strips it)
- Agent B's `Codebase` tool won't launch nested agentic loops (boolean check)

### 4. Not configurable — hard-enforced

There is **no configuration flag, experiment, or depth parameter** that enables deeper nesting:
- No `maxDepth`, `nestingLevel`, or `depth` variables exist in the subagent code paths
- The `SearchSubagentToolCallLimit` config controls tool call iterations within a single subagent, not nesting depth
- The `subAgentInvocationId` check is a simple `if (id)` — not `if (depth < max)`
- No frontmatter key can override these structural restrictions

### 5. What happens when nesting is attempted

- **Search subagent tries to invoke `runSubagent`**: Impossible — tool not in `allowedSearchTools` set
- **Codebase tool tries agentic mode in subagent**: `_isCodebaseAgentCall()` returns `false`, falls back to direct semantic search
- **Custom `.agent.md` subagent tries to invoke another agent**: `runSubagent` tool not available in the request (filtered by VS Code core)

## Patterns

**Single-level fan-out architecture**: The design enforces a strict orchestrator→worker topology. The main agent is the sole orchestrator that can dispatch subagents. Subagents are workers with restricted tool sets — they execute and return results but cannot delegate further.

**Context propagation model**: `subAgentInvocationId` serves triple duty:
1. **Nesting prevention** (boolean gate)
2. **Trajectory linking** (parent↔child trace correlation)
3. **Billing classification** (subagent requests are not user-initiated, not billed separately)

**Tool set as security boundary**: Rather than runtime depth checks, nesting prevention is structural — the tools simply aren't available. This is more robust than a counter because there's no code path that can "accidentally" invoke a nested subagent.

## Applicability

**Impact on wave's orchestrator→research fan-out**: Wave's single-level fan-out pattern (orchestrator dispatches N research agents in parallel) is **perfectly aligned** with VS Code's architecture. The depth-1 constraint means:

- Wave research agents should be designed as **leaf workers** that gather context and return results
- The orchestrator must handle all coordination, aggregation, and re-dispatch
- Multi-hop research (research-agent-spawns-sub-research) must be flattened into sequential orchestrator turns or parallel leaf dispatches

**`toolsCalledInParallel` set** at [toolCalling.tsx](../../../vscode-copilot-chat/src/extension/prompts/node/panel/toolCalling.tsx#L330-L342) includes `CoreRunSubagent`, confirming VS Code supports **parallel subagent dispatch** — multiple `runSubagent` calls in a single model response are executed concurrently.

## Open Questions

1. **Could nesting be enabled?** Technically yes — by: (a) adding `runSubagent` to the `allowedSearchTools` set, (b) removing the `subAgentInvocationId` boolean check in `codebaseTool.tsx`, and (c) modifying VS Code core to provide `runSubagent` to subagent requests. But this would require changes in both the extension AND VS Code core.

2. **Would deeper nesting cause issues?** Yes — likely:
   - **Token explosion**: Each nesting level multiplies context window consumption
   - **Billing ambiguity**: The `userInitiatedRequest: false` flag on subagent requests would need depth-aware billing logic
   - **Trajectory complexity**: The current trajectory linking assumes parent→child, not parent→child→grandchild
   - **Timeout cascading**: Subagent tool call limits would compound (e.g., 5 calls × 5 calls = 25 total)

3. **Is the `agents:` frontmatter key a vector for bypass?** No. It controls which agents the **parent** can invoke, not whether a subagent can invoke further subagents. Even if an `.agent.md` declares `agents: ['*']`, the subagent it dispatches still runs with `subAgentInvocationId` set and therefore cannot access `runSubagent`.
