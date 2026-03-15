# Q9: Distributed VS Code for Nested Parallelism

## Findings

### 1. VS Code Copilot Chat Subagent Architecture (Single-Instance)

The Copilot Chat extension implements subagents via the `runSubagent` tool (`ToolName.CoreRunSubagent`) and `search_subagent` (`ToolName.SearchSubagent`), registered as core tools in `src/extension/tools/common/toolNames.ts`. Subagents are tracked by a `subAgentInvocationId` (a unique string per invocation) on `ChatRequest`, with `parentRequestId` linking back to the parent. The `ToolCallingLoop` (in `src/extension/intents/node/toolCallingLoop.ts`) executes `SubagentStart` and `SubagentStop` hooks to inject context and control continuation.

**Critical limitation**: Subagent nesting is single-level. The `subAgentInvocationId` is a flat identifier—there is no `depth` counter, no `maxDepth` config, and no recursive invocation support. A subagent that tries to call `runSubagent` itself would create a new request but there is no architectural provision for chaining these beyond one level. The billing guard (`wouldBeBilled = isFirstTurn && !request.subAgentInvocationId`) confirms subagents are treated as leaf operations.

### 2. Remote Agents (GitHub Platform Agents)

`RemoteAgentContribution` in `src/extension/conversation/vscode-node/remoteAgents.ts` registers **cloud-hosted agents** fetched from the CAPI endpoint. These are GitHub Marketplace agents (e.g., `@github`) that run server-side—they are NOT remote VS Code instances. They use `RemoteAgentChatEndpoint` for communication via HTTP. This pattern provides external agent delegation but does not help with local nested parallelism.

### 3. VS Code Remote Architecture (Resolvers & Tunnels)

`vscode.proposed.resolvers.d.ts` defines the full remote development stack: `RemoteAuthorityResolver`, `Tunnel`, `TunnelFactory`, etc. This enables SSH remotes, Dev Containers, and WSL. Each remote window runs a separate **extension host** process (`extensionHostEnv` in resolver config). The Copilot Chat extension already detects "another extension host" materialization (node-pty shim, ripgrep shim code).

**Key insight**: Each remote VS Code window = independent extension host = independent Copilot Chat instance with its own agent session, tool calling loop, and subagent budget. They do NOT share agent state.

### 4. MCP as Coordination Layer

The extension's MCP integration (`src/extension/mcp/`) supports `stdio` and (via VS Code core) `sse` transports for connecting to MCP servers. MCP servers are per-workspace configuration. There is no built-in MCP-to-MCP bridging or cross-instance coordination protocol in the Copilot Chat codebase.

However, MCP's design is inherently suitable as a coordination bus: a custom MCP server could expose tools like `dispatch_to_instance(instance_id, prompt)` and `collect_results(task_id)`. Each VS Code instance connects to the same MCP server, enabling fan-out patterns.

### 5. Ralph-Loop Orchestrator

`src/orchestrator.ts` implements a single-instance loop orchestrator with `ParallelMonitorConfig` for stale-detection and `pickReadyTasks` for task selection. It operates within one VS Code window via the Copilot command API. There is no multi-instance awareness, no IPC, and no cross-process coordination. It uses `CopilotCommandStrategy` which sends commands to the local VS Code chat panel.

## Patterns

### Pattern A: Multi-Instance Fan-Out via MCP Coordinator

```
┌─────────────────────────────────────────────┐
│           MCP Coordination Server           │
│  (task queue, result aggregation, health)    │
└──────┬──────────┬──────────┬───────────────┘
       │          │          │
   ┌───┴───┐  ┌──┴────┐  ┌──┴────┐
   │VS Code│  │VS Code│  │VS Code│
   │Inst 1 │  │Inst 2 │  │Inst 3 │
   │(agent)│  │(agent)│  │(agent)│
   └───────┘  └───────┘  └───────┘
```

