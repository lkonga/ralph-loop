# Final Report: VS Code Prompt Frontmatter Visibility Controls

**Date**: 2026-03-15
**Sources**: 6 research reports + 2 aggregation reports
**Scope**: Can VS Code `.prompt.md` files be hidden from users? What frontmatter properties are supported?

---

## Executive Summary

**`.prompt.md` files have NO visibility/hidden mechanism.** The frontmatter schema has exactly 6 official fields (`description`, `name`, `argument-hint`, `agent`, `model`, `tools`) — none control visibility. This was confirmed unanimously across all 6 reports: source code analysis (R1, R3, R4), official documentation (R5), and empirical survey of 315 files (R6).

**`.agent.md` files DO support hiding** via `user-invocable: false` (hides from user dropdown, remains callable as subagent). This is the intended mechanism — the Explore subagent uses it in production.

**The design split is intentional.** Prompt files are user-facing slash commands by design. For internal/hidden orchestration prompts, VS Code's answer is: convert to `.agent.md` and set `user-invocable: false`.

**No prompt-to-prompt invocation exists.** There is no `${prompt:...}`, `#prompt:`, or `#include` syntax. The only cross-invocation path is prompt → agent → subagent via `handoffs`.

**The parser silently accepts unknown fields**, so custom metadata (e.g., `ralph-internal: true`) can be added without breaking anything — but it has no runtime effect in VS Code.

---

## Consolidated Findings

### 1. Complete `.prompt.md` Frontmatter Schema (6 Official Fields)

| Field | Type | Required | Description | Source |
|-------|------|----------|-------------|--------|
| `description` | string | No | Human-readable summary | R1, R5, R6 |
| `name` | string | No | Slash-command name (defaults to filename) | R1, R5, R6 |
| `argument-hint` | string | No | Input placeholder hint | R1, R5, R6 |
| `agent` / `mode` | string | No | Target agent: `ask`, `agent`, `plan`, or custom name | R1, R5, R6 |
| `model` | string \| string[] | No | Language model to use | R1, R5, R6 |
| `tools` | string[] \| object | No | Allowed tools/tool sets | R1, R5, R6 |

### 2. Complete `.agent.md` Frontmatter Schema (Extended)

All `.prompt.md` fields plus:

| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `user-invocable` | boolean | `false` = hidden from user dropdown | R1, R3, R5 |
| `disable-model-invocation` | boolean | `true` = model cannot auto-invoke | R1, R3, R5 |
| `handoffs` | IHandOff[] | Agent delegation buttons | R1, R4 |
| `agents` | string[] | Subagent names | R1, R3 |
| `target` | string | Platform: `vscode` or `github-copilot` | R1, R2 |
| `mcp-servers` | string[] | MCP server names (GitHub-only) | R1 |

### 3. Internal Parser Schema (20 Fields Total)

Five additional fields are defined in `PromptHeaderAttributes` but have **no typed getter and no known consumer**: `excludeAgent`, `advancedOptions`, `license`, `compatibility`, `metadata`. These are parsed into the generic `attributes` array but are effectively dead code. (R1, R3)

### 4. Two-Axis Visibility Model

| Axis | Field | Default | Effect | Used By |
|------|-------|---------|--------|---------|
| User visibility | `user-invocable: false` | `true` | Hides from agent dropdown | Explore agent, GitHub org agents |
| Model invocability | `disable-model-invocation: true` | `false` | Prevents autonomous invocation | Plan, Ask, EditMode agents |

These axes are independent — an agent can be hidden from users but callable by other agents, or visible to users but not auto-invocable. (R3, R5)

### 5. Three Distinct Hiding Mechanisms (Different Layers)

| Mechanism | Layer | Scope | Used By | Source |
|-----------|-------|-------|---------|--------|
| `user-invocable: false` | YAML frontmatter | Agent files | Explore, org agents | R1, R3 |
| `hiddenFromUser: true` | TypeScript interface | Slash commands | generateCode, unknownIntent | R3 |
| `isListedCapability: false` | TypeScript interface | System prompt | setupTests intent | R3 |

### 6. No Prompt-to-Prompt Invocation

| Syntax | Exists? | Reality | Source |
|--------|---------|---------|--------|
| `${prompt:other}` | No | Not implemented | R4 |
| `#prompt:name` | No | Not implemented | R4 |
| `#file:other.prompt.md` | Partial | Parsed as reference but NOT recursively expanded | R4 |
| `handoffs` | Yes | Agent-level UI delegation only | R4 |

### 7. Discovery Architecture

- **VS Code core**: Discovers `.prompt.md` files via file watchers and glob patterns across workspace (`.github/prompts/`, `.vscode/prompts/`) and user directory (`~/...User/prompts/`). Handles `user-invocable`/`target` filtering. (R2)
- **Copilot extension**: Parses frontmatter, registers additional sources (org agents, extension contributions), renders prompt content. Does NOT filter picker items. (R2)

### 8. Empirical Survey (315 Files)

13 unique frontmatter fields found across the wild. **Zero visibility-related fields in any file.** The 7 unofficial fields (`tested_with`, `title`, `type`, `phase`, `id`, `date`, `mode`) are silently accepted by the parser with no runtime effect. (R6)

### 9. Spelling Inconsistency

Frontmatter uses `user-invokable` (hyphenated, "k"). TypeScript uses `userInvocable` (camelCase, "c"). Both spellings coexist — potential source of bugs. (R1, R3)

---

## Pattern Catalog

### P1: Agent-Based Hiding (Production-Ready)

Convert internal prompts to `.agent.md` with `user-invocable: false`.

