# Ralph Loop

> Drives VS Code Copilot Agent Mode in a deterministic loop from PRD tasks.

Ralph-loop reads checkbox tasks from a `PRD.md` file, opens a **fresh Copilot session per task**, verifies completion with **deterministic machine checks** (not LLM self-report), and moves to the next — fully autonomous.

**Core insight**: Context rot is unsolvable within a session. Ralph-loop nukes the context after each task and persists all state in files — PRD.md as the task ledger, progress.txt as the audit log, knowledge.md as compounding learnings.

## Features

- **Deterministic control plane** — Verification, circuit breaking, and loop control as executable code, not prompt prose. 7 builtin verifiers, confidence scoring, dual exit gate.
- **Dual exit gate** — Task completion requires BOTH model self-report (PRD checkbox) AND machine verification (tsc + vitest + file changes).
- **7 circuit breaker types** — MaxRetries, MaxNudges, Stagnation, ErrorRate, TimeBudget, RepeatedError, PlanRegeneration. Graduated escalation: nudge → automated action → human checkpoint.
- **Auto-decomposition** — After repeated failures, splits stuck tasks into sub-tasks directly in PRD.md.
- **Compounding knowledge** — Extracts `[LEARNING]`/`[GAP]` tags from AI output, persists to `knowledge.md`, re-injects relevant learnings into future tasks.
- **4 presets** — `general`, `feature`, `bugfix`, `refactor` — each tuned for different development workflows.
- **CLI companion** — `npx ralph status/next/init` for PRD management from any terminal.
- **Session persistence** — Crash recovery via `.ralph/session.json` with atomic writes.
- **Async generator architecture** — `AsyncGenerator<LoopEvent>` yielding 30+ typed events, composable and testable.
- **Self-hosting** — Ralph-loop executes its own PRD to bootstrap its own development.

## Quickstart

### Prerequisites

- VS Code 1.93+ with [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) and [Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)

### Install

```bash
git clone <repo-url> ralph-loop
cd ralph-loop
npm install
npm run compile

npx @vscode/vsce package --allow-missing-repository
code --install-extension ralph-loop-*.vsix
```

### Run

1. Create a `PRD.md` in your workspace root with checkbox tasks:

```markdown
- [ ] Create a hello world function in src/hello.ts with a test
- [ ] Add error handling for invalid inputs
```

2. Open the workspace in VS Code — the extension activates automatically (`workspaceContains:PRD.md`)
3. Run **Ralph Loop: Start** from the Command Palette
4. Ralph picks the first pending task, opens a fresh Copilot session, sends the prompt, and watches for completion
5. When the task passes verification (checkbox + tsc + vitest), it commits and moves to the next task

### CLI

```bash
npx ralph status    # PRD progress: 3/10 tasks complete
npx ralph next      # Next pending task description
npx ralph init      # Scaffold a blank PRD template
```

The CLI is **read-only** — it inspects PRD state but never triggers the loop or modifies files.

## How It Works

```
                 ┌──────────────────────────────────────────────┐
                 │            LoopOrchestrator                  │
                 │         AsyncGenerator<LoopEvent>            │
                 ├──────────────────────────────────────────────┤
                 │                                              │
  PRD.md ──────► │  1. Parse PRD → pick next pending task       │
                 │  2. Guard checks (abort, pause, breakers)    │
                 │  3. Bearings pre-flight (tsc + vitest)       │
                 │  4. Build prompt (task + context + gates)     │
                 │  5. Open fresh Copilot session → send prompt │
                 │  6. Monitor: nudge on timeout, reset on      │
                 │     productive changes                       │
                 │  7. Evaluate: stagnation? struggle? done?    │
                 │  8. Verify: dual exit gate + confidence      │
progress.txt ◄── │  9. Commit → cooldown → next task            │
knowledge.md ◄── │                                              │
                 └──────────────────────────────────────────────┘
```

### Copilot Integration

4-layer architecture with graceful degradation:

| Layer | Mechanism | Fallback |
|-------|-----------|----------|
| Direct commands | `workbench.action.chat.*` commands | Agent mode → chat panel → clipboard |
| Execution strategy | File-watcher polling for PRD changes | 5-second polling loop |
| Hook bridge | Runtime scripts for `chat.hooks` API | No-op (feature flag gated) |
| Signal file IPC | Filesystem watcher on temp signal file | External processes can trigger chat |

## Architecture

### Source Modules

