# Aggregation C: Use Cases, Parallelism & Distributed Architecture

## Deduplicated Findings

### DF1: Handoffs and Subagents Are Complementary, Not Redundant
Handoffs are **user-facing transition buttons** (inter-phase, sequential, human-gated). Subagents are **model-invoked nested tool calls** (intra-phase, parallel-eligible, autonomous). Both support a `model` field but at different control levels: handoffs override the *target* agent's model at transition time; agents set their *own* default model. (R7)

### DF2: Parallelism Is Model-Driven via Eager Promise Pattern
The extension has no scheduler. The LLM decides parallelism by emitting multiple tool calls per round. A hardcoded `toolsCalledInParallel` set (read-only tools, `CoreRunSubagent`, all MCP tools) gets eagerly-started promises with trivial `tokenBudget: 1`. Non-parallel tools are deferred to sequential rendering. (R7, R8)

### DF3: Subagents Are Nested ToolCallingLoops, Not Processes
`SearchSubagentTool` spawns a child `ToolCallingLoop` with its own `Conversation`, `Turn`, and `subAgentInvocationId` (UUID). Results flow back as `LanguageModelToolResult`. No IPC, no separate process — it's all in-memory within the extension host. (R7, R8)

### DF4: Nesting Is Depth-1 Binary, Not Architectural
Nesting limit is enforced by: (a) `subAgentInvocationId` presence check degrades `Codebase` tool, and (b) subagent tool allowlist excludes `runSubagent`. No depth counter exists — a separate VS Code instance resets to depth 0. (R8, R9)

### DF5: MCP Tools Are Auto-Parallel and Cross-Instance Capable
All MCP-sourced tools bypass sequential dispatch via the same eager promise pattern. MCP servers communicate over stdio or HTTP (SSE/StreamableHTTP). An MCP server can bridge VS Code instances, acting as a coordination bus. (R8, R9)

### DF6: Hook System Provides Async Lifecycle Interception
Seven hook types (`SessionStart`, `SubagentStart`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `UserPromptSubmit`) execute as async shell commands with JSON I/O. `Stop` hook can force continuation — structurally similar to wave's task-not-done detection. (R8)

### DF7: File System Is the De Facto Coordination Bus
No shared state exists between instances — no DB, message queue, or distributed lock. The file system (PRD, `progress.txt`, markdown files) is the only cross-instance medium. Ralph-loop already uses this pattern with atomic git commits. (R9)

### DF8: Multi-Instance Costs Scale Linearly
Each additional VS Code instance costs ~500-800MB RAM and 1× API rate. N instances = N× API cost. Billing is per-session. This makes the MCP coordination bus (medium complexity, leverages existing infra) the most viable distributed approach over SSH farms or code-server clusters. (R9)

---

## Cross-Report Patterns

### CP1: Three-Tier Control Hierarchy (R7 + R8)
The architecture reveals three distinct control mechanisms at different granularities:
- **Macro**: Handoffs (user-controlled phase transitions between agents)
- **Meso**: SwitchAgent (model-initiated mode change within conversation)
- **Micro**: Subagents (model-invoked parallel workers within a turn)

Each tier has different model-switching semantics, state-passing mechanisms, and user visibility.

### CP2: Parallelism Without Coordination (R8 + R9)
A consistent gap across both async and distributed investigations: parallel tools/subagents race independently with **no fan-out/fan-in primitive, no shared state, and no inter-agent messaging**. Coordination only happens implicitly through prompt rendering (results collected during sequential await) or explicitly through the file system. This works for independent read-only tasks but fails for dependent workflows.

### CP3: Token Budget vs Parallelism Trade-off (R7 + R8)
Parallel tools receive `tokenBudget: 1` (trivial), sacrificing output size optimization for concurrent execution. Subagents, being full ToolCallingLoops, have their own token management but cannot be sized from the parent. This creates a blind spot: the parent has no way to control how much context parallel children consume.

