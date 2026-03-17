# Research Report 9: Wave Prompt Files and Agent Integration

**Question**: What prompt files exist for wave operations (wave-explore-fast, wave-parallel-lock, wave-return-to-agent), and how do they integrate with the agent system as entry points and handoffs?

---

## Findings

### Three Wave Prompt Files

All three live in `vscode-config-files/prompts/` (mirrored to `ralph-loop/prompts/`):

#### 1. `wave-explore-fast.prompt.md` — Primary Entry Point

- **Frontmatter**: `name`, `description`, `argument-hint`, `agent: wave-orchestrator`, `model`
- **Role**: User-facing entry point. The `agent:` field routes execution to the `wave-orchestrator` agent. The prompt body is minimal — "Entry point. All logic lives in the `wave-orchestrator` agent."
- **argument-hint**: `<1-12> [--direct|--same|--aggregate=K|--ralph-prd] topic` — communicates valid syntax to the VS Code chat UX
- **Mechanism**: When user runs `/wave-explore-fast 6 auth patterns`, VS Code reads the `agent: wave-orchestrator` frontmatter field, switches to that agent mode, and passes `$ARGUMENTS` through. The prompt is a thin routing shim.
- **Flags**: `--direct` (inline synthesis), `--same` (identical prompt), `--aggregate=K`, `--ralph-prd` (6-phase pipeline)

#### 2. `wave-return-to-agent.prompt.md` — Handoff Exit Point

- **Frontmatter**: `name`, `description` only — no `agent:` field
- **Role**: Mode-switching command that returns from wave-orchestrator back to default Agent mode
- **Body**: "Wave exploration complete. Resuming default Agent mode." plus guidance to use `research/_wave/` results
- **Integration**: Referenced by wave-orchestrator at the end of aggregate and ralph-prd flows: `> Run /wave-return-to-agent to switch back to Agent mode.`
- **This mirrors the orchestrator's frontmatter `handoffs:` entry** which declares `agent: agent` with `send: true` — both mechanisms serve the same exit purpose

#### 3. `wave-parallel-lock.prompt.md` — Reference Documentation

- **Frontmatter**: None (no YAML frontmatter at all)
- **Role**: Documentation-only prompt. Describes a lock file protocol for conflict-free parallel file editing across git worktrees
- **Not agent-routed**: No `agent:` field, no `argument-hint` — this is a reference pattern, not an executable workflow
- **Content**: Lock file schema (`/tmp/<project>-<file>.lock`), workflow for sequential file access between subagents, merge order strategy, subagent prompt template for lock-aware dispatching
- **Use case**: Relevant when multiple wave subagents need to edit the same file — provides the coordination protocol

### Agent-Prompt Integration Architecture

The wave system uses a **3-tier architecture** for prompt-to-agent routing:

| Layer | File | Purpose |
|-------|------|---------|
| **Entry prompt** | `wave-explore-fast.prompt.md` | User-facing command with `agent:` routing |
| **Orchestrator agent** | `wave-orchestrator.agent.md` | Coordination engine, dispatches subagents |
| **Exit prompt** | `wave-return-to-agent.prompt.md` | Returns to default mode |

The orchestrator agent (`wave-orchestrator.agent.md`) declares:
- `agents:` list — 7 subagents it can dispatch (decompose, researcher, group-aggregator, master-aggregator, context-grounder, spec-generator, prd-generator)
- `handoffs:` — explicit handoff back to `agent` mode with `send: true`
- `hooks:` — `SubagentStart` and `Stop` lifecycle hooks via Python scripts
- `user-invocable: true` — can also be invoked directly, not just via the prompt

### Frontmatter Field Roles

- **`agent:`** (in prompts) — Routes execution to a named agent. This is how prompts become entry points.
- **`argument-hint:`** (in prompts) — Syntax hint shown in VS Code chat input. Defines parameter shape.
- **`agents:`** (in agents) — List of subagents this agent can dispatch via `runSubagent`
- **`handoffs:`** (in agents) — Declares explicit mode transitions with label, target agent, prompt, and auto-send behavior
- **`user-invocable:`** (in agents) — Whether the agent appears in agent picker or only via subagent dispatch

---

## Patterns

1. **Thin entry point pattern**: Prompts serve as routing shims — they declare `agent:` in frontmatter and pass `$ARGUMENTS` through. Zero logic in the prompt body.

2. **Symmetric entry/exit**: `wave-explore-fast` enters the orchestrator; `wave-return-to-agent` exits it. The orchestrator's `handoffs:` frontmatter also declares this exit, creating dual exit paths (prompt command + handoff declaration).

3. **Documentation-as-prompt**: `wave-parallel-lock` has no frontmatter — it's a reference pattern stored alongside executable prompts. This allows agents and users to reference coordination protocols without them being executable commands.

4. **Orchestrator-as-hub**: All subagent dispatch logic lives in the orchestrator, not in the entry prompt. The prompt → orchestrator → subagent chain keeps prompts simple and logic centralized.

5. **argument-hint as contract**: The `argument-hint` field serves as both UX guidance and implicit API contract — `<1-12> [flags] topic` defines the parameter shape the orchestrator expects.

---

## Applicability to Ralph

- **Entry point pattern is directly reusable**: Ralph can use `agent:` frontmatter in `.prompt.md` files to route to executor agents — same thin-shim pattern
- **Handoff declarations**: The `handoffs:` frontmatter with `agent: agent` and `send: true` provides automatic mode switching — useful for ralph task completion flows
- **argument-hint for UX**: ralph-specific prompts should declare `argument-hint` to communicate expected input shapes to users
- **Documentation prompts**: The `wave-parallel-lock` pattern (no frontmatter, pure reference) is useful for storing coordination protocols that agents should reference but not execute as commands
- **Orchestration centralization**: Ralph's PRD-driven execution could follow the same pattern — thin entry prompt → executor agent → subagent dispatch

---

## Open Questions

1. **Prompt mirroring**: Both `vscode-config-files/prompts/` and `ralph-loop/prompts/` contain identical wave prompt files. Is this symlinked or manually synced? Affects where ralph should define its own prompts.

2. **wave-parallel-lock adoption**: The lock protocol is documented but it's unclear which actual wave runs use it. Is it actively used or aspirational?

3. **Dual exit paths**: The orchestrator declares both a `handoffs:` exit AND references `/wave-return-to-agent` prompt. Are these redundant or do they serve different UX paths (handoff button vs. slash command)?

4. **model field inheritance**: `wave-explore-fast` sets `model:` in its frontmatter. Does this override the orchestrator's own `model:` field, or does the `agent:` routing ignore the prompt's model?
