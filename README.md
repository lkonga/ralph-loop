# Ralph Loop

Drives VS Code Copilot Agent Mode in a deterministic loop from PRD tasks.

## How It Works

1. You write a `PRD.md` with checkbox tasks (`- [ ] Do something`)
2. The extension picks the next pending task, opens a fresh Copilot agent session, and sends it as a prompt
3. Copilot works on the task and ticks the checkbox (`- [x]`) when done
4. The extension detects the change (file watcher + polling), waits a countdown, then moves to the next task
5. Repeats until all tasks are complete or the iteration limit is hit

## Architecture

```
CLI (ralph)              VS Code Extension
─────────────            ──────────────────
ralph init  ──────────►  Creates PRD.md template
ralph status ─────────►  Shows progress from PRD.md
ralph next  ──────────►  Shows next pending task

                         Ralph Loop: Start (command)
                           │
                           ├── Parse PRD.md → pick next [ ] task
                           ├── Fresh Copilot session (newEditSession)
                           ├── Send prompt (openEditSession / chat / clipboard)
                           ├── Watch PRD.md for [x] change
                           ├── 12s countdown
                           └── Loop ↑
```

## Installation

```bash
# Clone and build
git clone <repo-url> ralph-loop
cd ralph-loop
npm install
npm run compile

# Package as VSIX
npx @vscode/vsce package --allow-missing-repository

# Install in VS Code
code --install-extension ralph-loop-0.1.0.vsix
```

## CLI Usage

```bash
# Create a blank PRD template
npx ralph init

# Check PRD progress
npx ralph status

# Show next pending task
npx ralph next
```

## VS Code Commands

| Command | Description |
|---------|-------------|
| `Ralph Loop: Start` | Start the autonomous loop |
| `Ralph Loop: Stop` | Stop the loop |
| `Ralph Loop: Show Status` | Show current loop state |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ralph-loop.prdPath` | `PRD.md` | Path to PRD file (relative to workspace) |
| `ralph-loop.progressPath` | `progress.txt` | Path to progress log |
| `ralph-loop.maxIterations` | `50` | Max loop iterations (0 = unlimited) |
| `ralph-loop.countdownSeconds` | `12` | Seconds between tasks |
| `ralph-loop.inactivityTimeoutMs` | `60000` | Timeout before skipping task |

## Project Structure

```
ralph-loop/
├── package.json          # Extension manifest + CLI bin
├── tsconfig.json
├── cli/
│   └── ralph.ts          # CLI: status, next, init
└── src/
    ├── types.ts          # Types, enums, logger factories
    ├── prd.ts            # PRD parser, task picker
    ├── copilot.ts        # 3-level Copilot fallback + prompt builder
    ├── verify.ts         # Binary pass/fail verification
    ├── orchestrator.ts   # Async generator loop + file watcher
    └── extension.ts      # VS Code entry point
```

## Key Design Choices

- **Deterministic verification**: Checks PRD checkbox state directly, no LLM involvement
- **3-level Copilot fallback**: agent mode → chat → clipboard
- **Fresh session per task**: Prevents context pollution between tasks
- **Async generator orchestrator**: Yields typed events, composable and testable
- **File watcher + 5s polling**: Reliable completion detection

## License

MIT
