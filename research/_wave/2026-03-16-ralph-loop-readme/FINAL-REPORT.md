# Final Report: Ralph-Loop README Content Research

## Executive Summary

Twelve research files across four aggregation reports provide a comprehensive view of ralph-loop v0.4.1 — a VS Code extension that drives Copilot Agent Mode in a deterministic loop from PRD tasks. The core insight driving the architecture is that **context rot is unsolvable within a session, so nuke the context and persist state in files**. This produces the fresh-session-per-task model, PRD.md as single source of truth (spec + task queue + completion ledger), and a compounding knowledge system that survives session boundaries.

Key differentiators vs. 13+ other Ralph implementations: (1) deterministic code-level control plane (not prompt prose), (2) dual exit gate requiring both model signal AND machine verification, (3) 7 circuit breaker types with tiered escalation and auto-decomposition, (4) async generator architecture yielding 30+ typed events, (5) 361+ Vitest unit tests (highest in ecosystem), and (6) self-hosting — ralph-loop executes its own PRD.

The draft README below consolidates all findings into a user-facing document covering core features, quickstart, architecture, configuration, CLI usage, verification system, safety mechanisms, presets, knowledge system, and design philosophy.

---

## Consolidated Findings

### Category 1: Core Identity & Architecture

**F1: Elevator Pitch** — VS Code extension that reads checkbox tasks from PRD.md, opens fresh Copilot sessions per task, verifies completion deterministically, and loops until done. Version 0.4.1, MIT license, 21 source modules. [via: aggregation-1.md#F1 ← research-1.md#L5-L12]

**F2: Fundamental Insight** — "Context rot is unsolvable within a session, so nuke the context and persist state in files." Drives fresh-session-per-task, file-based state, knowledge compounding. [via: aggregation-1.md#F2 ← research-1.md#L10-L11]

**F3: Async Generator Loop** — `LoopOrchestrator` uses `AsyncGenerator<LoopEvent>` with 3 states (Idle/Running/Paused), yielding 30+ event kinds consumed by a `for await` loop. Clean separation of loop logic from side effects. [via: aggregation-1.md#F4 ← research-2.md#L5-L18]

**F4: 9-Phase Execution Cycle** — Init → Guard checks → Task selection → Bearings pre-flight → Task execution → Nudge loop → Post-execution evaluation → Completion pipeline → Failure path/Cooldown. [via: aggregation-1.md#F5 ← research-2.md#L22-L77]

**F5: Dual Delivery Model** — VS Code extension (the loop engine) + CLI companion (`npx ralph init/status/next` for PRD management from any terminal). CLI is intentionally read-only. [via: aggregation-1.md#F14 ← research-1.md#L28-L30] [via: aggregation-3.md#CLI-Tool ← research-9.md#L5-L30]

### Category 2: PRD-as-Database & Task Management

**F6: PRD.md as Single Source of Truth** — Simultaneously spec, task queue, and completion ledger. Two-pass parsing: Pass 1 scans checkboxes, Pass 2 assigns sequential IDs and infers dependency DAG from indentation (explicit `depends:` annotations override). Output: `PrdSnapshot { tasks, total, completed, remaining }`. [via: aggregation-1.md#F6 ← research-3.md#L5-L18]

**F7: Dual-File State** — PRD.md (structured current state, mutated at exact line numbers) + progress.txt (append-only audit log with ISO 8601 timestamps). UUID `taskInvocationId` threads through all entries. Orchestrator re-reads PRD.md every iteration — no in-memory cache. [via: aggregation-1.md#F7 ← research-3.md#L25-L35]

**F8: Auto-Decomposition** — After 3+ consecutive failures, marks parent with `[DECOMPOSED]`, inserts 2-3 sub-tasks below in PRD.md. Parser picks them up naturally. [via: aggregation-1.md#F9 ← research-3.md#L42-L48]

### Category 3: Verification & Safety

**F9: Dual Exit Gate** — Task completion requires BOTH model self-report (PRD checkbox marked) AND machine verification (tsc + vitest + file changes). [via: aggregation-1.md#F8 ← research-2.md#L57-L68]

**F10: Confidence Scoring** — Weighted composite across checkbox=100, vitest=20, tsc=20, diff=20, no_errors=10, progress_updated=10 (max=180). Below-threshold scores re-enter the task with feedback. [via: aggregation-4.md#4 ← research-11.md#L79-L80]

**F11: 7 Verifier Types** — `checkbox`, `fileExists`, `fileContains`, `commandExitCode`, `tsc`, `vitest`, `custom`. VerifierRegistry with plugin pattern. Resolution: explicit config → verificationTemplates matching → defaults. [via: aggregation-4.md#4 ← research-11.md#L73-L78]

**F12: 7 Circuit Breaker Types** — MaxRetries(3), MaxNudges(3), Stagnation(2), ErrorRate(60%/5-window), TimeBudget(600s), RepeatedError(3x same hash), PlanRegeneration(after 2 decomp failures). Chain-of-responsibility pattern. Actions: `continue | retry | skip | stop | nudge | regenerate`. [via: aggregation-2.md#C1 ← research-5.md#L9-L30]

**F13: Stagnation Detector** — SHA-256 file-hash comparison. 3-tier escalation: enhanced nudge → circuit breaker skip → human checkpoint pause. [via: aggregation-2.md#C2 ← research-5.md#L34-L47]

**F14: Struggle Detector** — 4 signals: no-progress (≥3 iterations, 0 changes), short-iteration (≥3 at <30s), repeated-error (hash ≥2x), thrashing (same file+region ≥3x in 10-edit window). [via: aggregation-2.md#C3 ← research-5.md#L51-L64]

**F15: Diff Validator** — Parallel `git diff --stat` + `git diff --name-only`. Requires real code changes. Retry loop → human checkpoint escalation. [via: aggregation-2.md#C4 ← research-5.md#L68-L79]

**F16: Bearings Pre-flight** — Optional `tsc --noEmit` + `vitest run` before each task. Injects fix task or pauses if unhealthy. [via: aggregation-1.md#F5-Phase3 ← research-2.md#L40-L43]

### Category 4: Copilot Integration

**F17: 4-Layer Integration** — (1) Direct commands with 3-level fallback (agent mode → chat → clipboard), (2) Execution strategies with file-watcher polling, (3) Hook bridge with runtime-generated scripts for `chat.hooks` API, (4) Signal file IPC for external processes. [via: aggregation-2.md#A ← research-4.md#L5-L53]

**F18: Prompt Construction** — Structured sections: task description (sanitized, 5000 char limit), role/behavior, TDD gate, search-before-implement gate, learnings, operator context. 3-tier context trimming: Full (iterations 1-3), Abbreviated (4-8), Minimal (9+). [via: aggregation-2.md#B ← research-4.md#L63-L73]

**F19: Hook Bridge** — Stop hook (4-check verification gate), PostToolUse (activity marker), PreCompact (session resumption context injection). Shell hook provider with injection protection (dangerous pattern regex). [via: aggregation-2.md#E ← research-6.md#L54-L105]

**F20: PreCompact Reset** — Instead of fixed iteration limits, hooks into LLM's compaction signal. When context is about to degrade, saves state and starts fresh session. Key innovation vs. all other implementations. [via: aggregation-4.md#7 ← research-12.md#L100-L107]

### Category 5: Knowledge & Persistence

**F21: Knowledge System** — Extracts `[LEARNING]`/`[GAP]` tags from AI output, persists to `knowledge.md`, retrieves relevant entries via keyword-overlap filtering (≥2 matching words, capped at `maxInjectLines`). MD5 deduplication. Gives cross-session memory. [via: aggregation-3.md#Knowledge ← research-7.md#L7-L23]

**F22: Knowledge GC** — Staleness-first archival then score-based cap. Tracks hits/lastHitRun in `knowledge-meta.json`. Archives stale entries to `knowledge-archive.md`. [via: aggregation-3.md#KnowledgeGC ← research-7.md#L30-L37]

**F23: Session Persistence** — Resumable state via `.ralph/session.json`. Atomic writes (tmp + rename). Triple isolation guard (version, workspace, PID). 24-hour expiration. [via: aggregation-3.md#SessionPersistence ← research-7.md#L53-L66]

### Category 6: Configuration & Presets

**F24: Preset System** — Four presets: `general` (balanced), `feature` (higher retry, strict TDD), `bugfix` (aggressive error tracking), `refactor` (higher stagnation tolerance). Resolution: `DEFAULT ← preset ← user overrides ← workspaceRoot`. [via: aggregation-3.md#PresetSystem ← research-8.md#L7-L20]

**F25: Feature Flags** — 5 boolean flags: `useHookBridge`, `useSessionTracking`, `useAutopilotMode`, `useParallelTasks`, `useLlmConsistencyCheck`. All default false. Progressive opt-in. [via: aggregation-4.md#2 ← research-10.md#L83-L91]

**F26: Configuration Split** — Only 9 of ~35+ settings declared in `package.json`. Remaining ~25+ accessible only via manual `settings.json` edits. Config read once at loop start — changes require restart. [via: aggregation-4.md#1 ← research-10.md#L26-L82]

### Category 7: Git & Commits

**F27: Atomic Commits** — Per-task commits in 5 steps: guard checks (reject during rebase/merge) → `git add -A` → diff check → commit with conventional message + invocation ID trailer → capture hash. Happens after all verification gates. [via: aggregation-2.md#D ← research-6.md#L5-L46]

### Category 8: Ecosystem & Evolution  

**F28: Ecosystem Positioning** — Unique among 13+ Ralph implementations. Only one with deterministic code-level control plane (not prompt prose). Highest test count (361+ vs most at 0). Two-mode design (extension + CLI). [via: aggregation-4.md#6 ← research-12.md#L57-L65]

**F29: 9-Phase Evolution** — Foundation → Autonomy → Safety → Learning → Operational Maturity → Ecosystem Parity. Safety mechanisms added before capabilities (circuit breakers before knowledge system). [via: aggregation-4.md#5 ← research-12.md#L11-L31]

**F30: Self-Hosting** — Ralph-loop executes its own PRD to bootstrap development. [via: aggregation-4.md#P5 ← research-12.md#L137-L139]

---

## Pattern Catalog

### P1: PRD.md as Single Source of Truth (CRITICAL)
PRD.md serves as spec, task queue, state machine, and completion ledger. No external database. Re-read every iteration. Agent and orchestrator both write to it. Auto-decomposition rewrites it.
[via: aggregation-1.md#P1 ← research-1.md#L33, research-2.md#L34-L38, research-3.md#L5-L10]

### P2: Fresh-Session-Per-Task (CRITICAL)
The fundamental architectural decision. Nuke context, persist to files. Drives the file-based state system and knowledge compounding. PreCompact hook triggers mid-task fresh sessions when context degrades.
[via: aggregation-1.md#P2 ← research-1.md#L10-L11, research-2.md#L45-L50]
[via: aggregation-4.md#7 ← research-12.md#L100-L107]

### P3: Dual Exit Gate (HIGH)
Model-claim + machine-verify. Both PRD checkbox AND tsc/vitest/diff must pass. Confidence scoring provides weighted composite. Below-threshold re-enters with feedback. Unique differentiator.
[via: aggregation-1.md#P3 ← research-1.md#L19-L20, research-2.md#L57-L68, research-3.md#L36-L40]

### P4: Graduated Escalation (HIGH)
Every safety mechanism follows nudge → automated action → human checkpoint. Circuit breakers: continue → skip → stop. Stagnation: 3 tiers. Diff validation: retry → human pause. Consistent across all subsystems.
[via: aggregation-2.md#P1 ← research-5.md#L120-L121, research-5.md#L34-L47]

### P5: Verification Gate Chain (HIGH)
Sequential gate: file-watcher detection → dual exit → confidence scoring → PreComplete hook chain → TaskComplete hook → atomic commit. Only fully verified work enters git history.
[via: aggregation-2.md#P2 ← research-4.md#L22-L27, research-5.md#L102-L106, research-6.md#L34-L46]

### P6: Graceful Degradation (HIGH)
3-level command fallback, hook bridge behind feature flag with no-op default, try/catch on every proposed API call. Every external dependency has a fallback path.
[via: aggregation-2.md#P3 ← research-4.md#L83-L86, research-6.md#L88-L105]

### P7: Deterministic Control Plane (HIGH)
Verification, circuit breaking, and loop control as executable code rather than prompt instructions. The "fatal flaw" of `.agent.md` approaches: delegating verification to LLM text makes it non-deterministic. 361+ unit tests are a direct consequence.
[via: aggregation-4.md#P2 ← research-11.md#L73-L85, research-12.md#L62-L65]

### P8: Progressive Opt-In (MEDIUM)
Feature flags default false. ~25+ undeclared settings for power users. Safety-first layering (each phase adds protection before capability). Works out of the box, tunable at every layer.
[via: aggregation-4.md#P1 ← research-10.md#L83-L91, research-12.md#L114-L118]

### P9: File-Based IPC (MEDIUM)
Signal files, marker files, filesystem watchers for cross-process communication. Simple, debuggable, dependency-free. Single-machine only.
[via: aggregation-2.md#P4 ← research-4.md#L44-L53, research-6.md#L84-L86]

### P10: Invocation ID Traceability (MEDIUM)
UUID `taskInvocationId` threading through progress entries, events, hooks, and commits. Full end-to-end traceability per task attempt.
[via: aggregation-1.md#P5 ← research-2.md#L45-L46, research-3.md#L30-L32]

### P11: Adaptive Behavior (MEDIUM)
Nudge counters reset on productive changes. Iteration limits auto-expand (1.5x when tasks remain, capped at hardMax). Context trimming becomes progressively aggressive. System adjusts based on observed progress.
[via: aggregation-1.md#P6 ← research-2.md#L30-L32, research-2.md#L52-L55]

---

## Priority Matrix

| Pattern/Feature | Impact | Effort | Priority | Sources |
|----------------|--------|--------|----------|---------|
| Deterministic control plane messaging | Critical | None | P0 | [via: agg-4#P2 ← r12#L62-L65, r11#L73-L85] |
| PRD-as-single-source-of-truth | Critical | None | P0 | [via: agg-1#P1 ← r1#L33, r2#L34-L38, r3#L5-L10] |
| Fresh-session-per-task explanation | Critical | None | P0 | [via: agg-1#P2 ← r1#L10-L11, r2#L45-L50] |
| Dual exit gate + verification system | High | Low | P1 | [via: agg-1#P3, agg-4#4 ← r11#L73-L85] |
| Safety system overview (circuit breakers, struggle) | High | Low | P1 | [via: agg-2#C1-C5 ← r5#L9-L112] |
| Quickstart / installation instructions | High | Low | P1 | [via: agg-1#Gaps#2] |
| Configuration reference (all ~35 settings) | High | Medium | P1 | [via: agg-4#1 ← r10#L26-L91] |
| Preset system documentation | Medium | Low | P2 | [via: agg-3#Presets ← r8#L7-L20] |
| Knowledge system | Medium | Low | P2 | [via: agg-3#Knowledge ← r7#L7-L50] |
| CLI usage section | Medium | Low | P2 | [via: agg-3#CLI ← r9#L5-L30] |
| Feature flags documentation | Medium | Low | P2 | [via: agg-4#2 ← r10#L83-L91] |
| Architecture diagram update | Medium | Medium | P2 | [via: agg-1#F5, agg-2#A] |
| Hook system / extensibility | Low | Low | P3 | [via: agg-2#E ← r6#L54-L117] |
| Evolution narrative | Low | Low | P3 | [via: agg-4#5 ← r12#L11-L31] |

---

## Recommended Plan

1. **Replace README intro** with elevator pitch + core insight (F1, F2)
2. **Add Features section** covering: deterministic verification, dual exit gate, 7 circuit breakers, auto-decomposition, knowledge compounding, presets, CLI companion (P0+P1 items)
3. **Rewrite How It Works** with the 9-phase loop simplified to user-facing language (F4)
4. **Update Architecture** with the 4-layer Copilot integration and verification gate chain (F17, P5)
5. **Expand Configuration** with all declared settings + key undeclared ones + feature flags + presets (F24, F25, F26)
6. **Add Verification section** covering 7 verifier types, confidence scoring, dual exit gate (F9-F11)
7. **Add Safety section** covering circuit breakers, stagnation, struggle detection, bearings (F12-F16)
8. **Add Knowledge section** covering learning extraction, GC, session persistence (F21-F23)
9. **Keep existing CLI, PRD format, Research Workflow, and Development sections** (already good)
10. **Add Design Philosophy section** with key patterns (P1-P8)

Dependencies: Step 1 before 2-10 (sets the tone). Steps 2-9 are independent. Step 10 last.

---

## Gaps & Further Research

1. **Authoritative test count**: Three different numbers across reports (188, 322, 361+). Run `npm test` for current count. [via: aggregation-4.md#Gaps#1 ← research-12.md#L149-L150]
2. **Configuration enumeration**: ~25+ undeclared settings need a full inventory from source code scan of `getConfiguration()` calls. [via: aggregation-1.md#Gaps#1, aggregation-4.md#1]
3. **Visual assets**: No screenshots/GIFs of the loop in action. [via: aggregation-1.md#Gaps#3]
4. **Performance metrics**: No execution time, memory usage, or context window utilization data. [via: aggregation-4.md#Gaps#4]
5. **Non-Ralph ecosystem comparison**: Positioning is within Ralph family only — no comparison to Aider, Continue, Cline, etc. [via: aggregation-4.md#Gaps#5]
6. **Phase 9 completion status**: Unclear which of 8 Phase 9 capabilities are implemented vs. planned. [via: aggregation-4.md#Gaps#2]
7. **Command injection surface**: `commandExitCode` and `custom` verifiers use `execSync` without the dangerous pattern check applied in shell hooks. [via: aggregation-4.md#10 ← research-11.md#L96-L97]
8. **KnowledgeGC wiring**: No visible call site in orchestrator — may not be active. [via: aggregation-3.md#Gaps#1 ← research-7.md#L85-L86]
9. **Signal file security**: Predictable TMPDIR paths accept commands without authentication. [via: aggregation-2.md#Priority-Matrix ← research-6.md#L140-L141]

---

## Source Chain

- aggregation-1.md → research-1.md (identity, ecosystem), research-2.md (orchestrator architecture), research-3.md (PRD task management)
- aggregation-2.md → research-4.md (Copilot integration), research-5.md (safety mechanisms), research-6.md (git ops, hooks)
- aggregation-3.md → research-7.md (knowledge, session persistence), research-8.md (presets, strategies), research-9.md (CLI)
- aggregation-4.md → research-10.md (configuration surface), research-11.md (test infrastructure, verify system), research-12.md (evolution, ecosystem positioning)

---

## DRAFT README

The following is a complete draft README ready to replace the existing `README.md`. It preserves the existing sections that were already good (PRD format, research workflow, development) and adds/rewrites sections based on research findings.

---

````markdown
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

# Package and install the extension
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
3. Run `Ralph Loop: Start` from the Command Palette
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

Ralph-loop uses a **multi-signal verification pipeline** — not simple pass/fail:

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
- **No progress**: ≥3 iterations with 0 file changes
- **Short iterations**: ≥3 iterations under 30 seconds each
- **Repeated errors**: Same error hash appearing ≥2 times
- **Thrashing**: Same file+region edited ≥3 times in a 10-edit window

### Bearings Pre-flight

Optional health check (`tsc --noEmit` + `vitest run`) before each task. If unhealthy, injects a fix task or pauses the loop.

## Configuration

### VS Code Settings (Declared)

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
````
