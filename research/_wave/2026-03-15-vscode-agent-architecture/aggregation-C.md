# Aggregation C: Use Cases, Parallelism & Distributed Patterns

## Deduplicated Findings

### 1. Handoffs vs Subagents Are Orthogonal Mechanisms

Handoffs are **human-gated sequential transitions** (UI buttons, model switching via `model` field, full context transfer). Subagents are **model-initiated parallel workers** (tool calls, scoped context, result aggregation). The canonical pipeline is: Explore subagents for automated discovery → handoff button for human-approved implementation.

### 2. Parallelism Is Model-Driven, Not Scheduler-Driven

There is no task queue, semaphore, or concurrency scheduler. The LLM decides how many tool calls per turn. 12 hardcoded tools + all MCP tools use an **eager promise pattern** — promises start immediately with a dummy `tokenBudget: 1` before prompt-tsx renders. When the model emits N `runSubagent` calls in one turn, all N run concurrently. The outer `_runLoop` remains strictly sequential (one LLM turn at a time).

### 3. Subagent Nesting Is Capped at One Level

`subAgentInvocationId` is a flat identifier with no depth counter or `maxDepth` config. The billing guard (`wouldBeBilled = isFirstTurn && !request.subAgentInvocationId`) treats subagents as leaf operations. A subagent calling `runSubagent` itself has no architectural provision for chaining. All distributed patterns (MCP coordinator, code-server fleet, ralph multi-instance) add exactly **+1 effective level** because each VS Code instance has the same internal limit.

### 4. No Inter-Agent Communication Protocol

No ACP, shared memory, pub/sub, or message-passing exists between concurrent agents. Subagents communicate with parents only through `ExtendedLanguageModelToolResult` return values. Cross-instance coordination requires an external mechanism (MCP server, filesystem signals).

### 5. Hook System Is the Primary Extension Point

