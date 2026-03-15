# Ralph Loop

Drives VS Code Copilot Agent Mode in a deterministic loop from PRD tasks. The extension reads checkbox tasks from a PRD file, feeds them one-by-one to Copilot, verifies completion, and moves to the next — fully autonomous.

## How It Works

1. Write a `PRD.md` with checkbox tasks (`- [ ] Do something`)
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
                           ├── Build prompt (task + context + gates)
                           ├── Send prompt (agent mode → chat → clipboard)
                           ├── Watch PRD.md for [x] change
                           ├── Struggle detection → nudge / decompose / regenerate / skip
                           ├── Circuit breakers → trip on stagnation, errors, thrashing
                           ├── Countdown → next task
                           └── Loop ↑
```

### Source Modules

```
src/
├── types.ts              # All types, configs, enums, logger factories
├── prd.ts                # PRD parser, task picker, checkbox detection
├── prompt.ts             # Prompt builder with context trimming, frontmatter parsing
├── copilot.ts            # 3-level Copilot fallback (agent → chat → clipboard)
├── verify.ts             # Deterministic pass/fail verification
├── orchestrator.ts       # Async generator loop, file watcher, event system
├── extension.ts          # VS Code entry point, command registration
├── circuitBreaker.ts     # Chain of breakers: stagnation, error, repeated-error
├── stagnationDetector.ts # Detects stuck loops via progress diffing
├── struggleDetector.ts   # Classifies agent struggle signals
├── knowledge.ts          # Knowledge persistence (learnings across tasks)
├── gitOps.ts             # Git operations for diff, commit detection
├── diffValidator.ts      # Validates diffs match expectations
├── hookBridge.ts         # External hook script integration
├── shellHookProvider.ts  # Shell hook execution
├── sessionPersistence.ts # Save/restore loop state across restarts
├── consistencyChecker.ts # PRD ↔ progress consistency validation
├── decisions.ts          # Decision logging for decompose/skip actions
└── strategies.ts         # Configurable strategy patterns
```

## Installation

```bash
git clone <repo-url> ralph-loop
cd ralph-loop
npm install
npm run compile

# Package and install
npx @vscode/vsce package --allow-missing-repository
code --install-extension ralph-loop-0.1.0.vsix
```

## CLI Usage

```bash
npx ralph init      # Create a blank PRD template
npx ralph status    # Check PRD progress
npx ralph next      # Show next pending task
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
| `ralph-loop.inactivityTimeoutMs` | `300000` | Timeout before skipping task |
| `ralph-loop.promptTemplate` | `""` | Custom prompt template with `{{variable}}` placeholders |

## PRD Task Format

Tasks in `PRD.md` use a two-tier Progressive Disclosure (PD) pattern:

### Tier 1: Inline (self-contained)

For tasks fully describable in ≤ 3 sentences:

```markdown
- [ ] **Task 63 — Search-Before-Implement Gate**: Add SEARCH-BEFORE-IMPLEMENT GATE section to prompt. Add test verifying prompt contains it. Run `npx tsc --noEmit` and `npx vitest run`.
```

### Tier 2: PD Reference (spec-backed)

For complex tasks needing design details. The one-liner is intentionally too brief — forces the agent to read the spec:

```markdown
- [ ] **Task 57 — Context Budget Awareness**: Add token budget estimation with configurable annotate/handoff modes. → Spec: `research/14-phase9-refined-tasks.md` L15-L36
```

When `buildPrompt()` encounters a `→ Spec:` reference, it parses the spec file's YAML frontmatter and injects a one-liner context summary (phase, principles, verification commands) into the prompt automatically.

Use `/updatePRD` to add tasks following this format.

## Research Workflow

Research artifacts live in `research/` and follow a structured PD chain:

```
PRD.md (one-liner tasks)
  → Spec files (frontmatter + detailed task specs with line ranges)
    → Research files (frontmatter + analysis and evidence)
      → External sources (repos, docs, APIs)
```

### Slash commands

| Command | Purpose |
|---------|---------|
| `/researchPhase` | Run a multi-wave research phase: fan-out analysis of repos/URLs → synthesis → task specs → PRD entries |
| `/normalizeResearchFiles` | Add YAML frontmatter to research files that lack it |
| `/updatePRD` | Add tasks to PRD using two-tier PD format |

### Starting a new phase

```
/researchPhase
Sources: github.com/user/repo1, github.com/user/repo2
Phase: 10
Objective: Add multi-model support with provider abstraction
```

This produces two frontmatter'd files in `research/`, updates `research/INDEX.md`, and outputs PRD entries for review.

### Normalizing existing files

```
/normalizeResearchFiles 01-12
```

Scans files, extracts metadata from blockquote headers, adds YAML frontmatter, validates with `parseFrontmatter()`.

## Development

```bash
npm run compile       # Build
npm run watch         # Watch mode
npm test              # Run all tests (vitest)
npm run test:watch    # Watch tests
```

### Testing

Every change requires passing both checks:

```bash
npx tsc --noEmit      # Type checking (must exit 0)
npx vitest run        # All tests must pass
```

## Key Design Choices

- **Deterministic verification**: Checks PRD checkbox state directly, no LLM involvement
- **3-level Copilot fallback**: agent mode → chat → clipboard
- **Fresh session per task**: Prevents context pollution between tasks
- **Async generator orchestrator**: Yields typed events, composable and testable
- **Progressive context trimming**: Full → abbreviated → minimal as iterations increase
- **YAML frontmatter**: Machine-readable metadata on research/spec files for automatic context injection
- **Two-tier PD tasks**: Inline for simple tasks, spec-referenced for complex ones

## License

MIT
