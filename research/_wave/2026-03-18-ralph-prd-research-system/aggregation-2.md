# Aggregation Report 2

## Source Reports

### research-4.md — Wave-Researcher ↔ Wave-Research Dispatch Engine
- Two distinct agents: `wave-research` (dispatch engine) and `wave-researcher` (worker), connected by a textual report-structure contract with 4 mandatory sections (Findings, Patterns, Applicability, Open Questions) [source: research-4.md#L1-L12]
- Dual-channel output: researcher writes `research-{I}.md` file AND returns ≤10-line summary to the dispatcher for in-context aggregation [source: research-4.md#L48-L56]
- Single-batch parallel dispatch enforced purely through repeated prompt directives (caps, bold, warnings) at three levels — no programmatic validation exists [source: research-4.md#L58-L72]
- Orchestrator subsumes dispatch engine logic: `wave-orchestrator` dispatches `wave-researcher` directly, bypassing `wave-research`; the standalone dispatcher may be a legacy artifact [source: research-4.md#L86-L92]

### research-5.md — Group & Master Aggregation with Reference Chains
- Two-tier aggregation: group aggregators consolidate K=3 research reports into `aggregation-{G}.md`, then master aggregator reads ONLY aggregation files to produce `FINAL-REPORT.md` [source: research-5.md#L13-L25]
- `[source: research-{I}.md#L{start}-L{end}]` references at group tier; `[via: aggregation-{G}.md#L... ← research-{I}.md#L...]` chains at master tier preserve full provenance [source: research-5.md#L67-L90]
- Strict information barrier: master aggregator is prohibited from reading raw research files, forcing genuine synthesis at the aggregation layer [source: research-5.md#L45-L48]
- Three-level progressive disclosure (FINAL-REPORT → aggregation → research) with confidence scoring via cross-source convergence count [source: research-5.md#L92-L113]
- Deprecated monolithic `wave-aggregate` replaced by flat dispatch of separate group/master aggregators for parallelism [source: research-5.md#L115-L120]

### research-6.md — Wave-Spec-Generator Transformation
- Receives exactly two inputs: `FINAL-REPORT.md` + `context-brief.md` (from wave-context-grounder); transforms research findings into implementable task specifications [source: research-6.md#L16-L26]
- Auto-numbering via fallback chain: ContextBrief cache → PRD.md scan → research/ directory listing for phase, task, and file numbers [source: research-6.md#L28-L43]
- 4-stage transformation pipeline: Filter (drop low-impact/covered) → Order (dependency-aware) → Group (3-4 tasks per sub-phase) → Specify (full task spec blocks) [source: research-6.md#L45-L66]
- Output is deliberately unsealed (no YAML frontmatter); sealing deferred to Phase 3 after user review at Checkpoint 2 [source: research-6.md#L68-L78]
- Line Range Index in output enables `→ Spec: path LN-LN` references in PRD entries, powering `extractSpecReference()` at runtime [source: research-6.md#L80-L86]

---

## Deduplicated Findings

### F1: End-to-End Pipeline Architecture (Research → Aggregation → Spec)
The wave system implements a full MapReduce-style pipeline: N researchers fan out in parallel producing `research-{I}.md` files → ceil(N/K) group aggregators reduce in parallel to `aggregation-{G}.md` → 1 master aggregator synthesizes `FINAL-REPORT.md` → wave-spec-generator transforms into task specifications. Each stage has a defined input/output contract and strict information flow direction.
[source: research-4.md#L10-L18] [source: research-5.md#L13-L25] [source: research-6.md#L16-L26]

### F2: Provenance Traceability Across All Tiers
Traceability is maintained through three complementary mechanisms:
- **Research tier**: `file:line` references in findings sections [source: research-4.md#L29-L35]
- **Group aggregation tier**: `[source: research-{I}.md#L{start}-L{end}]` annotations on every finding [source: research-5.md#L67-L78]
- **Master tier**: `[via: aggregation-{G}.md#L... ← research-{I}.md#L...]` chains recording full provenance path [source: research-5.md#L80-L90]
- **Spec tier**: Line Range Index mapping task numbers to line ranges, enabling `→ Spec: path LN-LN` back-references in PRD entries [source: research-6.md#L80-L86]

This creates an unbroken chain: `PRD entry → spec file → FINAL-REPORT → aggregation → research → source code`.

### F3: Prompt-Based Contract Enforcement
All inter-agent contracts are enforced through textual prompts, not schema validation or programmatic checks:
- Report structure (4 mandatory sections) enforced by template in dispatcher prompt [source: research-4.md#L20-L46]
- Single-batch parallelism enforced by repeated emphatic directives [source: research-4.md#L58-L72]
- Aggregation format and `[source:]` rules enforced by group-aggregator agent definition [source: research-5.md#L27-L50]
- Master information barrier (no raw research access) enforced by agent prompt [source: research-5.md#L45-L48]
- Spec constraints (contiguous numbering, test-first) enforced by spec-generator prompt [source: research-6.md#L80-L86]

### F4: Deliberate Information Barriers Between Tiers
The system uses intentional barriers to force genuine synthesis:
- Master aggregator explicitly prohibited from reading raw research files — must work from aggregation summaries only [source: research-5.md#L45-L48]
- Spec generator receives only FINAL-REPORT + ContextBrief, not raw research or aggregation files [source: research-6.md#L16-L26]
- Researchers sandboxed to `research/_wave/` writes, cannot modify source code [source: research-4.md#L74-L80]

### F5: Parallel-Then-Sequential Execution Model
Each tier runs its agents in a single parallel batch, but tiers execute sequentially:
- All N researchers dispatched in ONE batch [source: research-4.md#L58-L72]
- All ceil(N/K) group aggregators dispatched in ONE batch after researchers complete [source: research-5.md#L13-L25]
- Single master aggregator runs after all group aggregators complete [source: research-5.md#L13-L25]
- Single spec generator runs after FINAL-REPORT is produced [source: research-6.md#L16-L26]

### F6: Dual-Channel & Multi-Format Output
Agents produce outputs in multiple formats serving different consumers:
- Researchers: file (persistent for aggregation) + ≤10-line return summary (for dispatcher context) [source: research-4.md#L48-L56]
- Spec generator: unsealed raw markdown (for human review) → sealed with frontmatter (for machine consumption) in a separate phase [source: research-6.md#L68-L78]
- FINAL-REPORT: executive summary (quick read) + full findings (deep dive) + source chain (audit) [source: research-5.md#L45-L65]

### F7: Auto-Numbering With Fallback Chain
The spec generator uses a prioritized detection strategy for determining next phase/task/file numbers: ContextBrief cache (from wave-context-grounder) → PRD.md header/task pattern scanning → research/ directory listing. This avoids redundant scanning when upstream agents have already computed the values.
[source: research-6.md#L28-L43]

### F8: Unsealed→Sealed Pipeline Split
Spec generation deliberately produces raw markdown without YAML frontmatter. Sealing is deferred to Phase 3 (after Checkpoint 2 user review) following the `Research → Spec (raw) → User refines → Seal → PRD entries` pipeline. This ensures users can modify specs before they become "executable."
[source: research-6.md#L68-L78] [source: research-6.md#L88-L96]

### F9: Confidence Scoring via Cross-Source Convergence
Source count serves as a lightweight confidence heuristic: findings appearing in 2+ research reports within a group get "highest confidence"; findings appearing across multiple aggregation groups in the FINAL-REPORT get escalating confidence labels (MEDIUM-HIGH → HIGH → VERY HIGH).
[source: research-5.md#L122-L133]

### F10: Subsumption of Dispatch Engine by Orchestrator
The orchestrator embeds dispatch logic inline and dispatches researchers directly, making `wave-research` (the standalone dispatch engine) redundant for the full pipeline. Similarly, the deprecated monolithic `wave-aggregate` was replaced by separate group/master aggregators under direct orchestrator dispatch.
[source: research-4.md#L86-L92] [source: research-5.md#L115-L120]

---

## Cross-Report Patterns

### CP1: Contract-by-Prompt Across All Tiers (3/3 reports)
Every inter-agent boundary relies on textual contracts in agent prompts rather than programmatic enforcement. This is consistent across researchers (report structure), aggregators (reference format), and spec generator (numbering/format rules). The pattern is pragmatic for LLM agents but creates a fragility risk — contract drift shows up as subtle quality degradation rather than hard errors.
[source: research-4.md#L94-L100] [source: research-5.md#L27-L50] [source: research-6.md#L80-L86]

### CP2: Provenance Never Lost — Full Chain from PRD to Source Code (3/3 reports)
Each tier adds its own traceability mechanism, and these compose into an unbroken reference chain. This is a deliberate design choice appearing in all three reports: researchers cite `file:line`, aggregators add `[source:]` with line ranges, master adds `[via:]` with arrow notation, and spec generator adds Line Range Index. The chain enables progressive disclosure navigation at any level.
[source: research-4.md#L29-L35] [source: research-5.md#L67-L90] [source: research-6.md#L80-L86]

### CP3: Information Isolation as Quality Forcing Function (2/3 reports)
Both the aggregation tier (master can't read research) and spec tier (generator receives only FINAL-REPORT + ContextBrief) enforce information barriers. This prevents bypass of synthesis steps and ensures each tier genuinely adds value rather than acting as a pass-through. The pattern trades potential information loss for guaranteed synthesis quality.
[source: research-5.md#L45-L48] [source: research-6.md#L16-L26]

### CP4: Flat Dispatch Over Nested Dispatch (2/3 reports)
Both the orchestrator's subsumption of `wave-research` and the deprecation of monolithic `wave-aggregate` reflect a consistent architectural preference for flat dispatch (orchestrator controls all agents directly) over nested dispatch (intermediary agents spawn sub-agents). This simplifies error handling and enables better parallelism.
[source: research-4.md#L86-L92] [source: research-5.md#L115-L120]

### CP5: Parallel Batch Execution Within Sequential Phases (2/3 reports)
The system consistently uses single-batch parallel dispatch within tiers (all researchers at once, all group aggregators at once) with sequential tier boundaries. This MapReduce pattern appears in both the research and aggregation stages and is enforced through emphatic prompt directives.
[source: research-4.md#L58-L72] [source: research-5.md#L13-L25]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| CP2: Full provenance chain (PRD→source) | **Critical** — enables audit, debugging, progressive disclosure | Already implemented across tiers | [research-4.md#L29-L35](research-4.md#L29-L35), [research-5.md#L67-L90](research-5.md#L67-L90), [research-6.md#L80-L86](research-6.md#L80-L86) |
| CP1: Contract-by-prompt enforcement | **High** — single biggest fragility risk | Medium (schema validation would add robustness) | [research-4.md#L94-L100](research-4.md#L94-L100), [research-5.md#L27-L50](research-5.md#L27-L50), [research-6.md#L80-L86](research-6.md#L80-L86) |
| CP3: Information barriers between tiers | **High** — guarantees synthesis quality | Low (already enforced via prompts) | [research-5.md#L45-L48](research-5.md#L45-L48), [research-6.md#L16-L26](research-6.md#L16-L26) |
| F8: Unsealed→sealed pipeline split | **High** — enables user checkpoint review | Already implemented | [research-6.md#L68-L78](research-6.md#L68-L78) |
| CP4: Flat dispatch architecture | **Medium** — simplifies orchestration | Already implemented (legacy deprecated) | [research-4.md#L86-L92](research-4.md#L86-L92), [research-5.md#L115-L120](research-5.md#L115-L120) |
| F9: Confidence via convergence count | **Medium** — lightweight quality signal | Low (already in aggregator prompts) | [research-5.md#L122-L133](research-5.md#L122-L133) |
| F7: Auto-numbering fallback chain | **Medium** — prevents numbering collisions | Low (grounding + scanning) | [research-6.md#L28-L43](research-6.md#L28-L43) |

---

## Gaps

1. **Error handling and partial failure recovery**: Research-4 raises partial researcher failure but no report addresses how the system recovers when aggregators or the spec generator fail mid-pipeline. The entire pipeline assumes all agents succeed.

2. **Reference chain validation tooling**: Research-5 asks whether automated reference integrity checking exists (none found). No report identifies any mechanism to detect stale `[source:]` or `[via:]` references after file edits.

3. **Quality gates between tiers**: Research-5 notes that low-quality research could poison aggregation groups. No quality-gating mechanism between tiers is documented in any report.

4. **Spec generator interaction with user at Checkpoint 2**: Research-6 describes the unsealed→sealed split but doesn't detail what happens during the user's review — can they add/delete/reorder tasks? How is re-numbering handled after edits?

5. **Scale limits**: None of the reports test or estimate the maximum practical scale (N researchers) before context window limits, file system latency, or aggregation quality degrades.

6. **wave-research standalone use case**: Research-4 notes the dispatch engine may be a legacy artifact. No report confirms whether any active workflow uses `wave-research` outside the orchestrator pipeline.

---

## Sources

- research-4.md — Wave-Researcher ↔ Wave-Research Dispatch Engine Interaction
- research-5.md — Wave Group & Master Aggregator Roles and Tiered Aggregation with Reference Chains
- research-6.md — Wave-Spec-Generator Transformation & Auto-Numbering Logic
