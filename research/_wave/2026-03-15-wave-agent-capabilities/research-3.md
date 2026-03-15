# Research 3: Subagent Dispatch Mechanism

## Findings

### Two Distinct Subagent Systems

Copilot Chat has **two separate subagent implementations** that serve different purposes:

1. **`runSubagent` (CoreRunSubagent)** — A VS Code core built-in tool, NOT implemented in the extension. The extension treats it as a passthrough tool dispatched via `vscode.lm.invokeTool()` ([toolsService.ts:157](src/extension/tools/vscode-node/toolsService.ts#L157)). VS Code core handles the actual dispatch—the extension only stores trace context before invocation and processes results after.

2. **`search_subagent` (SearchSubagent)** — A Copilot extension tool implemented locally in [searchSubagentTool.ts](src/extension/tools/node/searchSubagentTool.ts). This creates its own `SearchSubagentToolCallingLoop` for search-specific tasks, with a tool call limit from configuration.

### Dispatch Flow: `runSubagent`

```
Model emits tool_call(name="runSubagent", args={...})
  → toolCalling.tsx resolves input, runs preToolUse hook
  → toolsService.invokeToolWithEndpoint()
    → stores OTel trace context keyed by chatRequestId (L145)
    → delegates to vscode.lm.invokeTool("runSubagent", options)
  → VS Code core creates a new chat request with:
      - subAgentInvocationId (unique UUID)
      - subAgentName (from tool args)
      - parentRequestId (links to parent)
  → chatParticipants.ts receives the request (L204: isSubAgent = !!request.subAgentInvocationId)
  → DefaultIntentRequestHandler creates CapturingToken with subAgentInvocationId (L145-148)
  → toolCallingLoop.runStartHooks() fires SubagentStart hook (L582-585)
  → Normal tool-calling loop runs within the subagent context
  → On completion, SubagentStop hook fires (L848-852)
  → Result returns to parent as LanguageModelToolResult
```

### Dispatch Flow: `search_subagent`

```
Model emits tool_call(name="search_subagent", args={query, description, details})
  → SearchSubagentTool.invoke() (searchSubagentTool.ts:49)
  → Creates Conversation with search instruction
  → Generates subAgentInvocationId UUID
  → Creates SearchSubagentToolCallingLoop with toolCallLimit
  → Creates CapturingToken for trajectory grouping
  → Wraps loop in requestLogger.captureInvocation()
  → loop.run() executes (inner tool-calling loop with search tools)
  → Parses <final_answer> tags, hydrates code snippets from file paths
  → Returns LanguageModelToolResult with toolMetadata.subAgentInvocationId
```

### Parallelism

**Yes, subagents can run in parallel.** This is explicitly designed:

- `CoreRunSubagent` is in `toolsCalledInParallel` set ([toolCalling.tsx:331](src/extension/prompts/node/panel/toolCalling.tsx#L331)), meaning its tool result promise is started eagerly (not deferred until prompt rendering).
- The Claude Agent SDK fixture confirms parallel execution: 4 subagents with sleep 1-4s completed in ~10s total (dominated by longest), not 10s cumulative ([fixture b3a7bd3c](src/extension/chatSessions/claude/node/test/fixtures/b3a7bd3c-5a10-4e7b-8ff0-7fc0cd6d1093.jsonl)).
- The Claude system prompt explicitly instructs: "Launch multiple agents concurrently whenever possible... use a single message with multiple tool uses" ([fixture 30530d66](src/extension/chatSessions/claude/node/test/fixtures/30530d66-37fb-4f3b-aa5f-d92b6a8afae2.jsonl)).

When the model returns multiple `runSubagent` tool calls in one response, VS Code creates multiple chat requests simultaneously. Each gets its own `subAgentInvocationId`, `CapturingToken`, and independent tool-calling loop.

### Agent Name Resolution

Two distinct agent resolution paths:

**1. VS Code Built-in Agents (runSubagent)**
- Resolution happens in VS Code core, not the extension
- `request.subAgentName` arrives on the `ChatRequest` object ([chatParticipantPrivate.d.ts:112](src/extension/vscode.proposed.chatParticipantPrivate.d.ts#L112))
- The extension uses `subAgentName` for hook input (`agent_type` field) and telemetry

**2. Claude Agent SDK Custom Agents (Task tool)**
- `subagent_type` parameter in the Task tool schema selects the agent type
- Custom agents from `.agent.md` files are loaded by `CopilotCLIAgents` ([copilotCli.ts:307](src/extension/agents/copilotcli/node/copilotCli.ts#L307))
- Pattern: `.github/agents/*.agent.md`
- Resolution: `resolveAgent(agentId)` does case-insensitive match against loaded agents ([copilotCli.ts:367](src/extension/agents/copilotcli/node/copilotCli.ts#L367))
- File watchers refresh agent list on `.agent.md` file changes
- `getCustomAgents()` from the CopilotCLI SDK processes the markdown files

**3. VS Code Proposed API (`chatPromptFiles.d.ts`)**
- `ChatCustomAgentProvider.provideCustomAgents()` supplies `.agent.md` URIs
- `vscode.chat.customAgents` exposes the read-only list
- This is the VS Code side of agent discovery

### Result Collection

Results are collected as `LanguageModelToolResult`:
- Each subagent's result goes through `toolMetadata` which carries `subAgentInvocationId` and `agentName`
- `trajectoryLoggerAdapter.ts` maps `runSubagentToolCallToSessionId` (Map<toolCallId, sessionId>) to link parent tool calls to child trajectory sessions ([trajectoryLoggerAdapter.ts:38](src/platform/trajectory/node/trajectoryLoggerAdapter.ts#L38))
- `agentDebugEventCollector.ts` tracks `_subAgentStarted` set and maps invocation IDs to parent debug events

### Hook Lifecycle

```
SubagentStart hook → subagent runs tool-calling loop → SubagentStop hook
```

- **SubagentStart** ([toolCallingLoop.ts:456](src/extension/intents/node/toolCallingLoop.ts#L456)): Fires before first prompt. Can inject `additionalContext` into subagent.
- **SubagentStop** ([toolCallingLoop.ts:499](src/extension/intents/node/toolCallingLoop.ts#L499)): Fires when subagent would stop. Can return `decision: 'block'` with a reason to force continuation. Sets `stopHookActive` flag to prevent infinite loops.
- SessionStart does NOT fire for subagents ([toolCallingLoop.ts:579](src/extension/intents/node/toolCallingLoop.ts#L579))

## Patterns

1. **Passthrough pattern**: `runSubagent` is a VS Code core tool—the extension stores OTel context and passes through. The real dispatch is in VS Code's chat infrastructure.
2. **Self-contained pattern**: `search_subagent` is fully owned by the extension—creates its own tool-calling loop with restricted tools.
3. **Eager parallel execution**: Tools in `toolsCalledInParallel` get their promise started immediately rather than lazily during prompt rendering.
4. **UUID-based linking**: `subAgentInvocationId` is the key linkage between parent tool call → child session → trajectory → debug events.
5. **Hook injection points**: SubagentStart/Stop hooks allow external scripts to inject context or prevent termination, enabling orchestration patterns.

## Applicability

For wave-style orchestration:

- **Parallel dispatch is native**: The model just needs to emit multiple tool calls in one response. VS Code handles concurrent execution automatically.
- **SubagentStart hooks**: Perfect for injecting wave-specific instructions (wave ID, coordination rules, output format) before each subagent starts.
- **SubagentStop hooks**: Can implement wave completion logic—block a subagent from stopping until aggregation criteria are met.
- **Agent name resolution**: Custom `.agent.md` files in `.github/agents/` provide the mapping. A wave orchestrator agent can dispatch to named subagents like `wave-explore`, `wave-decompose`, etc.
- **Result collection**: Results come back as `LanguageModelToolResult` text parts to the parent agent, which can then aggregate.
- **Limitation**: Subagents are stateless—each invocation is independent. No inter-subagent communication; all coordination must go through the parent.

## Open Questions

1. **Where is `runSubagent` implemented in VS Code core?** The extension only handles it as a passthrough. The actual subagent dispatch logic (creating new ChatRequest, routing to participant) lives in `microsoft/vscode`, not this repo.
2. **How does VS Code core resolve agent names to `.agent.md` files for `runSubagent`?** The extension's `CopilotCLIAgents` handles it for the Claude SDK path, but the VS Code core path for standard `runSubagent` is opaque from this codebase.
3. **Is there a limit on concurrent subagents?** No explicit limit found in the extension code. The model's parallel tool call limit and VS Code's chat request concurrency are the practical bounds.
4. **Can subagents invoke sub-subagents?** The code doesn't prevent it—`subAgentInvocationId` would nest, but trace context propagation and trajectory linking may get complex.
