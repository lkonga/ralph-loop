---
type: research
id: 6
sources:
  - vinitm/ralph-loop
---
# vinitm/ralph-loop — Deep Architectural Analysis

## 1. Architecture Overview

**vinitm/ralph-loop** is a **Claude Code plugin** (NOT a VS Code extension). It installs via `claude plugin install github:anthropics/ralph-loop` and orchestrates Claude Code agents through a bash script (`scripts/ralph.sh`, ~670 lines) using `claude --print` CLI invocations.

### Key Files

| File | Purpose |
|------|---------|
| `scripts/ralph.sh` | Main orchestration loop (670 LOC bash) |
| `.ralphrc` | Bash-sourceable config (auto-detected values) |
| `tasks.json` | DAG task list with dependencies |
| `scripts/ralph/knowledge.md` | Cross-agent persistent knowledge base |
| `scripts/ralph/prompts/common/context.md` | Auto-generated project structure template |
| `scripts/ralph/prompts/common/rules.md` | Universal agent safety rules |
| `scripts/ralph/prompts/{tester,impl}/{role,steps}.md` | Agent identity + workflow templates |
| `agents/ralph-{planner,tester,impl}/AGENT.md` | Agent definitions |
| `skills/ralph-{init,plan,run,status,logs,add-task}/SKILL.md` | Slash commands |

### Execution Flow

```
/ralph-plan PRD.md → tasks.json (DAG)
                         ↓
/ralph-run → ralph.sh loop:
  ┌──────────────────────────────────────┐
  │ while pending_tasks > 0:             │
  │   task = next_unblocked(tasks.json)  │
  │   prompt = assemble_prompt("tester") │
  │   claude --print --prompt $prompt    │
  │   sleep COOLDOWN                     │
  │   prompt = assemble_prompt("impl")   │
  │   claude --print --prompt $prompt    │
  │   check_circuit_breaker()            │
  │   run_regression_tests()             │
  └──────────────────────────────────────┘
```

---

## 2. Unique Patterns NOT in Our ralph-loop

### 2.1 Knowledge Base System (`knowledge.md`)

**What**: A persistent markdown file that agents READ at the start of every invocation and APPEND to when they discover reusable patterns. Both tester and implementer agents participate.

**Why it matters**: Creates cross-agent institutional memory. Agent N+1 avoids mistakes Agent N already solved.

```markdown
# knowledge.md format:
- **Pattern name**: Description of the pattern and when to use it
```

**Our gap**: We have no cross-agent learning mechanism. Each task execution starts from scratch context-wise (except PRD + progress.txt). Our nudge system is intra-task only.

**Adoption priority**: HIGH — could be implemented as an append-only markdown file read into prompt context.

### 2.2 Modular Prompt Assembly

**What**: Prompts are built by concatenating modular markdown files:
```
context.md + rules.md + role.md + steps.md + knowledge.md + task JSON
```

Each component is a separate file in `scripts/ralph/prompts/`. The `assemble_prompt()` function in `ralph.sh` (lines 190-209) concatenates them:

```bash
assemble_prompt() {
    local agent_type="$1" task_json="$2"
    local prompt=""
    prompt+="$(cat scripts/ralph/prompts/common/context.md)"
    prompt+="$(cat scripts/ralph/prompts/common/rules.md)"
    prompt+="$(cat "scripts/ralph/prompts/${agent_type}/role.md")"
    prompt+="$(cat "scripts/ralph/prompts/${agent_type}/steps.md")"
    prompt+="$(cat "$KNOWLEDGE_FILE")"
    prompt+="# Current Task\n$task_json"
    echo "$prompt"
}
```

**Our gap**: We use `buildPrompt()` in `copilot.ts` with inline template logic + `promptBlocks` config. Less modular, harder to customize per-project.

**Adoption priority**: MEDIUM — our `promptBlocks` system is similar in spirit but less user-facing.

### 2.3 Two-Agent TDD Workflow (Tester → Implementer)

**What**: Strict role separation — a dedicated test-writer agent runs first, commits test files, then a separate implementer agent makes those tests pass. Each has its own `role.md` + `steps.md` identity files.

Key constraints:
- Tester: NEVER writes source code, NEVER marks tasks done
- Implementer: NEVER modifies tests (except genuine bugs), max 5 fix attempts

**Our gap**: We use a single Copilot Agent Mode session per task. No enforced tester/implementer separation.

**Adoption priority**: HIGH — this is a fundamentally different and arguably superior TDD flow. Could be implemented as a two-phase execution within each task iteration.

### 2.4 Error Hash Deduplication

**What**: `update_error_tracking()` (lines 377-406) hashes the last 20 lines of error output via `md5sum` to detect identical repeated errors and trigger circuit breaker:

