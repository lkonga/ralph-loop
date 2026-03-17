# Research Report 5: Wave Group & Master Aggregator Roles and Tiered Aggregation with Reference Chains

**Question**: What are the roles and report formats of wave-group-aggregator and wave-master-aggregator, and how do they implement tiered aggregation with `[source:]` and `[via:]` reference chains for progressive disclosure?

**Date**: 2026-03-18

---

## Findings

### Finding 1: Two-Tier Aggregation Architecture

The wave system uses a strict two-tier aggregation pipeline orchestrated by `wave-orchestrator.agent.md`:

1. **Tier 1 — Group Aggregation**: `wave-group-aggregator` consolidates groups of K research reports (default K=3, range 2-6) into `aggregation-{GROUP}.md` files. With N research reports, this produces ceil(N/K) aggregation files.

2. **Tier 2 — Master Aggregation**: `wave-master-aggregator` reads ONLY aggregation files (never raw research) and produces a single `FINAL-REPORT.md`.

The orchestrator dispatches them sequentially: all group aggregators run in ONE PARALLEL BATCH, then after all return, a single master aggregator runs. The full reduction chain is: `N researchers → ceil(N/K) group aggregators → 1 master aggregator`.

The orchestrator prints the plan upfront: `Aggregate plan: {N} researchers → {ceil(N/K)} aggregators (groups of {K}) → 1 master = {total} agents` (wave-orchestrator.agent.md, Step 2).

### Finding 2: Wave-Group-Aggregator Role and Report Format

**Role**: Read K assigned research reports and merge them into a single consolidated aggregation, removing duplication and resolving contradictions.

**Report format** (written to `research/_wave/{WAVE_ID}/aggregation-{GROUP}.md`):

| Section | Purpose |
|---------|---------|
| **Source Reports** | Key findings summary from each input research file |
| **Deduplicated Findings** | Merged findings with overlaps removed and contradictions resolved |
| **Cross-Report Patterns** | Patterns appearing in 2+ reports — flagged as high confidence |
| **Priority Matrix** | Pattern × Impact × Effort table with source references including line ranges |
| **Gaps** | What the input reports missed |
| **Sources** | List of ALL consumed research files with topic labels |

**Critical rule**: Every finding MUST include a `[source: research-{I}.md#L{start}-L{end}]` reference pointing back to the exact line range in the original research report.

### Finding 3: Wave-Master-Aggregator Role and Report Format

**Role**: Read ONLY aggregation reports — explicitly prohibited from reading raw research files. Source references are already embedded in the aggregation reports, so the master aggregator preserves and extends the chain.

**Report format** (written to `research/_wave/{WAVE_ID}/FINAL-REPORT.md`):

| Section | Purpose |
|---------|---------|
| **Executive Summary** | ≤20 lines overview |
| **Consolidated Findings** | By category, deduplicated across all aggregation reports |
| **Pattern Catalog** | Implementation details with source references |
| **Priority Matrix** | Impact × Effort × Priority × Sources table with line refs |
| **Recommended Plan** | Ordered implementation plan with dependencies |
| **Gaps & Further Research** | Unresolved questions and missing analysis |
| **Source Chain** | Full traceability: aggregation-{1..ceil(N/K)}.md → research-{1..N}.md |

### Finding 4: `[source:]` Reference Chains — Group Aggregator Tier

The group aggregator annotates every finding with `[source: research-{I}.md#L{start}-L{end}]`. In practice (verified in `2026-03-17-ralph-checkpoint-patterns/aggregation-1.md`), findings that appear across multiple research reports get multiple source references:

```
[source: research-1.md#L13-L35] [source: research-2.md#L35-L42] [source: research-3.md#L18-L32]
```

The line ranges point to specific sections within research files, enabling drill-down to the exact evidence.

### Finding 5: `[via:]` Reference Chains — Master Aggregator Tier

The master aggregator transforms `[source:]` references into `[via:]` chains that preserve the full provenance path:

```
[via: aggregation-1.md#L25-L35 ← research-1.md#L13-L35, research-2.md#L35-L42, research-3.md#L18-L32]
```

The `←` arrow notation creates a breadcrumb trail: `FINAL-REPORT → aggregation → research`. Multiple aggregation sources for the same finding get separate `[via:]` lines:

```
[via: aggregation-1.md#L97-L100 ← research-1.md#L84-L91, research-2.md#L35-L42, research-3.md#L116-L123]
[via: aggregation-2.md#L80-L85 ← research-4.md#L77-L95, research-5.md#L52-L65, research-6.md#L84-L92]
```

This notation encodes that two independent aggregation groups arrived at the same finding — a cross-group convergence signal.

### Finding 6: Progressive Disclosure Navigation Model

The reference chain system implements a three-level progressive disclosure hierarchy:

| Level | Document | Detail | Reader Action |
|-------|----------|--------|---------------|
| **L0** | FINAL-REPORT.md | Executive summary, pattern catalog, priority matrix | Start here |
| **L1** | aggregation-{G}.md | Group-level deduplication, cross-report patterns | Follow `[via: aggregation-{G}.md#L...]` |
| **L2** | research-{I}.md | Raw findings, code analysis, full evidence | Follow `← research-{I}.md#L...]` |

The master aggregator's rules explicitly state: "The final report must enable progressive disclosure: reader drills from FINAL-REPORT → aggregation → research."

### Finding 7: Deprecated wave-aggregate Agent

A monolithic `wave-aggregate.agent.md` previously handled all aggregation in a single agent. It is explicitly marked as DEPRECATED with the note: "The orchestrator now dispatches wave-group-aggregator and wave-master-aggregator directly (flat dispatch, no nesting)." This change moved from nested dispatch to flat dispatch for better parallelism and cleaner separation of concerns.

