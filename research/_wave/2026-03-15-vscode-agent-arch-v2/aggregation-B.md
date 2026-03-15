# Aggregation B: Handoff Integration — Return Path, Wave Pipeline & Ralph-Loop

## Deduplicated Findings

### DF-1: Handoffs Are Same-Session, Unidirectional, Stateless Transitions
*Sources: R4, R5, R6*

Handoffs use `toggleAgentMode` with `sessionResource` to switch agent persona **within the same conversation thread**. Conversation history carries over. There is **no return path** — no `returnTo`, `previousAgent`, or undo mechanism exists. Bidirectional flow requires each agent to explicitly define a reverse handoff. No state machine tracks transitions; each agent is unaware of being "returned to."

### DF-2: `send: true` Enables Auto-Submission, Not Orchestration
*Sources: R4, R5*

`send: true` auto-submits the prompt to the target agent without user interaction. Combined with reverse handoffs, this could theoretically create A→B→A loops — but with **no termination condition or guard**, risking infinite loops. This is useful for fire-and-forget chaining (Plan → Implement), not for coordinated pipelines.

### DF-3: Handoffs Are 1:1 Sequential — No Fan-Out
*Sources: R5, R6*

A handoff transitions from exactly one source to exactly one target. No `agents: [a, b, c]` fan-out mechanism exists. No wait-for-all semantics. No result aggregation at the source. This fundamentally prevents handoffs from replacing subagent dispatch for wave's parallel research phase.

### DF-4: Two Distinct Architectural Layers
*Sources: R5, R6*

| Dimension | Handoffs | Ralph-Loop |
|-----------|----------|------------|
| Layer | Declarative YAML in `.agent.md` | Imperative `executeCommand` API |
| Topology | 1:1 sequential | Multi-task lifecycle |
| Trigger | User click / `send: true` | `LoopOrchestrator.runLoop()` |
| Context | Full conversation forwarded | Black-box file-system observation |
| Verification | None | tsc + vitest gates, circuit breakers |

### DF-5: API Integration Gap Blocks Programmatic Handoffs
*Sources: R4, R6*

- `SwitchAgentTool` only supports `modeId: 'Plan'` — hardcoded single target
- Tool is behind experiment flag `chat.switchAgent.enabled` (default `false`)
- Blocked for Claude models (Anthropic tool blocklist)
- `sessionResource` URI not exposed to extensions
- No `executeCommand` equivalent for YAML-declared handoff buttons

### DF-6: Model Switching Is a Viable Handoff Feature
*Sources: R4, R5*

The `model` property in handoff config enables changing LLM between phases. This is genuinely useful for cost optimization (cheap model for planning, expensive for implementation) and works for the **exit ramp** pattern even though it can't help mid-pipeline.

## Cross-Report Patterns

### CP-1: "Exit Ramp" Consensus
All three reports converge on the same conclusion: handoffs are useful as **post-completion transitions** (research → implement, plan → execute), not as orchestration primitives. R4 calls them "exit ramps," R5 identifies them as the existing entry mechanism for wave (`.prompt.md` with `agent:` routing), R6 confirms they're "identity routing" vs ralph-loop's "lifecycle management."

### CP-2: Complementary Layers, Not Competing
R5 and R6 independently arrive at the same architecture: handoffs operate **above** the pipeline (entry/exit), while subagent dispatch (wave) and imperative commands (ralph-loop) operate **within** it. No substitution is possible in either direction.

### CP-3: Context Bloat Risk
R4 notes conversation history preservation across handoffs; R5 warns that N=12 research outputs in conversation history could exceed model context windows. Subagent dispatch avoids this via isolation. This makes handoffs actively harmful for mid-pipeline data flow at scale.

### CP-4: Automation Gap
R4 identifies no programmatic loop capability. R5 confirms subagent dispatch is the only parallel primitive. R6 confirms ralph-loop's `executeCommand` approach is "strictly more powerful for automation." All three converge: handoffs require human clicks (except `send: true` one-shot chains).

### CP-5: Future API Expansion Is the Key Enabler
R4 asks about `returnTo` parameter potential. R5 asks about fan-out (`agents: []`). R6 asks about `toggleAgentMode` expansion, handoff events (`onDidSwitchAgent`), and `sessionResource` access. All three identify VS Code API maturation as the gating factor for deeper integration.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| P0 | Handoffs cannot replace subagent dispatch for parallel work | R5, R6 | Keep `runSubagent` as wave's core primitive; do not attempt handoff-based parallelism |
| P0 | No return path exists; loops are unsafe | R4 | Design ralph-loop phases as independent tasks, not handoff chains |
| P1 | Handoffs work as exit ramps post-pipeline | R4, R5 | Implement "Start Implementation" handoff button on wave FINAL-REPORT output |
| P1 | Ralph-loop cannot trigger handoffs programmatically | R6 | Use `executeCommand('workbench.action.chat.openEditSession')` — don't depend on handoff APIs |
| P2 | Model switching via handoffs is useful at boundaries | R4, R5 | Use `model` property for exit ramp handoffs (e.g., cheap model → expensive for implementation) |
| P2 | Generate task-specific `.agent.md` with custom handoffs | R6 | Ralph-loop creates per-task agent files with verification handoff buttons |
| P3 | Monitor `toggleAgentMode` API expansion | R4, R6 | Track VS Code Insiders for arbitrary `modeId` support and event APIs |
| P3 | Context bloat risk with handoff chains | R4, R5 | Prefer subagent isolation over handoff-based context forwarding for multi-step flows |

## Gaps

1. **No empirical testing of `send: true` chains** — All three reports analyze code statically. No report tested actual A→B→A auto-submit behavior to confirm infinite loop risk or measure latency.

2. **`showContinueOn` semantics remain unclear** — R4 notes it controls UI visibility but the exact VS Code core rendering logic is outside the extension codebase. No report traced into `microsoft/vscode` to resolve this.

3. **GitHub issue #301697 unresolved** — R4 flags this issue as potentially in the VS Code core repo. No report verified its existence or content.

4. **Autopilot + handoffs convergence untested** — R6 notes `permissionLevel: 'autopilot'` may subsume some handoff use cases, but no report analyzed how autopilot mode interacts with handoff buttons or `send: true`.

5. **Custom `ChatCustomAgentProvider` path unexplored** — R6 mentions ralph-loop could register as a custom agent provider with handoffs, but no report investigated the registration API or feasibility.

6. **Handoff event hooks missing from VS Code** — R6 identifies `onDidSwitchAgent` as valuable for ralph-loop integration. No report confirmed whether this is planned or proposed in VS Code's API roadmap.

7. **Cost/latency tradeoffs of model switching** — R5 and R4 identify model switching as viable, but no report quantified the actual cost savings or latency impact of switching models at handoff boundaries vs within subagent definitions.
