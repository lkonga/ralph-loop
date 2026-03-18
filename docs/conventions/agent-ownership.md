# Agent Ownership Convention

## Centralized Source of Truth

`vscode-config-files/agents/` is the **single canonical home** for all agent files (`.agent.md`). This includes:

- **Ralph-specific agents**: `ralph-executor`, `ralph-explore`, `ralph-research`
- **Wave pipeline agents**: `wave-orchestrator`, `wave-context-grounder`, `wave-spec-generator`, `wave-prd-generator`, etc.
- **Shared infrastructure agents**: `coder`, `expert-reviewer`, etc.

## Symlink Strategy

Consumer repos (like `ralph-loop`) contain **only symlinks** in their `agents/` directory, pointing to the canonical files:

```
ralph-loop/agents/ralph-executor.agent.md -> ../../vscode-config-files/agents/ralph-executor.agent.md
```

This ensures:
- One place to edit agent definitions
- No content drift between repos
- Git tracks symlinks, so cloning preserves the structure

## Rules

1. **Never create regular agent files** in `ralph-loop/agents/` — always symlink from `vscode-config-files/agents/`.
2. **Edit via relative path** from ralph-loop's cwd: `../vscode-config-files/agents/{file}` — do not cd into vscode-config-files.
3. **New agents** go into `vscode-config-files/agents/` first, then symlink from consumer repos.
4. **Validation**: Run `scripts/check-agent-sync.sh` to detect broken symlinks or regular files that should be symlinks.

## Creating a New Symlink

From ralph-loop root:

```bash
ln -sf ../../vscode-config-files/agents/new-agent.agent.md agents/new-agent.agent.md
```

## Validation

```bash
./scripts/check-agent-sync.sh
```

Reports: regular files that should be symlinks, broken symlinks, and symlinks pointing outside the canonical directory.
