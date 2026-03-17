# Research: Risk of Overfitting Verification Checks — When Does a Second-Layer Barrier Make Sense?

## Findings

### 1. Current Verification Architecture: Multi-Signal but Shallow

Ralph has a layered verification system with **six distinct mechanisms**, each operating at a different granularity:

| Layer | Mechanism | What It Checks | Failure Mode |
|-------|-----------|----------------|-------------|
| 1 | `dualExitGateCheck()` | Model signal AND machine verification agree | Both can agree on wrong answer |
| 2 | `computeConfidenceScore()` with `CONFIDENCE_WEIGHTS` | Weighted sum of 6 signals (checkbox=100, vitest/tsc/diff=20 each, no_errors/progress=10 each) | Weights are static; vitest/tsc are **hardcoded to Pass** |
| 3 | `DeterministicConsistencyChecker` | Checkbox state, progress mtime, file paths exist | Existence ≠ correctness |
| 4 | `DiffValidator` | Git diff presence, line count stats | Diff present ≠ correct diff |
| 5 | `StagnationDetector` | Hash of progress.txt + PRD.md across iterations | Detects non-progress, not wrong-progress |
| 6 | Circuit breaker chain | Max retries, nudges, error rate, time budget, stagnation, repeated errors | Stops runaway loops, doesn't validate correctness |

### 2. Critical Gap: Hardcoded Pass for vitest/tsc in Confidence Scoring

