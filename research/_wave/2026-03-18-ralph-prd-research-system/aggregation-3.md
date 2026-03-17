## Aggregation Report 3

### Source Reports

**research-7.md — wave-prd-generator Tier Classification & Output Format**
- Two-tier task classification: Tier 1 (inline, ≤3 sentences, single surgical change) vs Tier 2 (spec-backed, deliberately terse one-liner with `→ Spec: path L{start}-L{end}` pointer) [source: research-7.md#L1-L11]
- Line-range indexing scans `### Task NN` headers to build `L{start}-L{end}` references for downstream agents [source: research-7.md#L31-L37]
- Auto-numbering detects `max(Task NN) + 1` from existing PRD.md via regex [source: research-7.md#L39-L41]
- Output format is a phase section block with spec/research paths, TDD mandate, and checkbox task entries [source: research-7.md#L43-L60]
- Human-in-the-loop gate: output presented as fenced block with [Apply]/[Refine]/[Back]/[Stop]; never auto-writes PRD.md [source: research-7.md#L62-L63]

**research-8.md — wave-context-grounder ContextBrief & 3-Zone Commit-Sampling**
- ContextBrief is a ≤30-line, ≤2K-token structured markdown produced as Phase 0, before any research dispatch [source: research-8.md#L5-L7]
- Contains: Project/Stack/Structure, Completed, In Progress, Numbering, Codebase Fingerprint, Conventions, Do NOT Research [source: research-8.md#L9-L19]
- 3-zone git commit-sampling (first 10, middle 10, last 10 commits) captures project arc without full history read [source: research-8.md#L23-L41]
- Triple-layer duplicate prevention: explicit "Do NOT Research" blocklist, "Completed" section, and prompt injection into all downstream agents [source: research-8.md#L47-L57]
- Configurable source chain: composable `(workspace) → ContextSnippet` functions with priority-ordered trimming [source: research-8.md#L59-L63]

**research-9.md — Wave Prompt Files as Entry/Exit Points**
- `wave-explore-fast.prompt.md` is the thin entry point — `agent:` frontmatter routes to wave-orchestrator, zero logic in body [source: research-9.md#L11-L18]
- `wave-return-to-agent.prompt.md` is the exit point — mode-switching prompt that returns to default Agent mode [source: research-9.md#L20-L25]
- `wave-parallel-lock.prompt.md` is a documentation-only prompt (no frontmatter) describing a lock protocol for parallel file editing [source: research-9.md#L27-L33]
- 3-tier architecture: Entry prompt → Orchestrator agent → Exit prompt, with orchestrator declaring subagents, handoffs, and hooks [source: research-9.md#L35-L44]
- `argument-hint` serves as both UX guidance and implicit API contract for parameter shape [source: research-9.md#L46-L54]

---

### Deduplicated Findings

#### 1. PRD Generation Pipeline Flow (Phase 0 → Research → Spec → PRD)

The three reports collectively describe a complete pipeline:

1. **Phase 0 — Context grounding**: `wave-context-grounder` produces a ContextBrief (≤30 lines, ≤2K tokens) from PRD.md, README.md, 3-zone git sampling, and optional sources. This brief is injected into all downstream agents. [source: research-8.md#L5-L19]

2. **Research phase**: Parallel researchers receive ContextBrief injection. The "Do NOT Research" and "Completed" sections prevent duplicate investigation. [source: research-8.md#L47-L57]

3. **PRD generation**: `wave-prd-generator` takes sealed specs and classifies tasks into Tier 1 (inline ≤3 sentences) or Tier 2 (one-sentence + spec line-range pointer). Output is a phase section block presented for human review. [source: research-7.md#L13-L63]

#### 2. Progressive Disclosure as Architectural Principle

Both the PRD generator and context grounder enforce progressive disclosure:
- **Tier 2 entries** are deliberately terse (one sentence) to force agents to read the spec file at the referenced line range [source: research-7.md#L25-L29]
- **ContextBrief** is token-budgeted (≤2K) with priority-ordered source trimming — earlier sources survive compression [source: research-8.md#L59-L63]
- **Entry prompts** are thin routing shims with zero logic — all execution logic lives in the orchestrator agent [source: research-9.md#L11-L18]

#### 3. Numbering Continuity Across Pipeline

Two independent mechanisms ensure numbering consistency:
- **ContextBrief numbering section**: Records last phase N, last task NN, last research file MM → provides next-N+1 values [source: research-8.md#L17]
- **PRD generator auto-numbering**: Regex-scans existing PRD.md for `Task (\d+)` patterns, computes `max + 1`. Spec-assigned numbers take precedence if present. [source: research-7.md#L39-L41]

These are complementary: the ContextBrief provides numbering to researchers/spec-generators; the PRD generator independently verifies against the actual PRD file.

#### 4. Human-in-the-Loop Gates

The PRD generator enforces a review gate: output is presented as a fenced code block with [Apply]/[Refine]/[Back]/[Stop] actions. PRD.md is never auto-written. [source: research-7.md#L62-L63]

The entry prompt pattern also provides user control: the user explicitly invokes `/wave-explore-fast` with flags and topics, making the pipeline user-initiated. [source: research-9.md#L11-L18]

#### 5. Entry/Exit Architecture

- **Entry**: `wave-explore-fast.prompt.md` with `agent: wave-orchestrator` frontmatter — thin shim, passes `$ARGUMENTS` through [source: research-9.md#L11-L18]
- **Exit**: Dual paths — `wave-return-to-agent.prompt.md` slash command AND orchestrator's `handoffs:` frontmatter declaring `agent: agent` with `send: true` [source: research-9.md#L20-L25]
- **Orchestrator hub**: Declares 7 subagents (including context-grounder and prd-generator), lifecycle hooks, and handoff targets [source: research-9.md#L35-L44]

#### 6. 3-Zone Commit-Sampling Technique

Read-only git sampling from three temporal zones (first 10, middle 10, last 10 commits) with `git log` and `git show --stat`. Falls back to all commits if repo has <30 total. Results are LLM-summarized into a Codebase Fingerprint (churn files, function signatures, dependencies). Cacheable at `.ralph/codebase-brief.md` to skip ~30s latency. [source: research-8.md#L23-L45]

#### 7. Duplicate Prevention via Negative-Space Directives

Three-level deduplication:
1. Explicit "Do NOT Research" blocklist in ContextBrief [source: research-8.md#L49-L50]
2. "Completed" section listing finished capabilities [source: research-8.md#L51-L52]
3. Prompt injection: orchestrator appends ContextBrief to every researcher prompt [source: research-8.md#L53-L57]

This is a negative-space approach — agents are told what NOT to investigate, freeing them to discover novel topics. No semantic similarity detection required.

---

### Cross-Report Patterns

**Pattern 1: Token-Budgeted Information Compression** (research-7, research-8)
Both the ContextBrief (≤2K tokens, ≤30 lines) and Tier 2 PRD entries (exactly one sentence) enforce strict brevity. The purpose is identical: force downstream consumers to read source material rather than operating on summaries. This pattern appears across the entire pipeline — context grounding, research, and PRD generation all compress aggressively. **High confidence.**

**Pattern 2: Line-Range Precision Pointers** (research-7, research-8)
The PRD generator creates `→ Spec: path L{start}-L{end}` pointers by scanning `### Task NN` headers. The context grounder similarly produces structured sections that downstream agents reference by section name. Both patterns minimize context loading — agents read only the relevant window, not the entire file. **High confidence.**

**Pattern 3: Pipeline Phase Ordering with Grounding-First** (research-7, research-8, research-9)
All three reports describe or reference the same pipeline ordering: Phase 0 (context grounding) → Phase 1 (research) → spec generation → PRD generation. The entry prompt triggers the orchestrator, which enforces this ordering. The context grounder runs before researchers; the PRD generator runs after specs are sealed. This "ground-then-fan-out" pattern is the system's primary coordination mechanism. **High confidence.**

**Pattern 4: Thin Routing Layers** (research-7, research-9)
Entry prompts are thin shims (zero logic), orchestrator handles dispatch, subagents handle execution. The PRD generator similarly only classifies and formats — it doesn't create specs or execute tasks. Each layer has a single responsibility with minimal logic overlap. **High confidence.**

**Pattern 5: Sealed Prerequisites Enforce Pipeline Integrity** (research-7, research-8)
The PRD generator rejects specs without YAML frontmatter (unsealed). The context grounder's ContextBrief must be produced before researchers dispatch. Both enforce "do not proceed without upstream completion" — a prerequisite-chain pattern. **Medium-high confidence.**

---

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Pipeline phase ordering (ground → research → spec → PRD) | High — core architecture | Medium — orchestrator coordination logic | [research-8.md#L5-L7](research-8.md#L5-L7), [research-9.md#L35-L44](research-9.md#L35-L44), [research-7.md#L62-L63](research-7.md#L62-L63) |
| Tier classification heuristic (Tier 1 vs Tier 2) | High — determines PRD entry fidelity | Low — 3-sentence / single-change boolean test | [research-7.md#L13-L29](research-7.md#L13-L29) |
| ContextBrief with duplicate prevention | High — prevents redundant research | Medium — source chain + 3-zone sampling | [research-8.md#L5-L57](research-8.md#L5-L57) |
| Line-range indexing for spec pointers | Medium — enables precise agent reads | Low — regex scan of `### Task NN` headers | [research-7.md#L31-L37](research-7.md#L31-L37) |
| Entry/exit prompt architecture | Medium — user-facing UX | Low — frontmatter routing, no logic | [research-9.md#L11-L33](research-9.md#L11-L33) |
| 3-zone commit-sampling | Medium — codebase fingerprinting | Medium — git commands + LLM summarization | [research-8.md#L23-L45](research-8.md#L23-L45) |
| Auto-numbering with collision prevention | Low-Medium — numbering continuity | Low — regex + max+1 | [research-7.md#L39-L41](research-7.md#L39-L41), [research-8.md#L17](research-8.md#L17) |
| Human-in-the-loop review gate | Medium — safety/correctness | Low — presentation format only | [research-7.md#L62-L63](research-7.md#L62-L63) |

---

### Gaps

1. **Spec generation phase**: research-7 covers PRD generation FROM specs, and research-8 covers context grounding BEFORE research, but none of these three reports detail the `wave-spec-generator` itself — the middle step between research and PRD generation.

2. **Error recovery / retry**: None of the reports address what happens when pipeline phases fail (e.g., context grounding produces an over-budget brief, PRD generator encounters malformed specs). No rollback or retry mechanisms documented.

3. **Parallel researcher coordination**: research-8 describes duplicate prevention via ContextBrief injection, but doesn't cover how parallel researchers avoid topic overlap BETWEEN themselves (only overlap with completed work). The `wave-parallel-lock.prompt.md` addresses file-level conflicts but not topic-level deduplication.

4. **Cache invalidation**: research-8 mentions `.ralph/codebase-brief.md` cache for commit-sampling but the freshness heuristic is unspecified. Stale caches could feed incorrect numbering or outdated "Completed" sections.

5. **Line-range staleness**: research-7 flags that spec edits invalidate `L{start}-L{end}` pointers in PRD.md, but no refresh mechanism is documented.

6. **Enforcement strength**: The "Do NOT Research" directive relies on downstream agents honoring it (contractual, not programmatic). research-8 notes that wave-researcher agents lack an explicit constraint corresponding to the spec-generator's check.

---

### Sources

- research-7.md — wave-prd-generator tier classification, output format, line-range indexing, auto-numbering, human-in-the-loop gate
- research-8.md — wave-context-grounder ContextBrief structure, 3-zone commit-sampling, duplicate prevention, configurable source chain
- research-9.md — wave prompt files (explore-fast, return-to-agent, parallel-lock), 3-tier entry/exit architecture, frontmatter routing, argument-hint contract
