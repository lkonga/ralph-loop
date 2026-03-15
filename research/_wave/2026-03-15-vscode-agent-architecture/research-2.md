# Q2: Ralph-Loop Hook Test Coverage Analysis

## Findings

### Test File Inventory

**1. `test/hookBridge.test.ts`** — 7 tests for `generatePreCompactHookScript`
- Validates script is valid Node.js (shebang, `use strict`)
- Validates progress.txt reading logic (contains `readFileSync`)
- `injectGitDiff: true` → script contains `git diff --stat` and `git diff --name-only`
- `injectGitDiff: false` → script omits all git diff references
- `summaryMaxLines` value is embedded in the generated script
- Output structure contains session resumption context sections (`=== SESSION RESUMPTION CONTEXT ===`, `## Progress So Far`, `## Recent File Changes`, `## Current Task`, `=== END ===`)
- Output JSON structure contains `action: 'continue'` and `additionalContext`

**2. `test/shellHook.test.ts`** — 19 tests across 4 describe blocks

- **`DANGEROUS_PATTERNS regex`** (1 test): Confirms exported constant is a RegExp instance.
- **`containsDangerousChars`** (12 tests): Blocks `&&`, `||`, `|`, `>`, `<`, backtick, `$()`, `${}`, `;`. Allows clean commands (`npx vitest run`), flags (`npx tsc --noEmit`), git commands (`git add -A`), and quoted strings (`git commit -m "feat: add feature"`).
- **`killProcessTree`** (5 tests): SIGTERM sent first, SIGKILL sent after 1s delay (fake timers), ESRCH error on both signals handled gracefully, Windows uses `taskkill /PID ... /T /F` with no `process.kill`.
- **`ShellHookProvider blocked command feedback`** (2 tests): `onSessionStart` returns `{ blocked: true, reason: /shell metacharacters/ }` for dangerous scripts. `onPostToolUse` returns blocked result with non-empty reason string.

**3. `test/copilot.test.ts`** — 1 hook test for `generateStopHookScript`
- Verifies script source contains `npx tsc --noEmit` and `npx vitest run` checks
- Confirms no `USE_VERIFICATION_GATE` string leak

**4. `test/orchestrator.test.ts`** — 5 tests for `runPreCompleteChain`
- All-continue: runs all hooks sequentially, returns `action: 'continue'`, all hookNames present
- Retry short-circuits: second hook returns `retry`, third hook never called
- Stop short-circuits: first hook returns `stop`, second hook never called, only 1 result
- `previousResults` accumulation: each subsequent hook receives accumulated results from prior hooks (0, 1, 2 items)
- Disabled hooks skipped: `enabled: false` hooks excluded from execution and results

### Type-Level Coverage

`src/types.ts` defines:
- `RalphHookType`: 5 hook types (`SessionStart`, `PreCompact`, `PostToolUse`, `PreComplete`, `TaskComplete`)
- `IRalphHookService`: interface with 5 methods (one per hook type)
- `HookResult`: `action` (continue/retry/skip/stop), optional `reason`, `additionalContext`, `blocked`
- Input types: `SessionStartInput`, `PreCompactInput`, `PostToolUseInput`, `PreCompleteInput`, `TaskCompleteInput`
- `PreCompleteHookResult` extends `HookResult` with `hookName`
- `PreCompleteHookConfig`: `name`, `type`, `enabled` fields

## Patterns

### Mocking Strategies
- **ShellHookProvider tests**: inject `vi.fn()` for `process.kill` and `execSync` via a `deps` parameter (dependency injection for testability). Logger is a plain object with `vi.fn()` methods.
- **Orchestrator tests**: `createMockHookService()` helper builds a full `IRalphHookService` mock with a custom `onPreComplete` function and no-op defaults for all other hooks.
- **hookBridge tests**: Pure function testing — `generatePreCompactHookScript` is a string generator, tests assert substring presence/absence in the output.

### Assertion Styles
- String containment (`toContain`/`not.toContain`) for generated script validation
- Boolean equality for dangerous char detection
- Structural assertions (`toHaveLength`, `.hookName`, `.action`) for chain results
- Error-does-not-throw assertions for ESRCH handling
- Fake timers (`vi.useFakeTimers`, `vi.advanceTimersByTime`) for testing SIGTERM→SIGKILL delay

### Edge Cases Covered
- ESRCH (process already dead) on both SIGTERM and SIGKILL
- Windows vs Linux platform branching in `killProcessTree`
- Disabled hooks in chain execution
- Short-circuit semantics (retry, stop)
- Accumulating `previousResults` across chain

## Applicability

### Coverage Gaps

1. **`generateStopHookScript`** — Only 1 test (string contains tsc/vitest). No tests for:
   - PRD checkbox check logic
   - Progress.txt mtime check (5-min window)
   - Failure aggregation (multiple failures)
   - Exit code semantics (`resultKind: 'success'` vs `resultKind: 'error'`)
   - Edge case: missing PRD file (graceful fallback)
   - Edge case: zero checkboxes (early return)

2. **`generatePostToolUseHookScript`** — **Zero tests**. This function generates a script that writes a marker file. Completely untested.

3. **`registerHookBridge`** — **Zero tests**. The main orchestration function that:
   - Creates temp directory and writes scripts
   - Reads/merges VS Code `chat.hooks` configuration
   - Conditionally registers PreCompact hook
   - Sets up FSWatcher for marker file
   - Returns `dispose()` for cleanup
   - This is the integration glue — entirely untested.

4. **`ShellHookProvider.executeHook`** (private method, but behavioral) — Partially tested:
   - ✅ Dangerous char blocking (tested via public methods)
   - ❌ Successful script execution (exit 0 with JSON stdout)
   - ❌ Warning scenario (exit 1)
   - ❌ Block scenario (exit 2)
   - ❌ Unexpected exit codes
   - ❌ Timeout + killProcessTree integration
   - ❌ stdin JSON writing to child process
   - ❌ Non-JSON stdout on exit 0 (fallback to continue)
   - ❌ Error event handling (spawn failure)

5. **Hook action: `skip`** — Defined in `HookResult.action` type but no tests verify skip behavior in `runPreCompleteChain`.

6. **`TaskComplete` hook integration** — No tests exercise `onTaskComplete` in any meaningful scenario.

7. **`SessionStart` / `PreCompact` hook integration** — Only tested as blocked-command scenarios in shellHook.test.ts, not as actual hook executions.

### Risk Areas

- **`registerHookBridge`** is the highest-risk untested code — it does filesystem I/O, VS Code config mutation, and FSWatcher setup. A regression here breaks the entire hook system silently.
- **`ShellHookProvider.executeHook`** handles all exit code semantics and timeout logic — the core of the shell hook runtime — but only the input validation (dangerous chars) is tested.
- **Generated scripts** are tested as strings, not executed. A syntax error in the template literals would not be caught.

## Open Questions

1. Should generated scripts be executed in tests (e.g., spawn the script, pipe stdin, assert stdout JSON)?
2. Is `registerHookBridge` integration-testable without VS Code, or does it need the extension host?
3. Should `ShellHookProvider.executeHook` be tested via all 5 public methods or extracted for direct testing?
4. The `skip` action is defined but never tested — is it implemented in `runPreCompleteChain`?
5. No test validates that the FSWatcher cleanup in `dispose()` actually works — acceptable risk or gap?
6. `containsDangerousChars` allows double quotes but doesn't test for `\n` or null bytes in commands — is this a security gap?
