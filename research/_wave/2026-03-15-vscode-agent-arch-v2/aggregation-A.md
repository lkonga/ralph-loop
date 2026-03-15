# Aggregation A: Tool Configuration, Nesting & Handoff Architecture

## Deduplicated Findings

### F1: Tool Resolution Pipeline (R1, R2)
Tools are resolved through a single pipeline: frontmatter `tools:` → `request.tools` map → `getEnabledTools()` filter chain. Priority order: model overrides > explicit disable > consumer filter > cross-enablement tags > frontmatter enable > default exclude. Both R1 and R2 confirm this pipeline applies uniformly to parent agents and subagents — each agent uses its **own** frontmatter tools, no inheritance occurs.

### F2: Two Distinct Subagent Mechanisms (R1, R2)
| Mechanism | Tool | Tool Set | Nesting |
|-----------|------|----------|---------|
| `runSubagent` (VS Code core) | `CoreRunSubagent` | Agent's own frontmatter — **full tool access** | Blocked at depth 1 by platform stripping `runSubagent` from subagent requests |
| `SearchSubagentToolCallingLoop` | `search_subagent` | Hardcoded 4 read-only tools (`semantic_search`, `file_search`, `grep_search`, `read_file`) | Structurally impossible — `runSubagent` not in allowlist |

### F3: Depth-1 Hard Enforcement (R2)
Three coordinated mechanisms enforce single-level fan-out — no depth counter exists:
1. **Tool set restriction**: `allowedSearchTools` whitelist (search subagent)
2. **Boolean gate**: `subAgentInvocationId` presence check blocks nested agentic loops in `codebaseTool.tsx`
3. **Platform filtering**: VS Code core strips `runSubagent` from subagent requests

Not configurable. No `maxDepth`, no experiment flag, no frontmatter override.

### F4: `subAgentInvocationId` Triple Duty (R2)
Single ID serves as: (a) nesting prevention boolean gate, (b) trajectory linking for parent↔child traces, (c) billing classification (`userInitiatedRequest: false`).

### F5: Handoff = Declarative Agent Switching (R3)
Frontmatter `handoffs:` key defines UI buttons rendered by VS Code core. Schema: `{agent, label, prompt}` required + optional `{send, showContinueOn, model}`. Context transfer is via prompt string injection + conversation history — no explicit state/memory transfer.

### F6: SwitchAgentTool = Programmatic Agent Switching (R3)
`switch_agent` tool is model-invoked (not user-initiated), currently hardcoded to Plan agent only, feature-gated behind `chat.switchAgent.enabled` (default: false). Injects full agent body text for persona adoption.

### F7: Parallel Subagent Dispatch Supported (R2)
`toolsCalledInParallel` set includes `CoreRunSubagent` — multiple `runSubagent` calls in a single model response execute concurrently.

### F8: Built-in Agent Tool Profiles (R1)
| Agent | Base Tools | Extras |
|-------|-----------|--------|
| Explore | `DEFAULT_READ_TOOLS` (search, read, web, memory, github, terminal output, test failure) | — |
| Plan | `DEFAULT_READ_TOOLS` | + `agent` (subagent invocation) |
| Ask | `DEFAULT_READ_TOOLS` | — |
| Agent (main) | Full set via `getAgentTools()` | edit, terminal, etc. |

## Cross-Report Patterns

### P1: Structural Security Over Runtime Checks
All three reports confirm VS Code uses **structural enforcement** — tools simply aren't available rather than runtime depth/permission counters. Tool allowlists (R1, R2), platform-level tool stripping (R2), and UI-rendered handoff buttons (R3) all prevent invalid operations by never offering them.

### P2: No Inheritance, Explicit Declaration Required
Tool sets (R1), nesting permissions (R2), and handoff definitions (R3) all follow the same pattern: each agent must explicitly declare its configuration. Nothing propagates from parent to child except `subAgentInvocationId` (which restricts, not enables).

### P3: Dual-Mode Agent Transitions
Two parallel systems exist for agent switching: declarative handoffs (user-facing buttons, R3) and programmatic switching (`SwitchAgentTool`, R3). Combined with `runSubagent` (R1/R2), there are three agent composition mechanisms with different scopes:
- `runSubagent`: task delegation (child returns results to parent)
- `handoffs`: workflow transition (switches active mode entirely)
- `SwitchAgentTool`: programmatic transition (model-initiated mode switch)

### P4: Fan-Out is the Canonical Multi-Agent Pattern
Depth-1 nesting (R2) + parallel dispatch support (R2) + per-agent tool sets (R1) = the architecture strongly favors **single-level parallel fan-out** from an orchestrator, not deep chains.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| **P0** | Custom agents via `runSubagent` get full frontmatter tools (not limited to 4) | R1§4A | Design wave coder agents with explicit `tools:` including edit+terminal |
| **P0** | Depth-1 hard limit — no deeper nesting possible | R2§4 | Flatten all multi-hop research into orchestrator re-dispatch loops |
| **P0** | Parallel `runSubagent` calls supported | R2§Applicability | Use parallel fan-out as primary wave research pattern |
| **P1** | Each subagent needs explicit `tools:` — no inheritance | R1§Patterns | Every `.agent.md` must declare its complete tool set |
| **P1** | Handoffs enable Plan→Agent workflow transitions with model override | R3§4 | Use handoffs for plan→implement transitions, specify model per phase |
| **P1** | `subAgentInvocationId` disables `Codebase` agentic mode inside subagents | R2§1B | Subagent semantic search returns direct results only — account for this in prompt design |
| **P2** | `SwitchAgentTool` exists but is gated + Plan-only | R3§5 | Monitor for generalization; don't depend on it yet |
| **P2** | `agents:` frontmatter key controls which subagents parent can invoke | R2§3 | Use as allowlist for multi-agent compositions |
| **P2** | Stale handoff buttons on settings change | R3§OpenQ3 | Design prompts to handle model override failures gracefully |
| **P3** | `PlanAgentAdditionalTools` / `AskAgentAdditionalTools` settings extend built-ins | R1§5 | Potential extension point for adding tools to built-in agents |

## Gaps

### G1: Tool Name Mapping Table
R1 notes the exact mapping between frontmatter short names (`edit`, `terminal`, `search`) and internal `ToolName` enum values lives in VS Code core — **not documented in extension source**. Needed to write correct frontmatter.

### G2: `permissionLevel` Propagation to Subagents
R1 asks whether `request.permissionLevel` (e.g., `autopilot`) propagates to subagents. The `task_complete` tool is gated on this. If subagents don't inherit autopilot permission, they can't autonomously complete tasks.

### G3: MCP Tools in Subagent Frontmatter
R1 identifies `GithubPromptHeaderAttributes.mcpServers` but the interaction between MCP tool references and the subagent tool pipeline is undocumented.

### G4: Handoff UI Rendering Implementation
R3 confirms button rendering lives in VS Code core (`microsoft/vscode`), not the extension. Full click-handling, mode-switching, and prompt-injection details require core source inspection.

### G5: `showContinueOn` vs `send` Semantics
R3 notes ambiguity: comment says "treated exactly like send" but it's a separate boolean field. Likely controls a "Continue on [agent]" UI affordance vs. auto-submission. Behavior unverified.

### G6: Conversation State Across Handoffs
R3 confirms no explicit state/memory transfer during handoffs — only conversation history provides continuity. Unclear if tool results, pending edits, or in-progress plans survive handoff transitions.

### G7: Subagent Token/Output Limits
R2 identifies timeout cascading risk but doesn't document per-subagent token limits or max output length. Relevant for sizing wave research agents' expected output.
