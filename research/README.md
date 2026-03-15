# Research

Research artifacts for ralph-loop: source analyses, ecosystem comparisons, gap analyses, and task specifications that feed into the PRD via Progressive Disclosure (PD) references.

For how this fits the overall workflow, see the root [README.md](../README.md). For a file-by-file catalog, see [INDEX.md](INDEX.md).

## File Naming Convention

```
{NN}-{descriptive-name}.md        # Numbered research or spec file
_raw-{session-id}.md              # Raw session dumps (not for agent consumption)
_parsed-{descriptor}.md           # Intermediate parsing artifacts
```

- `NN` = sequential number (01, 02, ... 14)
- Files prefixed with `_` are internal artifacts, not referenced by the PD chain
- Multiple files can share a number with letter suffixes (e.g. `06`, `06b`) for related analyses

## YAML Frontmatter

Research and spec files use YAML frontmatter for machine-readable metadata. This enables `buildPrompt()` in `src/prompt.ts` to extract context without reading the full file.

### Research type

```yaml
---
type: research
id: 13
phase: 9
date: 2026-03-14
sources:
  - repo-or-url-1
methodology: wave-explore-fast-direct x12 subagents
derived_specs:
  - 14
tags:
  - context-management
---
```

### Spec type

```yaml
---
type: spec
id: 14
phase: 9
tasks: [57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68]
research: 13
principles:
  - configurable
  - composable
verification:
  - npx tsc --noEmit
  - npx vitest run
completion_steps:
  - Run tsc and vitest (both must pass)
  - Append to progress.txt
  - Mark checkbox in PRD.md
---
```

## Key Design Decisions

These conclusions from the original research inform all subsequent development:

1. **Determinism is non-negotiable** — the control plane must be executable code, not LLM prompts
2. **Async generators** beat EventEmitters for orchestration — better backpressure, cancellation, testability
3. **PRD.md checkboxes** are the simplest viable DSL — human-readable, git-friendly, completion detection is a regex
4. **Nudges as user messages** have the highest LLM compliance rate — not system messages
5. **PreCompact reset** — hook into compaction signals to reset at the exact right moment