- Each instance runs its own Copilot agent session with full subagent budget (1 level deep)
- MCP server provides `get_next_task`, `submit_result`, `get_status` tools
- Coordinator manages task dependencies and aggregation
- Achieves effective nesting: Coordinator → Instance → Subagent (2 levels)

### Pattern B: code-server / VS Code Server Headless Instances

- `code-server` or `code tunnel` can run headless VS Code instances accessible via CLI
- Each instance has independent Copilot Chat with full agent capabilities
- Can be spawned on-demand via SSH (local or Tailscale)
- Resource cost: ~200-500MB RAM per instance, plus model API quota per agent

### Pattern C: Ralph-Loop as External Orchestrator

- Ralph-loop could spawn/manage multiple VS Code instances via CLI
- Each instance gets a task dispatched through ralph's PRD/progress mechanism
- Ralph monitors filesystem artifacts (progress.txt, git commits) for completion signals
- Already has `ParallelMonitorConfig` and stale detection infrastructure

## Applicability

### Feasibility for Wave Architecture

**HIGH feasibility** for Pattern A (MCP coordinator):
- Wave already uses MCP tools extensively
- A coordination MCP server is ~200 lines of TypeScript (task queue + SSE transport)
- Each wave agent instance gets full tool budget including subagents
- Effective nesting becomes: wave-orchestrator → instance-agent → subagent (2 levels vs current 1)
- Tailscale integration is straightforward: VS Code instances on different machines, MCP server on any reachable host

**MEDIUM feasibility** for Pattern C (ralph-loop external):
- Ralph already monitors filesystem signals; extending to multi-instance is architectural rather than fundamental
- Missing: IPC mechanism for dispatching tasks and collecting results
- Would need: a `MultiInstanceStrategy` alongside existing `CopilotCommandStrategy`

### Cost-Benefit Analysis

| Approach | Setup Cost | Runtime Cost | Parallelism Gain | Nesting Gain |
|----------|-----------|-------------|-------------------|--------------|
| MCP Coordinator | Low (1 new MCP server) | Medium (shared API quota) | High (N instances) | +1 level |
| code-server fleet | Medium (infra setup) | High (RAM per instance) | High | +1 level |
| Ralph multi-instance | Medium (new strategy) | Medium | Medium | +1 level |
| Single instance (baseline) | None | Low | 1 (sequential subagents) | 1 level |

**Key constraint**: All approaches add exactly +1 nesting level because each VS Code instance still has the same single-level subagent limit internally. True deep nesting (3+ levels) would require either patching the agent runtime or chaining multiple coordination layers.

## Open Questions

1. **API quota sharing**: Multiple VS Code instances hitting Copilot APIs simultaneously—does the GitHub token rate limit apply per-session or per-user? Could hit 429s with >3 parallel agents.

2. **State coherence**: If two instances edit the same file simultaneously, git conflicts are inevitable. Need a file-locking or partition strategy (assign different files/directories per instance).

3. **Lightweight alternative**: Instead of full VS Code instances, could a headless `ToolCallingLoop` be extracted from Copilot Chat and run as a standalone Node.js process? The loop is mostly API calls + tool execution—the VS Code UI is overhead for pure agent work.

4. **Tailscale multi-machine**: Distributing instances across machines via Tailscale is technically trivial (SSH + code tunnel). The real question is latency: MCP tool calls crossing network boundaries add 50-200ms per round-trip vs local ~1ms.

5. **Session persistence across instances**: If one instance crashes, can another pick up its task? Ralph's filesystem-based progress tracking provides a natural checkpoint mechanism, but Copilot agent sessions themselves are ephemeral and non-transferable.

6. **Claude Agent SDK**: The `src/extension/agents/claude/` integration uses Anthropic's Claude Agent SDK. Could this SDK's own multi-agent patterns be leveraged instead of VS Code instance fan-out? Worth investigating as potentially lighter-weight.