```bash
local error_hash=$(tail -20 "$agent_log" | md5sum | cut -d' ' -f1)
if [[ "$error_hash" == "$LAST_ERROR_HASH" ]]; then
    SAME_ERROR_COUNT=$((SAME_ERROR_COUNT + 1))
else
    SAME_ERROR_COUNT=1
    LAST_ERROR_HASH="$error_hash"
fi
```

Circuit breaker trips when `SAME_ERROR_COUNT >= CB_SAME_ERROR_MAX` (default 2).

**Our gap**: Our circuit breaker checks nudge count, retry count, elapsed time, and file changes — but NOT error content similarity.

**Adoption priority**: MEDIUM — could be a new breaker in our `CircuitBreakerChain`.

### 2.5 Rate Limiting (Sliding Window)

**What**: File-based sliding window rate limiter (lines 159-190). Tracks timestamps of API calls in `/tmp/ralph-call-times-$$`. Enforces `MAX_CALLS_PER_HOUR` (default 500):

```bash
check_rate_limit() {
    awk -v cutoff="$one_hour_ago" '$1 >= cutoff' "$RATE_FILE" > "$tmp"
    local count=$(wc -l < "$RATE_FILE")
    if ((count >= MAX_CALLS_PER_HOUR)); then
        sleep "$wait_time"
    fi
    echo "$now" >> "$RATE_FILE"
}
```

**Our gap**: No rate limiting at all. We rely on Copilot's own rate limits.

**Adoption priority**: LOW for VS Code extension (Copilot handles this), but worth noting.

### 2.6 Git Worktree Isolation

**What**: Optional branch-per-task isolation using `git worktree` (lines 296-377):
- `create_worktree()`: Creates worktree + branch, symlinks `node_modules/.venv/vendor`
- `merge_worktree()`: Uses `flock` for serialized merges, runs tests pre-merge AND post-merge, auto-reverts on failures
- `cleanup_worktree()`: Removes worktree and branch

**Our gap**: We use fresh Copilot sessions per task but share the same working directory. No branch isolation.

**Adoption priority**: LOW — complex to implement in VS Code context, but the test-before-merge and auto-revert patterns are valuable ideas.

### 2.7 Per-Task Failure Tracking with Graduated Response

**What**: Associative array `TASK_FAILURES` tracks per-task failure count (lines 513-541):
- 1 failure: retry immediately
- 2 failures: 30-second cooldown before retry
- 3+ failures: skip task entirely

**Our gap**: We have `MAX_RETRIES_PER_TASK` but no graduated cooldown or skip-after-N pattern.

**Adoption priority**: MEDIUM — simple to add to our orchestrator.

### 2.8 Pre-flight Test Verification

**What**: Before starting the loop, runs the existing test suite (lines 425-440) to ensure the codebase is green. Refuses to start if tests fail.

**Our gap**: No pre-flight check. We start the loop regardless of existing test state.

**Adoption priority**: HIGH — simple and valuable safety gate.

### 2.9 Post-Iteration Regression Detection

**What**: After each completed task, runs the full test suite to detect regressions. If new task breaks existing tests, the failure is caught immediately.

**Our gap**: Our consistency checker runs deterministic checks but doesn't run the actual test suite.

**Adoption priority**: HIGH — though implementation depends on knowing the test command.

### 2.10 Prompt Debugging (Saved Prompts)

**What**: Every assembled prompt is saved to disk before sending (line 228):

```bash
local prompt_file="$RUN_DIR/agents/$(printf '%03d' "$iteration")-${agent_type}-${task_id}.prompt.md"
echo "$prompt" > "$prompt_file"
```

**Our gap**: We don't persist prompts for post-mortem debugging.

**Adoption priority**: MEDIUM — useful for debugging but adds I/O overhead.

### 2.11 Structured JSON-Lines Logging

**What**: Machine-parseable log format (line 65):
```json
{"ts":"...","iteration":1,"agent":"tester","task":"setup-pkg","status":"success","duration_s":62,"exit_code":0}
```

Enables the `/ralph-logs` and `/ralph-status` skills to query run history.

**Our gap**: We emit `LoopEvent` objects but don't persist them to a queryable log file.

**Adoption priority**: MEDIUM — would enable post-mortem analysis tools.

### 2.12 Planner Agent with 6-Layer Ordering

**What**: Dedicated planner agent (`agents/ralph-planner/AGENT.md`) with explicit task sizing rules (1-3 files, <10 min) and 6-layer dependency ordering:
```
Layer 0: Project setup
Layer 1: Shared utilities
Layer 2: Core business logic
Layer 3: Features/commands
Layer 4: Integration tests
Layer 5: Final wiring
```

**Our gap**: Our PRD parsing extracts tasks but doesn't have explicit layer-based ordering guidance.

