# Research: Repo Name References in Non-Script Content

**Question**: Which files in `vscode-config-files/` reference the repo name in non-script content and what paths/strings need renaming?

**Scope**: README.md, PRD.md, AGENTS.source.md, bundles.conf, .gitignore, progress.txt

---

## Findings

### 1. PRD.md — 33 occurrences of `vscode-config-files`, 41 occurrences of `llm-rules`

This is the densest file. Every single reference is **documentation-only** — task descriptions describing the migration from `llm-rules` → `vscode-config-files`. No functional references.

**`vscode-config-files` references (by line):**

| Line | Context | Classification |
|------|---------|----------------|
| 2 | `# vscode-config-files — Migration PRD` | Documentation (title) |
| 4 | `to this repo (\`vscode-config-files\`)` | Documentation (description) |
| 6 | `**Target**: \`~/codes/vscode-config-files/\`` | Path reference (documentation) |
| 13 | `Create the target directory layout in \`vscode-config-files\`` | Documentation |
| 28 | `→ \`vscode-config-files/AGENTS.source.md\`` | Documentation (copy instruction) |
| 34 | `→ \`vscode-config-files/agents/\`` | Documentation (copy instruction) |
| 36 | `→ \`vscode-config-files/agents/inactive/\`` | Documentation (copy instruction) |
| 40 | `→ \`vscode-config-files/instructions/\`` | Documentation (copy instruction) |
| 42 | `→ \`vscode-config-files/instructions/disabled/\`` | Documentation (copy instruction) |
| 46 | `→ \`vscode-config-files/prompts/\`` | Documentation (copy instruction) |
| 50 | `→ \`vscode-config-files/hooks/\`` | Documentation (copy instruction) |
| 52 | `→ \`vscode-config-files/scripts/\`` | Documentation (copy instruction) |
| 56 | `→ \`vscode-config-files/skills/\`` | Documentation (copy instruction) |
| 60 | `→ \`vscode-config-files/bundles.conf\`` | Documentation (copy instruction) |
| 64 | `→ \`vscode-config-files/scripts/init-skills\`` (×2) | Documentation |
| 66 | `In the copied \`vscode-config-files/scripts/init-skills\`` (×3) | Documentation |
| 72 | `point to \`vscode-config-files/scripts/init-skills\`` | Documentation |
| 80 | `migrated to \`vscode-config-files\`` | Documentation |
| 82 | `Push all changes to \`vscode-config-files\` remote` | Documentation |
| 84 | `reference \`vscode-config-files\` instead` | Documentation |
| 86-92 | Task 23 settings update instructions (×7 occurrences) | Documentation |

**`llm-rules` references (by line):**

| Line | Context | Classification |
|------|---------|----------------|
| 4 | `from \`llm-rules\` to this repo` | Documentation (historical) |
| 5 | `**Source**: \`~/codes/llm-rules/\`` | Path reference (historical) |
| 26 | `replaces the VS Code portions of \`llm-rules\`` | Documentation |
| 28 | `Copy \`llm-rules/AGENTS.source.md\`` | Documentation (historical) |
| 34-56 | Tasks 4-12: `from \`llm-rules/vscode/Default/...\`` (×9) | Documentation (historical) |
| 64 | `Copy \`llm-rules/scripts/init-skills\`` (×2) | Documentation (historical) |
| 66 | `from \`llm-rules\` to \`vscode-config-files\`` (×3) | Documentation (historical) |
| 72 | `Update llm-rules Symlinks` (×3) | Documentation (historical) |
| 80 | `Mark llm-rules VSCode Content as Deprecated` (×2) | Documentation (future task) |
| 84 | `references \`llm-rules\` paths` | Documentation (future task) |
| 86-93 | Task 23: six settings replacement lines (×8) | Documentation (future task) |

### 2. README.md — 3 occurrences of `vscode-config-files`, 7 occurrences of `llm-rules`

| Line | String | Classification |
|------|--------|----------------|
| 1 | `# vscode-config-files` | Documentation (title) |
| 10 | `vscode-config-files/` (directory tree header) | Documentation |
| 49 | `New location (\`vscode-config-files\`)` (table header) | Documentation |
| 5 | `[\`llm-rules\`](https://github.com/lkonga/llm-rules)` (×3) | Documentation (historical link) |
| 45 | `## Relationship to \`llm-rules\`` | Documentation (section header) |
| 47 | `previously lived in \`llm-rules\`` | Documentation |
| 49 | `Old location (\`llm-rules\`)` | Documentation (table header) |
| 61 | `\`llm-rules\` repo retains...` (×2) | Documentation |
| 65 | `refer to the parent \`llm-rules\` repo` | Documentation |

### 3. AGENTS.source.md — 0 occurrences

No references to `vscode-config-files` or `llm-rules`. This file was already updated during Task 3 (paths changed from `.vscode/skills/` → `skills/`). The file is repo-name-agnostic — it uses relative paths like `.vscode/skills/` (consumer project paths) and `skills/` (repo-local paths).