```yaml
---
name: internal-orchestrator
description: Internal orchestration agent
user-invocable: false
tools:
  - codebase
  - terminal
---
You are an internal orchestration agent...
```

**Evidence**: Used by Explore agent (`exploreAgentProvider.ts` L35), GitHub org agents. (R3, R5)

### P2: Two-Axis Visibility Configuration

Combine `user-invocable` and `disable-model-invocation` for fine-grained control:

| Configuration | User Sees? | Model Invokes? | Use Case |
|--------------|-----------|----------------|----------|
| Both default | Yes | Yes | Normal agent |
| `user-invocable: false` | No | Yes | Internal subagent (Explore) |
| `disable-model-invocation: true` | Yes | No | User-only agent (Plan, Ask) |
| Both set | No | No | Fully hidden (not useful) |

(R3, R5)

### P3: Location-Based Scoping

Implicit visibility through file placement:

| Location | Scope | Shared? |
|----------|-------|---------|
| `.github/prompts/` | Project | Yes (via git) |
| `.vscode/prompts/` | Project | Yes (via git) |
| `~/...User/prompts/` | User | No (local/Settings Sync) |
| `assets/prompts/` | Extension | Bundled with extension |

(R2, R5, R6)

### P4: Custom Metadata Fields (No Runtime Effect)

The parser silently accepts unknown fields. Custom fields can store metadata for external tools:

```yaml
---
description: Internal wave prompt
ralph-internal: true
ralph-visibility: orchestrator-only
---
```

VS Code ignores these fields, but ralph-loop could read and filter on them. (R1, R6)

### P5: Handoff Delegation (Agent-Level)

```yaml
---
name: planner
handoffs:
  - agent: coder
    label: "Start Implementation"
    prompt: "Implement the plan from above"
    send: true
---
```

UI-level delegation between agents — not prompt file inclusion. (R4)

### P6: Slash Command Hiding (TypeScript Only)

For extension-built slash commands, use `hiddenFromUser: true` on `IIntentSlashCommandInfo`. Not available via frontmatter. (R3)

---

## Priority Matrix

| Pattern | Impact | Effort | Priority | Source Reports |
|---------|--------|--------|----------|----------------|
| Use `.agent.md` + `user-invocable: false` for hidden prompts | **High** | **Low** | **P0 — Do Now** | R1, R2, R3, R5 |
| Convert internal `.prompt.md` to `.agent.md` | **High** | **Low** | **P0 — Do Now** | R1, R2, R5 |
| Location-based scoping (folder conventions) | **Medium** | **Low** | **P1 — Easy Win** | R2, R5, R6 |
| Custom metadata fields for ralph-loop filtering | **Medium** | **Medium** | **P2 — Plan** | R1, R4, R6 |
| Trace `user-invocable` filtering in VS Code core | **Medium** | **Medium** | **P2 — Plan** | R2, R3 |
| Investigate `excludeAgent` for agent-scoped hiding | **Low** | **Medium** | **P3 — Backlog** | R1, R3 |
| Advocate for native `hidden` field upstream | **High** | **High** | **P3 — Backlog** | R5 |
| Resolve `invokable`/`invocable` spelling inconsistency | **Low** | **Low** | **P3 — Backlog** | R1, R3 |

---

## Recommended Implementation Plan

### Step 1: Convert Internal Prompts to Agents (Immediate)

For any `.prompt.md` file that should be hidden from users:

1. Rename from `.prompt.md` to `.agent.md`
2. Add `user-invocable: false` to frontmatter
3. Add `tools` list if the agent needs tool access
4. Reference as subagent from parent agents via `agents` field

### Step 2: Establish Folder Conventions (Immediate)

- `.github/prompts/` — user-facing, team-shared prompts
- `.vscode/prompts/` — user-facing, project-specific prompts
- Internal/orchestration prompts → use `.agent.md` format in appropriate location

### Step 3: Implement Ralph-Loop Filter Layer (If Needed)

If `.agent.md` conversion is insufficient (e.g., need prompt-level hiding without agent overhead):

1. Add custom frontmatter: `ralph-visibility: internal`
2. Implement filter in ralph-loop that reads parsed frontmatter
3. The VS Code parser preserves unknown fields in the `attributes` array — read from there

### Step 4: Monitor Schema Evolution

- Track `newChat: true` backlog item (GitHub issue #288838)
- Watch for new frontmatter fields in VS Code release notes
- The `infer` → `user-invocable` + `disable-model-invocation` split shows the schema actively evolves

---

## Gaps & Further Research

| Gap | Description | Priority |
|-----|-------------|----------|
| VS Code core filtering logic | `user-invocable` filtering happens in `microsoft/vscode`, not the extension. Exact behavior (picker hiding vs. complete exclusion) is untraced. | Medium |
| `.prompt.md` + `user-invocable` | Whether `user-invocable: false` works on plain `.prompt.md` files (not `.agent.md`) is unverified. All known uses are on `.agent.md`. | High |
| `excludeAgent` consumer | Defined in parser but no getter/usage found. Could be VS Code core-consumed or dead code. | Low |
| Runtime verification | No report tested `user-invocable: false` on a live file to observe actual behavior. All findings are from static analysis. | High |
| Extension-contributed prompts | Extensions can contribute prompts via API. Whether they have additional visibility controls is unexplored. | Low |
| Recursive `#file:` resolution | VS Code core may resolve `#file:` references recursively in the chat system, unlike the extension's flat-text approach. Unverified. | Low |
| Future schema roadmap | No VS Code RFC or roadmap found for prompt schema evolution. Direction beyond `newChat` is unclear. | Low |