**Adoption priority**: MEDIUM — could be added to our PRD prompt template.

---

## 3. Side-by-Side Comparison

| Capability | vinitm/ralph-loop | Our ralph-loop |
|---|---|---|
| **Platform** | Claude Code plugin (bash) | VS Code extension (TypeScript) |
| **AI integration** | `claude --print` CLI | Copilot Agent Mode API |
| **Orchestrator** | Bash script (~670 LOC) | TypeScript async generator (~840 LOC) |
| **Agent roles** | 3 (planner, tester, impl) | 1 (single Copilot session) |
| **TDD enforcement** | Two-agent tester→impl | Single-agent with nudges |
| **Task format** | JSON with `depends_on` DAG | PRD checkboxes with DAG |
| **Circuit breaker** | Consecutive failures + error hash | Configurable chain (nudge/retry/time/file) |
| **Stagnation detection** | N/A (uses circuit breaker) | File hash comparison across iterations |
| **Knowledge base** | `knowledge.md` (cross-agent) | None |
| **Prompt assembly** | Modular files (role + steps + rules) | `buildPrompt()` with `promptBlocks` |
| **Rate limiting** | Sliding window (500/hr) | None (relies on Copilot) |
| **Git isolation** | Worktrees + flock merge | Fresh sessions per task |
| **Diff validation** | N/A | `DiffValidator` with AST checks |
| **Review-after-execute** | N/A | Review prompt with verdict parsing |
| **Pre-complete hooks** | N/A | Configurable hook chain |
| **Hook bridge** | N/A | Shell hook provider + bridge |
| **Consistency checker** | N/A | Deterministic file/state checks |
| **Parallel execution** | Stub (not implemented) | Parallel monitor + batch execution |
| **Nudge system** | N/A | Multi-level nudges with file change tracking |
| **Pause/resume/yield** | N/A | Full lifecycle control |
| **Logging** | JSON-lines to file | VS Code OutputChannel events |
| **Pre-flight tests** | Yes | No |
| **Post-task regression** | Yes (full test suite) | No |
| **Prompt persistence** | Yes (saved to disk) | No |
| **Error deduplication** | MD5 hash of last 20 lines | No |
| **Per-task failure tracking** | Graduated (retry/cooldown/skip) | Fixed retry count |

---

## 4. What We Have That vinitm Doesn't

Our implementation has several advanced features absent from vinitm:

1. **DiffValidator** — AST-aware validation of code changes
2. **Review-after-execute** — AI-powered review with verdict parsing
3. **Pre-complete hook chain** — extensible validation pipeline before task completion
4. **Shell hook bridge** — external script integration points
5. **Consistency checker** — deterministic state verification
6. **Parallel monitor** — concurrent task execution monitoring
7. **Multi-level stagnation detection** — 3-tier graduated response (nudge → circuit breaker → human checkpoint)
8. **Nudge system** — intelligent re-prompting with file change tracking
9. **Pause/resume/yield** — full lifecycle control
10. **3-level Copilot fallback** — multiple strategies for triggering Copilot
11. **Inactivity timeout** — per-task timeout detection

---

## 5. Integration Recommendations

### Priority 1: Knowledge Base System
Add a `knowledge.md` persistence mechanism. After each task completion, append discovered patterns. Include in prompt context. Minimal implementation:
- Add `knowledgePath` to `RalphConfig`
- Read knowledge file in `buildPrompt()`
- Instruct Copilot to append learnings via prompt instructions

### Priority 2: Pre-flight Test Verification
Before starting the loop, run `TEST_CMD` and abort if tests fail. Simple guard in `start()`:
- Add `testCommand` to `RalphConfig`
- Run before first iteration
- Emit `LoopEventKind.PreFlightFailed` if non-zero exit

### Priority 3: Post-Task Regression Testing
After each `TaskCompleted`, run the full test suite. If regression detected:
- Emit `LoopEventKind.RegressionDetected`
- Either revert the task's commit or nudge for fix

### Priority 4: Error Hash Circuit Breaker
Add a new breaker to `CircuitBreakerChain` that hashes recent error output and trips on repeated identical errors.

### Priority 5: Two-Phase TDD Execution
Within each task iteration, run two Copilot sessions:
1. Phase 1: "Write failing tests for this task" (commit test files only)
2. Phase 2: "Make these tests pass" (commit source + mark done)

This would be a significant architectural change but aligns with TDD best practices.

### Priority 6: Prompt Persistence for Debugging
Save assembled prompts to `logs/` directory for post-mortem analysis. Low effort, high debugging value.

### Lower Priority
- Per-task graduated failure response (cooldown/skip)
- JSON-lines structured logging to file
- Modular prompt files (our `promptBlocks` already partially addresses this)
