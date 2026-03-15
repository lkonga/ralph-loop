# Q9: Distributed VS Code for Nested Parallelism

## Findings

### 1. The Nesting Limit Is Tool-Based, Not Architectural

The depth-1 nesting limit in VS Code Copilot Chat is enforced by two mechanisms (confirmed in `aggregation-B.md`): (a) `subAgentInvocationId` presence check degrades `Codebase` to non-agentic search, and (b) subagent tool allowlist **excludes** `runSubagent`/`search_subagent`. There is no depth counter — it's a binary tool restriction. This means the constraint is per-process, not per-network. A separate VS Code instance has no knowledge of another instance's nesting depth.

### 2. VS Code Remote Architecture Supports Multi-Instance

The `vscode.proposed.resolvers.d.ts` API defines `RemoteAuthorityResolver`, `ExecServer`, `Tunnel`, and `RemoteServerConnector` interfaces. VS Code's remote model (SSH, tunnels, WSL) runs a **separate extension host process** on the remote machine. The `isFromDifferentExtensionHost` flag in `vscode.proposed.extensionsAny.d.ts` confirms extensions can detect cross-host boundaries. Each remote extension host runs Copilot Chat independently with its own agent loop, nesting counter, and tool set.

### 3. MCP Servers Are Automatically Parallel

All MCP-sourced tools bypass the sequential tool dispatch path — they use the eager promise pattern (`toolCalling.tsx` ~L312) just like `CoreRunSubagent`. `McpToolCallingLoop` in `mcp/vscode-node/` provides a self-contained tool calling loop with `toolCallLimit: 100`. MCP servers communicate via stdio or HTTP (SSE/StreamableHTTP), defined in `IMcpStdioServerConfiguration` and `IMcpRemoteServerConfiguration`. An MCP server could act as a **coordination bus** between VS Code instances.

### 4. No Shared State Between Instances

The extension maintains all state in-process: `Conversation` objects, `TrajectoryLoggerAdapter`, circuit breakers, session IDs. There is no shared database, message queue, or distributed lock. The file system is the only shared medium — PRD files, `progress.txt`, and `research-{I}.md` files serve as the de facto coordination bus (confirmed in `aggregation-B.md` Pattern C).

### 5. Ralph-Loop Already Has Multi-Instance Primitives

The `LoopOrchestrator` supports parallel task execution via `pickReadyTasks()` with DAG-aware dependency resolution and `maxConcurrencyPerStage` / `maxParallelTasks` config. Tasks execute via `Promise.all()` with per-task `taskInvocationId` (UUID), atomic git commits, and independent progress logging. The `ParallelMonitorConfig` watches for stuck tasks via mtime polling. However, all parallelism is **intra-process** — multiple Copilot commands within a single VS Code instance.

### 6. Resource Costs

| Component | RAM | CPU | API Cost |
|-----------|-----|-----|----------|
| VS Code Server (headless) | ~300-500MB | Low idle, spiky on extension load | — |
| Copilot Chat extension per instance | ~100-200MB | Per-request model calls | Full rate per session |
| code-server (browser-based) | ~400-600MB | Similar to desktop | Same |
| MCP coordination server | ~20-50MB | Negligible | — |
| **Total per additional instance** | **~500-800MB** | Moderate | **1x API rate** |

Each instance counts as a separate Copilot session for billing. API rate limits apply per-token, per-user. N instances = N× API cost for the same work.

## Patterns

### Pattern A: MCP Coordination Bus

```
┌──────────────────┐     ┌──────────────────┐
│  VS Code (local) │     │ VS Code (remote) │
│  Parent Agent    │     │  Worker Agent    │
│  ┌────────────┐  │     │  ┌────────────┐  │
│  │ MCP Client ├──┼─────┼──┤ MCP Server │  │
│  └────────────┘  │     │  └────────────┘  │
└──────────────────┘     └──────────────────┘
         │                        │
         └────────┐  ┌────────────┘
              ┌───┴──┴───┐
              │ File System│ (PRD, progress.txt)
              └───────────┘
```