In [orchestrator.ts lines 898-900](src/orchestrator.ts#L898-L900), the confidence checks for `vitest` and `tsc` are **hardcoded to `VerifyResult.Pass`**:

```typescript
confidenceChecks.push({ name: 'vitest', result: VerifyResult.Pass });
confidenceChecks.push({ name: 'tsc', result: VerifyResult.Pass });
confidenceChecks.push({ name: 'no_errors', result: VerifyResult.Pass });
```

This means 50 out of 180 possible confidence points (vitest=20, tsc=20, no_errors=10) are **always awarded regardless of actual test/compile state**. The confidence score can never reflect a broken build or failing tests. This is the most concrete overfitting risk: the score says "confident" while the code is wrong.

### 3. Existence vs. Correctness Gap (The Symlink Problem)

The `fileExists` verifier uses `fs.existsSync()` — which returns `true` for symlinks regardless of target validity. A broken symlink (target deleted or moved) still "exists" at the link path. The `fileContains` verifier reads through symlinks, but can't verify that the symlink *target path* is correct.

For a task like "create symlink from A → B":
- `fileExists('A')` → Pass (symlink node exists)
- `fileContains('A', expectedContent)` → Could Pass (if any file with similar content exists at target)
- But the *target path* could be wrong — `readlink('A')` would reveal the mismatch

This generalizes to any **relational correctness** that automated checks miss: the individual pieces pass, but the relationship between them is wrong.

### 4. When All Checks Pass But Result Is Wrong

Concrete scenarios where the current multi-signal system gives false confidence:

| Scenario | Checks That Pass | What's Actually Wrong |
|----------|------------------|----------------------|
| Symlink to wrong target | fileExists, fileContains (if content matches) | Link target path incorrect |
| Cross-repo config pointing to stale path | fileExists (in source repo), tsc passes | Config references moved/renamed resource |
| Correct code, wrong file location | tsc, vitest, diff present, checkbox | File placed in wrong directory |
| Test passes but tests wrong assertion | vitest (hardcoded Pass anyway), tsc | Test doesn't validate actual requirement |
| Destructive delete + recreate | diff present, checkbox marked | Original data/history lost unnecessarily |
| Race condition in parallel tasks | All individual checks pass | Tasks wrote conflicting changes |

### 5. The Dual-Exit Gate Is Necessary but Insufficient

`dualExitGateCheck()` requires both model signal AND machine verification. This catches the most common failure (model claims done, machine disagrees). But it has a blind spot: **when both agree on a wrong outcome**. The model marks checkbox, PRD updates, diff exists — but the semantic intent of the task wasn't fulfilled.

### 6. Stagnation Detection Catches Non-Progress, Not Wrong-Progress

`StagnationDetector` hashes `progress.txt` and `PRD.md` to detect unchanged state. The three-tier escalation (Tier 1: nudge, Tier 2: circuit breaker skip, Tier 3: human checkpoint) is well-designed for **loops that go nowhere**. But it cannot detect loops that make progress in the wrong direction — files change, checkboxes flip, but the actual requirement is unsatisfied.

## Patterns

### Pattern 1: False Confidence from Correlated Checks

When multiple checks measure the **same underlying signal**, they provide redundant rather than independent verification. Currently:
- `checkbox` + `progress_updated` both measure "did the loop update tracking files" — correlated
- `diff` + `no_errors` + `tsc` + `vitest` should measure "is the code correct" — but 3 of 4 are hardcoded
- The only truly independent signals are: checkbox state, diff existence, and progress mtime

**Risk**: Adding more checks of the same type (more file existence checks, more mtime checks) increases the score without increasing actual verification quality. This is overfitting — optimizing the metric without improving the outcome.

### Pattern 2: Second-Layer Barriers Add Value for Semantic Correctness

A second-layer barrier is worth the cost when:

1. **Relational correctness matters**: The task involves relationships between entities (symlinks, config references, cross-file imports) where individual component checks pass but the relationship is wrong.

2. **Destructive operations**: File deletion, git force-push, database drops — where the operation cannot be undone and a false positive in verification means permanent data loss. The existing `HumanCheckpointRequested` event is the right mechanism but is only triggered by stagnation/diff-failure, not by task category.

3. **Cross-repo or cross-system state**: When the task modifies state outside the monitored workspace (another repo, a remote server, a database), local verification is structurally blind to the outcome.

4. **State that can't be automatically validated by exit-code**: Some outcomes require human judgment — UX changes, documentation quality, architecture decisions. The `LlmConsistencyCheckerStub` (which always returns pass) acknowledges this gap exists but doesn't fill it.

### Pattern 3: When NOT to Add a Second Layer

Adding a second-layer barrier is counterproductive when:

1. **The first layer already validates the actual requirement**: If `vitest` tests are well-written and actually run (not hardcoded to pass), they validate functional correctness. A second-layer check would be redundant.

2. **The task is idempotent and reversible**: For pure code additions that can be reverted by git, the cost of a false positive is low — a subsequent loop iteration or human review can catch it.

3. **The check would measure the same signal**: Adding `eslint` on top of `tsc` when both catch the same class of errors adds latency without verification breadth.

## Applicability

### Immediate Fix: Stop Hardcoding Confidence Checks

The most impactful change is making `vitest`, `tsc`, and `no_errors` confidence checks **actually run their verifiers** instead of hardcoding `VerifyResult.Pass`. The `createBuiltinRegistry()` already has working `tsc` and `vitest` verifiers — they're just not wired into the confidence scoring path.

### Task-Category-Based Checkpoint Triggers

Instead of a universal second-layer barrier, implement **task categorization** that triggers `HumanCheckpointRequested` based on task properties:

```
IF task description matches destructive_patterns (delete, remove, drop, force-push, overwrite)
  → emit HumanCheckpointRequested BEFORE execution, not after

IF task involves cross-repo references (detected by path patterns outside workspaceRoot)
  → require readlink/realpath verification for symlinks
  → require target-existence verification for cross-repo paths

IF task modifies configuration files (*.json, *.yaml, *.toml in config paths)
  → require schema validation as a verifier, not just fileExists
```

### Symlink-Specific Verifier

A `symlinkTarget` verifier that:
1. Checks `fs.lstatSync()` to confirm it's actually a symlink (not a regular file)
2. Reads `fs.readlinkSync()` to verify the target path matches expectation
3. Resolves `fs.realpathSync()` to verify the resolved path exists

This fills the gap the user identified between "fileExists passes" and "symlink is correct."

### Confidence Score Decomposition

Split the confidence score into independent dimensions instead of a single sum:
- **Structural confidence**: checkbox, file existence, diff present (current system does this well)
- **Functional confidence**: tests pass, build succeeds, no runtime errors (currently faked)
- **Semantic confidence**: LLM review, human review, consistency check (currently stubbed)

A task should only complete when ALL dimensions exceed their thresholds, not when the sum crosses a single threshold. This prevents structural signal from masking functional/semantic gaps.

## Open Questions

1. **Should destructive-operation detection be a new circuit breaker or a verifier?** Circuit breakers stop loops; verifiers gate completion. A destructive operation gate needs to fire *before* execution, making it more like a command-blocker than a post-hoc verifier. The `CommandBlocked` event exists but is only triggered by hook scripts, not by task classification.

2. **How should the confidence threshold adapt per task complexity?** Simple tasks (mark checkbox, create file) need lower confidence than complex tasks (refactor module, implement feature). Should the `confidenceThreshold` be per-task rather than global config?

3. **Is the LLM consistency checker worth implementing?** The stub exists (`LlmConsistencyCheckerStub`). For semantic correctness gaps, an LLM review of the diff against the task description would catch cases where all automated checks pass but the intent wasn't fulfilled. But this adds latency and cost per iteration.

4. **Parallel task race conditions**: When `useParallelTasks` is enabled, two tasks can write conflicting changes. Each passes individual verification, but the combined state is incorrect. Should there be a post-parallel-batch consistency check?

5. **Can the existing `ReviewAfterExecuteConfig` (disabled by default) serve as the second-layer barrier?** It already supports `'same-session'` and `'new-session'` review modes with structured verdicts. Enabling it selectively for high-risk tasks might be simpler than building a new barrier system.
