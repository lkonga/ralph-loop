# Frontmatter Sealing Pattern

## Core Constraint

Frontmatter (`tasks`, `verification`, `completion_steps`, `principles`) must be the **last transformation** applied to spec files — after all research, synthesis, and user refinement is complete.

Ralph's `buildPrompt()` reads frontmatter to drive execution. Applying frontmatter mid-pipeline with incomplete data causes partial specs — tasks reference unfinished research, verification steps target code that doesn't exist yet, and principles may not reflect the final design direction.

## Why This Matters

The `buildSpecContextLine()` function in `prompt.ts` extracts frontmatter fields from spec files at runtime:

- `phase` → used for context grouping
- `principles` → injected into the prompt as design constraints
- `verification` → tells the agent what commands to run
- `research` → links back to the source research file

If frontmatter is applied before the spec content is finalized, `buildPrompt()` will emit instructions based on stale or incomplete data. The agent then executes against a partial spec, producing low-quality output that requires rework.

## Pipeline Sequence

```
Research → Spec (raw, no frontmatter) → User refines → Seal (apply frontmatter) → PRD entries with → Spec: pointers
```

### Phase-by-Phase

1. **Research** — Fan-out exploration produces raw findings (e.g., `research/13-phase9-deep-research.md`). These files have their own `ResearchFrontmatter` with `type: research`, source attribution, and methodology tags.

2. **Spec (raw, no frontmatter)** — Synthesis transforms findings into task specifications with interfaces, config fields, and test expectations. At this stage the spec is **unsealed** — it has no `tasks`, `verification`, `completion_steps`, or `principles` frontmatter because the content is still being shaped.

3. **User refines** — The human reviews the raw spec, adjusts scope, reorders tasks, adds constraints, or removes sections. This is where design decisions finalize.

4. **Seal (apply frontmatter)** — Only after refinement is complete, the frontmatter block is written. This "seals" the spec as the source of truth for execution. The sealed frontmatter captures the final task list, verification commands, completion steps, and guiding principles.

5. **PRD entries with → Spec: pointers** — PRD task entries reference the sealed spec via `→ Spec: path LN-LN` syntax. The `extractSpecReference()` function in `prompt.ts` parses these pointers so `buildPrompt()` can inject spec context at runtime.

## Frontmatter Fields

Defined in `src/types.ts` as `SpecFrontmatter`:

| Field | Type | Purpose |
|-------|------|---------|
| `tasks` | `number[]` | Task IDs covered by this spec |
| `verification` | `string[]` | Commands the agent must run (e.g., `npx tsc --noEmit`) |
| `completion_steps` | `string[]` | Post-task actions (update progress, commit) |
| `principles` | `string[]` | Design constraints injected into prompts |

## Examples from Existing Research Files

### Unsealed: Research File (before sealing)

From `research/13-phase9-deep-research.md` — a research file with `ResearchFrontmatter`. Note: no `tasks`, `verification`, `completion_steps`, or `principles` fields. This is raw research output, not yet transformed into an executable spec:

```yaml
---
type: research
id: 13
phase: 9
date: 2026-03-14
sources:
  - vercel-labs/ralph-loop-agent
  - mikeyobrien/ralph-orchestrator
methodology: wave-explore-fast-direct x12 + github_repo + crawl4ai
derived_specs: [14]
tags: [context-management, thrashing-detection, cooldown]
---
```

The `derived_specs: [14]` field points forward to the spec that will eventually be sealed from this research.

### Sealed: Spec File (after sealing)

From `research/14-phase9-refined-tasks.md` — the sealed spec derived from research file 13. All execution-critical frontmatter is present:

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
  - chainable
  - deterministic
  - reproducible
verification:
  - npx tsc --noEmit
  - npx vitest run
completion_steps:
  - append to progress.txt
  - mark checkbox in PRD.md
  - git add -A && git commit -m 'feat: <description>'
---
```

This sealed frontmatter tells `buildPrompt()` exactly what to enforce: which tasks belong to this spec, what principles guide implementation, what verification commands to run, and what completion steps are required.

## The → Spec: Pointer Pattern

PRD entries reference sealed specs using the `→ Spec:` syntax:

```markdown
- [ ] **Task 57 — Context Budget Awareness**: Add token estimation and budget annotation
  → Spec: research/14-phase9-refined-tasks.md L42-L78
```

At runtime, `extractSpecReference()` parses `research/14-phase9-refined-tasks.md L42-L78` and `buildSpecContextLine()` reads the spec's frontmatter to inject context like:

```
[Spec context: Phase 9 | principles: configurable, composable, chainable | verify: tsc --noEmit+vitest run | research: 13]
```

## Anti-Pattern: Premature Sealing

Applying frontmatter before the spec content is finalized leads to partial specs:

```yaml
# BAD: Sealed too early — tasks list is incomplete, principles haven't been refined
---
type: spec
tasks: [57, 58]          # Only 2 of 12 tasks identified so far
principles:
  - configurable          # Missing 4 other principles discovered during refinement
verification:
  - npx tsc --noEmit      # Missing vitest — added later but frontmatter not updated
---
```

This causes `buildPrompt()` to emit incomplete context — the agent only sees 2 tasks instead of 12, follows fewer principles, and skips test verification.

## Summary

Frontmatter sealing is a sequencing discipline: gather all information first, let the human refine it, then seal once. The sealed frontmatter becomes the single source of truth that `buildPrompt()` reads to drive agent execution. Premature sealing with incomplete data produces partial specs that degrade agent output quality.