An MCP server on instance B exposes tools like `submit_task`, `get_result`, `check_status`. Instance A's agent calls these MCP tools (which are auto-parallel). Instance B's agent picks up work and runs at depth 0 — no nesting limit applies because it's a fresh instance.

### Pattern B: SSH/Tailscale Remote Workers

```
ralph-loop orchestrator (local)
  ├── vscode-server@host1 (SSH) → task batch 1
  ├── vscode-server@host2 (SSH) → task batch 2
  └── vscode-server@host3 (Tailscale) → task batch 3
```

Each `vscode-server` runs headless with Copilot Chat. Ralph-loop dispatches tasks via `vscode.commands.executeCommand()` or CLI. File sync via git push/pull between nodes. Tailscale provides private mesh networking without port forwarding.

### Pattern C: Ralph-Loop Multi-Instance Orchestrator

Extend `LoopOrchestrator` with a `distributedWorkers` config:

```typescript
interface DistributedWorkerConfig {
  host: string;              // SSH target or Tailscale hostname
  workspaceRoot: string;     // Remote workspace path
  maxConcurrency: number;    // Tasks per instance
  syncStrategy: 'git' | 'rsync' | 'shared-fs';
}
```

Ralph-loop already has: DAG task scheduling (`pickReadyTasks`), per-task UUID tracking (`taskInvocationId`), parallel monitor (`ParallelMonitorConfig`), circuit breakers, and atomic commits. The missing piece is **remote dispatch** — sending a task to a different VS Code instance instead of the local one.

## Applicability

### Feasibility Assessment

| Approach | Complexity | Nesting Bypass | Cost | Verdict |
|----------|-----------|---------------|------|---------|
| MCP coordination bus | Medium | Yes — each instance at depth 0 | N× API | **Most viable** — leverages existing MCP infra |
| SSH remote workers | High | Yes — independent instances | N× API + server costs | Good for heavy workloads, overkill for research |
| code-server farm | High | Yes | N× API + hosting | Redundant with SSH approach |
| Single instance tricks | Low | No — nesting is binary | 1× API | Cannot bypass limit |

### Cost-Benefit for Wave

**Benefits**: True nested parallelism (orchestrator → sub-orchestrators → workers), N× throughput for embarrassingly parallel research, independent failure domains.

**Costs**: N× API spend, state synchronization complexity, git merge conflicts between instances, debugging distributed failures, setup/teardown overhead.

**Recommendation**: For wave's research pipeline, the **MCP coordination bus** is the sweet spot. A lightweight MCP server (~100 lines) running on the same machine can coordinate 2-3 VS Code instances. Each instance runs independently at depth 0, avoiding the nesting limit entirely. Ralph-loop's existing `ParallelMonitorConfig` and `taskInvocationId` tracking extend naturally to cross-instance monitoring.

### Ralph-Loop Integration Path

1. **Phase 1**: Add `ITaskExecutionStrategy` for remote dispatch (SSH exec of `code --goto` or direct API call)
2. **Phase 2**: Create MCP server exposing `submit_task` / `poll_result` tools
3. **Phase 3**: Extend `ParallelMonitorConfig` to poll remote `progress.txt` via SSH/HTTP
4. **Phase 4**: Add git-based state sync between instances (atomic pull before task, push after commit)

## Open Questions

1. **API rate limits**: Does Copilot enforce per-user concurrency limits that would throttle multiple instances? Unknown — would need empirical testing.
2. **Session identity**: Can multiple VS Code instances share the same GitHub authentication token, or does each need a separate seat?
3. **MCP timeout**: MCP tool calls have a timeout (implementation-dependent). Long-running subagent tasks could exceed it — would need a poll-based pattern instead of synchronous call-and-wait.
4. **Git conflict resolution**: Parallel instances writing to the same repo will create merge conflicts. Worktree-per-instance solves this but adds setup complexity.
5. **Lighter alternatives**: Could a single instance achieve pseudo-nesting by using MCP tools that internally call the Copilot API directly (bypassing the extension host)?  This avoids multi-instance overhead but may violate API terms.
6. **Headless viability**: Does `vscode-server` (headless) fully support agent mode with all tools, or does it require a GUI for some tools (e.g., `run_in_terminal`)?