### CP4: MCP as Universal Extension Point (R8 + R9)
MCP surfaces in both parallelism (auto-parallel dispatch) and distribution (cross-instance coordination bus). It's the only mechanism that's simultaneously: parallel-eligible, cross-process capable, protocol-standardized, and extensible. This makes it the natural foundation for any future coordination layer.

### CP5: Eager Promise Pattern Extends to Distribution (R8 + R9)
The eager promise pattern (start immediately, await during collection) that enables intra-instance parallelism maps directly to distributed dispatch: start tasks on remote instances immediately, poll for results during synthesis. Ralph-loop's `ParallelMonitorConfig` (mtime polling) is already the distributed equivalent.

---

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| P0-Critical | Nesting is depth-1 binary — blocks recursive orchestration | R8, R9 | Design around it: MCP bus gives each instance depth-0; don't try to hack deeper nesting |
| P0-Critical | No fan-out/fan-in primitive exists | R8, R9 | Build coordination layer: MCP `submit_task`/`poll_result` server (~100 lines) |
| P1-High | Handoff `prompt` is text-only — lossy state transfer | R7 | For ralph-loop: pass structured state via file references (task IDs, paths) not inline text |
| P1-High | Token budget bypass for parallel tools | R8 | Accept trade-off for read-only tools; implement result-truncation in ralph-loop's aggregation step |
| P1-High | File system is the only cross-instance coordination medium | R9 | Formalize git-based sync protocol; add worktree-per-instance to avoid merge conflicts |
| P2-Medium | SwitchAgent only supports Plan target | R7 | Not blocking for ralph-loop; monitor for upstream generalization |
| P2-Medium | No subagent model override at call site | R7 | Work around via agent config defaults; propose upstream enhancement |
| P2-Medium | Hook system can emulate wave orchestration patterns | R8 | Prototype `Stop` hook as task-not-done detector in ralph-loop |
| P2-Medium | MCP coordination bus is most viable distributed approach | R9 | Phase 1: implement single-machine MCP coordinator; Phase 2: extend to SSH remote |
| P3-Low | No conditional/dynamic handoffs | R7 | Low urgency — static handoffs sufficient for current plan→implement flow |
| P3-Low | API rate limits for multi-instance unknown | R9 | Empirical testing with 2-3 instances before scaling further |
| P3-Low | Headless vscode-server agent mode completeness unknown | R9 | Test `code serve-web` with full agent tool set |

---

## Gaps

### G1: Empirical Concurrency Data Missing
No report tested actual parallel tool execution timings, throughput, or failure rates. All findings are from static code analysis. Real-world behavior under load (API throttling, memory pressure, race conditions) is unknown.

### G2: Multi-Instance Session Identity Unresolved
Can multiple VS Code instances share one GitHub auth token? Do they count as separate Copilot seats? This directly impacts cost modeling for distributed approaches.

### G3: MCP Timeout Behavior for Long Tasks
MCP tool calls have implementation-dependent timeouts. Long-running subagent tasks (multi-minute research) could exceed them. Poll-based patterns are mentioned but not designed.

### G4: Git Conflict Resolution Strategy Undefined
Parallel instances writing to the same repo create merge conflicts. Worktree-per-instance is suggested but adds setup complexity. No concrete strategy for conflict detection, resolution, or prevention.

### G5: Handoff→Subagent Bridge Missing
Subagents cannot trigger handoffs; handoffs cannot spawn subagents. The two mechanisms are isolated. A "subagent recommends handoff" pattern could enable richer workflows but doesn't exist.

### G6: Hook-Based Orchestration Untested
The `Stop` hook's ability to force continuation mirrors wave's task-not-done pattern, but no prototype validates this approach. `PreToolUse`/`PostToolUse` as approval gates are theoretical.

### G7: Distributed Debugging Story Absent
No discussion of how to debug failures across distributed VS Code instances — no centralized logging, no distributed tracing beyond per-instance OpenTelemetry, no replay capability.
