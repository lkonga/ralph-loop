## Aggregation Report 2

### Source Reports

1. **research-4.md** — Copilot Chat Integration: 4-layer integration architecture (direct commands, execution strategies, hook bridge, signal file IPC), prompt construction with context trimming, session tracking, and autopilot mode.
2. **research-5.md** — Safety Mechanisms: 7 circuit breaker types, stagnation detector with 3-tier escalation, 4-signal struggle detector, git-based diff validation, filesystem consistency checker, plus orchestrator-level gates (dual exit, confidence scoring, bearings, human checkpoints).
3. **research-6.md** — Git Operations & Hook Bridge: Atomic per-task commits with conventional commit messages, hook bridge generating runtime scripts for VS Code's chatHooks API, shell hook provider with security hardening, and file-based IPC for external process communication.

### Deduplicated Findings

#### A. Copilot Chat Integration Architecture

Ralph-loop integrates with VS Code Copilot Chat through a **4-layer architecture** with graceful degradation at every level:

- **Layer 1 — Direct Command Execution** (`openCopilotWithPrompt()`): 3-level fallback: agent mode → chat panel → clipboard. Autopilot mode passes `permissionLevel: 'autopilot'` via `chatParticipantPrivate` proposed API. [source: research-4.md#L5-L12]
- **Layer 2 — Execution Strategies**: `CopilotCommandStrategy` (default) uses file-watcher polling loop to detect task completion via PRD checkbox changes and workspace file activity. `DirectApiStrategy` is a stub awaiting `chatProvider` API. [source: research-4.md#L18-L29]
- **Layer 3 — Hook Bridge**: Generates Node.js scripts at runtime registered via `chat.hooks` config for Stop (4-check verification gate), PostToolUse (activity marker), and PreCompact (session resumption context injection). [source: research-4.md#L31-L42] [source: research-6.md#L54-L82]
- **Layer 4 — Signal File IPC**: Filesystem watcher on `$TMPDIR/ralph-loop-chat-send.signal` enables external processes to trigger chat interactions without VS Code API access. [source: research-4.md#L44-L53] [source: research-6.md#L84-L86]

#### B. Prompt Construction & Context Management

Prompts are built with structured sections including task description (sanitized, 5000 char limit), role/behavior block, TDD gate, search-before-implement gate, spec reference gate, learnings, and operator context. **Context trimming** operates in 3 tiers: Full (iterations 1-3), Abbreviated (4-8), Minimal (9+). Token budget annotation adds utilization headers. [source: research-4.md#L63-L73]

#### C. Safety System — Defense in Depth

The safety architecture comprises **5 dedicated modules** orchestrated by `LoopOrchestrator`, plus additional orchestrator-level mechanisms:

**C1. Circuit Breaker Chain** — Chain-of-responsibility pattern with 7 breaker types: MaxRetries (3), MaxNudges (3), Stagnation (2 consecutive), ErrorRate (60%/5-window), TimeBudget (600s), RepeatedError (3x same hash), PlanRegeneration (after 2 decomp failures). Actions: `continue | retry | skip | stop | nudge | regenerate`. Preset-driven profiles (`bugfix` enables aggressive error tracking). [source: research-5.md#L9-L30]

**C2. Stagnation Detector** — SHA-256 file-hash comparison across iterations on tracked files (`progress.txt`, `PRD.md`). 3-tier escalation: enhanced nudge → circuit breaker skip → human checkpoint pause. Includes AutoDecomposer for splitting stuck tasks at sentence/step boundaries. [source: research-5.md#L34-L47]

**C3. Struggle Detector** — 4 independent signals: `no-progress` (≥3 iterations, 0 file changes), `short-iteration` (≥3 iterations < 30s), `repeated-error` (hash ≥2x), `thrashing` (same file+region ≥3x in 10-edit window). Sub-components: ThrashingDetector (sliding window), BackpressureClassifier (convergence trend analysis). [source: research-5.md#L51-L64]

**C4. Diff Validator** — Runs `git diff --stat HEAD` and `git diff --name-only HEAD` in parallel. Requires real code changes, generates nudge on empty diff. Retry loop with maxDiffValidationRetries then human checkpoint escalation. Produces markdown state blocks appended to `progress.txt`. [source: research-5.md#L68-L79]

**C5. Consistency Checker** — 3 deterministic checks: checkbox_state (PRD task checkbox state vs phase), progress_mtime (modified within 5 min), file_paths_exist (referenced paths exist). LLM verification stubbed. Failures emit events but don't currently block progression. [source: research-5.md#L83-L98]

**C6. Orchestrator-Level Gates** — Dual exit gate (model signal + machine verification), confidence scoring (checkbox/vitest/tsc/no_errors/progress_updated/diff), bearings pre-flight check (tsc + vitest before each task), human checkpoint requests, cooldown dialog, iteration limits (soft with 1.5x auto-expand + hard max), linked cancellation via AbortController. [source: research-5.md#L102-L112]

#### D. Git Operations — Atomic Commits

`atomicCommit()` provides per-task atomic commits in 5 steps: guard checks (reject during rebase/merge/cherry-pick) → `git add -A` → diff check → `git commit --no-verify` → capture commit hash. Conventional commit messages with task invocation ID trailers. Commit happens **after all verification gates** (dual exit → confidence → PreComplete hook chain → TaskComplete hook) but before cooldown. [source: research-6.md#L5-L30] [source: research-6.md#L34-L46]

#### E. Hook System — Dual Strategy

Two implementations share the `IRalphHookService` interface:

- **Hook Bridge** (VS Code-native): Runtime-generated Node.js scripts registered via proposed `chatHooks` API. Stop hook runs 4-check gate (PRD checkbox, progress mtime, tsc, vitest). PreCompact hook injects session resumption context (progress tail + git diff + current task). PostToolUse hook writes activity marker for inactivity timer reset. [source: research-6.md#L54-L82]
- **Shell Hook Provider** (portable): Executes user-provided scripts with security hardening — dangerous pattern regex (`&&`, `||`, `;`, `|`, `>`, `<`, backtick, `$(`, `${`) blocks injection, 30s timeout with process tree kill, stdin/stdout JSON isolation. Exit code protocol: 0=success, 1=warning, 2=block. [source: research-6.md#L88-L105]

Hook lifecycle: `onSessionStart` → (loop) → `onPreCompact` → `onPostToolUse` → `onPreComplete` (chain, can block) → `onTaskComplete`. [source: research-6.md#L107-L117]

#### F. File-Based IPC Patterns

Three distinct file-based IPC mechanisms span the reports:

1. **ChatSend signal file** (`$TMPDIR/ralph-loop-chat-send.signal`): JSON-based command injection from external processes into VS Code chat panel. [source: research-4.md#L44-L53] [source: research-6.md#L84-L86]
2. **Tool activity marker** (`$TMPDIR/ralph-loop-tool-activity.marker`): Timestamp touch file for inactivity timer reset. [source: research-4.md#L37-L38] [source: research-6.md#L72-L73]
3. **PRD/workspace file watchers**: File system watchers on PRD.md (checkbox changes) and workspace files (activity detection) for completion/inactivity tracking. [source: research-4.md#L22-L27]

### Cross-Report Patterns

**P1. Graduated Escalation** (HIGH CONFIDENCE — 3 reports)
Every safety mechanism follows nudge → automated action → human checkpoint. Circuit breakers escalate `continue → skip → stop`. Stagnation uses 3 tiers. Diff validation retries then pauses for human. The hook bridge's stop hook blocks premature agent stopping. This consistent pattern prevents both premature termination and infinite loops. [source: research-5.md#L120-L121] [source: research-5.md#L34-L47] [source: research-5.md#L68-L79]

**P2. Verification Gate Chain** (HIGH CONFIDENCE — 2 reports)
Task completion requires passing through a strict sequential gate chain: file-watcher completion detection → dual exit gate (model + machine) → confidence scoring → PreComplete hook chain → TaskComplete hook → atomic commit. Only fully verified work enters git history. [source: research-4.md#L22-L27] [source: research-5.md#L102-L106] [source: research-6.md#L34-L46]

**P3. Graceful Degradation Everywhere** (HIGH CONFIDENCE — 3 reports)
Integration with VS Code uses 3-level command fallback. Hook bridge is gated behind feature flag with no-op default. Autopilot mode falls back if proposed API unavailable. Shell hook exit code protocol degrades from success → warning → block. Every external dependency has a fallback path. [source: research-4.md#L83-L86] [source: research-6.md#L88-L105] [source: research-4.md#L5-L12]

**P4. File-Based IPC as Integration Primitive** (HIGH CONFIDENCE — 3 reports)
Signal files, marker files, and filesystem watchers are used pervasively for cross-process communication — simple, debuggable, dependency-free. Used for chat send, tool activity tracking, completion detection, and hook script coordination. [source: research-4.md#L90] [source: research-6.md#L122-L123] [source: research-4.md#L22-L27]

**P5. Hash-Based Deduplication** (MEDIUM CONFIDENCE — 2 reports)
Error normalization (strip ANSI/timestamps/paths/line numbers) + MD5 hashing prevents repeated errors from consuming retry budget. SHA-256 file hashing detects stagnation. Both patterns use deterministic hashing to compress state for comparison. [source: research-5.md#L24-L25] [source: research-5.md#L34-L38]

**P6. Runtime Code Generation** (MEDIUM CONFIDENCE — 2 reports)
Hook bridge scripts are generated at runtime from templates with embedded paths and config values, written to temp dirs, registered in workspace config. This avoids shipping separate scripts and keeps paths dynamic but adds maintenance complexity. [source: research-4.md#L40-L42] [source: research-6.md#L120-L121]

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---|---|---|---|
| Graduated escalation (safety layers) | High — prevents runaway loops AND premature stops | Low (already implemented) | [research-5.md#L120-L121](research-5.md#L120-L121), [research-5.md#L34-L47](research-5.md#L34-L47) |
| Verification gate chain | High — ensures only verified work persists | Low (already implemented) | [research-4.md#L22-L27](research-4.md#L22-L27), [research-6.md#L34-L46](research-6.md#L34-L46) |
| Graceful degradation | High — works across VS Code versions/configs | Low (already implemented) | [research-4.md#L83-L86](research-4.md#L83-L86), [research-6.md#L88-L105](research-6.md#L88-L105) |
| File-based IPC | Medium — enables external orchestration | Low (already implemented) | [research-4.md#L44-L53](research-4.md#L44-L53), [research-6.md#L84-L86](research-6.md#L84-L86) |
| Signal file security hardening | Medium — predictable TMPDIR paths accept commands | Medium (needs auth/permissions) | [research-6.md#L140-L141](research-6.md#L140-L141), [research-4.md#L97-L98](research-4.md#L97-L98) |
| Parallel commit race conditions | Medium — concurrent `git add -A` could collide | Medium (needs locking) | [research-6.md#L132-L133](research-6.md#L132-L133) |
| LLM verification implementation | Low (future) — stub exists | High (design + implementation) | [research-5.md#L130-L131](research-5.md#L130-L131) |
| BackpressureClassifier wiring | Low — exists but may not be integrated | Low (wiring only) | [research-5.md#L134-L135](research-5.md#L134-L135) |

### Gaps

1. **Error signal capture**: research-5 notes the orchestrator passes empty arrays to `struggleDetector.recordIteration()` for errors — actual error strings may not be captured from execution output, reducing struggle detection accuracy. [source: research-5.md#L137-L138]
2. **Thrashing detection wiring**: `ThrashingDetector.recordEdit()` requires `regionHash` but the orchestrator only calls `recordIteration()` — per-region thrashing may not be active. [source: research-5.md#L135-L136]
3. **Consistency check enforcement**: Failed consistency checks emit events but don't block progression — a gap in the otherwise strict gate chain. [source: research-5.md#L96-L97]
4. **chatProvider API**: `DirectApiStrategy` is a stub. No timeline or design for when this API becomes available. [source: research-4.md#L79-L80]
5. **Session tracking**: Relies on 2-second polling of proposed API with no change event — fragile. [source: research-4.md#L81-L82]
6. **Distributed IPC**: File-based IPC is single-machine only; no path toward distributed/remote orchestration. [source: research-6.md#L127-L128]

### Sources
- research-4.md — Copilot Chat Integration (direct commands, execution strategies, hook bridge, signal file, prompt construction, session tracking)
- research-5.md — Safety Mechanisms (circuit breakers, stagnation detector, struggle detector, diff validator, consistency checker, orchestrator gates)
- research-6.md — Git Operations & Hook Bridge (atomic commits, hook bridge scripts, shell hook provider, file-based IPC, hook lifecycle)