```
src/
├── orchestrator.ts       # Async generator loop, 9-phase execution, event system
├── prd.ts                # PRD parser (2-pass), task picker, DAG-aware selection
├── prompt.ts             # Prompt builder, context trimming, frontmatter parsing
├── verify.ts             # 7 verifiers, confidence scoring, dual exit gate
├── copilot.ts            # 3-level Copilot fallback (agent → chat → clipboard)
├── circuitBreaker.ts     # 7 breaker types, chain-of-responsibility pattern
├── stagnationDetector.ts # SHA-256 file-hash diffing, 3-tier escalation
├── struggleDetector.ts   # 4-signal struggle classification
├── knowledge.ts          # Learning extraction, dedup, keyword retrieval, GC
├── diffValidator.ts      # Git diff validation, retry with human escalation
├── gitOps.ts             # Atomic per-task commits, conventional messages
├── hookBridge.ts         # Runtime hook script generation for chat.hooks API
├── shellHookProvider.ts  # Shell hook execution with injection protection
├── sessionPersistence.ts # Crash recovery via .ralph/session.json
├── consistencyChecker.ts # PRD ↔ progress consistency validation
├── decisions.ts          # Pure decision functions for testability
├── strategies.ts         # ITaskExecutionStrategy pattern
├── types.ts              # All types, configs, enums, logger factories
├── extension.ts          # VS Code entry point, command registration
cli/
└── ralph.ts              # Standalone CLI (status, next, init)
```

### Key Files

| File | Role |
|------|------|
| `PRD.md` | Task queue + spec + completion ledger. Re-read every iteration. |
| `progress.txt` | Append-only audit log with ISO 8601 timestamps and invocation IDs |
| `knowledge.md` | Compounding learnings extracted from AI output |
| `.ralph/session.json` | Resumable loop state for crash recovery |

## Verification System

Multi-signal verification pipeline — not simple pass/fail:

### 7 Builtin Verifiers

| Verifier | What it checks |
|----------|---------------|
| `checkbox` | PRD task checkbox state (`[x]`) |
| `tsc` | TypeScript compilation (`tsc --noEmit`) |
| `vitest` | Test execution (`vitest run`) |
| `fileExists` | Expected files were created |
| `fileContains` | File content matches expectations |
| `commandExitCode` | Arbitrary command exits 0 |
| `custom` | User-defined verification logic |

### Confidence Scoring

Each verification produces a weighted confidence score:

| Signal | Weight |
|--------|--------|
| Checkbox marked | 100 |
| Vitest passes | 20 |
| TSC clean | 20 |
| Files changed (diff) | 20 |
| No errors | 10 |
| Progress updated | 10 |

Below the confidence threshold, the task re-enters with structured feedback.

### Dual Exit Gate

A task is only complete when **both** conditions are met:
1. **Model signal** — Agent marked the PRD checkbox as done
2. **Machine verification** — Deterministic checks (tsc, vitest, diff) pass

This prevents the LLM from claiming completion without actual working code.

## Safety Mechanisms

### Circuit Breakers

7 types in a chain-of-responsibility:

| Breaker | Threshold | Action |
|---------|-----------|--------|
| MaxRetries | 3 attempts | skip |
| MaxNudges | 3 nudges | skip |
| Stagnation | 2 consecutive stale iterations | skip |
| ErrorRate | 60% in 5-iteration window | stop |
| TimeBudget | 600 seconds | stop |
| RepeatedError | 3x same error hash | skip |
| PlanRegeneration | 2 decomposition failures | regenerate |

### Graduated Escalation

Problems escalate uniformly across all subsystems:

```
Inject context → Nudge → Circuit breaker → Auto-decompose → Human checkpoint
```

### Struggle Detection

4 independent signals:
- **No progress** — ≥3 iterations with 0 file changes
- **Short iterations** — ≥3 iterations under 30 seconds each
- **Repeated errors** — Same error hash appearing ≥2 times
- **Thrashing** — Same file+region edited ≥3 times in a 10-edit window

### Bearings Pre-flight

Optional health check (`tsc --noEmit` + `vitest run`) before each task. If unhealthy, injects a fix task or pauses the loop.

## Configuration

### VS Code Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ralph-loop.prdPath` | `PRD.md` | Path to PRD file (relative to workspace) |
| `ralph-loop.progressPath` | `progress.txt` | Path to progress log |
| `ralph-loop.maxIterations` | `50` | Max loop iterations (0 = unlimited) |
| `ralph-loop.countdownSeconds` | `12` | Seconds between tasks |
| `ralph-loop.inactivityTimeoutMs` | `300000` | Inactivity timeout (ms) before nudging |
| `ralph-loop.promptTemplate` | `""` | Custom prompt template with `{{variable}}` placeholders |
| `ralph-loop.preset` | `general` | Preset profile: `general`, `feature`, `bugfix`, `refactor` |

