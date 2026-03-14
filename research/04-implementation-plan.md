# Implementation Plan — Ralph + Autopilot Fusion

> Source: Synthesis of autopilot reverse-engineering + Ralph ecosystem analysis (March 2026)

---

## Architecture: Two Delivery Modes

The system works as a **VS Code extension** (chat participant) AND via **CLI** (task management). Two interfaces on a shared core:

```
┌──────────────────────────────────────────────────┐
│                   Ralph Core                      │
│                                                   │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────┐ │
│  │ Task     │  │ Session  │  │ State           │ │
│  │ Manager  │  │ Reset    │  │ Persistence     │ │
│  │          │  │ Engine   │  │ (files + git)   │ │
│  └────┬─────┘  └────┬─────┘  └────────┬────────┘ │
│       │              │                 │          │
│  ┌────┴──────────────┴─────────────────┴────────┐│
│  │           Orchestrator Loop                   ││
│  │  (autopilot principles: deterministic,        ││
│  │   safety valves, nudge injection)             ││
│  └──────────────┬───────────────────┬────────────┘│
└─────────────────┼───────────────────┼─────────────┘
                  │                   │
         ┌────────┴───────┐  ┌────────┴────────┐
         │ VS Code Chat   │  │ CLI / API       │
         │ Extension      │  │ Interface       │
         └────────────────┘  └─────────────────┘
```

---

## Patterns Borrowed from Autopilot

| Autopilot Concept | Ralph Adaptation |
|---|---|
| **Deterministic continuation** — binary `task_complete` check | Each sub-task has binary `passes: true/false`. No heuristics. |
| **Nudge injection** — `UserMessage` injected when model tries to stop | Between session resets, inject state summary as the opening context |
| **Tool call limit expansion** — 1.5x up to 200 cap | Per-session iteration cap (configurable) with auto-expansion across resets |
| **Yield suppression** — ignore new messages during autopilot | Task-level focus: don't yield mid-task, but yield between tasks |
| **Retry logic with counter reset** | Per-task retry with counter reset on progress. Global retry via session reset. |
| **Three-tier stop hooks** — external → subagent → internal | External hooks (user configurable), session-level (orchestrator), task-level (completion criteria) |
| **formatHookContext** — wrap context for injection | State summary formatter: completed tasks, current task, progress.txt, blockers |

## Patterns Borrowed from Ralph Implementations

| Ralph Concept | Source | Implementation |
|---|---|---|
| **Fresh session per task** | snarktank, aymenfurter | `workbench.action.chat.newEditSession` |
| **Circuit breaker** (3-state) | frankbria | Stagnation detection → HALF_OPEN → retry → OPEN → skip |
| **Dual exit gate** | frankbria, Gsaecy | Model signal AND machine verification required |
| **Auto-decomposition** | Gsaecy, giocaizzi | AI decomposes goal into atomic tasks |
| **6 verifiable criteria types** | Gsaecy | `diagnostics`, `fileExists`, `fileContains`, `vscodeTask`, `globExists`, `userConfirm` |
| **progress.txt as memory** | snarktank, aymenfurter | Append-only learnings log survives session resets |
| **Git as ground truth** | giocaizzi | Atomic commits per task = durable state |
| **`.agent.md` pipeline** | giocaizzi | Planner → Executor → Reviewer roles |

---

## Three Integration Options

### Option A: Chat Participant (full control)

```
@ralph "Build a user authentication system with OAuth2"
```

A chat participant registered via `vscode.chat.createChatParticipant()` that:
1. Decomposes the goal into atomic tasks
2. For each task, creates a **fresh agent mode session**
3. Injects task context + state summary as the opening prompt
4. Monitors completion via file watchers or hooks
5. On task completion, commits, updates progress, moves to next task
6. On stagnation, triggers circuit breaker → retry or skip

### Option B: Claude Hook System (lighter)

