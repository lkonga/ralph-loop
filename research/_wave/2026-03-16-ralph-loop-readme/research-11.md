## Research 11: Test Infrastructure

### Findings

#### Framework & Configuration
- **Test runner**: Vitest v3.2.4 (`vitest run` / `vitest` watch mode)
- **Config**: [vite.config.ts](../../../vite.config.ts) — includes `test/**/*.test.ts`, aliases `vscode` → `__mocks__/vscode.ts`
- **VS Code mock**: [__mocks__/vscode.ts](../../../__mocks__/vscode.ts) — stubs `workspace.getConfiguration`, `window.showInformationMessage`, `window.showInputBox`, `env.clipboard`, `commands.executeCommand`, `ConfigurationTarget`
- **Scripts**: `npm test` → `vitest run`, `npm run test:watch` → `vitest`

#### Test File Inventory (17 files, 1:1 with src modules)

| Test File | Source Module | Key Concerns Tested |
|-----------|--------------|---------------------|
| `verify.test.ts` | `verify.ts` | VerifierRegistry, builtin verifiers (checkbox, fileExists, fileContains, commandExitCode, tsc, vitest, custom), runVerifierChain, resolveVerifiers, confidence scoring, dual exit gate, feedback formatting |
| `orchestrator.test.ts` | `orchestrator.ts`, `decisions.ts` | runPreCompleteChain (hook chaining, retry/stop short-circuit, disabled hooks, previousResults accumulation), runBearings, LinkedCancellationSource |
| `circuitBreaker.test.ts` | `circuitBreaker.ts` | MaxRetriesBreaker, MaxNudgesBreaker, StagnationBreaker, ErrorRateBreaker, TimeBudgetBreaker, CircuitBreakerChain, ErrorHashTracker, RepeatedErrorBreaker, PlanRegenerationBreaker |
| `diffValidator.test.ts` | `diffValidator.ts` | Git diff parsing (stat/name-only output), hasDiff/filesChanged/linesAdded/linesRemoved, nudge generation, truncation (maxDiffLines), state block format |
| `parallelMonitor.test.ts` | `orchestrator.ts` (startMonitor) | Stuck detection with stuckThreshold, counter reset on progress/PRD mtime/checkbox count changes, clean stop |
| `copilot.test.ts` | `prompt.ts`, `copilot.ts` | buildPrompt (PRD filtering, progress truncation, sanitization, TDD gate, role section), parseReviewVerdict, renderTemplate, parseFrontmatter, token estimation |
| `prd.test.ts` | `prd.ts` | parsePrd (checked/unchecked tasks, line numbers, sequential IDs, taskId zero-padding, DECOMPOSED marker), pickNextTask |
| `gitOps.test.ts` | `gitOps.ts` | inferCommitType (fix/feat classification), buildCommitMessage (conventional format, truncation, taskId prefix), atomicCommit |
| `hookBridge.test.ts` | `hookBridge.ts` | generatePreCompactHookScript (script validity, progress reading, git diff injection, summaryMaxLines, session resumption context) |
| `knowledge.test.ts` | `knowledge.ts` | KnowledgeManager (extractLearnings, extractGaps, persist), HarvestPipeline, computeEntryHash, categorizeEntry, dedup, KnowledgeGC |
| `presets.test.ts` | `presets.ts` | PRESETS catalog (general/feature/bugfix/refactor), resolveConfig (preset merging, user overrides, unknown preset fallback) |
| `sessionPersistence.test.ts` | `sessionPersistence.ts` | Save/load/clear `.ralph/session.json`, version mismatch rejection, expiry (hasIncompleteSession), custom expireAfterMs |
| `shellHook.test.ts` | `shellHookProvider.ts` | DANGEROUS_PATTERNS regex, containsDangerousChars (blocks `&&`, `||`, `|`, `>`, `<`, backticks, `$()`, `${}`, `;`; allows clean commands), killProcessTree (SIGTERM→SIGKILL, ESRCH handling) |
| `stagnationDetector.test.ts` | `stagnationDetector.ts` | StagnationDetector (hash-based file change detection, stale iteration counting, reset on any file change), AutoDecomposer |
| `struggleDetector.test.ts` | `struggleDetector.ts` | StruggleDetector (no-progress, short-iteration, repeated-error signals with threshold triggers and resets), ThrashingDetector, BackpressureClassifier |
| `cooldownDialog.test.ts` | `cooldownDialog.ts` | showCooldownDialog (auto-accept timeout, button responses — Pause/Stop/Edit Next Task/dismiss, description truncation) |
| `consistencyChecker.test.ts` | `consistencyChecker.ts` | DeterministicConsistencyChecker (checkbox check, progress.txt mtime staleness >5min, file path existence validation) |

