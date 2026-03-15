# Aggregation A: Hook Systems, Test Coverage & Handoff Internals

## Deduplicated Findings

### Hook Architecture: Two Layers, Three Systems

The VS Code Copilot Chat extension runs **two coexisting hook systems** (Q1), while ralph-loop implements a **third, independent variant** (Q2):

| System | Location | I/O Model | Action Semantics |
|--------|----------|-----------|-----------------|
| VS Code Internal Registry | `claudeHookRegistry.ts` | In-process TypeScript, DI-injected | Boolean gate: `{ continue: true }` |
| VS Code Shell Hooks | `.vscode/settings.json` + external scripts | JSON stdin/stdout, exit codes | Binary: exit 0 (allow) / exit 2 (block) |
| Ralph-loop Hooks | `ShellHookProvider` + `IRalphHookService` | Shell scripts with JSON I/O | Rich: continue / retry / skip / stop |

All three share the same 13 hook events (SessionStart, PreToolUse, PostToolUse, Stop, etc.) but differ in expressiveness. Ralph's `retry` and `skip` actions have no VS Code equivalent.

### Hook Event Catalog (Consolidated)

Five hook types are defined in ralph-loop's `types.ts`: `SessionStart`, `PreCompact`, `PostToolUse`, `PreComplete`, `TaskComplete`. VS Code defines 13 events including `SubagentStart/Stop`, `PermissionRequest`, and `Notification` — events ralph-loop does not yet surface.

### Stop Hook = PreComplete Chain

The VS Code "Stop" hook and ralph-loop's `runPreCompleteChain` serve identical purposes: gate agent completion on validation criteria. Both implement recursive-stop guards (`stop_hook_active` / short-circuit on `retry`/`stop`). The key difference: VS Code's Stop hook is a single binary gate per hook; ralph's PreComplete chain runs hooks sequentially with accumulating `previousResults` and richer short-circuit semantics.

### Handoff Mechanism (Q3 Unique)

Agent-to-agent transitions use two paths:
1. **UI path**: `handoffs:` YAML frontmatter → rendered buttons → user clicks → mode switch
2. **Programmatic path**: `SwitchAgentTool` → `toggleAgentMode` command → same-session switch

Handoffs are **one-directional** with no back-stack. Context transfer relies on the `prompt` field (text injection), `model` field (LLM switch), and `sessionResource` (conversation continuity).

### Security: Input Validation

Ralph-loop's `containsDangerousChars` blocks shell metacharacters (`&&`, `||`, `|`, `>`, `<`, `` ` ``, `$()`, `${}`, `;`) with 12 dedicated tests (Q2). VS Code's shell hooks have no equivalent documented input sanitization — they trust the configured script path and pass JSON via stdin.

## Cross-Report Patterns

### Pattern 1: Context Injection Convergence

Three independent mechanisms inject context into model conversations:
- **Hook `additionalContext`** (Q1): Stop/SubagentStart hooks inject text via `hookSpecificOutput.additionalContext`
- **Hook `systemMessage`** (Q1): Informational injection that doesn't block
- **Handoff `prompt`** (Q3): Text injected into the target agent's input on mode switch
- **Ralph `additionalContext`** (Q2): `generatePreCompactHookScript` produces `additionalContext` with session resumption context

All four serve the same purpose (steering model behavior at transition points) but use different channels. No unified abstraction exists.

### Pattern 2: Filesystem as Coordination Primitive

Across all reports, the filesystem is the primary inter-agent coordination mechanism:
- Stop hooks check for file existence (`research-*.md`, `FINAL-REPORT.md`) (Q1)
- `generatePostToolUseHookScript` writes marker files (Q2, untested)
- `registerHookBridge` sets up FSWatcher for marker files (Q2, untested)
- Handoff prompts reference file paths for the target agent to work on (Q3)

### Pattern 3: Generated Scripts as Untested Runtime Code

