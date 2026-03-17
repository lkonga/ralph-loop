## Research Report 10: Ralph-Loop Agent Definitions & Wave Agent Relationship

### Findings

#### Ralph-Loop Agents (3 agents in `ralph-loop/agents/`)

**1. ralph-executor.agent.md** — The primary autonomous coding agent.
- **Model**: `Claude Opus 4.6 (fast mode) (Preview) (copilot)`
- **Role**: PRD-driven task implementation using TDD (write failing test → implement → verify green)
- **User-invocable**: Yes (entry point)
- **Tools**: Full write/execute access — `search`, `read/readFile`, `read/problems`, `edit/editFiles`, `edit/createFile`, `execute/runInTerminal`, `execute/getTerminalOutput`, `agent`, `todo`, `vscode/memory`
- **Sub-agents**: `['ralph-explore', 'ralph-research']` — delegates read-only and research tasks
- **Key behavior**: Completes tasks fully, runs `npx tsc --noEmit` and `npx vitest run` before marking done, updates PRD.md checkboxes and progress.txt

**2. ralph-explore.agent.md** — Read-only codebase exploration.
- **Model**: `claude-opus-4-0-fast`
- **Role**: Analyze code, search patterns, gather information
- **User-invocable**: No (subagent only)
- **Tools**: Read-only — `search`, `read/readFile`, `read/problems`
- **Sub-agents**: None
- **Explicit denials**: No `replace_string_in_file`, `multi_replace_string_in_file`, `create_file`, `run_in_terminal`, `manage_todo_list`
- **Rationale for `manage_todo_list` denial**: "ralph orchestrator owns task state"

**3. ralph-research.agent.md** — Read-only exploration + web search.
- **Model**: `claude-opus-4-0-fast`
- **Role**: Code analysis + external web research
- **User-invocable**: No (subagent only)
- **Tools**: Read-only + web — `search`, `read/readFile`, `read/problems`, `web`, `crawl4ai/*`, `searxng-search/*`
- **Sub-agents**: None
- **Explicit denials**: Same as ralph-explore (no file modification, no terminal, no todo management)

#### Tool Restriction Hierarchy

| Capability | ralph-executor | ralph-explore | ralph-research |
|---|---|---|---|
| Search/read codebase | ✅ | ✅ | ✅ |
| Read problems/diagnostics | ✅ | ✅ | ✅ |
| Edit files | ✅ | ❌ | ❌ |
| Create files | ✅ | ❌ | ❌ |
| Run terminal commands | ✅ | ❌ | ❌ |
| Manage todos | ✅ | ❌ | ❌ |
| Dispatch sub-agents | ✅ | ❌ | ❌ |
| Web search / crawl | ❌ | ❌ | ✅ |
| Memory access | ✅ | ❌ | ❌ |

#### Copies in vscode-config-files

The files at `vscode-config-files/agents/ralph-{executor,explore,research}.agent.md` are **byte-identical copies** of the ones in `ralph-loop/agents/`. This confirms vscode-config-files serves as the canonical distribution source for agent definitions, which are then deployed/copied into individual project repos like ralph-loop.

#### Wave Agents in vscode-config-files (9 agents)

The wave system is a **parallel research orchestration pipeline** that coexists alongside the ralph agents:

| Agent | Tools | Role |
|---|---|---|
| wave-orchestrator | `read, search, agent` | Top-level entry; chains decompose → research → aggregate |
| wave-decompose | `read, search` | Splits topic into N focused questions |
| wave-research | `read, search, agent` | Parallel dispatch engine for wave-researcher |
| wave-researcher | `read, search, edit/createFile` | Individual research agent; writes reports |
| wave-group-aggregator | `read, search, edit/createFile` | Consolidates K research reports |
| wave-master-aggregator | `read, search, edit/createFile` | Produces FINAL-REPORT from aggregations |
| wave-context-grounder | `read, search, terminal` | Reads PRD+README+git for ContextBrief |
| wave-spec-generator | `read, search, edit/createFile` | Transforms FINAL-REPORT into task specs |
| wave-prd-generator | `read, search, edit/createFile` | Converts sealed specs into PRD entries |

#### Relationship Between Ralph and Wave Systems

1. **Ralph = Implementation pipeline** (PRD → code). The executor is the autonomous coder; explore + research are its read-only subagents.
2. **Wave = Research pipeline** (topic → structured research → spec → PRD entries). Wave agents decompose questions, research in parallel, aggregate findings, and generate specs.
3. **The `--ralph-prd` flag** on wave-orchestrator bridges the two: it runs the full 6-phase research-to-PRD pipeline with human checkpoints, producing PRD entries that ralph-executor can then implement.
4. **Wave agents never edit source code** — they only write to `research/_wave/` and potentially `research/` (specs). Ralph-executor is the only agent that modifies source code and runs tests.
5. **Shared distribution**: Both ralph and wave agents are maintained in `vscode-config-files/agents/` as canonical copies, deployed into project repos as needed.

### Patterns

1. **Escalating privilege model**: explore (read-only) → research (read + web) → executor (full write/execute). Each layer adds capabilities while maintaining the principle of least privilege.
2. **Explicit denial lists**: ralph-explore and ralph-research redundantly deny tools in both the YAML `tools:` array (allowlist) AND the body text (denylist). Belt-and-suspenders safety.
3. **Task state ownership**: Only the executor/orchestrator owns task state (`manage_todo_list`). Subagents are stateless workers.
4. **Fan-out/fan-in**: Wave uses decompose → N parallel researchers → K group aggregators → 1 master aggregator. This is a classic MapReduce pattern applied to codebase research.
5. **Progressive disclosure (PD)**: Wave reports use source reference chains (`[via: aggregation → research]`) enabling drill-down from summary to detail.
6. **Frontmatter sealing**: Spec files are raw markdown until sealed with YAML frontmatter, separating research from finalization.

### Applicability

**High** — Understanding these agent definitions is critical for:
- Designing new agents or modifying existing ones in the ralph/wave ecosystem
- Understanding the security model (tool restrictions prevent subagent privilege escalation)
- Knowing where canonical agent definitions live (vscode-config-files) vs. deployed copies (ralph-loop)
- Understanding how wave research flows into ralph PRD implementation

### Open Questions

1. **Sync mechanism**: How are agent files synchronized from `vscode-config-files/agents/` to `ralph-loop/agents/`? Is this manual copy, symlink, or automated script?
2. **Wave agent absence in ralph-loop**: Wave agents only exist in vscode-config-files, not in ralph-loop. Does ralph-loop rely on VS Code multi-root workspace to access them?
3. **Model mismatch**: ralph-executor uses `Claude Opus 4.6 (fast mode) (Preview) (copilot)` while explore/research use `claude-opus-4-0-fast`. Is this intentional (executor gets the better model) or a version drift?
4. **`disable-model-invocation: true`** on ralph-executor prevents other agents from auto-invoking it. Only wave agents that explicitly list it in their `agents:` array or direct user invocation can trigger it. Is this the intended isolation boundary?
5. **Missing `wave-aggregate.agent.md`**: Marked as DEPRECATED — superseded by direct group/master aggregator dispatch. Should it be removed or archived?