#### Modules WITHOUT Dedicated Tests
- `extension.ts` — VS Code extension activation (likely needs integration tests)
- `strategies.ts` — no test file found
- `decisions.ts` — tested indirectly through `orchestrator.test.ts` (imports `shouldContinueLoop`, `shouldNudge`, `shouldRetryError`)
- `types.ts` — type definitions only, no runtime behavior to test

### Patterns

1. **Pure unit tests**: Most tests are pure functions tested with deterministic inputs. No test spins up VS Code extension host.
2. **TDD markers**: `verify.test.ts` contains explicit `// --- New verifier system tests (TDD – written FIRST) ---` comment, confirming TDD workflow.
3. **Mocking strategy**:
   - `vscode` module → global alias via vite config to `__mocks__/vscode.ts`
   - `fs` → `vi.mock('fs')` for stagnation, knowledge, consistency tests
   - `child_process` → `vi.mock('child_process')` for git operations (diffValidator, gitOps)
   - Fake timers → `vi.useFakeTimers()` for parallelMonitor, shellHook (time-dependent behavior)
4. **Temp filesystem**: `verify.test.ts`, `sessionPersistence.test.ts` use real temp dirs (`fs.mkdtempSync`) for integration-style checks.
5. **Helper factories**: Most test files define `makeTask()`, `makeState()`, `makeConfig()`, `makeInput()` factory functions for test data.
6. **No snapshot tests**: All assertions use explicit `expect().toBe()` / `toEqual()` / `toContain()`.
7. **No test utilities shared**: Each test file is self-contained with its own helpers — no shared test utility module.

### The Verify System

The verification system is the most sophisticated subsystem with multiple layers:

1. **VerifierRegistry** — Plugin registry mapping type strings (`checkbox`, `fileExists`, `fileContains`, `commandExitCode`, `tsc`, `vitest`, `custom`) to async `VerifierFn` functions
2. **createBuiltinRegistry()** — Factory that pre-registers 7 builtin verifiers
3. **runVerifierChain()** — Runs all configured verifiers sequentially (no short-circuit), returns composite `VerifyCheck[]`
4. **resolveVerifiers()** — Resolution strategy: explicit config > verificationTemplates matching > defaults (`[checkbox, tsc]`) with optional auto-classification (adds `vitest` for test-related tasks)
5. **computeConfidenceScore()** — Weighted scoring: checkbox=100, vitest=20, tsc=20, diff=20, no_errors=10, progress_updated=10 (max=180)
6. **dualExitGateCheck()** — Requires BOTH model signal (PRD checkbox) AND machine verification to pass
7. **formatVerificationFeedback()** — Human-readable failure summary for nudge messages
8. **Legacy functions** — `verifyTaskCompletion()`, `isAllDone()`, `progressSummary()` provide simpler PRD-level checks

### Applicability

- Test infrastructure is mature and well-structured for a VS Code extension's core logic layer
- Coverage appears comprehensive for the "engine" (loop control, verification, detection) but lacks extension activation/UI integration tests
- The verify system is a key differentiator — multi-layer verification with confidence scoring goes beyond simple pass/fail
- Mocking patterns are clean and consistent; the vscode alias approach cleanly decouples from VS Code runtime
- The 1:1 test file mapping makes it easy to find tests for any module

### Open Questions

1. **What is `strategies.ts` and why has it no tests?** — Needs investigation; could be dead code or newly added
2. **Are there integration tests that exercise the full loop?** — All tests appear to be unit-level; no end-to-end test running the orchestrator with real PRD files through multiple iterations
3. **Is `decisions.ts` sufficiently covered via indirect testing in orchestrator.test.ts?** — Direct tests for `shouldContinueLoop`, `shouldNudge`, `shouldRetryError` would improve confidence
4. **Are the `commandExitCode` and `custom` verifiers command-injection safe?** — Both use `execSync` with user-provided command strings; `shellHookProvider` has `containsDangerousChars` but verify.ts doesn't apply it
5. **What's the actual test pass rate?** — No CI output available; would need `npm test` execution to confirm
