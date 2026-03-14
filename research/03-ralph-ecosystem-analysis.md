# Ralph Ecosystem Analysis

> Source: Parallel analysis of 7 Ralph implementations + awesome-ralph catalog (March 2026)

---

## The Ralph Core Principle

Every implementation converges on one idea:

> **Context rot is unsolvable within a session, so nuke the context and persist state in files.**

The differences are in *how* they nuke it, *what* state they persist, and *how* they verify progress.

---

## The 7 Implementations

### 1. snarktank/ralph — The Original

| Attribute | Value |
|---|---|
| Type | Bash script (113 lines) |
| Innovation | Fresh process per iteration |
| Memory | `prd.json` + `progress.txt` |
| Mechanism | Pipe prompt into Claude CLI, capture output, check completion, repeat |

The simplest implementation. Each iteration is a clean process — no accumulated context.

### 2. frankbria/ralph-claude-code

| Attribute | Value |
|---|---|
| Type | Bash script (1900 lines) |
| Innovation | Circuit breaker, dual exit gate, session resume |
| Protocol | Structured `RALPH_STATUS` protocol |

Key patterns:
- **3-state circuit breaker**: CLOSED → HALF_OPEN → OPEN for stagnation detection
- **Dual exit gate**: Both model signal AND machine verification required
- **Session resume**: Can pick up from where it left off

### 3. hehamalainen/Ralph

| Attribute | Value |
|---|---|
| Type | VS Code extension (chat participant) |
| Innovation | Security-hardened single-command execution |
| API | Model-agnostic via Language Model API |

Focuses on security: one command at a time, no bulk operations.

### 4. Gsaecy/Ralph-Loop-Code

| Attribute | Value |
|---|---|
| Type | VS Code extension |
| Innovation | Auto-decomposition into sub-tasks |
| Verification | 6 machine-verifiable criteria types |
| Providers | Dual provider (Copilot + OpenAI) |

The 6 verification types:

| Type | What It Checks |
|---|---|
| `diagnostics` | VS Code diagnostics (errors/warnings) |
| `fileExists` | A specific file was created |
| `fileContains` | A file contains expected content |
| `vscodeTask` | A VS Code task runs successfully |
| `globExists` | Files matching a glob pattern exist |
| `userConfirm` | Manual user confirmation |

### 5. aymenfurter/ralph

| Attribute | Value |
|---|---|
| Type | VS Code extension (webview) |
| Innovation | Visual Control Panel, Fresh Chat Mode |
| Session Reset | `workbench.action.chat.newEditSession` |
| Detection | Inactivity detection |

3-level Copilot fallback:
1. Try `openEditSession` (agent mode with prompt)
2. Try `chat.open` (regular chat)
3. Try `newEditSession` (fresh session)
4. Fall back to clipboard

### 6. giocaizzi/ralph-copilot

| Attribute | Value |
|---|---|
| Type | Zero-code (4 `.agent.md` files) |
| Innovation | Pure prompt engineering pipeline |
| Pattern | Planner → Coordinator → Executor → Reviewer |
| Uses | VS Code Custom Agents |

Roles defined entirely through `.agent.md` files — no executable code. Relies on VS Code's built-in agent system for execution.

### 7. awesome-ralph (Catalog)

- 20+ implementations cataloged
- Core principles documented
- Community convergence on key patterns

---

## Convergent Patterns Across Implementations

| Pattern | Who Uses It | Description |
|---|---|---|
| Fresh session per task | snarktank, aymenfurter | Clean context for each task iteration |
| File-based state persistence | All | `progress.txt`, `prd.json/md`, git commits |
| Binary completion check | All | Checkbox, status file, or explicit signal |
| Circuit breaker | frankbria | Stagnation detection with state transitions |
| Dual exit gate | frankbria, Gsaecy | Model claims done + machine verifies |
| Auto-decomposition | Gsaecy, giocaizzi | Break goal into atomic sub-tasks |
| Git as ground truth | giocaizzi | Atomic commits = durable state |
| Workbench commands | aymenfurter, hehamalainen, Gsaecy | Drive Copilot via internal VS Code commands |

---

## Workbench Commands Used

All VS Code-based Ralph implementations rely on **internal/undocumented** commands:

| Command | Purpose |
|---------|---------|
| `workbench.action.chat.newEditSession` | Create a **fresh** agent mode session (clean context) |
| `workbench.action.chat.openEditSession` | Open agent mode with a specific prompt |
| `workbench.action.chat.open` | Open chat panel with a prompt |

These are part of VS Code's internal command registry — not in the public extension API. They could break in any VS Code update.

---

## Key Insight: CLI vs Extension

The split is architecturally necessary:

- **CLI** = PRD/task file management (`init`, `status`, `next`) — works from any terminal
- **Extension** = the actual loop — **must** be inside VS Code because Copilot's workbench commands only exist in the extension host

A CLI can trigger the extension (e.g., via URI handler), but the execution loop itself requires the VS Code environment.