### Feature Flags

Advanced capabilities behind `ralph-loop.features.*` (all default `false`):

| Flag | Purpose |
|------|---------|
| `useHookBridge` | Enable hook bridge for `chat.hooks` integration |
| `useSessionTracking` | Track active Copilot sessions |
| `useAutopilotMode` | Enable autopilot permission level |
| `useParallelTasks` | Enable DAG-aware parallel task execution |
| `useLlmConsistencyCheck` | Enable LLM-based consistency verification |

### Presets

| Preset | Purpose | Key tuning |
|--------|---------|------------|
| `general` | Balanced defaults | No overrides |
| `feature` | New feature development | `maxNudgesPerTask: 5`, `maxIterations: 30`, strict TDD |
| `bugfix` | Bug hunting | 3min inactivity timeout, aggressive error tracking |
| `refactor` | Code restructuring | `maxNudgesPerTask: 6`, `maxStaleIterations: 4` |

Config resolution: `DEFAULT_CONFIG → preset → user overrides → workspaceRoot`.

## VS Code Commands

| Command | Description |
|---------|-------------|
| `Ralph Loop: Start` | Start the autonomous loop |
| `Ralph Loop: Stop` | Stop the loop |
| `Ralph Loop: Pause` | Pause the loop (resume with Start) |
| `Ralph Loop: Show Status` | Show current loop state |

## PRD Task Format

Tasks in `PRD.md` use a two-tier Progressive Disclosure (PD) pattern:

### Tier 1: Inline (self-contained)

For tasks fully describable in ≤ 3 sentences:

```markdown
- [ ] **Task 63 — Search-Before-Implement Gate**: Add SEARCH-BEFORE-IMPLEMENT GATE section to prompt. Add test verifying prompt contains it. Run `npx tsc --noEmit` and `npx vitest run`.
```

### Tier 2: PD Reference (spec-backed)

For complex tasks needing design details:

```markdown
- [ ] **Task 57 — Context Budget Awareness**: Add token budget estimation with configurable annotate/handoff modes. → Spec: `research/14-phase9-refined-tasks.md` L15-L36
```

When `buildPrompt()` encounters a `→ Spec:` reference, it parses the spec file's YAML frontmatter and injects context automatically.

### DAG Dependencies

Indent sub-tasks under parents for implicit dependency ordering, or use explicit annotations:

```markdown
- [ ] **Task A**: Build the API
  - [ ] **Task A.1**: Create schema (depends: Task A)
  - [ ] **Task A.2**: Add endpoints (depends: Task A.1)
```

## Knowledge System

Ralph-loop builds **compounding knowledge** across tasks:

1. After each task, scans AI output for `[LEARNING]` and `[GAP]` tags
2. Deduplicates via MD5 content hashing
3. Persists to `knowledge.md`
4. Before each new task, retrieves relevant learnings via keyword overlap and injects them into the prompt

This gives the system memory across the fresh-session boundary — learnings from task 1 inform task 15.

Garbage collection archives stale entries (0 hits after 20 runs) to `knowledge-archive.md`, capping at 200 active entries.

## Research Workflow

Research artifacts live in `research/` and follow a structured PD chain:

```
PRD.md (one-liner tasks)
  → Spec files (frontmatter + detailed task specs with line ranges)
    → Research files (frontmatter + analysis and evidence)
      → External sources (repos, docs, APIs)
```

### Slash Commands

| Command | Purpose |
|---------|---------|
| `/researchPhase` | Run a multi-wave research phase: fan-out analysis → synthesis → task specs → PRD entries |
| `/normalizeResearchFiles` | Add YAML frontmatter to research files that lack it |
| `/updatePRD` | Add tasks to PRD using two-tier PD format |

## Design Philosophy

- **PRD.md is the database** — Spec, task queue, state machine, and completion ledger in one file. No external store.
- **Fresh session per task** — Context rot is unsolvable, so don't try. Nuke and restart.
- **Deterministic over probabilistic** — Machine verification (tsc, vitest, diff) over LLM self-assessment.
- **Progressive opt-in** — Works with zero config. Every advanced feature behind flags defaulting to off.
- **Graceful degradation** — Every external dependency has a fallback path. Proposed APIs wrapped in try/catch.
- **Safety before capability** — Each development phase adds safety mechanisms before new features.
- **File-based IPC** — Signal files and filesystem watchers for cross-process communication. Simple, debuggable, dependency-free.

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

Tests are pure unit tests (no VS Code extension host) with 1:1 source module mapping across 17 test files.

## License

MIT
