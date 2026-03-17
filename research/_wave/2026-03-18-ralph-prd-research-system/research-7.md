# Research Report: wave-prd-generator — Tier Classification & Output Format

**Question**: How does wave-prd-generator classify tasks into Tier 1 (inline) vs Tier 2 (spec-backed with line ranges), and what is its output format for PRD entries?

**Source**: `vscode-config-files/agents/wave-prd-generator.agent.md`

---

## Findings

### Tier Classification Criteria

The agent classifies each `### Task NN — Title` section from a sealed spec into exactly two tiers:

#### Tier 1 — Inline (self-contained)

A task qualifies for Tier 1 when ALL of:
- Fully describable in **≤ 3 sentences**
- No complex interfaces, config schemas, or multi-file coordination
- **Single surgical change** (prompt edit, config tweak, simple fix)
- The PRD description alone IS the complete spec — no external reference needed

#### Tier 2 — PD Reference (spec-backed)

A task qualifies for Tier 2 when ANY of:
- Has design details, type definitions, or test matrices
- Multi-file coordination or new subsystem
- The PRD one-liner is **deliberately insufficient** — exactly one sentence
- Brevity is enforced to **force agents to read the spec** rather than guessing from a summary

### Line Range Index (Step 4)

Before generating output, the agent builds an index mapping each task section in the spec to its line range:
1. Locate each `### Task NN — Title` header → record start line
2. Find the next `### Task` header or EOF → record end line
3. Encode as `L{start}-L{end}` for `→ Spec:` pointers

This is critical — it gives downstream coding agents a precise byte window into the spec file so they read only the relevant section.

### Task Numbering (Step 2)

Task numbers are auto-detected by scanning existing `PRD.md` for all `- [ ] **Task NN` and `- [x] **Task NN` patterns, computing `max(NN) + 1`. If the sealed spec already has assigned numbers (from wave-spec-generator), those take precedence.

### Output Format

The complete output is a phase section block:

```markdown
---

## Phase {P} — {Phase Title}

> Specs: `{spec_file_path}` | Research: `{research_file_path}`
> **TDD is MANDATORY**. Run `npx tsc --noEmit` and `npx vitest run` before marking any task done.

- [ ] **Task NN — Title**: {Full inline description ≤3 sentences}. Run `npx tsc --noEmit` and `npx vitest run`.
- [ ] **Task NN+1 — Title**: {One sentence only}. → Spec: `{spec_path}` L{start}-L{end}
```

Key format rules:
- **Tier 1 entries**: Full description (≤3 sentences), end with TDD commands, NO spec pointer
- **Tier 2 entries**: Exactly one sentence, MUST end with `→ Spec: \`path\` L{start}-L{end}`
- Phase header includes spec + research file paths and a mandatory TDD footer
- Phase number comes from the spec's frontmatter `phase` field
- Research path comes from the spec's frontmatter `research` field

### User Review Gate

Output is presented as a fenced code block with four actions: [Apply] (append to PRD.md), [Refine] (regenerate), [Back] (previous phase), [Stop] (discard). The agent NEVER writes to PRD.md without explicit user confirmation.

---

## Patterns

| Pattern | Implementation |
|---------|---------------|
| **Progressive Disclosure** | Tier 2 entries are deliberately terse — one sentence only — to force spec reads |
| **Line-range pointers** | `→ Spec: path L42-L78` gives agents a precise read window, avoiding full-file loads |
| **Human-in-the-loop gate** | PRD entries are presented for review, never auto-applied |
| **Sequential numbering continuity** | Auto-detects max task number from existing PRD to prevent collisions |
| **Sealed spec prerequisite** | Rejects any spec without YAML frontmatter — enforces pipeline ordering |
| **TDD mandate** | Every phase header and Tier 1 entry includes explicit test commands |

---

## Applicability

For Ralph's PRD generation system, these patterns are directly reusable:

1. **Tier classification heuristic** — The 3-sentence / single-change test is a clean, implementable rule for deciding when a task needs a spec vs. when a one-liner suffices.
2. **Line-range indexing** — Programmatically scanning `### Task NN` headers and encoding `L{start}-L{end}` is straightforward to implement in TypeScript with a regex pass over file content.
3. **Output template** — The phase section format is a concrete string template that PRD generation code can emit directly.
4. **Numbering auto-detection** — Regex scan of `PRD.md` for `Task (\d+)` patterns, `Math.max(...) + 1` — trivial to automate.

---

## Open Questions

1. **Edge case: tasks at tier boundary** — What happens when a task is borderline (e.g., 2 files but simple changes)? The agent doc doesn't specify a fallback — does it default to Tier 2 for safety?
2. **Line range accuracy** — If spec files are later edited (sections added/removed), line ranges in PRD.md become stale. Is there a refresh mechanism?
3. **Spec numbering vs auto-numbering conflict** — The doc says "if the spec already contains specific numbers, use those instead." What if spec numbers conflict with existing PRD numbers?
4. **Research file resolution** — The frontmatter `research` field "resolves to `research/{research_id}-*.md`" — is this a glob or exact match? How is ambiguity handled?