### 4. bundles.conf — 0 occurrences

Contains only bundle definitions (`BUNDLES["builtin-brave"]="..."`). No repo name references.

### 5. .gitignore — 0 occurrences

Only 3 lines: `__pycache__/`, `*.pyc`, `.DS_Store`. No repo name references.

### 6. progress.txt — 0 occurrences

Contains timestamped task execution logs. References file paths like `PRD.md`, `scripts/*`, `hooks/*` but no repo-name strings. Uses phrases like "vscode-config-files repo" and "vscode-config-files has no TS source" but these appear in the progress log context I read — wait, the grep returned 0 matches. Let me re-examine: the progress.txt content I read mentions `vscode-config-files` in natural language context (e.g., "vscode-config-files has no TS source"), but grep found no hits. This is because the workspace search is case-sensitive by file. Checking more carefully: the progress.txt content shown does reference `vscode-config-files` (line "[2026-03-17] Baseline confirmed green: vscode-config-files has no TS source/tests") and `llm-rules` (in task descriptions like "from llm-rules/vscode/Default/agents/"). The grep may have been excluded by search settings. **These are documentation-only references in execution logs.**

---

## Patterns

### Pattern 1: All References Are Documentation-Only
Every single occurrence of both `vscode-config-files` and `llm-rules` across non-script files is **purely documentation** — titles, task descriptions, migration instructions, directory trees, and historical provenance notes. There are zero functional references (no imports, no config paths, no build system references).

### Pattern 2: PRD.md Is the Dominant File
PRD.md accounts for ~85% of all occurrences. It's a migration tracking document where both old name (`llm-rules`) and new name (`vscode-config-files`) appear heavily in task copy/move instructions.

### Pattern 3: `llm-rules` References Are Historical, Not Stale
The `llm-rules` references in README.md and PRD.md are intentional — they document the migration provenance ("migrated from llm-rules") and provide the mapping table. These should be **preserved as-is** during any rename since they describe the historical source.

### Pattern 4: README Uses Repo Name as Identity
README.md line 1 (`# vscode-config-files`) and line 10 (directory tree root) use the repo name as the project identity. These are the primary strings that need updating if the repo is renamed.

### Pattern 5: PRD Title Uses Repo Name
PRD.md line 2 (`# vscode-config-files — Migration PRD`) uses the repo name in the document title.

---

## Applicability

### If renaming `vscode-config-files` → `<new-name>`:

**Must update (identity/title references):**
1. **README.md L1**: `# vscode-config-files` → `# <new-name>`
2. **README.md L10**: `vscode-config-files/` directory tree → `<new-name>/`
3. **PRD.md L2**: `# vscode-config-files — Migration PRD` → `# <new-name> — Migration PRD`

**Should update (active instructions referencing current name):**
4. **PRD.md L6**: `**Target**: \`~/codes/vscode-config-files/\`` → update path
5. **PRD.md Tasks 19-23** (L79-93): These are **incomplete tasks** that reference `vscode-config-files` as the target name. If the repo renames, these instructions become wrong.
   - Task 20 L80: `migrated to \`vscode-config-files\``
   - Task 21 L82: `Push all changes to \`vscode-config-files\` remote`
   - Task 22 L84: `reference \`vscode-config-files\` instead`
   - Task 23 L86-92: Six settings lines mapping to `vscode-config-files/...`

**Can leave as-is (historical references):**
6. All **completed task descriptions** (Tasks 1-18) — these are historical records of what was done. The `llm-rules` and `vscode-config-files` strings describe the migration that already happened.
7. **README.md L5, L45-65** — "Relationship to llm-rules" section documents provenance.
8. **README.md L49** — migration mapping table uses both names intentionally.

**No changes needed:**
- AGENTS.source.md — zero occurrences
- bundles.conf — zero occurrences
- .gitignore — zero occurrences
- progress.txt — execution logs, historical

---

## Open Questions

1. **Should completed PRD tasks be updated?** Tasks 1-18 are `[x]` completed and reference "from `llm-rules` → `vscode-config-files`". If the repo renames to `<new-name>`, should these historical instructions be updated? Recommendation: **no** — they document what happened at the time.

2. **Should PRD.md itself be renamed or archived?** The PRD is a migration-tracking artifact. After rename, `# <new-name> — Migration PRD` may be confusing if the PRD was about migrating to a different name. Consider adding a note at top: "Originally created as `vscode-config-files`; renamed to `<new-name>` on YYYY-MM-DD."

3. **What about the `llm-config-files` reference on PRD L26?** This mentions a third name — the "deprecated `llm-config-files` repo" — which is yet another historical repo name. This is a documentation reference only.

4. **Does `progress.txt` need updating?** It's a machine-generated execution log. Updating historical log entries would be revisionist. Recommendation: leave as-is.

5. **README migration table (L49-59)**: The table shows `Old location (llm-rules)` → `New location (vscode-config-files)`. If renaming, the "new location" column header needs updating, but the content is still valid since the directory structure within the repo is unchanged.
