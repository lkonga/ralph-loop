# Final Report: Ralph-Loop Checkpoint & Human Intervention Patterns

## Executive Summary

Across 12 research files consolidated into 4 aggregation reports, a comprehensive picture emerges of ralph-loop's checkpoint architecture. The system has drifted from its zero-intervention bash script origins to accumulate 7 human intervention pathways and 40+ config fields, yet **all human checkpoints remain purely reactive** — triggered only by failure (stagnation tier 3, diff validation exhaustion), never by design milestones. The central missing capability is **proactive, user-declared checkpoints**. The recommended path is a `[CHECKPOINT]` DSL annotation (~22 lines, following the existing `[DECOMPOSED]` precedent) combined with wiring the already-built-but-disconnected `runVerifierChain()` into the orchestrator. Three critical bugs are identified: hardcoded confidence checks (28% fabricated), guidance persistence leak (permanent instead of one-shot), and "Skip Task" being identical to "Continue." The verifier infrastructure is mature (7 types, full resolution chain) but unused in the main execution path. A composable four-approach checkpoint strategy (sentinel verifier, DSL annotation, agent escalation, split PRD) covers planned milestones, external gating, adaptive situations, and manual phasing respectively. Blocking indefinitely on `HumanCheckpointRequested` with no timeout is the single most impactful anti-pattern for unattended operation.

---

## Consolidated Findings

### 1. Purely Reactive Checkpoint Philosophy

Ralph-loop's `HumanCheckpointRequested` fires from exactly **two** code paths, both failure-driven:

| Trigger | Location | Condition |
|---------|----------|-----------|
| Stagnation Tier 3 | orchestrator.ts ~L760 | `staleIterations >= maxStaleIterations + 2` (≥4 default) |
| Diff validation exhausted | orchestrator.ts ~L870 | `diffAttempt >= maxDiffValidationRetries` (3 default) |

