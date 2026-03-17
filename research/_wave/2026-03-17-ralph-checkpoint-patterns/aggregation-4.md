# Aggregation Report 4

## Source Reports

### research-10.md — Risk of Overfitting Verification Checks
Analyzes ralph's 6-layer verification architecture and identifies critical gaps: vitest/tsc/no_errors confidence checks are **hardcoded to Pass** (50/180 points always awarded), existence-based checks miss relational correctness (symlink problem), and correlated checks inflate confidence without improving verification quality. Recommends fixing hardcoded checks, task-category-based human checkpoints, a symlink-specific verifier, and decomposing confidence into structural/functional/semantic dimensions. [source: research-10.md#L1-L5]

### research-11.md — Dual Exit Gate × Human Checkpoint Layer Interaction
Maps the complete post-gate pipeline (7-stage veto chain after dual exit gate), identifies that human checkpoints are currently **reactive-only** (triggered by stagnation/diff exhaustion, never on happy path), and evaluates three integration approaches. Concludes that **sequential gates** (dual gate → human review) via the existing `ReviewAfterExecuteConfig` slot is the best architectural fit. Triple gate and human-replaces-machine approaches are rejected. [source: research-11.md#L1-L10]

### research-12.md — Checkpoint Approach Code Changes Analysis
Provides detailed implementation specs for four checkpoint approaches with exact file changes, line counts, and risk assessments. DSL checkpoint annotation (Approach B, ~22 lines) fills the proactive checkpoint gap most cleanly. Sentinel verifier (A), agent escalation (C), and split PRD (D) are complementary strategies for different use cases. [source: research-12.md#L1-L12]

---

## Deduplicated Findings

### 1. Hardcoded Confidence Checks Are the Most Critical Gap

All three reports reference the hardcoded `VerifyResult.Pass` for vitest, tsc, and no_errors in orchestrator.ts ~L898-900. This means 50/180 confidence points (28%) are always awarded, making the confidence score structurally unable to reflect broken builds or failing tests. The builtin registry already has working verifiers — they're just not wired into the confidence scoring path. [source: research-10.md#L23-L35]

### 2. Dual Exit Gate Is Strict AND Gate with 7-Stage Post-Pipeline

The dual exit gate requires `modelSignal ∧ machineVerification`. After passing, a sequential veto chain runs: consistency check → diff validation (with retry loop) → confidence scoring → preComplete hooks → taskComplete hook → reviewAfterExecute → atomic commit. Each stage can reject and loop back. The gate hierarchy provides multiple veto points but all are currently automated — no proactive human checkpoint exists on the happy path. [source: research-11.md#L13-L50] [source: research-11.md#L83-L99]

### 3. Human Checkpoint Is Reactive, Never Proactive

`HumanCheckpointRequested` fires only on failure escalation: stagnation tier-3 (≥ maxStaleIterations + 2) or diff validation exhaustion. There is no mechanism for "always require human approval for task X" or "pause at this milestone." This is the central gap all three reports converge on. [source: research-11.md#L55-L70] [source: research-10.md#L64-L70] [source: research-12.md#L143-L147]

### 4. Existence ≠ Correctness — Relational Verification Gap

File existence checks (`fs.existsSync`) pass for broken symlinks. Individual component checks pass but relationships between them can be wrong (symlink target path, cross-repo config references, correct code in wrong file location). No verifier currently validates relational correctness. [source: research-10.md#L37-L55]

### 5. ReviewAfterExecute Is the Natural Insertion Point for Human Review

`ReviewAfterExecuteConfig` is fully implemented (not just typed) with `enabled: false` by default. It sits after confidence threshold, before atomic commit. Currently LLM-on-LLM only (`'same-session' | 'new-session'`). Extending `mode` to include `'human'` would be a minimal, backward-compatible change that slots into the existing orchestrator flow. [source: research-11.md#L72-L80] [source: research-11.md#L139-L148]

### 6. Four Checkpoint Approaches with Composable Architecture

| Approach | Lines Changed | Complexity | Key Files | Blocking Behavior |
|----------|:------------:|:----------:|-----------|-------------------|
| A: Sentinel Verifier | ~15 | Very Low | verify.ts | Indirect (stagnation delay) |
| B: DSL `[CHECKPOINT]` | ~22 | Low | types.ts, prd.ts, orchestrator.ts | Immediate, deterministic |
| C: Agent Escalation | ~35 | Medium | types.ts, orchestrator.ts, strategies.ts | Immediate, fuzzy signal |
| D: Split PRD | 0 | Zero | (none) | Manual between phases |

Approaches A, B, C are complementary, not mutually exclusive. B handles planned milestones, A handles external gating (CI/CD), C handles adaptive runtime situations. [source: research-12.md#L30-L170] [source: research-12.md#L172-L188]

### 7. `[DECOMPOSED]` Annotation Provides Implementation Precedent

PRD parser already handles inline annotations via simple string matching (`line.includes('[DECOMPOSED]')`). This establishes the exact pattern needed for `[CHECKPOINT]` parsing — same mechanism, different behavioral outcome. [source: research-12.md#L190-L197]

### 8. Correlated Checks Create False Confidence

Multiple checks measuring the same underlying signal (checkbox + progress_updated both measure "tracking file updated") provide redundant rather than independent verification. Adding more checks of the same type is overfitting — optimizing the metric without improving the outcome. Only three truly independent signals exist today: checkbox state, diff existence, and progress mtime. [source: research-10.md#L72-L80]

---

## Cross-Report Patterns

### Pattern A: Proactive Human Checkpoint Is the Central Missing Capability (3/3 reports)
All three reports independently identify the same architectural gap: human checkpoints are reactive (failure-triggered), never proactive (milestone-triggered). Research-10 frames it as "when second-layer barriers make sense," research-11 maps it to the gate hierarchy, research-12 provides four concrete implementation paths. **High confidence** — this is the convergence point. [source: research-10.md#L85-L95] [source: research-11.md#L101-L105] [source: research-12.md#L143-L147]

### Pattern B: ReviewAfterExecuteConfig Is the Optimal Extension Point (2/3 reports)
Research-11 and research-12 both identify `ReviewAfterExecuteConfig` as the natural insertion point. Research-11 recommends adding `mode: 'human'` to the existing config. Research-12's Approach B (DSL checkpoint) achieves a similar outcome by yielding `HumanCheckpointRequested` directly after checkpoint-annotated task completion. Both converge on: human review should sit between confidence scoring and atomic commit. [source: research-11.md#L131-L148] [source: research-12.md#L68-L105]

### Pattern C: Machine Verification Should Be Additive, Never Substitutive (2/3 reports)
Research-10 argues second-layer checks should not replace first-layer when the first already validates the requirement. Research-11 explicitly rejects "human replaces machine" (Option C) as an anti-pattern — machine verification is cheap, reliable, and should always run. Human review is additive. [source: research-10.md#L95-L103] [source: research-11.md#L120-L129]

### Pattern D: Confidence Score Needs Dimensional Decomposition (2/3 reports)
Research-10 proposes splitting into structural/functional/semantic dimensions with independent thresholds. Research-12's approach comparison implicitly validates this: sentinel verifiers add structural confidence, DSL checkpoints add operational confidence, agent escalation adds semantic confidence. A single summed score masks dimensional gaps. [source: research-10.md#L120-L128] [source: research-12.md#L200-L210]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Fix hardcoded vitest/tsc/no_errors confidence checks | **Critical** — 28% of confidence score is fabricated | Very Low — wire existing verifiers into scoring path | [research-10.md#L23-L35](research-10.md#L23-L35) |
| Implement DSL `[CHECKPOINT]` annotation (Approach B) | **High** — fills the proactive checkpoint gap | Low — ~22 lines across 3 files, follows `[DECOMPOSED]` precedent | [research-12.md#L55-L105](research-12.md#L55-L105), [research-11.md#L101-L105](research-11.md#L101-L105) |
| Add `mode: 'human'` to ReviewAfterExecuteConfig | **High** — enables human review in existing pipeline slot | Low — minimal, backward-compatible type extension | [research-11.md#L131-L148](research-11.md#L131-L148) |
| Add symlink-specific verifier (`symlinkTarget`) | **Medium** — closes relational correctness gap | Very Low — ~15 lines in verify.ts | [research-10.md#L110-L118](research-10.md#L110-L118) |
| Implement sentinel verifier (Approach A) | **Medium** — enables external system gating | Very Low — ~15 lines in verify.ts | [research-12.md#L30-L53](research-12.md#L30-L53) |
| Decompose confidence score into dimensions | **Medium** — prevents structural signal masking functional gaps | Medium — requires threshold logic restructuring | [research-10.md#L120-L128](research-10.md#L120-L128) |
| Agent-initiated escalation (Approach C) | **Medium** — adaptive checkpointing | Medium — fuzzy signal detection, ~35 lines + strategy changes | [research-12.md#L107-L142](research-12.md#L107-L142) |
| Task-category-based checkpoint triggers | **Low-Medium** — proactive gating for destructive ops | Medium — requires task classification heuristics | [research-10.md#L100-L112](research-10.md#L100-L112) |

---

## Gaps

1. **No analysis of checkpoint UX richness**: Research-11 notes the current dialog is a simple 4-button warning. Effective human review needs diff display, test results, and confidence breakdown — but no report investigates what VS Code UI capabilities are available for this.

2. **No performance/latency benchmarks**: Adding human checkpoints, real vitest/tsc runs, and additional verifiers will increase loop iteration time. No report quantifies the current iteration time or projects the impact.

3. **Parallel task race conditions**: Research-10 raises this as an open question (conflicting changes from parallel tasks), but neither research-11 nor research-12 addresses it in their checkpoint designs. Post-parallel-batch consistency checking remains unexamined.

4. **Auto-approve timeout behavior**: Research-11 raises whether human review should auto-approve or auto-reject after timeout. No report explores the tradeoffs or proposes a default.

5. **Signal detection for Approach C (agent escalation)**: Research-12 lists options (structured marker, progress file entry, exit code) but doesn't recommend one or analyze false-positive rates. The strategies.ts changes are sketched but not fully specified.

6. **Pre-execution vs. post-execution checkpoint semantics**: Research-12 raises `[CHECKPOINT:pre]` as an alternative but doesn't analyze when pre-execution pause is preferable to post-execution pause.

---

## Sources

- **research-10.md** — Risk of Overfitting Verification Checks / When Second-Layer Barriers Make Sense
- **research-11.md** — Dual Exit Gate × Human Checkpoint Layer Interaction
- **research-12.md** — Checkpoint Approach Code Changes Analysis
