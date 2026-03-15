# Aggregation A: Context Transfer, Tool Access & Conditional Implementation

## Deduplicated Findings

### F1: Session Continuity Is Guaranteed via `sessionResource` URI
Both handoff paths (frontmatter buttons and `SwitchAgentTool`) pass `sessionResource` to `toggleAgentMode`, preserving the full conversation thread. Disk session resources (8h TTL) also survive. The handoff prompt is **additive** — a new user turn on top of existing history, not a replacement. *(R1, R3)*

### F2: `runSubagent` Grants Full Tool Access — No Stripping
Coder agents dispatched via `runSubagent` inherit exactly the tools declared in their `.agent.md` frontmatter. No restriction/filtering code exists. This includes `edit/editFiles`, `execute/runInTerminal`, `edit/createFile`, `search`, and the `agent` tool for sub-delegation. *(R2)*

### F3: `search_subagent` Is Read-Only — Not Suitable for Implementation
`SearchSubagentToolCallingLoop` explicitly filters to grep/glob/semantic search tools. It runs inline within the parent, not as a separate session. Use `runSubagent` for any write operations. *(R2)*

### F4: LLM Tool Calls Are Already Conditional
The `ToolCallingLoop` lets the LLM decide which tools to call per turn. No special gating logic is needed for optional dispatch — clear conditional instructions in the agent prompt suffice. *(R3)*

### F5: Two Handoff Trigger Paths Exist
1. **Frontmatter `handoffs:`** — UI buttons, user-gated, supports `send: true` for auto-submit
2. **`SwitchAgentTool`** — programmatic, LLM-driven, currently limited to Plan agent target

Both use the same `toggleAgentMode` command with `sessionResource`. *(R1, R3)*

### F6: IHandOff Contract Fields
`agent`, `label`, `prompt`, `send` (auto-submit), `showContinueOn`, `model` (optional override). Fully sufficient for wave orchestrator → coder handoff. *(R1)*

### F7: Coder Has 8k Output Token Cap
The coder agent's mode instructions hard-cap output at 8k tokens. Large implementation plans must be split across multiple coder dispatches. *(R2, R3)*

## Cross-Report Patterns

| Pattern | Reports | Significance |
|---------|---------|-------------|
| `sessionResource` is the universal context bridge | R1, R2, R3 | All handoff/subagent paths preserve context through this single mechanism |
| Token budget is the real constraint, not handoff mechanics | R1, R2, R3 | Context survives handoff but may be truncated by prompt-tsx token budgeting in the new agent |
| `runSubagent` = full session, `search_subagent` = restricted | R2, R3 | Critical distinction — wrong tool choice breaks implementation capability |
| LLM conditional logic replaces programmatic gating | R1, R3 | No code changes needed for conditional dispatch — agent instructions are sufficient |
| Prompt is additive across all transitions | R1, R3 | FINAL-REPORT content in conversation history is visible to the next agent |

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| **P0** | `runSubagent` must be used (not `search_subagent`) for coder dispatch | R2 | Ensure orchestrator uses `agent` tool (maps to `runSubagent`) for implementation |
| **P0** | Add `--implement` flag to wave-explore-fast | R3 | Add flag + Step 5 conditional coder dispatch in orchestrator/prompt instructions |
| **P0** | Context survives handoff — no special serialization needed | R1 | No work required; FINAL-REPORT in conversation history is automatically visible |
| **P1** | Add `handoffs:` frontmatter to orchestrator as user-gated fallback | R1, R3 | Add `handoffs: [{label: "Implement Changes", agent: coder, prompt: "...", send: false}]` |
| **P1** | Split large plans for 8k coder output cap | R2, R3 | Orchestrator instructions should chunk action items into phases for multiple coder dispatches |
| **P1** | Hybrid pattern (Pattern C) — auto-detect + `askQuestions` confirmation | R3 | Add `askQuestions` step before coder dispatch when `--implement` is set |
| **P2** | Token budget re-rendering on agent switch | R1 | Investigate whether prompt-tsx re-budgets and drops older turns post-handoff |
| **P2** | Multi-hop handoff depth limits | R1 | Test orchestrator → coder → sub-coder chains for depth ceiling |
| **P3** | Post-implementation verification subagent | R3 | Design a verify step that runs tests after coder completes |
| **P3** | `--implement` + `--direct` mode incompatibility | R3 | Document that `--implement` requires aggregate mode (needs FINAL-REPORT.md) |

## Gaps

1. **Token budgeting across handoffs** — All three reports flag this. Does prompt-tsx re-render the context window on agent switch, potentially dropping critical earlier turns? No codebase evidence available (logic is in VS Code core, not the extension).

2. **`runSubagent` parallelism** — R2 asks whether multiple `runSubagent` calls run concurrently or serialize. Unknown — affects multi-phase implementation dispatch strategy.

3. **Approval propagation** — R2 flags that `permissionLevel: 'autoApprove'` inheritance to `runSubagent` children is unverified. If not inherited, coder subagents would block on file edit approvals.

4. **Rollback on implementation failure** — R3 raises this. No mechanism exists for reverting partial coder changes if implementation fails mid-way. Git stash/branch strategies could mitigate but aren't documented.

5. **Context inheritance depth** — R2/R4 intersection: how much of the parent's file-read and edit history is visible to a `runSubagent` child? Unclear whether it starts with a clean context or inherits the parent's tool call history.

6. **`SwitchAgentTool` target restriction** — R1 notes it currently only supports switching to Plan agent. Extending to coder/custom agents for programmatic handoff is not yet possible without changes.

7. **Scope control for large refactors** — R3 flags risk of coder making broad changes. No "implement only P0 items" filtering mechanism exists beyond prompt instructions.