Zero proactive checkpoint triggers exist. The PRD (line ~134) only specifies failure-driven checkpoints — this is by design, not oversight. The cooldown dialog is the closest to proactive but auto-continues on timeout and doesn't yield `HumanCheckpointRequested`.
[via: aggregation-1.md#L25-L35 ← research-1.md#L13-L35, research-2.md#L35-L42, research-3.md#L18-L32]
[via: aggregation-4.md#L39-L46 ← research-11.md#L55-L70, research-12.md#L143-L147]

### 2. Complete Escalation Chain (6 Tiers)

| Tier | Mechanism | Human? |
|------|-----------|--------|
| 0 — Nudge | Re-send prompt with continuation suffix | No |
| 1 — Stagnation/Struggle | Inject "try different approach" guidance | No |
| 1.5 — Confidence/Gate rejection | Re-enter task with failure feedback | No |
| 2 — Circuit breaker | Skip task or stop loop | No |
| 3 — Auto-decompose | Split task into sub-tasks in PRD | No |
| 4 — HumanCheckpoint | Pause loop, show 4-option dialog | **Yes** |
| 5 — Stop | Terminate loop | **Yes**/Auto |

The graduated escalation model is architecturally sound — mature external systems (Aider, Continue.dev, Cursor, Cline, AutoGen, CrewAI, LangGraph) converge on this same pattern.
[via: aggregation-1.md#L37-L50 ← research-3.md#L78-L100, research-1.md#L27-L35]
[via: aggregation-3.md#L46-L50 ← research-8.md#L93-L100]

### 3. HumanCheckpointRequested Blocks Indefinitely

When fired, `pauseRequested = true` triggers a 1-second poll spin-wait with **no timeout**. If the user is absent, the loop halts permanently. This converts a safety valve into a "requires active supervision" constraint, directly contradicting the "write a PRD, press start, come back to commits" value proposition.
[via: aggregation-2.md#L32-L39 ← research-4.md#L77-L95, research-5.md#L52-L65]

### 4. Verifier Chain: Built but Disconnected

The codebase contains a complete verifier registry (7 types), a resolution chain (`resolveVerifiers`), and a chain runner (`runVerifierChain`), but the orchestrator's main execution path **does not call them**. The dual exit gate only checks checkbox status + diff presence inline. This means the research→spec→PRD pipeline produces verification metadata used only as prompt context, never as runtime enforcement.
[via: aggregation-3.md#L24-L32 ← research-7.md#L13-L20, research-9.md#L70-L75]

### 5. Hardcoded Confidence Checks (28% Fabricated)

Vitest, tsc, and no_errors confidence checks are **hardcoded to `VerifyResult.Pass`** in orchestrator.ts ~L898-900, awarding 50/180 points regardless of actual build/test state. The builtin verifier registry has working implementations — they're simply not wired into the confidence scoring path.
[via: aggregation-4.md#L25-L32 ← research-10.md#L23-L35]

### 6. Dual Exit Gate with 7-Stage Post-Pipeline

The dual exit gate requires `modelSignal ∧ machineVerification`. After passing, a sequential veto chain runs:

```
dual exit gate → consistency check → diff validation (retry loop) → confidence scoring
→ preComplete hooks → taskComplete hook → reviewAfterExecute → atomic commit
```

Each stage can reject and loop back. All are currently automated — no proactive human checkpoint exists on the happy path.
[via: aggregation-4.md#L34-L38 ← research-11.md#L13-L50, research-11.md#L83-L99]

### 7. Nine additionalContext Injection Points

All sources that inject one-shot context into the agent prompt: SessionStart hook, shell command blocked, stagnation tier 1, struggle detected, confidence score low, dual exit gate rejection, taskComplete hook (success/failure), and pre-complete chain. Key property: `additionalContext` is always one-shot and agent-facing (never shown to user).
[via: aggregation-1.md#L67-L80 ← research-3.md#L56-L76]

### 8. PRD Is Flat-Parsed, Phase Headings Are Cosmetic

`parsePrd()` scans for checkbox lines and ignores markdown headings entirely. No phase-aware scheduling exists — `pickNextTask()` returns the first pending task in file order. The `expectedPhase` field exists in types but is disconnected from task scheduling.
[via: aggregation-2.md#L47-L50 ← research-5.md#L27-L42]

### 9. Sequential Mode Ignores Dependencies

`pickNextTask()` (sequential/default mode) returns the first pending task regardless of `dependsOn` annotations. Only `pickReadyTasks()` (parallel mode) respects the dependency graph. This makes `depends:` annotations unreliable for most users.
[via: aggregation-3.md#L36-L38 ← research-9.md#L31-L36]

### 10. Nine Checkpoint/Pause Patterns in the Ecosystem

Catalogued across the ralph ecosystem: inter-task cooldown, dual exit gate, yield requests (VS Code autopilot), Signs & Gates (ClaytonFarr/ralph-playbook), backpressure verification, circuit breaker states, hook suspend policies (WaitForResume/RetryBackoff/WaitThenRetry), state checkpointing (LangGraph pattern), and session boundaries. The most successful systems are reactive (fire-on-failure).
[via: aggregation-2.md#L62-L67 ← research-6.md#L13-L107]

### 11. Autonomy Drift from Zero-Intervention Origins

The system evolved from snarktank/ralph (113 lines bash, zero checkpoints) through aymenfurter/ralph (cooldown countdown) to the current state: 3 blocking checkpoints, 7 total intervention pathways, 40+ config fields. This graduated autonomy erosion transforms an automated loop into an interactive assistant with a loop bolted on.
[via: aggregation-2.md#L28-L31 ← research-4.md#L12-L30]

---

## Pattern Catalog

### P1: Proactive Human Checkpoint Is the Central Missing Capability
**Confidence: VERY HIGH (4/4 aggregation reports)**
All 12 research files and all 4 aggregation reports independently converge: the system lacks any mechanism for "always require human approval for task X" or "pause at this milestone." This is the single most important architectural gap.
[via: aggregation-1.md#L97-L100 ← research-1.md#L84-L91, research-2.md#L35-L42, research-3.md#L116-L123]
[via: aggregation-2.md#L80-L85 ← research-4.md#L77-L95, research-5.md#L52-L65, research-6.md#L84-L92]
[via: aggregation-3.md#L59-L66 ← research-7.md#L13-L20, research-8.md#L106-L112, research-9.md#L70-L75]
[via: aggregation-4.md#L67-L72 ← research-10.md#L85-L95, research-11.md#L101-L105, research-12.md#L143-L147]

### P2: DSL `[CHECKPOINT]` Annotation Is the Recommended Approach
**Confidence: HIGH (3/4 aggregation reports)**
~22 lines across 3 files (types.ts, prd.ts, orchestrator.ts), follows the exact pattern of existing `[DECOMPOSED]` annotation (`line.includes('[DECOMPOSED]')`). Parser recognizes marker, orchestrator yields `HumanCheckpointRequested` before execution. Zero wasted compute, clear intent.
[via: aggregation-1.md#L85-L96 ← research-2.md#L55-L134, research-2.md#L149-L175]
[via: aggregation-2.md#L52-L56 ← research-5.md#L82-L107]
[via: aggregation-4.md#L60-L66 ← research-12.md#L55-L105]

### P3: Wire `runVerifierChain()` Into the Orchestrator
**Confidence: HIGH (aggregation-3, all 3 source reports)**
The disconnected verifier chain is the critical integration gap. Resolution chain, registry, and chain runner all exist. Wiring them in replaces inline checks with a configurable, extensible verification pipeline. Deterministic gates (tsc + vitest + fileExists) serve as human-approval proxies.
[via: aggregation-3.md#L53-L66 ← research-7.md#L13-L20, research-8.md#L106-L112, research-9.md#L70-L75]

### P4: Reactive Gates Over Proactive Pauses for Automated Operations
**Confidence: HIGH (aggregation-2, all 3 source reports)**
Default behavior should be no pause on success, intervention only on failure. The cooldown dialog adds 12s × N tasks of dead time. The most successful ecosystem patterns (Signs & Gates, backpressure verification, dual exit gate) are all reactive.
[via: aggregation-2.md#L86-L92 ← research-4.md#L35-L50, research-5.md#L82-L107, research-6.md#L111-L115]

### P5: ReviewAfterExecuteConfig Is the Optimal Extension Point
**Confidence: HIGH (aggregation-4, 2 source reports)**
Fully implemented with `enabled: false` by default, sits between confidence threshold and atomic commit. Currently LLM-on-LLM only. Adding `mode: 'human'` is a minimal, backward-compatible change.
[via: aggregation-4.md#L73-L78 ← research-11.md#L131-L148, research-12.md#L68-L105]

### P6: Blocking Indefinitely Is the Core Anti-Pattern
**Confidence: HIGH (aggregation-2, all 3 source reports)**
The single most actionable fix: add a configurable timeout to `HumanCheckpointRequested`. Hook suspend policies in ralph-orchestrator already designed timeout-bounded alternatives (RetryBackoff, WaitThenRetry).
[via: aggregation-2.md#L80-L85 ← research-4.md#L77-L95, research-5.md#L52-L65, research-6.md#L84-L92]

### P7: File-Based State Persistence Is Non-Negotiable
**Confidence: HIGH (aggregation-2, 2 source reports)**
"Provide Guidance" creates volatile state not persisted to any file artifact. Guidance should write to knowledge.md; loop state should be serializable for crash recovery resume.
[via: aggregation-2.md#L94-L97 ← research-4.md#L63-L70, research-6.md#L93-L100]

### P8: Machine Verification Should Be Additive, Never Substitutive
**Confidence: HIGH (aggregation-4, 2 source reports)**
Human review is additive to machine verification, not a replacement. Machine verification is cheap, reliable, and should always run. "Human replaces machine" is an anti-pattern.
[via: aggregation-4.md#L82-L85 ← research-10.md#L95-L103, research-11.md#L120-L129]

### P9: Four Composable Checkpoint Approaches
**Confidence: MEDIUM-HIGH (aggregation-4, 1 source report with cross-validation)**

| Approach | Lines | Use Case | Blocking |
|----------|:-----:|----------|----------|
| A: Sentinel Verifier | ~15 | External gating (CI/CD) | Indirect (stagnation delay) |
| B: DSL `[CHECKPOINT]` | ~22 | Planned milestones | Immediate, deterministic |
| C: Agent Escalation | ~35 | Adaptive runtime situations | Immediate, fuzzy signal |
| D: Split PRD | 0 | Manual phasing | Manual between phases |

Approaches are complementary, not mutually exclusive.
[via: aggregation-4.md#L54-L66 ← research-12.md#L30-L170, research-12.md#L172-L188]

### P10: Confidence Score Needs Dimensional Decomposition
**Confidence: MEDIUM (aggregation-4, 2 source reports)**
The single summed confidence score masks dimensional gaps. Correlated checks (checkbox + progress_updated) provide redundant, not independent, verification. Only three truly independent signals exist today: checkbox state, diff existence, and progress mtime. Decomposing into structural/functional/semantic dimensions with independent thresholds would fix this.
[via: aggregation-4.md#L87-L92 ← research-10.md#L72-L80, research-10.md#L120-L128]

---

## Priority Matrix

| # | Item | Impact | Effort | Priority | Sources |
|---|------|--------|--------|----------|---------|
| 1 | Fix hardcoded vitest/tsc/no_errors confidence checks | **Critical** — 28% fabricated score | Very Low | **P0** | [via: aggregation-4.md#L25-L32 ← research-10.md#L23-L35] |
| 2 | Add timeout to `HumanCheckpointRequested` | **Critical** — unblocks unattended operation | Low | **P0** | [via: aggregation-2.md#L80-L85 ← research-4.md#L77-L95, research-6.md#L84-L92] |
| 3 | Implement DSL `[CHECKPOINT]` annotation | **High** — fills proactive checkpoint gap | Low (~22 LOC) | **P1** | [via: aggregation-1.md#L85-L96 ← research-2.md#L149-L175] [via: aggregation-4.md#L60-L66 ← research-12.md#L55-L105] |
| 4 | Wire `runVerifierChain()` into orchestrator | **Critical** — unlocks all verifier patterns | Medium | **P1** | [via: aggregation-3.md#L53-L66 ← research-7.md#L13-L20, research-9.md#L70-L75] |
| 5 | Fix guidance persistence bug (`promptBlocks` → `injectContext`) | **Medium** — prevents stale guidance pollution | Trivial (1 line) | **P1** | [via: aggregation-1.md#L110-L114 ← research-3.md#L163-L165, research-1.md#L162-L163] |
| 6 | Fix "Skip Task" semantics | **Medium** — Skip should actually skip | Low | **P1** | [via: aggregation-1.md#L116-L118 ← research-1.md#L60-L62, research-3.md#L167-L168] |
| 7 | Add BearingsFailed UI handler | **Medium** — silent pause with no dialog is a bug | Low | **P1** | [via: aggregation-1.md#L106-L108 ← research-1.md#L76-L79] |
| 8 | Default cooldown dialog to OFF / 0s | **High** — eliminates 4+ min dead time per run | Low | **P1** | [via: aggregation-2.md#L86-L92 ← research-4.md#L35-L50, research-6.md#L13-L19] |
| 9 | Fix sequential mode to respect `dependsOn` | **High** — prerequisite for dependency checkpoints | Small | **P1** | [via: aggregation-3.md#L72-L74 ← research-9.md#L31-L36] |
| 10 | Backpressure verification gate | **High** — prevents false completions | Low | **P2** | [via: aggregation-2.md#L68-L72 ← research-6.md#L57-L68] |
| 11 | Add `mode: 'human'` to ReviewAfterExecuteConfig | **High** — human review in existing pipeline | Low | **P2** | [via: aggregation-4.md#L73-L78 ← research-11.md#L131-L148] |
| 12 | Extend `autoClassifyTasks` rules | **High** — per-task verification without config | Small | **P2** | [via: aggregation-3.md#L78-L80 ← research-7.md#L41-L50] |
| 13 | Persist "Provide Guidance" to knowledge.md | **Medium** — fixes audit trail gap | Low | **P2** | [via: aggregation-2.md#L94-L97 ← research-4.md#L63-L70] |
| 14 | Headless/supervised mode toggle | **High** — replaces 40+ config fields | Medium | **P2** | [via: aggregation-2.md#L99-L101 ← research-4.md#L117-L145] |
| 15 | State checkpointing for crash recovery | **High** — enables resume after interruption | Medium-High | **P3** | [via: aggregation-2.md#L73-L76 ← research-6.md#L93-L100] |
| 16 | Add `compileVerificationStrings()` for spec frontmatter | **Medium** — pipeline-driven verifier config | Small | **P3** | [via: aggregation-3.md#L82-L84 ← research-7.md#L67-L80] |
| 17 | Decompose confidence score into dimensions | **Medium** — prevents signal masking | Medium | **P3** | [via: aggregation-4.md#L87-L92 ← research-10.md#L120-L128] |
| 18 | Add symlink-specific verifier | **Medium** — relational correctness gap | Very Low | **P3** | [via: aggregation-4.md#L49-L52 ← research-10.md#L110-L118] |

---

## Recommended Plan

### Phase 1: Critical Bugs & Unblocking (P0)
**Dependencies**: None
1. **Fix hardcoded confidence checks** — Wire existing vitest/tsc/no_errors verifiers into the confidence scoring path. Currently 28% of the score is fabricated.
2. **Add configurable timeout to HumanCheckpointRequested** — Default to auto-continue after timeout (e.g., 5 min). This unblocks unattended operation without removing the safety valve.

### Phase 2: Core Checkpoint Infrastructure (P1)
**Dependencies**: Phase 1 (timeout) enables safe checkpoint addition
3. **Implement `[CHECKPOINT]` DSL annotation** — Parser change (~22 LOC across types.ts, prd.ts, orchestrator.ts), following `[DECOMPOSED]` precedent. Yields `HumanCheckpointRequested` before checkpoint-annotated task.
4. **Wire `runVerifierChain()` into orchestrator exit gate** — Replace inline checkbox+diff checks with the configurable resolution+chain pipeline. Must include CI/headless auto-approve flag.
5. **Fix guidance persistence** — Change `updateConfig()` → `injectContext()` in `HumanCheckpointRequested` "Provide Guidance" handler (1 line).
6. **Fix "Skip Task"** — Mark task as skipped and advance to next, instead of calling `resume()` identically to "Continue."
7. **Add BearingsFailed UI handler** — Add VS Code dialog handler in extension.ts to surface the silent pause.
8. **Default cooldown dialog to OFF** — Change default config value.
9. **Fix sequential mode dependencies** — Add `dependsOn` check to `pickNextTask()`.

### Phase 3: Verification Enhancement (P2)
**Dependencies**: Phase 2 (verifier chain wired in)
10. **Implement backpressure verification gate** — Before accepting completion, require evidence (files modified, tests if test-related, progress updated).
11. **Add `mode: 'human'` to ReviewAfterExecuteConfig** — Extends existing slot between confidence scoring and atomic commit.
12. **Extend `autoClassifyTasks`** — Add keyword→verifier rules: file creation→fileExists, compilation→tsc, content→fileContains, script→commandExitCode.
13. **Persist guidance to knowledge.md** — Write to file before injecting into prompt.
14. **Implement headless/supervised mode toggle** — Three presets replacing 40+ boolean flags.

### Phase 4: Advanced Features (P3)
**Dependencies**: Phase 3 (verification pipeline stable)
15. **State checkpointing** — Serialize loop state for crash recovery.
16. **Spec frontmatter compilation** — `compileVerificationStrings()` to bridge spec metadata and runtime verifiers.
17. **Confidence score decomposition** — Split into structural/functional/semantic dimensions.
18. **Symlink verifier** — Close relational correctness gap.

---

## Gaps & Further Research

1. **No quantitative data on checkpoint frequency** — How often does `HumanCheckpointRequested` actually fire in real PRD runs? Stagnation tier 3 may be rare enough that indefinite blocking is mostly theoretical.

2. **No checkpoint UX richness analysis** — The current dialog is a simple 4-button warning. Effective human review needs diff display, test results, and confidence breakdown. No report examines available VS Code UI capabilities.

3. **No performance/latency benchmarks** — Wiring `runVerifierChain()` means running tsc/vitest on every exit gate check. No report measured verifier execution time or discussed caching/throttling.

4. **Parallel task × checkpoint race conditions** — If `pickReadyTasks()` runs multiple tasks and one hits a checkpoint, what happens to the others? Post-parallel-batch consistency checking remains unexamined.

5. **No cost-of-reactive quantification** — How many tokens are consumed between "agent gets stuck" and "human gets asked"? This data would strengthen the proactive checkpoint case.

6. **No competing tool UX comparison** — How do Cursor, Windsurf, Aider handle human checkpoints at the UX level?

7. **`decisions.ts` decision engine unexplored** — Could decision confidence inform checkpoint triggers (e.g., "decision confidence below threshold → checkpoint")?

8. **`hookBridge.ts` pre-complete chain as checkpoint surface** — Could hooks serve as lightweight checkpoint triggers beyond the pre-complete stage?

9. **Agent self-awareness limitation** — The prompt says "Do not ask questions — act," preventing agent-initiated clarification. Could a tool-based escape hatch (`request_review` tool) bridge this?

10. **`parseTaskId()` naming mismatch** — Dependencies resolve against bold text or slugified descriptions, not sequential IDs. This usability issue could make dependency annotations unreliable in practice.

11. **Auto-approve timeout semantics** — Should human review auto-approve or auto-reject after timeout? No analysis of tradeoffs.

12. **Phase visibility in agent context** — Should Phase 2 tasks be hidden from the agent during Phase 1? No analysis of LLM behavior when future tasks are visible.

---

## Source Chain

| Aggregation | Research Sources |
|-------------|-----------------|
| aggregation-1.md | research-1.md (behavioral audit), research-2.md (DSL design analysis), research-3.md (escalation chain + injection points) |
| aggregation-2.md | research-4.md (automation philosophy risk), research-5.md (split PRDs vs inline checkpoints), research-6.md (ecosystem checkpoint catalog) |
| aggregation-3.md | research-7.md (verifier pipeline), research-8.md (HITL patterns across 7 systems), research-9.md (dependency-driven checkpoints) |
| aggregation-4.md | research-10.md (verification overfitting), research-11.md (dual exit gate × human layer), research-12.md (implementation code changes) |

Full traceability: FINAL-REPORT → aggregation-{1..4}.md → research-{1..12}.md
