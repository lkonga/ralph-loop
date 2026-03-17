# Research 8: Wave Context Grounder — ContextBrief, 3-Zone Commit-Sampling, and Duplicate Prevention

## Findings

### What wave-context-grounder produces

The agent produces a **ContextBrief** — a structured markdown document constrained to **≤30 lines** and **≤2K tokens**. It runs as Phase 0 of the `--ralph-prd` pipeline, before any research agents are dispatched.

The ContextBrief has these sections:

| Section | Content |
|---------|---------|
| **Project / Stack / Structure** | Name, languages/frameworks/deps, top-level directory layout (1 line each) |
| **Completed** | Bullet list of finished phases/features (one-line summaries) |
| **In Progress** | Open tasks or phases currently underway |
| **Numbering** | Last phase N → next N+1, last task NN → next NN+1, last research file MM → next MM+1 |
| **Codebase Fingerprint** | Top files by churn, key function signatures, dependency list |
| **Conventions** | Naming patterns, file org rules, architectural constraints |
| **Do NOT Research** | Topics already covered by completed work (duplicate-prevention list) |

Sources: `PRD.md`, `README.md`, 3-zone git commit-sampling, optionally `CHANGELOG.md` and custom files via the configurable source chain.

### 3-Zone Git Commit-Sampling Implementation

The agent uses **read-only** git commands to sample commits from three temporal zones:

1. **Zone 1 — Founding intentions** (first 10 commits):
   - `git log --oneline --reverse | head -10` to find earliest commits
   - `git show --stat <hash>` for each commit to see files touched

2. **Zone 2 — Evolutionary trajectory** (middle 10 commits):
   - Compute total commit count, find midpoint
   - `git log --oneline --skip=$((midpoint-5)) -10` to sample around the middle
   - `git show --stat <hash>` for each

3. **Zone 3 — Current state** (last 10 commits):
   - `git log --oneline -10` for the most recent commits
   - `git show --stat <hash>` for each

If the repo has fewer than 30 commits, all available commits are sampled instead of strict 10/10/10 zones.

The samples are summarized into a **Codebase Fingerprint** containing:
- Top files by churn (most frequently changed across all zones)
- Key function signatures or patterns observed
- Dependency list (from `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, etc.)

The commit-sampling adds ~30s latency. A pre-computed cache at `.ralph/codebase-brief.md` (Task 35) can skip the sampling entirely if fresh.

### How ContextBrief Prevents Duplicate Research

The duplicate-prevention mechanism operates at **three levels**:

1. **"Do NOT Research" section**: An explicit blocklist of topics already covered by completed work. Downstream agents (e.g., `wave-spec-generator`) are instructed: "Do NOT duplicate capabilities already listed in the ContextBrief's 'Completed' or 'Do NOT Research' sections." This is a direct contractual constraint between agents.

2. **"Completed" section**: Lists finished phases/features. Any researcher seeing this section knows these capabilities exist and should not be re-investigated or re-proposed.

3. **Prompt injection into all downstream agents**: The orchestrator saves the ContextBrief to `research/_wave/{WAVE_ID}/context-brief.md` and appends it to every researcher's prompt during Phase 1. From the orchestrator: "The ContextBrief is injected into all subsequent subagent prompts as grounding context to prevent researching solved problems."

### Configurable Context Source Chain

Sources are composable pure functions `(workspace) → ContextSnippet` returning `{ source, content, tokenEstimate? }`. The chain concatenates snippets in order and trims from the end when exceeding the token budget (earlier sources get priority).

Built-in sources: `prd`, `readme`, `commits-3zone`, `changelog`. Custom files can be added via `fileSource("architecture.md")`.

TypeScript implementation in `ralph-loop/src/contextSourceChain.ts` provides: `ContextSource`, `ContextSnippet`, `ContextSourceChainConfig`, `runContextSourceChain()`, and built-in source functions.

## Patterns

1. **Phase 0 grounding pattern**: Run a lightweight read-only agent before any research to establish shared context. This is the "measure twice, cut once" approach to multi-agent coordination.

2. **Explicit blocklist pattern**: The "Do NOT Research" section is a negative-space directive — rather than telling agents what to research, it tells them what is already solved. This is more resilient than positive-space directives because researchers can still discover novel topics.

3. **3-zone temporal sampling**: Sampling first/middle/last commits captures project arc without reading the full history. This is a compression technique — 30 commits provide enough signal for founding vision, architectural shifts, and current focus.

4. **Token-budgeted source chain**: The composable source chain with priority-ordered trimming ensures the brief stays within budget regardless of how many sources are enabled. Earlier sources are preserved when trimming occurs.

5. **Cache bypass pattern**: The `.ralph/codebase-brief.md` cache eliminates the ~30s commit-sampling latency for repeat runs where the codebase hasn't changed significantly.

## Applicability

- **To ralph-loop**: The ContextBrief is the foundational grounding mechanism for the entire `--ralph-prd` pipeline. Without it, every parallel researcher would redundantly investigate completed features and propose conflicting numbering schemes.

- **To multi-agent systems generally**: The pattern of "ground first, then fan-out" with injected context is transferable to any multi-agent research or implementation pipeline. The "Do NOT Research" blocklist is a practical deduplication mechanism that doesn't require semantic similarity detection.

- **To codebase analysis**: The 3-zone commit-sampling technique is a standalone analysis tool — useful anytime you need a quick project evolution summary without reading the full git history.

## Open Questions

1. **Cache freshness**: How does Task 35's cache determine "freshness"? Is it timestamp-based, commit-hash-based, or content-hash-based? The agent says "see Task 35" but the freshness heuristic isn't specified in the grounder itself.

2. **LLM summarization step**: The agent describes the commit data being "summarized into a Codebase Fingerprint" but doesn't explicitly state whether this summarization is done by the grounder agent's own LLM pass or by a structured extraction. The test file (`commitSamplingHook.test.ts`) checks for "LLM summar" suggesting it's an LLM-driven step.

3. **Enforcement**: The "Do NOT Research" section relies on downstream agents honoring the directive. There's no programmatic enforcement — a researcher that ignores the ContextBrief could still duplicate work. The spec-generator has an explicit rule checking this, but wave-researcher agents don't have a corresponding explicit constraint visible in the grounder itself.

4. **Token budget vs. 30-line limit**: With 4 sources (PRD, README, commits, changelog) and a 2K token budget, large PRDs could crowd out commit-sampling data. The trimming strategy preserves earlier sources, so the source order in the chain config determines which data survives compression.
