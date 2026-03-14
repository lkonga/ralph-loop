# Deep Analysis: aymenfurter/ralph

> Source: https://github.com/aymenfurter/ralph (v0.5.1, MIT License)
> An implementation of [Geoffrey Huntley's Ralph technique](https://ghuntley.com/ralph/) for GitHub Copilot.

## 1. Architecture Overview

### File Structure (13 source files)

| File | Lines | Purpose |
|------|-------|---------|
| `extension.ts` | ~110 | Entry point, `RalphExtension` class, command registration |
| `orchestrator.ts` | ~344 | **Core loop** - state machine, task sequencing, file watchers |
| `taskRunner.ts` | ~153 | Task execution, Copilot interaction, iteration tracking |
| `copilotIntegration.ts` | ~39 | VS Code command wrappers for Copilot |
| `promptBuilder.ts` | ~236 | Prompt construction with sanitization & templates |
| `fileUtils.ts` | ~148 | PRD/progress file I/O, task parsing |
| `fileWatchers.ts` | ~159 | PRD change detection, activity monitoring |
| `timerManager.ts` | ~121 | Countdown timer, inactivity monitor |
| `controlPanel.ts` | ~356 | Webview panel + sidebar provider |
| `uiManager.ts` | ~76 | UI facade over panel/sidebar/statusbar |
| `statusBar.ts` | ~74 | Status bar with state icons |
| `config.ts` | ~17 | VS Code configuration reader |
| `types.ts` | ~91 | Enums, interfaces, constants |
| `webview/*` | ~1500+ | styles, scripts, templates (HTML generation) |

### Core Flow

```
Extension.activate()
  → RalphExtension (singleton)
    → RalphStatusBar
    → LoopOrchestrator
    → RalphSidebarProvider (Activity Bar)
    → Commands: ralph.showPanel, ralph.viewLogs

Start Loop:
  1. Check pending tasks in PRD.md
  2. Ensure progress.txt exists
  3. Clear history/logs, set RUNNING state
  4. setupWatchers() → PrdWatcher + ActivityWatcher + InactivityMonitor
  5. runNextTask() → TaskRunner.triggerCopilotAgent()
  6. PrdWatcher detects task completion (checkbox change)
  7. Record completion, append progress.txt
  8. 12-second review countdown
  9. Next task (goto 5)
```

## 2. Copilot Integration (CRITICAL)

### `copilotIntegration.ts` - 3-Level Fallback

```typescript
export async function openCopilotWithPrompt(prompt, options) {
  if (options.freshChat) {
    await tryCommand('workbench.action.chat.newEditSession');
  }
  // Level 1: Agent Mode (edit session)
  if (await tryCommand('workbench.action.chat.openEditSession', { query: prompt })) {
    return 'agent';
  }
  // Level 2: Chat panel
  if (await tryCommand('workbench.action.chat.open', { query: prompt })) {
    return 'chat';
  }
  // Level 3: Clipboard fallback
  await vscode.env.clipboard.writeText(prompt);
  return 'clipboard';
}

export async function startFreshChatSession() {
  return tryCommand('workbench.action.chat.newEditSession');
}
```

**Key insight**: Ralph ALWAYS starts a fresh chat session per task:
```typescript
// taskRunner.ts - triggerCopilotAgent()
const success = await startFreshChatSession(); // Always fresh
const method = await openCopilotWithPrompt(prompt); // Then send prompt
```

### Commands Used (Internal, Unofficial)
- `workbench.action.chat.newEditSession` - New fresh session
- `workbench.action.chat.openEditSession` - Open agent mode with query
- `workbench.action.chat.open` - Open chat with query

## 3. Completion Detection (File-Watching Strategy)

Ralph does NOT parse Copilot output. Instead it watches PRD.md for changes:

```
Orchestrator → PrdWatcher watches PRD.md
  → onDidChange: compare old vs new content
  → handlePrdChange(): compare current task description against next task
  → If task changed from "- [ ]" to "- [x]" → task complete
  → Record in taskHistory, append to progress.txt
  → Start 12-second review countdown
```

The prompt instructs Copilot to mark tasks complete:
```
1. After completing the task, UPDATE PRD.md:
   Find this line:    - [ ] <task>
   Change it to:      - [x] <task>
2. APPEND to progress.txt with what you did
```

**This is the simplest possible completion signal** - no confidence scoring, no status blocks. Just file-system level observation.

## 4. Prompt Engineering

### Agent Prompt Structure (`buildAgentPromptAsync`)

```
═══════════════════════════════════════════════════════════════
                       YOUR TASK TO IMPLEMENT
═══════════════════════════════════════════════════════════════

<sanitized task description>

═══════════════════════════════════════════════════════════════
           MANDATORY: UPDATE PRD.md AND progress.txt WHEN DONE
═══════════════════════════════════════════════════════════════

🚨 THESE STEPS ARE REQUIRED - DO NOT SKIP THEM! 🚨

1. After completing the task, UPDATE PRD.md:
   Find this line:    - [ ] <task>
   Change it to:      - [x] <task>

2. APPEND to progress.txt with what you did

═══════════════════════════════════════════════════════════════
                      PROJECT CONTEXT
═══════════════════════════════════════════════════════════════

## Current PRD.md Contents:
<full PRD>

## Progress Log (progress.txt):
<progress so far>

═══════════════════════════════════════════════════════════════
                       WORKFLOW REMINDER
═══════════════════════════════════════════════════════════════

1. ✅ Implement the task
2. ✅ Write unit tests (if enabled)
3. ✅ Run tests (if enabled)
...
N. ✅ UPDATE PRD.md
N+1. ✅ APPEND to progress.txt

Workspace: <root>
Begin now. Remember: updating both PRD.md and progress.txt when done is MANDATORY!
```

### Input Sanitization
- `MAX_TASK_DESCRIPTION_LENGTH = 5000`
- Strips control characters
- Collapses triple+ newlines
- Escapes code fences (`\`\`\``)

### Custom Templates
Supports `{{task}}`, `{{prd}}`, `{{progress}}`, `{{requirements}}`, `{{workspace}}` placeholders via VS Code settings.

## 5. Task Parsing

```typescript
// Regex: /^[-*]\s*\[([ x~!])\]\s*(.+)$/im
// Markers: ' ' → PENDING, 'x' → COMPLETE, '~' → IN_PROGRESS, '!' → BLOCKED
// Handles CRLF, LF, and CR line endings
```

42 fixture files for cross-platform line ending testing.

## 6. Inactivity Handling

```
InactivityMonitor: polls every 10s, triggers after 60s no file activity
  → handleInactivity() shows dialog:
    - "Continue Waiting" → reset timer
    - "Retry Task" → re-trigger same task
    - "Skip Task" → move to next
    - "Stop Loop" → stop everything
```

## 7. Review Countdown

```
REVIEW_COUNTDOWN_SECONDS = 12
After task completion → 12-second countdown with SVG circle animation
  → User can click "Stop" to halt
  → Otherwise auto-advances to next task
```

## 8. UI Architecture

**Dual UI pattern:**
1. **Sidebar** (`RalphSidebarProvider`): Minimal - logo + "Open Control Panel" button
2. **Panel** (`RalphPanel`): Full webview in Column Two with `retainContextWhenHidden: true`

**Event system** using typed `Map<PanelEventType, Set<PanelEventHandler>>`:
- Events: start, stop, pause, resume, next, generatePrd, requirementsChanged, settingsChanged
- Returns `vscode.Disposable` for cleanup

**Webview features:**
- Task timeline histogram (bar chart)
- Countdown clock (SVG circle)
- Optimistic UI updates (button states change before server response)
- XSS prevention: `escapeHtml()` for log messages
- Session timing with ETA calculation

## 9. Acceptance Criteria (TaskRequirements)

User-toggleable checkboxes in the UI that inject steps into the prompt:
- `writeTests` → "Write unit tests"
- `runTests` → "Run tests and ensure they pass"
- `runTypeCheck` → "Run type checking (tsc --noEmit)"
- `runLinting` → "Run linting and fix issues"
- `updateDocs` → "Update documentation"
- `commitChanges` → "Commit with descriptive message"

All default to `false`. These are **prompt-level gates**, not verified programmatically.

---

## 10. Comparative Analysis: ralph vs ralph-loop

### What ralph HAS that ralph-loop could adopt

| Pattern | Ralph Implementation | Value for ralph-loop |
|---------|---------------------|---------------------|
| **Review Countdown** | 12s pause between tasks for human review | HIGH - gives user visibility into what's happening before auto-advancing |
| **File Activity Detection** | `ActivityWatcher` on `**/*` feeds inactivity monitor | MEDIUM - alternative/supplement to stagnation detection |
| **Inactivity Dialog** | 4-option dialog (Continue/Retry/Skip/Stop) after 60s | HIGH - more user-friendly recovery than auto circuit-break |
| **PRD.md as Completion Signal** | Watches for checkbox changes instead of parsing Copilot output | HIGH - simpler, more reliable than response parsing |
| **Webview Control Panel** | Rich panel with timeline, countdown, stats | MEDIUM - better UX than status bar alone |
| **PRD Generation** | Copilot generates PRD from description | LOW - nice onboarding UX but not core |
| **Custom Prompt Templates** | `{{task}}`, `{{prd}}` etc via settings | MEDIUM - power user feature |
| **Acceptance Criteria UI** | Checkbox toggles for test/lint/typecheck gates | MEDIUM - visual equivalent of TDD gates |
| **Optimistic UI Updates** | Instant button state changes | LOW - nice polish |

### What ralph-loop HAS that ralph LACKS

| Pattern | ralph-loop | Impact |
|---------|-----------|--------|
| **Async Generator Orchestrator** | `yield`-based loop with backpressure | Ralph uses simple state machine with callbacks |
| **Circuit Breakers** (3-state) | CLOSED/HALF_OPEN/OPEN with auto-recovery | Ralph only has iteration limit + inactivity timeout |
| **Stagnation Detection** | Multi-signal: repeated errors, no-progress scoring | Ralph only has 60s inactivity check |
| **TDD Gates** (programmatic) | Actually verifies test results | Ralph only asks Copilot to run tests (prompt-level) |
| **Atomic Git Commits** | Per-task git commits with structured messages | Ralph has optional `commitChanges` flag (prompt-level) |
| **Nudge System** | Progressively stronger prompts on stall | Ralph has retry or skip, no gradual escalation |
| **Hook Bridge** | Shell hook integration for external tools | No equivalent |
| **Diff Validation** | Validates changes are meaningful | No equivalent |
| **Review-After-Execute** | Post-execution review pass | No equivalent |
| **Parallel Monitor** | Concurrent task tracking | Ralph is strictly sequential |
| **DAG Task Dependencies** | Task dependency graph | Ralph is sequential only |
| **Consistency Checker** | Cross-file consistency validation | No equivalent |

### Architecture Differences

| Aspect | ralph | ralph-loop |
|--------|-------|-----------|
| **Pattern** | Class-based OOP, callbacks | Async generators, functional |
| **State** | Simple IDLE/RUNNING + isPaused flag | More granular states |
| **Copilot Integration** | Internal workbench commands (unofficial) | Same approach (3-level fallback) |
| **Completion Detection** | File watching (PRD.md changes) | Copilot output parsing + file checks |
| **Error Recovery** | Inactivity dialog + iteration limit | Circuit breakers + stagnation detection + nudges |
| **Verification** | Prompt-level only ("please run tests") | Programmatic verification |
| **UI** | Rich webview panel | Status bar / simpler |

## 11. Key Patterns Worth Adopting

### 1. File-Based Completion Signal (HIGHEST PRIORITY)
Ralph's approach of watching PRD.md for checkbox changes is more reliable than parsing Copilot output. The prompt instructs Copilot to update the file, and the file watcher detects the change. This is deterministic and doesn't require parsing natural language.

**Recommendation**: Add PRD file watching as a primary completion signal in ralph-loop, with the existing output parsing as fallback.

### 2. Review Countdown Timer
The 12-second pause gives humans a chance to inspect changes before auto-advancing. This is a safety net that ralph-loop currently lacks.

**Recommendation**: Add configurable review countdown between tasks.

### 3. Inactivity Dialog with Options
Instead of just circuit-breaking, offer the user choices: Continue/Retry/Skip/Stop. This is more user-friendly and avoids the need to restart the entire loop.

**Recommendation**: Integrate this as a fallback when stagnation is detected, before circuit breaker trips.

### 4. Acceptance Criteria as Prompt Injection
The checkbox UI that dynamically builds numbered steps in the prompt is clean. Each requirement adds a step like "2. ✅ Run tests and ensure they pass".

**Recommendation**: Consider making ralph-loop's TDD gates configurable via a similar UI, while keeping programmatic verification as the enforcement layer.

### 5. Input Sanitization
`sanitizeTaskDescription()` handles: control characters, triple newlines, code fence escaping, length limits. Simple but important for prompt injection prevention.

**Recommendation**: Adopt similar sanitization in ralph-loop's prompt builder.
