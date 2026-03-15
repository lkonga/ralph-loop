# Q8: Async and Parallelism in VS Code Agents

## Findings

### Parallel Dispatch Is Model-Driven, Not Extension-Driven

The VS Code Copilot Chat extension has **no internal scheduler or concurrency cap** for tool calls. Parallelism is entirely controlled by the LLM:

1. **The model emits multiple tool calls in a single response round.** Each round's `toolCalls[]` array may contain 1–N calls. The `ToolCallingLoop` in `src/extension/intents/node/toolCallingLoop.ts` processes rounds sequentially — it calls `runOne()` in a `while(true)` loop, one iteration per LLM turn.

2. **Within a round, parallel execution happens at the prompt-rendering layer** via the "eager promise" pattern in `src/extension/prompts/node/panel/toolCalling.tsx` (lines 185–317). Tools in the `toolsCalledInParallel` set get their promises started immediately (with a dummy `PromptSizing`), rather than waiting for sequential rendering:

```typescript
if (tool?.source instanceof LanguageModelToolMCPSource || 
    tool?.name && toolsCalledInParallel.has(tool.name as ToolName)) {
    const promise = getToolResult({ tokenBudget: 1, countTokens: () => 1, ... });
    call = () => promise;  // eagerly started
} else {
    call = getToolResult;  // deferred until render
}
```

3. **The parallel-eligible tool set** (`toolsCalledInParallel`):
   - `CoreRunSubagent` (subagent dispatch)
   - `ReadFile`, `FindFiles`, `FindTextInFiles`, `ListDirectory`
   - `Codebase`, `GetErrors`, `GetScmChanges`
   - `GetNotebookSummary`, `ReadCellOutput`
   - `InstallExtension`, `FetchWebPage`
   - All MCP tools (checked via `instanceof LanguageModelToolMCPSource`)

4. **Token budget bypass**: Eagerly-started tools receive `tokenBudget: 1` — a trivial budget that effectively says "don't worry about sizing, just run." This means parallel tools cannot adapt their output size based on available context window space.

### Subagent Dispatch (`CoreRunSubagent`)

Subagents are tools, not separate processes. `SearchSubagentTool` (`src/extension/tools/node/searchSubagentTool.ts`) creates a `SearchSubagentToolCallingLoop` which is itself a `ToolCallingLoop` — a nested agentic loop with its own LLM conversation, tool set, and tool-call limit (`SearchSubagentToolCallLimit`).

Key mechanics:
- Each subagent gets a unique `subAgentInvocationId` (UUID) for trajectory linking
- Parent stores OpenTelemetry trace context so subagent spans nest under parent
- Subagent has its own `Conversation` and `Turn` — fully independent context
- Result is returned as a `LanguageModelToolResult` to the parent loop
- **No fan-out primitive**: If the model calls `runSubagent` 3× in one round, all 3 start eagerly (via `toolsCalledInParallel`), but there's no `Promise.all` coordinating them — they race independently during prompt rendering

### Telemetry Tracks Parallelism

`chatParticipantTelemetry.ts` (lines 463–494) computes:
- `parallelToolCallRounds`: count of rounds where `toolCalls.length > 1`
- `parallelToolCallsTotal`: sum of calls in those rounds
- `totalToolCalls`: total across all rounds

### Hook System (Async, Sequential)

The hook system in `chatHookService.ts` provides **6 hook types**, all executed as async shell commands via `NodeHookExecutor`:

| Hook | Timing | Can Block? |
|------|--------|-----------|
| `SessionStart` | Before first LLM call | No (provides context) |
| `SubagentStart` | Before subagent's first call | No (provides context) |
| `PreToolUse` | Before each tool execution | Yes (deny/ask/allow) |
| `PostToolUse` | After each tool execution | Yes (block) |
| `Stop` | When model stops producing tool calls | Yes (block = continue) |
| `SubagentStop` | When subagent stops | Yes (block = continue) |
| `UserPromptSubmit` | Before prompt reaches agent | Yes (block) |

Hooks are **async** (shell commands with JSON stdin/stdout), executed **sequentially** (one at a time per hook point), and can inject `additionalContext` into the prompt.

### No ACP Support

No references to "ACP" or "Agent Communication Protocol" exist in the codebase. Agent-to-agent communication happens solely through the tool-call interface: parent calls `runSubagent` tool → child runs nested `ToolCallingLoop` → result flows back as tool output.

### Concurrency Limits

- **Tool call limit per session**: Configurable via `toolCallLimit` (default varies by mode). In autopilot mode, auto-increases by 50% up to hard cap of 200.
- **No concurrency cap on parallel tools**: All N tool calls in a round start simultaneously.
- **Subagent tool call limit**: Separate `SearchSubagentToolCallLimit` config.
- **Completions queue**: `PromiseQueue` exists for inline completions (not chat tools).

## Patterns

### Model-Driven Fan-Out
The model decides parallelism. The extension blindly executes whatever tool calls arrive in a round. There is no batching, throttling, or scheduling layer between the model's output and tool execution.

### Eager Promise Pattern
Tools known to be independent (read-only, MCP, subagents) are started immediately without waiting for prompt-tsx's sequential render pass. This is the **only** parallelism optimization — it turns sequential rendering into concurrent execution for safe tools.

### Result Collection via Prompt Rendering
Tool results flow back through `ToolResultElement.render()` which `await`s the promise. The prompt-tsx renderer calls each element's render, collecting results. No explicit `Promise.all` — parallelism emerges from eager promise creation + sequential await.

### Token Budget Ignorance for Parallel Tools
Parallel tools get `tokenBudget: 1`, meaning they can't adapt output size. This is a deliberate trade-off: parallelism over optimal context utilization.

## Applicability

### What Wave Can Learn
1. **Eager promise pattern** is elegant for read-only fan-out — start all, await during collection
2. **Tool-call-as-subagent** avoids complex IPC; subagents are just nested loops
3. **Hook system** provides async lifecycle interception without blocking the main loop

### What's Missing for Wave
1. **No explicit fan-out/fan-in primitive**: Can't say "run these 3 tasks, merge results"
2. **No coordination between parallel subagents**: No shared state, no inter-agent messaging
3. **No priority or scheduling**: All parallel tools are equal, no resource allocation
4. **Token budget bypass in parallel mode**: Loses ability to size-constrain outputs

### ACP Potential via MCP
MCP tools are already parallel-eligible. An ACP-like protocol could layer on MCP by:
- Defining agent-to-agent message schemas as MCP tool inputs/outputs
- Using `SubagentStart`/`SubagentStop` hooks for coordination signals
- Leveraging `subAgentInvocationId` for correlation

## Open Questions

1. **Could async subagents be added?** The eager promise pattern already supports it — a "fire-and-forget" subagent tool that returns a handle, with a separate "await-subagent" tool to collect results later, would enable true async dispatch.

2. **Fan-out/fan-in primitives?** Not present. Would require a coordination layer above `ToolCallingLoop` that manages a set of parallel loops and merges their results before returning to the parent.

3. **What limits true parallelism?** The LLM API itself — each `runOne()` is a single LLM request. True parallelism only exists within a round's tool execution. The model cannot be "called back" mid-tool-execution.

4. **Could hooks enable wave-style orchestration?** The `Stop` hook's ability to inject reasons and force continuation is structurally similar to wave's task-not-done detection. `PreToolUse`/`PostToolUse` could implement approval gates.
