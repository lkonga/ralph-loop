# Research 8: How `init-skills` Needs to Change for the 2-Env Pattern

## Findings

### 1. Source Repo Discovery (`CONFIG_ROOT`)

The script discovers itself via `SCRIPT_DIR` → parent:

```bash
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CONFIG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
```

`CONFIG_ROOT` = the root of `vscode-config-files`. All source paths derive from it. There is no `SOURCE_REPO` variable — that name was likely from the older `llm-rules` version. The current script uses `CONFIG_ROOT` exclusively.

### 2. Current Environment Detection

The script already derives the active environment from `host-env.yaml` (L39-48):

```bash
HOST_ENV_FILE="$HOME/codes/opencode-model-swap/host-env.yaml"
CURRENT_ENV=$(get_host_env "$(hostname)")
CURRENT_ENV="${CURRENT_ENV:-stable}"
```

This is used to resolve `SOURCE_OPENCODE_ENV_DIR` and `SOURCE_OPENCODE_AGENTS_DIR`:

```bash
SOURCE_OPENCODE_ENV_DIR="$CONFIG_ROOT/environments/$CURRENT_ENV/.opencode_global"
SOURCE_OPENCODE_AGENTS_DIR="$HOME/.config/opencode-$CURRENT_ENV/agent"
SOURCE_OPENCODE_CONFIG="$SOURCE_OPENCODE_ENV_DIR/opencode.json"
```

**Critical finding**: The `environments/` directory does NOT currently exist in `vscode-config-files`. The script references `$CONFIG_ROOT/environments/$CURRENT_ENV/.opencode_global` at L56 but this path is broken. This is pre-wiring for the 2-env pattern that hasn't been created yet.

### 3. Self-Detection Logic (`detect_source_project`)

Located at L847-876. Uses two heuristics:

1. **Name check**: `basename "$TARGET_PROJECT_DIR" == "vscode-config-files"`
2. **File check**: `scripts/init-skills` exists AND is NOT a symlink (consumer projects symlink the `scripts/` directory)

Sets `IS_LLMP_RULES_SOURCE=true` (legacy naming from `llm-rules` migration). This flag changes behavior throughout:
- **Skills symlink** (L476): Creates `.vscode/skills → CONFIG_ROOT/skills` instead of `→ SOURCE_SKILLS_DIR`
- **AGENTS.md** (L509): Creates `AGENTS.md → CONFIG_ROOT/AGENTS.source.md`  
- **Prompts** (L560, L592): Skips symlink creation (source already has the directories)
- **OpenCode skills** (L1277): Verifies directory exists rather than creating symlink
- **Verification** (L620+): Checks source files exist rather than symlinks

### 4. Complete Path Resolution Inventory

All source paths that derive from `CONFIG_ROOT` (and would need per-env variants):

| Variable | Current Path | Env-Sensitive? |
|----------|-------------|----------------|
| `SOURCE_SKILLS_DIR` | `$CONFIG_ROOT/skills` | **No** — VS Code skills are shared |
| `SOURCE_AGENTS_FILE` | `$CONFIG_ROOT/AGENTS.source.md` | **Possibly** — if envs have different AGENTS.md |
| `SOURCE_PROMPTS_VSCODE_DIR` | `$CONFIG_ROOT/prompts` | **No** — VS Code prompts are shared |
| `SOURCE_PROMPTS_OPENCODE_DIR` | `$CONFIG_ROOT/prompts_opencode` | **Possibly** — if per-env prompts differ |
| `SOURCE_OPENCODE_ENV_DIR` | `$CONFIG_ROOT/environments/$CURRENT_ENV/.opencode_global` | **Yes** — already env-qualified |
| `SOURCE_OPENCODE_SKILLS_DIR` | `$CONFIG_ROOT/opencode/skills` | **Possibly** — if per-env skill sets differ |
| `SOURCE_OPENCODE_CLAUDE_FILE` | `$SOURCE_OPENCODE_ENV_DIR/CLAUDE.source.md` | **Yes** — derives from env dir |
| `SOURCE_OPENCODE_AGENTS_DIR` | `$HOME/.config/opencode-$CURRENT_ENV/agent` | **Yes** — already env-qualified |
| `SOURCE_OPENCODE_CONFIG` | `$SOURCE_OPENCODE_ENV_DIR/opencode.json` | **Yes** — derives from env dir |