Async hooks (`SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, etc.) can inject context, block completion, modify tool input, and abort execution. "Most restrictive wins" policy for `preToolUse`. This is the most viable mechanism for wave-style orchestration control without patching the runtime.

### 6. MCP as Coordination Bus Is Architecturally Natural

MCP tools are automatically parallel (via `LanguageModelToolMCPSource` check). A custom MCP server exposing `dispatch_to_instance`, `collect_results`, and `get_status` tools could coordinate multiple VS Code instances. Each instance connects to the same server, enabling fan-out. Estimated complexity: ~200 lines of TypeScript.

### 7. Each Remote VS Code Instance Is Fully Independent

Remote windows (SSH, Dev Containers, tunnels) run separate extension hosts with independent Copilot Chat sessions, tool calling loops, and subagent budgets. They do NOT share agent state. This isolation is both a benefit (no cross-contamination) and a cost (no native coordination).

## Cross-Report Patterns

### Pattern: The Nesting Ceiling Problem

All three reports converge on the same constraint from different angles:
- **Q7** shows subagents are single-level workers that return to parent
- **Q8** confirms no dependency DAG, no fan-out/fan-in primitive, no background execution
- **Q9** demonstrates every distributed architecture adds exactly +1 level

**Implication**: Deep reasoning chains (3+ levels) require either runtime patches or chaining multiple coordination layers (MCP coordinator → VS Code instance → subagent), which compounds latency.

### Pattern: Model-as-Scheduler Creates Unpredictable Concurrency

- **Q8** reveals concurrency is driven by how many tool calls the LLM emits per turn (typically 5-15)
- **Q7** shows the parent agent decides *when* to dispatch subagents but the *count* depends on model behavior
- **Q9** notes no concurrency cap exists — limited only by API rate limits

**Implication**: Wave orchestration cannot guarantee a specific degree of parallelism. The model might emit 1 or 15 subagent calls. Prompt engineering or hook-based steering is needed for predictable fan-out.

### Pattern: Human Gates vs Automation Gates

- **Q7** defines handoffs as checkpoints where humans approve transitions
- **Q8** shows hooks can programmatically block/allow transitions (`decision: 'block'`)
- **Q9** shows ralph-loop monitors filesystem artifacts as completion signals

**Implication**: Three distinct gating mechanisms exist (UI buttons, hooks, filesystem signals). A unified gating abstraction could combine human oversight with automated orchestration — e.g., auto-approve if validation passes, surface for human review if confidence is low.

### Pattern: Context Isolation vs Context Sharing Tension

- **Q7**: Subagents get scoped context via tool call arguments (isolation by design)
- **Q8**: Each subagent gets a fresh `Conversation` (no cross-contamination)
- **Q9**: Each VS Code instance has independent agent state (no sharing)

**Implication**: Isolation prevents interference but forces redundant context gathering. A shared read-only context layer (workspace index, semantic search cache) accessible to all agents/instances would reduce duplicate work without breaking isolation.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| High | Subagent nesting capped at 1 level — blocks deep reasoning chains | Q7, Q9 | Build MCP coordinator for +1 level; investigate runtime patch for native depth support |
| High | No fan-out/fan-in primitive exists | Q8 | Implement in wave-orchestrator using eager promise pattern + result aggregation |
| High | MCP coordinator is low-cost, high-impact (~200 LOC) | Q9 | Prototype MCP server with `dispatch_task` / `collect_results` / `get_status` tools |
| High | Hook system is most viable extension point for orchestration | Q8, Q7 | Use `SubagentStart`/`SubagentStop` hooks for wave task injection and completion gating |
| Medium | Model-driven concurrency is unpredictable (1-15 parallel calls) | Q8 | Add prompt-level steering to request specific fan-out count; consider hook-based throttling |
| Medium | Handoff `model` field enables cost-optimized phase transitions | Q7 | Leverage for plan-with-expensive → implement-with-fast model switching in wave pipelines |
| Medium | No subagent-level model override at invocation time | Q7 | Propose extension: per-subagent model selection for cost-optimized fan-out |
| Medium | API quota contention with multiple parallel instances | Q9 | Investigate per-session vs per-user rate limits; implement backoff in MCP coordinator |
| Medium | File conflict risk with multi-instance edits | Q9 | Implement directory partitioning strategy — assign disjoint file sets per instance |
| Low | Headless `ToolCallingLoop` extraction for lighter-weight agents | Q9 | Evaluate complexity of decoupling loop from VS Code UI; protential for 10x resource savings |
| Low | Claude Agent SDK multi-agent patterns as alternative to instance fan-out | Q9 | Research Anthropic SDK's native orchestration capabilities |
| Low | Async handoffs (queue work for later review) not supported | Q7 | Design proposal for deferred handoff mechanism |

## Gaps

### 1. Failure Handling & Retry Semantics
None of the reports systematically cover what happens when a subagent fails, a distributed instance crashes, or an MCP coordinator loses connectivity. Q8 notes "no automatic retry" but doesn't explore recovery strategies. **Need**: Failure taxonomy, retry policies, checkpoint/resume mechanisms.

### 2. Cost Modeling & Token Economics
No report quantifies the token cost of parallelism. Parallel subagents each consume their own context window. N instances × M subagents × K tokens per context = significant API spend. **Need**: Cost model for different fan-out strategies with break-even analysis.

### 3. Observability & Debugging Multi-Agent Systems
Q8 mentions trace linking via `subAgentInvocationId` and Q9 notes ralph's filesystem monitoring, but no report addresses how to debug a distributed multi-agent system. **Need**: Distributed tracing story, log correlation across instances, visualization of agent dependency graphs.

### 4. Security & Sandboxing of Parallel Agents
No discussion of trust boundaries between parallel agents. Can a subagent escalate privileges? Can a rogue MCP coordinator inject malicious tasks? **Need**: Threat model for multi-agent architectures.

### 5. Prompt Contamination in Aggregation
When a parent agent aggregates results from N subagents, the combined context may exceed token limits or contain contradictory information. No report discusses aggregation strategies (voting, confidence-weighted merge, conflict resolution). **Need**: Aggregation patterns for multi-agent results.

### 6. Latency Profiling
Q9 mentions MCP cross-network latency (50-200ms) but no report measures end-to-end latency of subagent dispatch → execution → result return. **Need**: Latency benchmarks for single-instance subagents, MCP-coordinated instances, and cross-machine distribution.
