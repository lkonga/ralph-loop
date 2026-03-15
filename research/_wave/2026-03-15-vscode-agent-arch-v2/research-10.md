# Q10: Ralph-Loop Hook Test Coverage

## Findings

### Source Files Analyzed
- `src/hookBridge.ts` — 3 exported functions: `generateStopHookScript`, `generatePreCompactHookScript`, `registerHookBridge`; 1 internal: `generatePostToolUseHookScript`
- `src/shellHookProvider.ts` — 3 exports: `DANGEROUS_PATTERNS`, `containsDangerousChars`, `killProcessTree`; 1 class: `ShellHookProvider` (implements `IRalphHookService` with 5 hook methods)
- `src/types.ts` — Hook interfaces: `IRalphHookService`, `HookResult`, `RalphHookType`, `SessionStartInput`, `PreCompactInput`, `PostToolUseInput`, `PreCompleteInput`, `TaskCompleteInput`, `PreCompleteHookResult`

### Test File: `test/hookBridge.test.ts` — 7 tests

| # | Test Name | What It Asserts |
|---|-----------|----------------|
| 1 | generates a valid Node.js script string | Output is string, contains shebang and 'use strict' |
| 2 | includes progress.txt reading logic | Script contains 'progress.txt' and 'readFileSync' |
| 3 | includes git diff logic when injectGitDiff is true | Script contains 'git diff --stat' and 'git diff --name-only' |
| 4 | omits git diff logic when injectGitDiff is false | Script does NOT contain 'git diff' |
| 5 | respects summaryMaxLines | Script embeds the configured value (25) |
| 6 | outputs JSON with session resumption context structure | Script contains all 5 section markers |
| 7 | outputs HookResult with action continue | Script contains 'continue' and 'additionalContext' |

**Scope**: Only tests `generatePreCompactHookScript`. All tests are string-contains assertions on generated script output — no execution testing.

### Test File: `test/shellHook.test.ts` — 19 tests

**`describe('DANGEROUS_PATTERNS regex')` — 1 test**

| # | Test Name | Assertion |
|---|-----------|-----------|
| 1 | is a RegExp | `DANGEROUS_PATTERNS instanceof RegExp` |

**`describe('containsDangerousChars')` — 13 tests**