### 5. OpenCode Project Type System

The script has a project type detection system (L1700-1800) that scans `$CONFIG_ROOT/opencode/.opencode_project_*` directories. The `ensure_opencode_dir()` function (L1170-1260) resolves skill sources based on project type:

```bash
if [[ "$project_type" == ".opencode_project_type_generic" ]]; then
    skill_source="$CONFIG_ROOT/opencode/.opencode_project_type_generic/skills"
elif [[ "$project_type" == ".opencode_project_type_laravel_fullstack" ]]; then
    skill_source="$CONFIG_ROOT/opencode/.opencode_project_type_laravel_fullstack/skills"
```

If the 2-env pattern moves project types under `environments/$ENV/`, these hardcoded paths need updating.

### 6. Preflight Checks

The `preflight_check()` function (L120-170) validates:
- `~/.config/opencode-$CURRENT_ENV` exists with `CLAUDE.md` and `opencode.json`
- `OPENCODE_DISABLE_PROJECT_CONFIG` env var is set

These checks already use `CURRENT_ENV` so they would work with an `--env` flag override.

## Patterns

### Pattern 1: Layered Resolution (Shared → Env-Specific)

The script already separates VS Code paths (shared) from OpenCode paths (env-specific). The 2-env pattern extends this:

```
Shared (no env):
  CONFIG_ROOT/skills/           → .vscode/skills/
  CONFIG_ROOT/AGENTS.source.md  → AGENTS.md
  CONFIG_ROOT/prompts/          → prompts/

Env-specific (needs --env or auto-detect):
  CONFIG_ROOT/environments/$ENV/.opencode_global/CLAUDE.source.md
  CONFIG_ROOT/environments/$ENV/.opencode_global/opencode.json
  $HOME/.config/opencode-$ENV/agent/
  CONFIG_ROOT/opencode/.opencode_project_*/  (if moved under envs/)
```

### Pattern 2: Auto-Detect with Override

Current: `CURRENT_ENV` auto-detected from `host-env.yaml`, defaults to `stable`.
Proposed: Add `--env stable|experimental` flag that overrides `CURRENT_ENV`.

```bash
# In parse_args():
--env)
    CURRENT_ENV="$2"
    shift 2
    ;;
```

This single change would cascade through all env-dependent path variables, since they all derive from `CURRENT_ENV`.

### Pattern 3: Self-Detection Needs No Change

The `detect_source_project()` function checks project identity, not environment. Whether the project is `vscode-config-files` or a consumer is orthogonal to which environment is active. **No changes needed for self-detection logic itself.**

However, when running inside `vscode-config-files` (the source), the behavior of env-specific paths changes — it sources from its own `environments/$ENV/` rather than symlinking to it.

### Pattern 4: The `environments/` Directory Must Be Created First

The script already references `$CONFIG_ROOT/environments/$CURRENT_ENV/.opencode_global` but this directory doesn't exist yet. Before any `--env` flag work:
1. Create `environments/stable/.opencode_global/`
2. Create `environments/experimental/.opencode_global/`
3. Move/create `CLAUDE.source.md` and `opencode.json` into each

## Applicability

### Changes Required (Minimal Set)

1. **Add `--env` flag to `parse_args()`** (~5 lines)
   - Validates value is `stable` or `experimental`
   - Overrides `CURRENT_ENV` before source path construction
   - Must be parsed BEFORE source paths are computed (currently paths are computed at global scope, so `--env` would need to trigger a re-computation)

