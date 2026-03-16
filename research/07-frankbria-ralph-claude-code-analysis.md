---
type: research
id: 7
sources:
  - https://github.com/frankbria/ralph-claude-code
---
# Deep Analysis: frankbria/ralph-claude-code

**Repository**: [frankbria/ralph-claude-code](https://github.com/frankbria/ralph-claude-code)
**Version**: v0.11.5 | **Architecture**: Modular Bash (~1900-line orchestrator + lib/)
**Tests**: 556 BATS tests (100% pass rate)

---

## 1. Circuit Breaker Pattern

**File**: `lib/circuit_breaker.sh` (~463 lines)

Three-state implementation based on Michael Nygard's "Release It!":

```
CLOSED ──(2 loops no progress)──→ HALF_OPEN ──(1 more loop no progress)──→ OPEN
                                       │                                      │
                                       ←──(progress detected)──               │
                                                                              │
CLOSED ←──(auto-reset)── HALF_OPEN ←──(cooldown elapsed, default 30min)──────┘
```

**State file**: `.ralph/.circuit_breaker_state` (JSON):
```json
{
  "state": "CLOSED",
  "last_change": "<ISO timestamp>",
  "consecutive_no_progress": 0,
  "consecutive_same_error": 0,
  "consecutive_permission_denials": 0,
  "last_progress_loop": 0,
  "total_opens": 1,
  "reason": "",
  "current_loop": 7,
  "opened_at": "<ISO timestamp>"
}
```

**Thresholds** (configurable via `.ralphrc`):
- `CB_NO_PROGRESS_THRESHOLD=3` — loops with zero file changes
- `CB_SAME_ERROR_THRESHOLD=5` — identical error repetitions
- `CB_PERMISSION_DENIAL_THRESHOLD=2` — consecutive permission denials
- `CB_OUTPUT_DECLINE_THRESHOLD=70%` — output length decline ratio
- `CB_COOLDOWN_MINUTES=30` — auto-recovery cooldown
- `CB_AUTO_RESET=true` — bypass cooldown entirely

**Key design decisions**:
- **OPEN is not terminal**: Cooldown timer auto-transitions OPEN → HALF_OPEN → CLOSED
- **`opened_at` field** (backward-compatible with `last_change` fallback) tracks exactly when OPEN state was entered for cooldown calculation
- **Permission denials have highest priority** (Issue #101) — opens circuit after just 2 denials
- **Progress detection is multi-source**: git diff (uncommitted), HEAD comparison (committed), RALPH_STATUS `FILES_MODIFIED` field
- **Corruption recovery**: validates JSON on init, recreates state file if corrupted
- **History file**: `.ralph/.circuit_breaker_history` stores JSON array of all state transitions with timestamps, from/to states, reasons, and loop numbers

**Lesson for ralph-loop**: The auto-recovery via cooldown makes the circuit breaker fully autonomous. Combined with `CB_AUTO_RESET=true`, the system can recover from transient failures without human intervention. The `opened_at` field solves the edge case where `last_change` gets updated by other operations.

---

## 2. RALPH_STATUS Protocol

**Structured output contract** between the AI agent and the orchestrator:

```
---RALPH_STATUS---
STATUS: IN_PROGRESS|COMPLETE|BLOCKED
TASKS_COMPLETED_THIS_LOOP: <int>
FILES_MODIFIED: <int>
TESTS_STATUS: PASSING|FAILING|NOT_RUN
WORK_TYPE: IMPLEMENTATION|TESTING|DEBUGGING|DOCUMENTATION|TEST_ONLY
EXIT_SIGNAL: true|false
RECOMMENDATION: <free text>
---END_RALPH_STATUS---
```

**Critical rule**: `EXIT_SIGNAL` in the structured block takes **precedence** over all heuristic signals. This prevents the orchestrator from making unilateral exit decisions.

**Design subtlety**: `EXIT_SIGNAL: false` + `STATUS: COMPLETE` = "this phase is complete, but keep working on the next phase." This enables multi-phase workflows without premature termination.

**Parsing**: Regex extraction between delimiters, with fallback to JSON parsing and then text heuristics. The `analyze_response()` function detects the output format first via `detect_output_format()` and branches accordingly.

**Lesson for ralph-loop**: This explicit protocol eliminates the ambiguity of trying to infer completion from unstructured output. The EXIT_SIGNAL precedence rule is particularly important — it means the AI agent has explicit veto power over exit decisions.

---

## 3. Dual Exit Gate Mechanism

The exit system uses a **layered priority** approach (highest to lowest):

1. **Permission denials** → immediate halt (2 consecutive)
2. **Test saturation** → exit after 3 test-only loops
3. **Completion signals** → 2 done signals required
4. **Safety breaker** → force exit after 5 consecutive `EXIT_SIGNAL=true`
5. **Project complete** → 2 completion indicators + `EXIT_SIGNAL=true` (dual gate)
6. **Plan complete** → all `fix_plan.md` checkboxes checked

The **dual gate** requires BOTH:
- `completion_indicators >= 2` (from `.exit_signals` rolling window)
- `EXIT_SIGNAL: true` from the latest `.response_analysis`

This prevents premature exits when the orchestrator's heuristics detect completion but the AI agent disagrees.

**Exit signals tracking**: `.ralph/.exit_signals` stores rolling arrays:
```json
{
  "test_only_loops": [1, 2, 3],
  "done_signals": [4, 5],
  "completion_indicators": [6, 7]
}
```
Arrays are capped at the last 5 entries to prevent unbounded growth.

**Lesson for ralph-loop**: The layered priority with dual-condition gating is the most transferable pattern. A single signal should never be sufficient for exit — require corroboration from multiple independent sources.

---

## 4. Semantic Response Analyzer

**File**: `lib/response_analyzer.sh` (~884 lines)

### Confidence Scoring System

Multiple signals contribute additively to a confidence score:

| Signal | Points |
|--------|--------|
| Structured RALPH_STATUS output | 100 |
| Completion keywords detected | +10 |
| "Nothing to do" patterns | +15 |
| File changes via git | +20 |
| Output length decline (>50%) | +10 |

### Three JSON Format Support
1. **Flat JSON**: `{ "status": "COMPLETE", "exit_signal": true }`
2. **Claude CLI object**: `{ "result": "...", "sessionId": "...", "metadata": {...} }`
3. **Claude CLI array**: Stream JSON with multiple events

Format detection via `detect_output_format()` before parsing.

### Completion Keywords
```
"done", "complete", "finished", "all tasks complete",
"project complete", "ready for review"
```

### Test-Only Detection
Counts test commands (`npm test`, `pytest`, `bats`) vs implementation commands. If test commands > 0 and implementation commands = 0, flags as test-only loop.

### Output Length Trending
Stores previous output length in `.ralph/.last_output_length`. If current output is <50% of previous, adds confidence points (declining engagement signal).

**Lesson for ralph-loop**: The confidence scoring system that aggregates multiple weak signals into a strong decision is elegant. Each signal alone might be unreliable, but their combination provides robust completion detection.

---

## 5. Session Resume / Continuity

### Session Lifecycle
- `init_session_tracking()` — creates `.ralph/.ralph_session`
- `generate_session_id()` — creates unique session identifier
- `store_session_id()` — persists to `.ralph/.claude_session_id`
- `should_resume_session()` — checks validity (24h expiration)
- `reset_session()` — clears session state with reason logging

### Session Expiration
```bash
SESSION_EXPIRATION_SECONDS=86400  # 24 hours
```
Calculated by comparing stored timestamp against current epoch time.

### Session Reset Triggers
- Circuit breaker opens
- Manual interrupt (SIGINT/SIGTERM)
- Project completion
- Manual `--reset-session` flag
- Integrity failure (critical files missing)

### CLI Integration
Uses `--resume <session_id>` (NOT `--continue`) to avoid session hijacking (Issue #151). The `--continue` flag was deprecated because it could accidentally resume an unrelated session.

### Session History
`.ralph/.ralph_session_history` stores the last 50 session transitions for debugging.

**Lesson for ralph-loop**: The 24-hour expiration window and explicit reset triggers prevent stale session contamination. The decision to use `--resume` over `--continue` is a security consideration worth adopting.

---

## 6. Rate Limiting

### Hourly Call Tracking
```bash
MAX_CALLS_PER_HOUR=100  # configurable via --calls flag
```

**Mechanism**:
- `can_make_call()` — reads `.ralph/.call_count`, compares against limit
- `increment_call_counter()` — atomically increments counter file
- `init_call_tracking()` — checks hour boundary (`date +%Y%m%d%H`), resets on new hour
- `wait_for_reset()` — countdown timer until next hour

**Two-tier limit detection**:
1. **Hourly limit** (100/hr): Automatic wait with countdown display, auto-reset
2. **API 5-hour limit**: Detected via `rate_limit_event` in Claude CLI stream JSON or text fallback. Prompts user: wait (default for unattended) or exit

**API limit detection layers** (in `execute_claude_code()`):
1. Exit code 124 = timeout, NOT an API limit (avoids false positive)
2. `rate_limit_event` with `status: "rejected"` in stream JSON = real API limit
3. Text fallback: `tail -30` + filter out tool_result lines + grep for "5-hour limit" patterns

**Lesson for ralph-loop**: The three-layer API limit detection with explicit timeout guard (layer 1) prevents misclassifying timeouts as rate limits — a subtle but important distinction for autonomous systems.

---

## 7. Error Classification (Two-Stage Filtering)

### The Problem
JSON responses often contain fields like `"is_error": false` or `"error_count": 0`. Naive grep for "error" produces false positives that trigger the circuit breaker incorrectly.

### The Solution
**Stage 1** — Filter out JSON field patterns:
```bash
grep -v '"[^"]*error[^"]*":'
```
This removes lines where "error" appears as a JSON key (e.g., `"is_error": false`).

**Stage 2** — Detect actual errors with context-specific patterns:
```bash
grep -qE '(^Error:|^ERROR:|^error:|\]: error|Link: error|Error occurred|failed with error|[Ee]xception|Fatal|FATAL)'
```

### Pattern Consistency
Both `ralph_loop.sh` and `lib/response_analyzer.sh` use **identical** patterns. A dedicated test suite (`tests/test_error_detection.sh`, 13 scenarios) validates both.

### Test Coverage
- JSON fields with "error" keyword → NOT detected
- Actual error messages → detected
- Mixed JSON + real errors → only real errors detected
- Git diffs with error classes → NOT detected (code, not errors)
- Type annotations (`error: Error`) → NOT detected

**Lesson for ralph-loop**: This two-stage approach is directly applicable. Any system parsing mixed structured/unstructured output needs this kind of filtering to avoid false positives in error detection.

---

## 8. Recovery Patterns

### Circuit Breaker Auto-Recovery
OPEN → HALF_OPEN after cooldown (default 30 min). In HALF_OPEN, a single loop with progress → CLOSED. A single loop without progress → back to OPEN.

### Session Auto-Reset
Sessions automatically reset on circuit breaker open, preventing stale context from polluting recovery attempts.

### File Integrity Recovery
`validate_ralph_integrity()` checks required paths before AND during the loop. If critical files are deleted mid-execution:
1. Log the failure
2. Print integrity report
3. Reset session with reason `integrity_failure`
4. Update status to `halted`
5. Break the loop

### Graceful Shutdown
Signal handlers (SIGINT, SIGTERM) trigger `cleanup()` which:
1. Resets session with reason `manual_interrupt`
2. Updates status file
3. Exits cleanly

### State File Corruption
Circuit breaker validates JSON on `init_circuit_breaker()`. If parsing fails, recreates the state file with defaults rather than crashing.

---

## 9. State Machine Logic

The overall system operates as a nested state machine:

**Outer loop states** (in `main()`):
```
INIT → [CHECK_INTEGRITY] → [CHECK_CIRCUIT_BREAKER] → [CHECK_RATE_LIMIT] →
[CHECK_EXIT_CONDITIONS] → [EXECUTE] → [ANALYZE] → [RECORD] → loop
```

**Exit code protocol** from `execute_claude_code()`:
- `0` = success → analyze response, continue
- `1` = generic error → log, continue
- `2` = API 5-hour limit → prompt user (wait/exit)
- `3` = circuit breaker tripped → halt loop
- `124` = timeout → log warning, continue

**Circuit breaker states** (see §1 above): CLOSED / HALF_OPEN / OPEN

**Session states**: active / expired / reset (with 6 reset reasons)

**Lesson for ralph-loop**: The exit code protocol is a clean way to communicate different failure modes from the execution function to the main loop, each requiring different handling.

---

## 10. Configuration System (`.ralphrc`)

### Loading Mechanism
`load_ralphrc()` sources `.ralphrc` as a bash file, but preserves environment variable precedence:

1. Save env state BEFORE setting defaults: `_env_MAX_CALLS_PER_HOUR="${MAX_CALLS_PER_HOUR:-}"`
2. Set defaults: `MAX_CALLS_PER_HOUR="${MAX_CALLS_PER_HOUR:-100}"`
3. Source `.ralphrc` (overwrites defaults)
4. Restore env values if they were explicitly set: `[[ -n "$_env_MAX_CALLS_PER_HOUR" ]] && MAX_CALLS_PER_HOUR="$_env_MAX_CALLS_PER_HOUR"`

### Name Mapping
`.ralphrc` uses user-friendly names mapped to internal variables:
- `ALLOWED_TOOLS` → `CLAUDE_ALLOWED_TOOLS`
- `SESSION_CONTINUITY` → `CLAUDE_USE_CONTINUE`
- `SESSION_EXPIRY_HOURS` → `CLAUDE_SESSION_EXPIRY_HOURS`

### Configurable Values
| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_CALLS_PER_HOUR` | 100 | API call rate limit |
| `CLAUDE_TIMEOUT_MINUTES` | 15 | Per-execution timeout (1-120) |
| `CLAUDE_OUTPUT_FORMAT` | json | Output format (json/text) |
| `SESSION_EXPIRY_HOURS` | 24 | Session validity window |
| `CB_NO_PROGRESS_THRESHOLD` | 3 | Loops before HALF_OPEN |
| `CB_SAME_ERROR_THRESHOLD` | 5 | Error repetitions before OPEN |
| `CB_COOLDOWN_MINUTES` | 30 | Auto-recovery cooldown |
| `CB_AUTO_RESET` | false | Bypass cooldown entirely |

### Security
Config updates use `awk` (not `sed`) to avoid command injection from user input:
```bash
awk -v val="$CONFIG_MAX_CALLS" '/^MAX_CALLS_PER_HOUR=/{$0="MAX_CALLS_PER_HOUR="val}1' .ralphrc
```

---

## Key Patterns for ralph-loop Adoption

### High Priority
1. **RALPH_STATUS protocol** — Define a structured output contract between Copilot and the orchestrator. This eliminates guesswork from response parsing.
2. **Dual exit gate** — Never exit on a single signal. Require corroboration.
3. **Two-stage error filtering** — Essential when parsing mixed structured/unstructured AI output.
4. **Circuit breaker auto-recovery** — OPEN should not be a dead end.

### Medium Priority
5. **Confidence scoring** — Aggregate weak signals into strong decisions.
6. **Exit code protocol** — Return codes (0/1/2/3/124) communicate distinct failure modes.
7. **Session expiration** — 24h window prevents stale context contamination.
8. **Layered API limit detection** — Distinguish timeouts from real rate limits.

### Lower Priority (but valuable)
9. **Rolling window for signal arrays** — Cap at last 5 entries.
10. **File integrity validation** — Check critical files before AND during loop execution.
11. **State transition history** — Log all circuit breaker transitions for post-mortem analysis.
12. **Permission denial fast-path** — 2 denials → immediate halt (don't waste tokens).
