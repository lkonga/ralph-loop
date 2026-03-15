# Aggregation D: Hook Systems, Test Coverage & Architecture Synthesis

## Deduplicated Findings

### Hook I/O Contract (R11 canonical, R10 supplements)
- **Spawn protocol**: `child_process.spawn` with `stdio: 'pipe'`, shell mode. JSON on stdin, JSON+exit-code on stdout.
- **Exit code semantics**: 0=success, 2=blocking error, other=non-blocking warning. Uniform across all hook types.
- **Timeout**: 30s default, SIGTERM→SIGKILL(5s). No per-event customization (R11). Ralph-loop's `killProcessTree` mirrors this with SIGTERM→SIGKILL(1s) (R10).
- **Response fields**: `continue`, `stopReason`, `decision`, `hookSpecificOutput.additionalContext`, `hookSpecificOutput.permissionDecision`.

### Hook Event Taxonomy (R11 canonical, R12 maps to ralph-loop)
10 canonical `ChatHookType` events. Ralph-loop maps 5 of these via `IRalphHookService`:

| Ralph Hook | ChatHookType | Enforcement | Coverage (R10) |
|---|---|---|---|
| `onSessionStart` | `SessionStart` | Soft (context inject) | 1 blocked-path test only |
| `onPreCompact` | `PreCompact` | Soft (context inject) | Script generation tested, no execution |
| `onPostToolUse` | `PostToolUse` | Soft (timer reset) | 1 blocked-path test only |
| `onPreComplete` | `Stop` | **Hard (completion gate)** | **ZERO tests** |
| `onTaskComplete` | `SessionEnd` | Cleanup | **ZERO tests** |

### Multi-Hook Collapsing (R11 only)
- PreToolUse: most restrictive wins (`deny > ask > allow`)
- PostToolUse/Stop/SubagentStop: first block wins, all reasons collected
- Context: all `additionalContext` concatenated
- Ralph-loop has no multi-hook collapsing — single script per event.

### Three-Layer Stack (R12 only)
Wave (fan-out research) → Ralph-loop (sequential PRD execution) → VS Code Copilot (tool calling loop). Each layer adds autonomy controls. No automated bridge between Wave output and Ralph-loop PRD input.

## Cross-Report Patterns

### P1: Critical Path Is Least Tested
The Stop hook is the **primary verification gate** (R10) and uses **hard enforcement** via `decision: "block"` (R11). Yet `generateStopHookScript` has **zero tests** (R10). The most safety-critical code path is completely unverified.

### P2: String-Contains Testing Is Insufficient
R10 shows all hookBridge tests use `toContain`/`not.toContain` on generated script strings. R11 reveals the actual runtime contract (JSON stdin/stdout, exit codes, field routing, `hookEventName` filtering). The tests validate script generation but never exercise the contract that matters.

### P3: Integration Seams Are Untested
R10 confirms zero orchestrator-level hook tests. R12 identifies 3 critical integration seams: (1) hook registration via `chat.hooks` config, (2) ralph-loop→Copilot command dispatch, (3) Wave→PRD bridge. None have integration tests.

### P4: Soft vs Hard Enforcement Mismatch
R11 documents two enforcement modes (context injection vs completion blocking). R12 shows ralph-loop relies on hard enforcement (Stop hook) for its core value proposition (PRD completion gating). R10 reveals the hard enforcement path is untested while soft enforcement paths have partial coverage.

### P5: Parallel vs Sequential Tension
R12 identifies Wave as inherently parallel (`runSubagent`) and Ralph-loop as sequential (command-based). Ralph-loop has `useParallelTasks` flag (default off). The `DirectApiStrategy` placeholder in R12 would enable in-process dispatch but is unimplemented.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| **P0** | `generateStopHookScript` has zero tests | R10 | Write tests covering PRD checkbox detection, progress.txt mtime, tsc/vitest gates |
| **P0** | `registerHookBridge` has zero tests | R10 | Test temp file creation, config update, marker watcher, dispose cleanup |
| **P0** | `ShellHookProvider.executeHook` only tests blocked path | R10 | Test successful spawn, JSON parsing, exit code 0/1/2, timeout+kill, stderr |
| **P1** | No execution tests for generated hook scripts | R10, R11 | Create fixture-based tests: write script to disk, run against mock PRD/progress |
| **P1** | Stop hook `decision:"block"` → continuation flow untested | R11 | Integration test: hook returns block → verify reason injected as next prompt |
| **P1** | `onPreComplete`/`onTaskComplete` hook methods untested | R10 | Unit tests for remaining `ShellHookProvider` methods |
| **P1** | Wave→PRD bridge missing | R12 | Build converter: research findings → checkbox PRD tasks |
| **P2** | `hookEventName` routing/filtering untested | R11 | Test mismatched event name → result ignored behavior |
| **P2** | Unified tracing across layers missing | R12 | Link `taskInvocationId` ↔ `subAgentInvocationId` |
| **P2** | `DirectApiStrategy` unimplemented | R12 | Implement chatProvider-based dispatch as alternative to command-based |
| **P3** | `ErrorOccurred`/`PostToolUseFailure`/`PermissionRequest` stubs | R11 | Clarify implementation status; document as future or remove |
| **P3** | No PreCompact output schema | R11 | Define output type or document as fire-and-forget |
| **P3** | Dynamic hook script regeneration for wave-created PRDs | R12 | Auto-regenerate hook scripts when PRD path changes |

## Gaps

### Cross-Report Gaps (not covered by any report)
1. **Error recovery across layers**: R10 covers `killProcessTree` error handling, R11 covers hook-level error semantics, R12 covers ralph-loop circuit breaker — but no report examines what happens when a hook failure cascades across layers (e.g., Stop hook crash during ralph-loop task → does circuit breaker trigger?).
2. **Hook script security**: R10 tests `containsDangerousChars` for shell injection, but the generated hook scripts themselves (R10 `generateStopHookScript`) execute `tsc`, `vitest`, `git diff` — no report examines whether these embedded commands are injection-safe when PRD paths contain special characters.
3. **Concurrency under parallel tasks**: R12 notes `useParallelTasks` flag exists. If enabled, multiple tasks could trigger hooks simultaneously. No report addresses hook execution concurrency (R11 shows hooks are sequential per event but doesn't address cross-task parallelism).
4. **Hook performance budget**: R11 documents 30s timeout. No report profiles actual hook execution time. Stop hooks running `tsc` + `vitest` on large codebases could easily exceed 30s.
5. **Observability gap**: R12 identifies missing unified tracing. Additionally, no report covers hook execution telemetry — success/failure rates, latency distributions, timeout frequency.