2. **Defer source path computation** (~15 lines of restructuring)
   - Currently, `SOURCE_OPENCODE_ENV_DIR`, `SOURCE_OPENCODE_CLAUDE_FILE`, `SOURCE_OPENCODE_AGENTS_DIR`, `SOURCE_OPENCODE_CONFIG` are computed at global scope (L56-60)
   - These need to move into a function called AFTER `parse_args()` but BEFORE `validate_sources()`
   - Suggested: Create `compute_source_paths()` function

3. **Update help text** (~10 lines)
   - Add `--env stable|experimental` to options list
   - Document default behavior (auto-detect from hostname)
   - Add examples

4. **Update `initialize_opencode()`** (L1809-1852)
   - When re-computing source paths for selected project type, incorporate env:
   ```bash
   local project_type_dir="$CONFIG_ROOT/opencode/$selected_project_type"
   # Might become: $CONFIG_ROOT/environments/$CURRENT_ENV/opencode/$selected_project_type
   ```
   - This depends on whether project types live under `environments/` or remain shared

5. **Update summaries** (~5 lines)
   - Display current `CURRENT_ENV` in `show_opencode_summary`
   - Show whether auto-detected or overridden

### Backward Compatibility

- **No flag = same behavior as today**: Auto-detect from `host-env.yaml`, default `stable`
- **VS Code mode unaffected**: `--vscode` path never uses `CURRENT_ENV`
- **Consumer projects unchanged**: They don't know about envs — they just see the symlinks init-skills creates
- **`--env` is purely additive**: Existing invocations (`init-skills --yes`, `init-skills --opencode --project-type 1 --yes`) continue working identically

### Decision: Where Do Project Types Live?

Two options for the 2-env layout:

**Option A: Project types stay shared** (recommended for v1)
```
CONFIG_ROOT/
  environments/stable/.opencode_global/     ← CLAUDE.source.md, opencode.json
  environments/experimental/.opencode_global/ ← CLAUDE.source.md, opencode.json  
  opencode/.opencode_project_type_*/        ← skills/agents (SHARED across envs)
```
- Simpler — only CLAUDE.md and config differ per env
- Project type skills are identical in both envs
- **Fewer changes** to init-skills (project type resolution stays the same)

**Option B: Project types under env**
```
CONFIG_ROOT/
  environments/stable/opencode/.opencode_project_type_*/
  environments/experimental/opencode/.opencode_project_type_*/
```
- More flexibility — different skills per env
- More complex — `detect_project_types()` needs env awareness
- Duplicates skill directories between envs

## Open Questions

1. **Should `environments/` directory be created as part of this init-skills change, or as a prerequisite task?** Currently the directory doesn't exist. The script already references it but the path is dead.

2. **Do OpenCode project types differ between stable and experimental?** If skills are identical across envs, Option A is clearly better. If experimental needs different/additional skills, Option B is needed.

3. **Should `--env` validate that `$CONFIG_ROOT/environments/$ENV/` exists?** Currently `CURRENT_ENV` is set without validation. Adding a check would catch misconfigured setups but also fail on first-time setup before directories are created.

4. **Should `--env` also affect `$HOME/.config/opencode-$ENV/` validation?** The preflight check already uses `CURRENT_ENV` to check `~/.config/opencode-$CURRENT_ENV`. If `--env` changes `CURRENT_ENV`, preflight would automatically validate the correct env config dir.

5. **Naming: `IS_LLMP_RULES_SOURCE` should be renamed** during this refactor to `IS_SOURCE_PROJECT` or `IS_CONFIG_SOURCE`. The `LLMP` name is a legacy artifact from the `llm-rules` migration.

6. **The global-scope path computation (L51-60) is a structural issue.** Moving to deferred computation requires ensuring no global-scope code references these variables before `parse_args()` runs. Currently safe since `parse_args()` is called first in `main()` and global vars are just declarations, but the init order should be explicit.
