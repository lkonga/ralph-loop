# Research 7 — PRD File Identity and Branch Name Derivability

## Question
How does ralph-loop handle PRD file identity — is the branch name derivable from PRD filename, title, or content?

## Findings

### 1. PRD Path Configuration

The PRD file path is a **configurable string** stored in `RalphConfig.prdPath` (default: `'PRD.md'`). It is resolved at runtime via:

- `resolvePrdPath(workspaceRoot, prdRelative)` in `src/prd.ts` — simply calls `path.resolve(workspaceRoot, prdRelative)`.
- `loadConfig()` in `src/orchestrator.ts` (line ~1464) reads the path from VS Code setting `ralph-loop.prdPath`, defaulting to `'PRD.md'`.
- `resolveWorkspaceRoot()` in `src/extension.ts` (line ~14) uses `vscode.workspace.findFiles('**/PRD.md')` to discover the file, then derives the workspace root from the containing folder.

**Key insight**: The filename is always `PRD.md` (or a user-configured relative path). There is **no variation in filename** across PRD files — the system expects a single `PRD.md` per workspace root.

### 2. PRD Title / Content Structure

The PRD.md file has a **markdown heading** as its title. From the current ralph-loop PRD:

```markdown
# Ralph Loop V2 — Phase 1 Self-Fix PRD
```

The `parsePrd(content)` function in `src/prd.ts`:
- Parses **checkboxes** (`- [ ]` and `- [x]`) as tasks
- Detects **phase headers** (`### Phase N — Description`) for agent annotation inheritance
- Assigns **sequential Task IDs** (`Task-001`, `Task-002`, etc.)
- Extracts `[AGENT:name]` annotations and `depends:` annotations
- **Does NOT extract the PRD title (H1 heading)** or any frontmatter metadata

### 3. Available Metadata for Branch Name Derivation

| Source | Available? | Example | Extraction Needed? |
|--------|-----------|---------|---------------------|
| **PRD filename** | Always `PRD.md` | `PRD.md` | Not useful (no variation) |
| **PRD H1 title** | Yes, in content | `Ralph Loop V2 — Phase 1 Self-Fix PRD` | Yes — not currently parsed |
| **Phase headers** | Yes, `### Phase N` | `Phase 2 — Autopilot Patterns` | Yes — recognized but not stored as metadata |
| **Task IDs** | Yes, auto-generated | `Task-001` through `Task-NNN` | Already available in `Task.taskId` |
| **Config prdPath** | Yes, string | `PRD.md` or `docs/sprint-3.md` | Could derive from non-default paths |
| **Frontmatter** | Not present in PRD | — | Would need to be added |
| **Workspace root** | Yes | `/home/user/ralph-loop` | Available but not project-specific |

### 4. Current Branch/Git Handling

Ralph-loop has **no branch management logic**. The `src/gitOps.ts` module handles:
- `atomicCommit()` — stages all changes and commits with conventional commit messages (`feat(Task-001): description`)
- Uses `--no-verify` flag on commits
- **No branch creation, checkout, or validation**

There is no check for which branch the user is on, no enforcement of feature branches, and no branch naming convention.

### 5. Proposed Branch Naming Convention

Given the available metadata, a branch name could be derived by extracting the PRD title:

**Strategy A — PRD title-based (recommended)**:
```
ralph/<slugified-prd-title>
```
Example: `ralph/ralph-loop-v2-phase-1-self-fix-prd`

Implementation: Add a `parsePrdTitle(content: string): string | undefined` function that extracts the first H1 heading, then slugify it (`toLowerCase()`, replace non-alphanumeric with hyphens, collapse, trim).

**Strategy B — Config path-based**:
```
ralph/<prd-filename-without-ext>
```
Example: `ralph/PRD` (not great for default), `ralph/sprint-3` (better for custom paths)

**Strategy C — Phase-aware**:
```
ralph/phase-<N>-<phase-description>
```
Example: `ralph/phase-2-autopilot-patterns`

Requires knowing which phase is being actively worked on. Could derive from the first pending task's phase header.

**Strategy D — Hybrid title + phase**:
```
ralph/<prd-slug>/phase-<N>
```
Example: `ralph/v2-self-fix/phase-5`

### 6. Implementation Approach

To extract a branch name, add to `src/prd.ts`:

```typescript
export function parsePrdTitle(content: string): string | undefined {
    const match = /^#\s+(.+)$/m.exec(content);
    return match ? match[1].trim() : undefined;
}

export function deriveBranchName(content: string, fallbackSlug: string = 'prd'): string {
    const title = parsePrdTitle(content);
    const slug = (title ?? fallbackSlug)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
    return `ralph/${slug}`;
}
```

Current phase could be derived by finding the nearest `###` header above the first pending task.

### 7. Gaps and Considerations

- **No YAML frontmatter in PRD.md**: Unlike research files (which have frontmatter per Task 69-71), the PRD file itself has no structured metadata block. Adding frontmatter (e.g., `branch: ralph/v2-self-fix`) would be the cleanest approach but requires a PRD format change.
- **Multiple PRDs**: `resolveWorkspaceRoot()` handles multiple `PRD.md` files via picker, but branch naming would need to account for which PRD is active.
- **The `prdPath` config defaults to `PRD.md`**: The filename alone provides no differentiation. Title extraction is the most reliable source.
- **Phase detection requires parsing context**: The current parser captures phase headers for agent inheritance but doesn't expose them as structured data on the snapshot.

## Summary

Ralph-loop treats the PRD as a **flat config path** (default `PRD.md`) with no identity metadata extracted. The H1 title is present in every PRD but is **not parsed or stored**. Task IDs are auto-generated sequential numbers. Phase headers are recognized for agent annotations but not exposed as snapshot metadata. **Branch names are best derived from the PRD H1 title via slugification** (`ralph/<slug>`), with an optional phase suffix from the first pending task's phase context. A `parsePrdTitle()` + `deriveBranchName()` function pair in `src/prd.ts` would be ~10 lines of code.
