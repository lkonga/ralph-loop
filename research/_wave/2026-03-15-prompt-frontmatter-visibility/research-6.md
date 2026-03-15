## Research Report 6: Existing Prompt File Patterns

### Findings

**Total .prompt.md files found: 315**
- VS Code Insiders user prompts: 7 files (`~/.config/Code - Insiders/User/prompts/`)
- vscode-copilot-chat repo: 29 files (`assets/prompts/`, `.github/prompts/`, root)
- Other repos in ~/codes/: 279 files (awesome-copilot, llm-rules, adspower_2, dotfiles, etc.)

**Unique frontmatter fields discovered (13 total):**

| Field | Count | Purpose |
|-------|-------|---------|
| `description` | 280 | Human-readable summary of what the prompt does |
| `name` | 161 | Machine-readable identifier (kebab-case) |
| `argument-hint` | 140 | Hint text for user input placeholder |
| `mode` | 97 | Execution mode: `'agent'` (94), `Plan` (2), unquoted `agent` (27) |
| `tools` | 71 | Array of allowed tool identifiers |
| `agent` | 31 | Target agent: `agent` (20), custom names (11) |
| `model` | 9 | Preferred LLM model (e.g., `Claude Sonnet 4`, `Claude Opus 4.6`) |
| `tested_with` | 4 | Validation note (e.g., `'GitHub Copilot Chat (GPT-4o) - Validated July 20, 2025'`) |
| `title` | 1 | Alternative to `name` (seen in `editorconfig.prompt.md`) |
| `type` | 1 | Unconfirmed usage |
| `phase` | 1 | Research phase number |
| `id` | 1 | Unique identifier |
| `date` | 1 | Creation/modification date |

### Visibility-Related Fields

**None found.** No `.prompt.md` file across all 315 files uses any frontmatter field related to:
- Visibility control (`visibility`, `hidden`, `public`, `private`)
- Access control (`access`, `restricted`, `scope`)
- Internal-only markers (`internal`, `draft`, `published`)
- Team/role restrictions

The `.prompt.md` format as used by VS Code Copilot Chat has **no built-in visibility or access control mechanism** in its frontmatter schema.

### Patterns

1. **Core trio** (`description` + `name` + `argument-hint`): Present in ~50% of files. The `description` field is near-universal (89%). `name` provides the slash-command identifier.

2. **Agent execution** (`mode` + `tools` + `agent`): Controls how VS Code runs the prompt. `mode: 'agent'` enables agentic execution with tool access. The `tools` array restricts which tools are available. The `agent` field routes to a specific agent (e.g., `playwright-test-planner`).

3. **Model selection** (`model`): Rare (9 files). Pins a specific LLM for the prompt.

4. **Metadata** (`tested_with`, `date`, `phase`, `id`): Very rare. Only `tested_with` appears more than once (4 files, all from awesome-copilot SQL prompts).

5. **Location-based "visibility"**: The only implicit visibility control is file placement:
   - `.github/prompts/` → project-scoped (shared via git)
   - `~/.config/Code - Insiders/User/prompts/` → user-scoped (local only)
   - `assets/prompts/` → bundled with extension (shipped to all users)

### Applicability

**Medium** — No existing visibility/access-control field exists in the .prompt.md spec. Any visibility feature would be a net-new addition to the schema. However, the `mode` and `agent` fields show precedent for execution-control frontmatter, and the location-based pattern shows the ecosystem already thinks about scope implicitly.

### Open Questions

1. Does VS Code's prompt file parser silently ignore unknown frontmatter fields? (If yes, custom fields like `visibility: internal` could be added without breaking anything.)
2. Does the `agent` field in vscode-copilot-chat's `assets/prompts/` files serve as an implicit access-control mechanism by routing to specific registered agents?
3. Would a `scope` or `visibility` field need VS Code core support, or could ralph-loop implement it independently as a filter layer?