| # | Test Name | Blocked Char | Result |
|---|-----------|-------------|--------|
| 1 | blocks && | `&&` | true |
| 2 | blocks \|\| | `\|\|` | true |
| 3 | blocks pipe \| | `\|` | true |
| 4 | blocks redirect > | `>` | true |
| 5 | blocks redirect < | `<` | true |
| 6 | blocks backtick | `` ` `` | true |
| 7 | blocks $() subshell | `$()` | true |
| 8 | blocks ${} variable expansion | `${}` | true |
| 9 | blocks semicolon ; | `;` | true |
| 10 | allows clean commands | `npx vitest run` | false |
| 11 | allows clean command with flags | `npx tsc --noEmit` | false |
| 12 | allows simple git commands | `git add -A` | false |
| 13 | allows commands with quotes | `git commit -m "feat: add feature"` | false |

**`describe('killProcessTree')` — 5 tests**

| # | Test Name | Assertion |
|---|-----------|-----------|
| 1 | sends SIGTERM first | `kill(pid, 'SIGTERM')` called |
| 2 | sends SIGKILL after 1-second delay | SIGKILL NOT called immediately; called after 1s timer advance |
| 3 | handles ESRCH error on SIGTERM gracefully | No throw when ESRCH on SIGTERM |
| 4 | handles ESRCH error on SIGKILL gracefully | No throw when ESRCH on delayed SIGKILL |
| 5 | uses taskkill on Windows | Calls `exec('taskkill /PID ... /T /F')`, does NOT call `kill` |

**`describe('ShellHookProvider blocked command feedback')` — 2 tests**

| # | Test Name | Assertion |
|---|-----------|-----------|
| 1 | returns blocked: true with reason when script contains dangerous chars | `onSessionStart` returns `{blocked: true, reason: contains 'shell metacharacters', action: 'continue'}` |
| 2 | blocked result includes reason string usable as feedback | `onPostToolUse` returns `{blocked: true}` with non-empty reason string |

### Other Test Files — 0 hook-related tests
- `test/copilot.test.ts` — No hook references
- `test/orchestrator.test.ts` — No hook references

### Total Test Count: **26 tests** across 2 files

## Patterns

### Testing Strategies Used
1. **String-contains on generated scripts** (hookBridge) — tests verify script generation via `toContain`/`not.toContain` but never run the generated scripts
2. **Dependency injection for process APIs** (shellHook) — `killProcessTree` accepts `{kill, exec}` deps for testability
3. **Fake timers** (shellHook) — `vi.useFakeTimers()` to test SIGKILL delay behavior
4. **Stub logger** (shellHook) — `{log: vi.fn(), warn: vi.fn(), error: vi.fn()}` for `ShellHookProvider` construction
5. **No integration tests** — no tests spawn actual child processes or verify real hook execution

## Applicability

### Well-Covered Areas
- `containsDangerousChars`: Thorough — all 9 dangerous patterns + 4 allow-listed patterns
- `killProcessTree`: Good — covers SIGTERM→SIGKILL flow, ESRCH errors, Windows path
- `generatePreCompactHookScript`: Adequate — covers config toggles and output structure

### P0 Coverage Gaps (Critical)

| Gap | Risk | Source Location |
|-----|------|-----------------|
| **`generateStopHookScript` — ZERO tests** | Stop hook is the primary verification gate (PRD checkbox, progress freshness, tsc, vitest). Completely untested. | `hookBridge.ts:11-97` |
| **`generatePostToolUseHookScript` — ZERO tests** | Tool activity marker file logic untested | `hookBridge.ts:210-237` |
| **`registerHookBridge` — ZERO tests** | Full registration flow (temp file creation, VS Code config update, marker watcher, dispose cleanup) untested | `hookBridge.ts:253-350` |
| **`ShellHookProvider.executeHook` — minimal tests** | Only 2 tests cover the blocked-command path. ZERO tests for: successful spawn, stdout JSON parsing, exit code 0/1/2 handling, timeout+kill behavior, stderr capture, stdin writing | `shellHookProvider.ts:58-140` |
| **`ShellHookProvider` hook methods beyond `onSessionStart`/`onPostToolUse`** | `onPreCompact`, `onPreComplete`, `onTaskComplete` never tested | `shellHookProvider.ts:50-66` |

### P1 Coverage Gaps (Important)

| Gap | Risk |
|-----|------|
| No test verifies the generated stop script actually detects unchecked PRD checkboxes | PRD gate could silently pass/fail incorrectly |
| No test verifies progress.txt mtime check logic in stop script | Stale progress could pass verification |
| No test for PreCompact hook's `resultKind` vs `action` field reconciliation | PreCompact returns both `resultKind` and `action` — tested in generation but not in consumption |
| No integration test proving `registerHookBridge` correctly writes to `chat.hooks` config | Hook registration could silently fail in real VS Code |
| No test for hook script error handling (`main().catch`) fallback paths | Script crash could produce unexpected output |

## Open Questions

1. **Why is `generateStopHookScript` completely untested?** It's the most critical hook (verification gate for task completion). This is the highest-priority gap.
2. **Should the generated scripts be execution-tested?** Current tests only check string contents. A test that writes the script to disk and runs it against fixture PRD/progress files would catch logic bugs.
3. **Is `ShellHookProvider.executeHook` integration-testable?** The spawn/timeout/exit-code logic is complex and entirely untested beyond the trivial blocked-command case.
4. **Are the `IRalphHookService` interface methods tested at the orchestrator level?** No — the orchestrator tests contain zero hook references, meaning hook→orchestrator integration is untested.
5. **What about `PostToolUseInput.output`?** The test file references `output: ''` but the types definition shows `PostToolUseInput` has `toolName`, `taskId`, `taskInvocationId` — no `output` field. This may be a type mismatch bug in the test.
