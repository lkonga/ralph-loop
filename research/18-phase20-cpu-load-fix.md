---
type: research
phase: 20
title: "CPU Load Reduction — Config-First Test Runner"
source: "wave-explore-fast --ralph-prd 2026-03-22"
verification:
  - npx tsc --noEmit
  - npx vitest run
---

# Phase 20 — CPU Load Reduction: Config-First Test Runner

## Problem Statement

Ralph's test runner hardcodes CLI flags (`--pool=forks --poolOptions.forks.maxForks=12`) that
override the project's own Vitest configuration. In Vitest 3.2, the `--poolOptions.forks.maxForks`
flag is silently ignored (not a supported CLI option), but `--pool=forks` IS supported and
actively overrides `pool: 'threads'` in `vite.config.ts`. This means the project's deliberate
pool choice is bypassed during ralph-loop operation (verifier, bearings, hook bridge).

Additionally, `hookBridge.ts` is the last remaining site with stale CLI flags after partial fixes
to `verify.ts` and `orchestrator.ts`.

## Research Sources

- `research/_wave/2026-03-22-ralph-loop-cpu-load-fix/FINAL-REPORT.md`
- `research/_wave/2026-03-22-ralph-loop-cpu-load-fix/FINAL-REPORT-2.md`
- 12 research reports + 5 aggregation reports (see wave folder)

## Key Findings

1. **CLI `--pool=forks` overrides config `pool: 'threads'`** — the fix in vite.config.ts is bypassed
2. **`--poolOptions.forks.maxForks=12` is a no-op in Vitest 3.2** — silently ignored
3. **vmThreads/vmForks pools** reuse workers via VM contexts — lower spawn overhead than forks
4. **`test.projects`** is the supported way to mix pools (not deprecated `poolMatchGlobs`)
5. **`execSync` blocks the extension host** — already partially fixed in orchestrator (async), but hookBridge still generates synchronous scripts
6. **VS Code extension best practice**: conservative workers (2-4), keep test execution out of extension host
7. **OS-level containment**: `taskset`/`systemd-run` propagate to child process trees

## Task Specifications

### Task 144 — Strip stale CLI flags from hookBridge stop script (L30-L43)

**What**: In `src/hookBridge.ts`, change the vitest command in `generateStopHookScript` from
`npx vitest run --pool=forks --poolOptions.forks.maxForks=12` to `npx vitest run`.

**Why**: The CLI `--pool=forks` overrides the project's `vite.config.ts` pool setting. Ralph must
respect the project's test configuration, not impose its own. Plain `npx vitest run` defers to
whatever pool/concurrency the project configured.

**Acceptance**: `grep -r 'pool=forks\|maxForks' src/` returns zero matches. All tests pass.

### Task 145 — CHECKPOINT: Config-first test runner verification (L45-L60)

**What**: Verify that ralph-loop no longer overrides project test configuration anywhere.

**Acceptance criteria**:
1. `grep -r 'pool=forks\|maxForks\|maxThreads' src/` returns zero matches
2. `npx tsc --noEmit` exits 0
3. `npx vitest run` — all tests pass
4. The vitest command in all 3 runtime sites (verify.ts, orchestrator.ts, hookBridge.ts) is plain `npx vitest run`
5. `vite.config.ts` is the sole authority for pool type and concurrency

### Task 146 — Reduce default maxThreads and document pool rationale (L62-L85)

**What**: In `vite.config.ts`, change `maxThreads: 4` to use a dynamic value based on available
CPU cores: `Math.max(2, Math.floor(os.cpus().length / 4))`. This follows the GitLens pattern
of conservative worker budgets. Add a comment explaining the rationale.

For projects that need forks (process.exit, process.chdir usage), document in README.md that
they can override pool in their own vite.config.ts or set `VITEST_MAX_FORKS` env var.

**Why**: 4 threads is reasonable but static. Dynamic calculation adapts to machine capability while
staying conservative (e.g., 2 on 8-core, 4 on 16-core).

**Acceptance**: `vite.config.ts` uses dynamic maxThreads. README documents pool override options.

### Task 147 — Add test that hookBridge script uses plain vitest command (L87-L105)

**What**: In `test/hookBridge.test.ts` (or `test/copilot.test.ts` if that's where stopHook tests
live), add a test that the generated stop hook script does NOT contain `--pool=` or `--poolOptions`
or `maxForks`. The script should contain `npx vitest run` without any pool overrides.

**Why**: Prevents regression — ensures ralph never re-introduces CLI pool overrides.

**Acceptance**: New test exists and passes. Test fails if pool flags are re-added to the script.