Register hooks into Copilot's existing hook registry:
- `SessionStart` → Initialize Ralph state, load PRD
- `Stop` → Check if current task is done; if not, inject nudge
- `PreCompact` → Trigger session reset before context compacts (**key innovation**)
- `PostToolUse` → Track progress

### Option C: Hybrid (recommended)

Chat participant for orchestration + hooks for in-session quality control:
- The participant manages the task queue and fresh sessions
- Hooks monitor quality within each session

---

## Key Innovation: PreCompact Reset

The single biggest improvement over existing Ralph implementations.

Instead of using a fixed iteration count to decide when to reset, **hook into the LLM's own compaction signal**:

```
Normal autopilot:  context fills → compaction → quality degrades → eventual failure
Ralph autopilot:   context fills → PreCompact fires → save state → fresh session → continue
```

Why this is superior:
- No arbitrary iteration limits
- Reset happens at the *exact* right moment (when context is about to degrade)
- State transfer is explicit and structured (not hoping the LLM remembers)

---

## API Interface Design

```typescript
interface RalphAPI {
  start(config: {
    goal: string;
    prd?: TaskDefinition[];
    model: string;
    workspacePath: string;
    maxIterations?: number;
    maxTasks?: number;
    verifiers?: Verifier[];
  }): RalphSession;

  pause(sessionId: string): void;
  resume(sessionId: string): void;
  stop(sessionId: string): void;
  skip(sessionId: string): void;

  getProgress(sessionId: string): Progress;
  getState(sessionId: string): SessionState;
  onEvent(sessionId: string, handler: EventHandler): Disposable;
}
```

Exposure options:
1. **VS Code commands** — inter-extension communication
2. **Extension API** — `vscode.extensions.getExtension('ralph').exports`
3. **HTTP server** — external orchestrator integration
4. **CLI wrapper** — terminal-based automation

---

## Recommended File Structure

```
ralph-loop/
├── src/
│   ├── core/
│   │   ├── orchestrator.ts        # Main loop (autopilot-style deterministic)
│   │   ├── taskManager.ts         # PRD parsing, task queue, decomposition
│   │   ├── sessionResetEngine.ts  # Fresh session creation + state injection
│   │   ├── stateStore.ts          # progress.txt, PRD state, checkpoints
│   │   ├── circuitBreaker.ts      # 3-state stagnation detection
│   │   ├── verifier.ts            # Machine verification (6 types)
│   │   └── types.ts               # Shared interfaces
│   ├── vscode/
│   │   ├── chatParticipant.ts     # @ralph chat participant
│   │   ├── hooks/
│   │   │   ├── preCompactReset.ts # Reset before compaction
│   │   │   ├── stopHook.ts        # Task completion gate
│   │   │   └── progressTracker.ts # PostToolUse progress tracking
│   │   ├── panel.ts               # Control panel webview
│   │   └── commands.ts            # VS Code commands
│   ├── api/
│   │   ├── server.ts              # HTTP API for maestro
│   │   ├── client.ts              # Programmatic control
│   │   └── cli.ts                 # CLI wrapper
│   └── extension.ts               # Activation
├── templates/
│   ├── decompose.prompt.md        # Task decomposition prompt
│   ├── execute.prompt.md          # Per-task execution prompt
│   └── review.prompt.md           # Verification prompt
└── package.json
```

---

## Phased Delivery

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Core loop + CLI + VS Code extension (flat structure) | ✅ Complete |
| **Phase 2** | Autopilot patterns (nudge, retry, hooks, state machine) | ✅ Complete |
| **Phase 3** | Extended patterns (yield, shell hooks, prompt blocks, hook bridge) | ✅ Complete |
| **Phase 4** | Agentic proxy patterns (invocation threading, strategies, verification gate) | ✅ Complete |
| **Phase 5** | Advanced patterns (PreCompact reset, circuit breaker, chat participant, multi-verifier) | 🔲 Planned |