### Finding 8: Source Chain Section in FINAL-REPORT

The FINAL-REPORT includes a dedicated **Source Chain** section that maps the full traceability graph as a table:

```
| Aggregation | Research Sources |
|-------------|-----------------|
| aggregation-1.md | research-1.md (topic), research-2.md (topic), research-3.md (topic) |
| aggregation-2.md | research-4.md (topic), research-5.md (topic), research-6.md (topic) |
```

Followed by a summary line: `Full traceability: FINAL-REPORT → aggregation-{1..G}.md → research-{1..N}.md`

### Finding 9: Confidence Signaling Through Cross-Source Convergence

The system uses source count as a confidence heuristic. In the group aggregator, cross-report patterns (appearing in 2+ reports) get "highest confidence." In the FINAL-REPORT pattern catalog, each pattern includes an explicit confidence label derived from how many aggregation reports independently surface it:

- `**Confidence: VERY HIGH (4/4 aggregation reports)**` — all groups converge
- `**Confidence: HIGH (3/4 aggregation reports)**` — strong convergence
- `**Confidence: MEDIUM-HIGH (1 report with cross-validation)**` — single source but corroborated

### Finding 10: Practical Scale in Real Waves

Examining actual wave runs in `research/_wave/`:
- **2026-03-17-ralph-checkpoint-patterns**: 12 research → 4 aggregation (K=3) → 1 FINAL-REPORT (262 lines)
- **2026-03-15-vscode-agent-architecture**: 3 aggregation files (A, B, C) — used letter-based grouping
- **2026-03-16-ralph-loop-readme**: 4 aggregation files (1-4) — used numeric grouping
- **2026-03-17-ralph-parallel-sequential**: present in the directory

The naming convention evolved from letter-based (A, B, C) to numeric (1, 2, 3) between earlier and later waves.

---

## Patterns

### Pattern 1: Information Funnel with Provenance Preservation

Each tier reduces volume while adding structure. Raw research (detailed, potentially overlapping) → group aggregation (deduplicated, cross-referenced) → final report (prioritized, actionable). The key innovation is that provenance is never lost — every claim in the final report can be traced back to exact source lines.

### Pattern 2: Strict Information Barrier Between Tiers

The master aggregator is explicitly prohibited from reading raw research files. This constraint forces all information to flow through the aggregation tier, guaranteeing that the aggregation layer actually performs its deduplication/synthesis role rather than being bypassed.

### Pattern 3: Parallel-Then-Sequential Reduction

All agents within a tier run in parallel (group aggregators run simultaneously), but tiers are strictly sequential (master waits for all group aggregators). This is a classic MapReduce pattern applied to LLM research synthesis.

### Pattern 4: Reference Chain as Quality Signal

The density and breadth of `[via:]` chains serves as an implicit quality metric. A finding with `[via: aggregation-1.md ← research-1.md, research-2.md, research-3.md] [via: aggregation-2.md ← research-4.md, research-5.md]` has been independently validated by 5 research agents across 2 aggregation groups — far more reliable than a single-source finding.

### Pattern 5: Flat Dispatch Over Nested Dispatch

The deprecation of `wave-aggregate` in favor of separate group/master aggregators reflects a design preference for flat dispatch (orchestrator dispatches all agents directly) over nested dispatch (orchestrator dispatches one aggregator that internally dispatches sub-aggregators). Flat dispatch enables parallel group aggregation and simpler error handling.

---

## Applicability

### For Ralph-Loop PRD System

1. **Reference chains are directly reusable** for any multi-agent research pipeline. The `[source:]` / `[via:]` convention is not tied to the wave system — it can be applied anywhere research needs traced back to evidence.

2. **The two-tier aggregation pattern scales predictably**: with K=3, a 12-researcher wave produces 4+1=5 aggregation agents. A 30-researcher wave would produce 10+1=11. The overhead is sub-linear.

3. **The information barrier (master can't read research directly)** is a crucial design decision for progressive disclosure: it guarantees the aggregation layer is not a pass-through but a genuine synthesis step.

4. **Confidence scoring via convergence count** (number of independent sources) is a lightweight alternative to formal consensus mechanisms.

### For Documentation Systems

5. **The three-level progressive disclosure hierarchy** (summary → synthesis → evidence) maps naturally to any documentation system where readers need different levels of detail.

6. **Line-range references** (`#L{start}-L{end}`) make the system work with file-based documents without requiring a database or link management system.

---

## Open Questions

1. **How are line ranges maintained when files are edited?** If `research-1.md` is modified after `aggregation-1.md` is written, the `[source: research-1.md#L13-L35]` references become stale. Is this handled or accepted as a snapshot-in-time guarantee?

2. **What happens when group aggregators produce contradictory findings?** The group aggregator is told to "resolve contradictions" within its group, but cross-group contradictions would only be detectable by the master aggregator. Are master-level contradiction resolution rules defined?

3. **Why was the default K changed to 3?** The orchestrator allows K=2 to K=6. What drove the default of 3 — token limits, quality experiments, or practical observation?

4. **Is there tooling to validate reference chain integrity?** Given the line-range references, an automated checker could verify that `[source: research-1.md#L13-L35]` actually contains the claimed content. No such tool was found in the workspace.

5. **How does the system handle research reports of wildly different quality?** A low-quality research report could poison an aggregation group. Are there quality gates between the research and aggregation tiers?

6. **Could the naming convention standardization (letters vs numbers) cause issues?** Older waves use A/B/C, newer use 1/2/3. If tooling expects one convention, the other breaks.
