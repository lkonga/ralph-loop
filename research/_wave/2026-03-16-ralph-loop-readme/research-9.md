## Research 9: CLI Tool

### Findings

The `ralph` CLI is a lightweight, standalone Node.js command-line tool defined in [cli/ralph.ts](cli/ralph.ts). It provides three subcommands for interacting with PRD files outside of VS Code:

**Commands:**

| Command | Description |
|---------|-------------|
| `ralph status [--prd <path>]` | Show PRD progress: total, completed, remaining counts plus a per-task checklist |
| `ralph next [--prd <path>]` | Print the description of the next pending task (or "All tasks complete") |
| `ralph init [--prd <path>]` | Create a blank `PRD.md` template with three placeholder tasks |
| `ralph help` | Display usage information |

**Options:**
- `--prd <path>` — Path to the PRD file (defaults to `PRD.md` via `DEFAULT_CONFIG.prdPath`)
- `--cwd <path>` — Working directory (defaults to `process.cwd()`)

**Registration:** Declared in [package.json](package.json) under the `"bin"` field:
```json
"bin": {
  "ralph": "./out/cli/ralph.js"
}
```
This means after `npm link` or global install, `ralph` is available as a shell command.

**Argument parsing:** Uses manual `process.argv` parsing — a custom `arg()` helper scans for named flags. No external CLI framework (yargs, commander, etc.) is used. The command is simply `process.argv[2]`.

**Dependencies on core modules:** The CLI imports three functions from the main extension source:
- `readPrdSnapshot(prdPath)` from `src/prd.ts` — parses a PRD markdown file, extracts checkbox tasks with status, dependency tracking, and task IDs
- `pickNextTask(snapshot)` from `src/prd.ts` — returns the first pending task
- `resolvePrdPath(cwd, relative)` from `src/prd.ts` — resolves PRD path relative to working directory
- `progressSummary(prdPath)` from `src/verify.ts` — returns `{total, completed, remaining}` counts
- `DEFAULT_CONFIG` and `createConsoleLogger()` from `src/types.ts`

**Build:** Compiled via `tsc -p ./` (`npm run compile`), output goes to `out/cli/ralph.js`.

### Patterns

1. **Code reuse across extension and CLI:** The CLI shares the exact same PRD parsing and verification logic as the VS Code extension. `prd.ts` and `verify.ts` are the single source of truth — no duplication.

2. **No external dependencies for CLI parsing:** The CLI avoids any CLI framework, keeping the dependency footprint minimal. This is appropriate given there are only 3 commands and 2 options.

3. **Read-only operations:** The CLI only reads the PRD file (for `status` and `next`) or creates a new one (for `init`). It never modifies an existing PRD or triggers the autonomous loop — that functionality lives exclusively in the VS Code extension.

4. **Shebang line:** `#!/usr/bin/env node` at the top enables direct execution when installed globally.

5. **Error handling:** Exits with code 1 on missing PRD (for `status`/`next`) or pre-existing PRD (for `init`). Unknown commands print usage and exit 1.

6. **Template generation:** The `init` command creates a minimal PRD with the expected checkbox format (`- [ ] Task description`), serving as a quick-start scaffold.

### Applicability

- **README documentation:** The CLI should be documented as a standalone companion tool. Key points to cover:
  - Installation: `npm install -g ralph-loop` or `npm link` for development
  - Usage: the four commands with examples
  - Relationship to the extension: CLI is for inspection/scaffolding; the extension drives the autonomous loop
  - The CLI works without VS Code — it's pure Node.js reading markdown files

- **Architecture section:** The existing README architecture diagram already shows the CLI commands mapping to PRD operations. This is accurate and should be preserved.

- **Use cases for standalone CLI:**
  - CI/CD pipelines checking PRD progress (`ralph status`)
  - Scripting: `ralph next` to feed the next task into another tool
  - Quick PRD scaffolding without opening VS Code (`ralph init`)
  - Terminal-based workflow inspection

### Open Questions

1. **No tests for CLI:** There are no test files covering `cli/ralph.ts` directly. The underlying functions (`readPrdSnapshot`, `pickNextTask`, `progressSummary`) are tested via `src/` tests, but CLI-specific behavior (argument parsing, exit codes, output formatting) is untested.

2. **No `--json` output flag:** For CI/scripting integration, a `--json` flag on `status` and `next` would be useful but doesn't exist.

3. **No version flag:** `ralph --version` is not implemented. Standard CLI practice would read from `package.json`.

4. **npm publish status:** The package has `"publisher": "ralph-loop"` but it's unclear if it's published to npm, making the `bin` field's global install path uncertain for end users.

5. **Missing README CLI section:** The current README mentions the CLI in the architecture diagram but lacks a dedicated "CLI Usage" section with examples.