Both `generateStopHookScript` and `generatePostToolUseHookScript` (Q2) produce Node.js scripts via template literals that are tested only as **string containment**, never executed. These scripts contain filesystem reads, git operations, and JSON I/O — a syntax error in the template would pass all tests but fail at runtime.

### Pattern 4: Phase Transition = Mode Switch

The wave orchestrator's phase transitions (decompose → explore → aggregate) map directly onto VS Code's handoff mechanism (Q3). The `send: true` flag enables automated phase transitions. The `model` override enables per-phase model selection. Ralph-loop could adopt `toggleAgentMode` via its existing `activeChatPanelSessionResource` tracking.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| **P0** | `registerHookBridge` has zero tests — it's the integration glue for the entire hook system | Q2 | Write integration tests covering temp dir creation, config merge, FSWatcher setup, and dispose cleanup |
| **P0** | `ShellHookProvider.executeHook` exit code semantics (0/1/2) and timeout logic are untested | Q2 | Add tests for all exit codes, JSON/non-JSON stdout, timeout + kill, stdin piping |
| **P1** | `generatePostToolUseHookScript` has zero tests | Q2 | Add string-level tests at minimum; consider execution-level tests |
| **P1** | `generateStopHookScript` has 1 test — no coverage for PRD checkbox logic, mtime check, failure aggregation, missing-file edge cases | Q2 | Expand test suite to cover all branches |
| **P1** | Stop hook re-entry depth is unbounded — no max retry count documented in SDK | Q1 | Investigate SDK source for depth limit; add guard in ralph-loop's PreComplete chain |
| **P2** | `skip` action defined in `HookResult` type but never tested or verified in `runPreCompleteChain` | Q2 | Verify implementation exists, add test, or remove from type |
| **P2** | Handoffs are one-directional with no return mechanism | Q3 | Evaluate whether wave phases need bidirectional transitions; if yes, design a back-stack |
| **P2** | `SwitchAgentTool` hardcoded to only support "Plan" agent | Q3 | Track for future extensibility when ralph-loop needs programmatic mode switches |
| **P3** | Shell hook timeout not documented — ralph uses 30s, SDK default unknown | Q1 | Check Claude Agent SDK source for default timeout |
| **P3** | `containsDangerousChars` doesn't test `\n` or null bytes | Q2 | Assess whether these are exploitable; add tests if yes |
| **P3** | Handoff button staleness — settings changes don't update rendered buttons | Q3 | Document as known limitation; no immediate action needed |
| **P3** | `systemMessage` vs `additionalContext` persistence semantics unclear | Q1 | SDK documentation review needed |

## Gaps

### Not Covered by Any Report

1. **Hook performance impact**: No report measures the latency overhead of shell hook execution (process spawn, JSON serialization, script execution, response parsing). For wave workflows with many subagents, cumulative hook latency could be significant.

2. **Concurrent hook execution**: All reports assume sequential hook execution. No analysis of whether hooks for simultaneous events (e.g., two subagents starting at once) race or queue.

3. **Error propagation from hooks to UI**: When a hook fails (crash, timeout, malformed JSON), how does the error surface to the user? Is it silent, logged, or shown in chat?

4. **Hook configuration validation**: No report examines what happens when hook configuration in `.vscode/settings.json` is malformed (wrong event names, missing fields, invalid script paths).

5. **Cross-session hook state**: Hooks are stateless per-invocation. No analysis of whether hooks need persistent state across sessions (e.g., tracking cumulative metrics, progressive quality gates).

6. **Handoff + Hook interaction**: What happens when a Stop hook blocks completion but a handoff has already been rendered? Can a user click a handoff button while the agent is still working due to a blocked stop?

7. **VS Code internal registry hooks beyond logging**: All current internal hooks return `{ continue: true }`. No analysis of whether blocking/modifying hooks are planned or possible via the internal registry path.

8. **Ralph-loop's `TaskComplete` hook**: Defined in types, listed in the hook service interface, but no report analyzes its implementation, usage, or test coverage.
