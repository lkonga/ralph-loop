# Q8: Async and Parallelism in VS Code Agents

## Findings

### Parallel Tool Dispatch (Eager Promise Pattern)

The core parallelism mechanism lives in `toolCalling.tsx` (`buildToolResultElement`, ~line 312). For tools in the `toolsCalledInParallel` set **or** MCP-sourced tools, the tool result promise is created **eagerly** — before prompt-tsx's sequential render pass reaches the element:

```typescript
if (tool?.source instanceof LanguageModelToolMCPSource || tool?.name && toolsCalledInParallel.has(tool.name as ToolName)) {
    const promise = getToolResult({ tokenBudget: 1, countTokens: () => 1, endpoint: { modelMaxPromptTokens: 1 } });
    call = () => promise;  // returns same promise on every call
} else {
    call = getToolResult;  // deferred — waits for sizing info
}
```

The eager path passes a **dummy tokenBudget of 1** because these tools don't need sizing information to execute. The promise starts immediately; by the time prompt-tsx renders the `ToolResultElement` and calls `call(sizing)`, the tool may already have resolved. Non-parallel tools get the real `sizing` object with actual token budget.

### Tools Called In Parallel (Hardcoded Set)

12 tools are marked for parallel execution (`toolCalling.tsx`, ~line 328):

- `CoreRunSubagent` (runSubagent), `ReadFile`, `FindFiles`, `FindTextInFiles`, `ListDirectory`
- `Codebase` (semantic_search), `GetErrors`, `GetScmChanges`, `GetNotebookSummary`
- `ReadCellOutput`, `InstallExtension`, `FetchWebPage`

All MCP tools are **automatically** parallel (via the `LanguageModelToolMCPSource` check).

### Token Budget Management

Parallel tools receive `tokenBudget: 1` — they cannot use sizing info for result truncation. Sequential tools get real budget from prompt-tsx's flex layout system. The `ToolResultElement` renders content with optional `truncateAt` for size control. Each tool in a round "reserves" `1/(N*4)` of available space to prevent newer calls from completely eliminating older ones.

### Subagent Dispatch (Synchronous, Not Parallel)

`SearchSubagentTool.invoke()` is **synchronous** — it `await`s `loop.run(stream, token)` inline, blocking the parent until completion. Each subagent gets:
- Independent `subAgentInvocationId` (UUID) for trajectory linking
- Fresh `Conversation` with only the search instruction (independent context window)
- Its own `CapturingToken` for nested tool call grouping
- Parent trace context via `otelService.getStoredTraceContext(`subagent:${parentRequestId}`)`

However, because `CoreRunSubagent` is in `toolsCalledInParallel`, when the **model requests multiple subagent calls in one assistant turn**, they all start eagerly as concurrent promises. The parallelism comes from the model requesting multiple tool calls, not from the dispatcher.

### Async Hook System

All hooks are fully async. Hook types: `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`.

Hooks execute via `chatHookService.executeHook()` → returns `Promise<ChatHookResult[]>`. Multiple hook results are collapsed using "most restrictive wins" (deny > ask > allow for `preToolUse`). Hooks can:
- Block agent/subagent from stopping (`Stop`/`SubagentStop` with `decision: 'block'`)
- Modify tool input (`preToolUse` with `updatedInput`)
- Inject additional context (`SessionStart`/`SubagentStart` with `additionalContext`)
- Abort execution entirely (via `isHookAbortError`)

Hook context is appended to the next assistant round via `round.hookContext`.

### No ACP (Agent Communication Protocol)

No ACP, `agentCommunicationProtocol`, or inter-agent communication protocol exists. Subagents communicate with parent only through tool results (the `ExtendedLanguageModelToolResult` return value). There is no message-passing, shared memory, or pub/sub between concurrent agents.

### No Queue or Scheduler

No task queue, semaphore, or concurrency scheduler exists. The tool calling loop is a simple `while(true)` sequential loop in `_runLoop()`. Within each iteration, the model's tool calls execute (some eagerly/concurrently via the parallel set), results are collected, and the next prompt is built.

## Patterns

1. **Eager Promise Creation**: Tools in the parallel set start execution immediately when `buildToolResultElement` is called, before prompt-tsx render. The promise is cached and returned on render.
2. **Model-Driven Concurrency**: The LLM decides how many tool calls per turn. If it emits 5 `runSubagent` calls in one assistant message, all 5 start concurrently.
3. **Sequential Round Loop**: The outer loop (`_runLoop`) is strictly sequential — one LLM turn at a time, waiting for all tool results before the next prompt.
4. **Independent Context Isolation**: Each subagent gets a fresh `Conversation`, preventing cross-contamination. Parent state is not shared.
5. **Trace Linking**: `subAgentInvocationId` chains parent ↔ child trajectories for observability. Stored in `runSubagentToolCallToSessionId` map in `TrajectoryLoggerAdapter`.

## Applicability

**What works for wave-style orchestration:**
- Eager promise pattern is directly applicable — wave tasks that don't need sizing can start immediately
- Model-driven concurrency means wave can dispatch N explore subagents in one turn and they run concurrently
- `subAgentInvocationId` pattern provides the tracing model for correlating wave tasks to parent

**What's missing:**
- **No fan-out/fan-in primitive**: No built-in way to launch N tasks, wait for all, and aggregate results
- **No dependency DAG**: Tasks can't express "B depends on A's output"
- **No background execution**: All subagents block the parent — no fire-and-forget with progress streaming
- **No shared accumulator**: Concurrent subagents can't write to a common result store
- **No retry/backoff**: Failed subagent = failed tool call, no automatic retry (except autopilot mode retries the outer loop)

## Open Questions

1. **Could ACP be added via MCP?** MCP tools are automatically parallel. A custom MCP server could implement agent-to-agent messaging, but it would be tool-call-mediated, not native protocol. Latency would be high.
2. **Async subagent dispatch feasibility?** The `BackgroundPipelineManager` design in `.copilot/background/reviewers/r02-async-orchestration.md` proposes exactly this but is not implemented. It would require a new service with state machine (pending→running→checkpoint→completed/failed/cancelled).
3. **Parallelism limits?** No explicit concurrency cap — limited only by model's willingness to emit parallel tool calls (typically 5-15 per turn) and by API rate limits. No semaphore or connection pool.
4. **Token budget for parallel subagents?** Each gets `tokenBudget: 1` (dummy), meaning subagents can't do token-aware result truncation. This is fine for search but problematic for large result aggregation.
5. **Hook-driven wave control?** `SubagentStart`/`SubagentStop` hooks could inject wave-specific instructions or block completion until aggregation criteria are met — this is the most viable extension point.
