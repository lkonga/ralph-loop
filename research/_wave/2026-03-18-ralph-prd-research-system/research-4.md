# Research Report 4: Wave-Researcher ↔ Wave-Research Dispatch Engine Interaction

**Wave**: 2026-03-18-ralph-prd-research-system
**Question**: How do wave-researcher and wave-research (dispatch engine) work together — what report structure do researchers write, and how does the dispatch engine enforce single-batch parallel launches?
**Date**: 2026-03-18

---

## Findings

### 1. Two Distinct Roles, One Contract

The wave system separates concerns between two agent definitions:

| Agent | File | Role |
|---|---|---|
| **wave-research** | `vscode-config-files/agents/wave-research.agent.md` | **Dispatch engine** — fans out N subagent calls in parallel |
| **wave-researcher** | `vscode-config-files/agents/wave-researcher.agent.md` | **Research worker** — reads, searches, writes one report file |

`wave-research` declares `agents: ['wave-researcher']` in its frontmatter, meaning it can only delegate to `wave-researcher`. The researcher has `user-invocable: false` — it is never called directly by users, only spawned by the dispatch engine (or by the orchestrator directly).

### 2. The Report Structure Contract

The dispatch engine (`wave-research.agent.md`) defines the **exact report structure** that every researcher must write. This is injected into each subagent's prompt:

```markdown
## Research Report {I}: {SHORT_TITLE}
### Findings
(file paths, line numbers, code snippets)
### Patterns
(reusable patterns, architectural decisions)
### Applicability
(high/medium/low + rationale)
### Open Questions
(unresolved items)
```

Four mandatory sections:
1. **Findings** — concrete evidence: file paths, line numbers, code snippets, interface definitions
2. **Patterns** — abstracted insights: architectural decisions, reusable patterns observed
3. **Applicability** — rated high/medium/low with rationale for relevance to the research topic
4. **Open Questions** — unresolved items that need further investigation

The output file path is also prescribed: `research/_wave/{WAVE_ID}/research-{I}.md` where `{I}` is the 1-indexed researcher number and `{WAVE_ID}` is a date-slug identifier (e.g., `2026-03-15-auth-patterns`).

### 3. The ≤10-Line Summary Return

Beyond the file, each researcher must RETURN (not write) a ≤10 line summary containing:
- Top 3 findings with `file:line` references
- Applicability rating
- Key patterns

This summary is collected by the dispatch engine and pasted into its final output under `### Agent Summaries`. This dual-channel output (file + return value) enables both persistent storage and in-context aggregation.

### 4. Single-Batch Parallel Dispatch Enforcement

The dispatch engine enforces single-batch parallelism through **repeated textual directives** in its agent definition:

> "You MUST call `runSubagent` exactly {N} times in a SINGLE tool-call batch."
> "Do NOT dispatch 2-3 at a time. Do NOT go sequential."
> "ONE batch. ALL {N} calls. PARALLEL."

This is reinforced at three levels:
1. **wave-research.agent.md** — the `⚠️ CRITICAL RULE` section at the top
2. **wave-orchestrator.agent.md** — the `⚠️ PARALLEL DISPATCH IS MANDATORY` section
3. **wave-orchestrator.agent.md** — repeated per-step instructions ("Dispatch {N} wave-researcher subagents in ONE PARALLEL BATCH")

There is **no programmatic enforcement** — no code validates the batch size or rejects sequential launches. Enforcement is purely through prompt engineering with heavy emphasis (caps, bold, repeated warnings). This works because VS Code's `runSubagent` tool accepts multiple parallel calls in a single tool-call block.

### 5. The Researcher's Constraints

The `wave-researcher` agent definition is deliberately minimal and constrained:

- **Tools**: `[read, search, edit/createFile]` — can read and search the codebase, and create/edit files
- **Scope limitation**: "NEVER edit source code, run implementation commands, or modify any files outside `research/_wave/`"
- **Single output**: The only file it creates is its assigned `research/_wave/{WAVE_ID}/research-{I}.md` report
- **Actionable items**: If it finds things that need implementation, it documents them in the report for the user to act on later — never acts on them itself

### 6. Real-World Report Examples

Examining actual wave runs confirms adherence to the contract, with natural variation:

- `2026-03-15-vscode-agent-architecture/research-1.md`: Uses `# Q1: {Title}` → `## Findings` → tables, code blocks, extensive detail. Follows the structure with richer formatting.
- `2026-03-17-ralph-parallel-sequential/research-1.md`: Uses `# Research 1: {Title}` → numbered subsections under Findings with tables. More detailed than the template minimum.
- `2026-03-16-ralph-deep-verification/research-4.md`: Uses `# Research Report 4: {Title}` with explicit wave/question/date metadata header, then `## 1. Executive Summary` before diving into detailed findings.

**Pattern**: Researchers consistently include Findings with file:line references and code snippets. The Patterns/Applicability/Open Questions sections are sometimes merged or reformatted, but the core information is always present.

### 7. How the Orchestrator Bypasses wave-research

The `wave-orchestrator.agent.md` lists both `wave-researcher` and the group/master aggregators in its `agents:` allowlist. In its Aggregate Mode and Ralph PRD Mode, the orchestrator dispatches `wave-researcher` subagents **directly** — it does NOT go through `wave-research`. The orchestrator embeds the same dispatch logic and report-structure template inline.

This means `wave-research` is effectively a **standalone dispatch engine** for simpler use cases, while the orchestrator subsumes its functionality for the full pipeline. The orchestrator's `agents:` list does not include `wave-research` at all.

## Patterns

1. **Contract-by-Prompt**: The report structure is a textual contract defined in the dispatcher's prompt template, not enforced by schema validation. This is brittle but pragmatic for LLM-based agents.

2. **Dual-Channel Output**: File (persistent) + return value (contextual) — enables both downstream aggregation and human review without re-reading files.

3. **Prompt-Based Parallelism Enforcement**: No programmatic check exists; parallelism is enforced purely through repeated, emphatic prompt instructions. This relies on LLM compliance.

4. **Subsumption Pattern**: The orchestrator subsumes the dispatch engine's logic rather than delegating to it, avoiding an extra agent hop and keeping the orchestrator in control of the full pipeline.

5. **Safety-by-Restriction**: Researchers are sandboxed to `research/_wave/` writes only, preventing accidental source code modifications during exploration.

## Applicability

**High** — This directly describes the core architecture of the wave research system. Understanding the researcher↔dispatcher contract is essential for:
- Adding new researchers or modifying report structure
- Debugging why reports don't aggregate correctly
- Understanding why the orchestrator doesn't use `wave-research` as an intermediary
- Extending the system with new output formats

## Open Questions

1. **What happens when parallel dispatch partially fails?** If 3 of 8 researchers fail (e.g., context limits, tool errors), does the dispatch engine retry, skip, or abort? No retry logic is documented.

2. **Is the ≤10-line summary actually used downstream?** The dispatch engine pastes summaries, but the aggregation agents (`wave-group-aggregator`, `wave-master-aggregator`) read the full report files, not the summaries. The summaries may only serve as immediate user feedback.

3. **Why does wave-research exist separately from the orchestrator?** The orchestrator already contains all dispatch logic. `wave-research` may be a legacy artifact or intended for standalone use outside the full pipeline, but no usage path currently calls it.

4. **Report structure drift**: Real reports deviate from the template (different heading styles, extra sections like Executive Summary). Should the contract be tightened, or is flexibility acceptable for LLM-generated content?
