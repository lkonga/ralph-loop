# Aggregation Report 2

**Wave**: 2026-03-17-ralph-checkpoint-patterns
**Group**: 2
**Sources**: research-4.md, research-5.md, research-6.md
**Date**: 2026-03-17

---

## Source Reports

### research-4.md — Risk of Checkpoint Overuse Deviating from Ralph's Fully-Automated Philosophy
Key findings: Ralph-loop has accumulated 7 human intervention pathways (3 blocking) despite originating from a zero-intervention bash script. The cooldown dialog fires after every task (12s dead time × N tasks). `HumanCheckpointRequested` blocks indefinitely with no timeout. "Provide Guidance" injects volatile state that isn't persisted to any file artifact. 40+ config fields signal a system trying to be both fully automated and fully supervised. Proposes a "Headless Mode" with auto-skip timeouts and no dialogs. [source: research-4.md#L1-L169]

### research-5.md — Split PRDs vs Inline Checkpoints
Key findings: PRD loading is single-file, session-scoped — switching PRDs mid-session is unsupported. `parsePrd()` ignores phase headings entirely, treating the file as a flat task list. Cross-PRD dependencies require manual tracking. Proposes checkpoint-annotated single PRD (`<!-- CHECKPOINT: name -->`) as the recommended pattern, leveraging existing `HumanCheckpointRequested` + pause/resume machinery. Split PRDs work today without code changes but lose dependency graph and state continuity. [source: research-5.md#L1-L152]

### research-6.md — Checkpoint/Pause Patterns in Existing Research
Key findings: Catalogues 9 distinct checkpoint/pause patterns across the ralph ecosystem: inter-task cooldown, dual exit gate, yield requests, Signs & Gates, backpressure verification, circuit breaker states, hook suspend policies, state checkpointing, and session boundaries. Classifies them into 4 categories: proactive pauses, reactive gates, state transitions, and platform signals. Identifies backpressure verification gate and inter-task cooldown as immediately applicable. State checkpointing for crash recovery flagged as high-value but higher effort. [source: research-6.md#L1-L159]

---

## Deduplicated Findings

### F1: Ralph-Loop Has Drifted from Its Zero-Intervention Origins
The system evolved from snarktank/ralph (113 lines bash, zero human checkpoints) through aymenfurter/ralph (cooldown countdown) to the current state with 3 blocking checkpoints, 7 total intervention pathways, and 40+ config fields. This graduated autonomy erosion transforms an automated loop into an interactive assistant with a loop bolted on. [source: research-4.md#L12-L30]

### F2: HumanCheckpointRequested Blocks Indefinitely
Both stagnation tier 3 and diff validation exhaustion emit `HumanCheckpointRequested`, setting `pauseRequested = true` and spin-waiting in a 1-second poll with no timeout. If the user is absent, the loop halts permanently. This converts a safety valve into a "requires active supervision" constraint — directly contradicting the "write a PRD, press start, come back to commits" value proposition. [source: research-4.md#L77-L95] [source: research-5.md#L52-L65]

### F3: "Provide Guidance" Creates Volatile, Unpersisted State
When `HumanCheckpointRequested` fires, the user can type guidance that gets injected into `promptBlocks`. This state is not persisted to progress.txt, knowledge.md, or session.json — it's invisible in the audit trail, unrecoverable after crash, and antithetical to ralph's file-based state philosophy. [source: research-4.md#L63-L70]

### F4: PRD Is Flat-Parsed, Phase Headings Are Cosmetic
`parsePrd()` scans for checkbox lines and ignores markdown headings. There is no phase-aware scheduling — `pickNextTask()` returns the first pending task in file order. The `expectedPhase` field exists in `ConsistencyCheckInput` and frontmatter types but is disconnected from task scheduling. [source: research-5.md#L27-L42]

### F5: Inline Checkpoint Annotations Are the Recommended PRD Enhancement
A `<!-- CHECKPOINT: name -->` marker in the PRD would leverage the existing `HumanCheckpointRequested` + pause/resume machinery with minimal parser changes (~90 lines of regex). This preserves the dependency graph, state continuity, and progress.txt accumulation — advantages lost with split PRDs. [source: research-5.md#L82-L107]

### F6: Split PRDs Work Today but Lose Critical State
Split PRDs require no code changes (different `--prd` arg per session) but forfeit: cross-PRD dependency resolution, `completedTasks` set continuity, circuit breaker state, stagnation detector history, and knowledge manager accumulation. UX friction is high (stop → config change → restart per phase). [source: research-5.md#L64-L81]

### F7: Nine Checkpoint/Pause Patterns Exist Across the Ecosystem
The research base documents: inter-task cooldown (aymenfurter/ralph), dual exit gate (frankbria/ralph-claude-code), yield requests (VS Code autopilot), Signs & Gates (ClaytonFarr/ralph-playbook), backpressure verification (ralph-orchestrator), circuit breaker states, hook suspend policies (WaitForResume/RetryBackoff/WaitThenRetry), state checkpointing (LangGraph pattern), and session boundaries. [source: research-6.md#L13-L107]

### F8: Backpressure Verification Gate Is High-Value, Low-Cost
Before accepting task completion, require evidence: at least one file modified, test files modified if task mentions "test," progress.txt updated. Rejection sends the agent back with specific missing-evidence feedback. This is a reactive gate (fires only on failure) that prevents false completions without adding latency to successful runs. Already designed in research-08. [source: research-6.md#L57-L68]

### F9: State Checkpointing Enables Crash Recovery
Serializable loop state with resume logic would enable recovery from crashes and interruptions. Minimum viable state: current task index, iteration count, circuit breaker state. Full state: entire session including verification history and knowledge entries. Recommended by the orchestration comparison but requires architecture work. [source: research-6.md#L93-L100]

### F10: The Cooldown Dialog Is the Highest-Latency Checkpoint
12 seconds × 20 tasks = 4 minutes of idle time in the best case. The auto-accept makes it functionally a speed bump. It implies the user should be watching, undermining the automation value. The original aymenfurter/ralph used 5s; ralph-loop's 12s may be a cargo-culted artifact since the dual exit gate eliminates the need for human observation of completion quality. [source: research-4.md#L35-L50] [source: research-6.md#L13-L19]

### F11: Dual Exit Gate May Make Additional Verification Layers Redundant
The dual gate (PRD checkbox marked AND tsc/vitest passes) already provides strong guarantees. Ralph-loop adds diff validation (third check), post-task review (fourth), consistency checks (fifth), pre-complete hooks (sixth), and human checkpoints (seventh). Each layer adds diminishing safety returns but guaranteed latency. [source: research-4.md#L96-L115]

---

## Cross-Report Patterns

### CP1: Blocking Indefinitely Is the Core Anti-Pattern (3/3 reports)
All three reports identify the indefinite-blocking nature of `HumanCheckpointRequested` as problematic. Research-4 calls it the most impactful deviation from automated philosophy. Research-5 shows the existing pause/resume machinery could support timeout-bounded variants. Research-6 documents that hook suspend policies in ralph-orchestrator already designed timeout-bounded alternatives (`RetryBackoff`, `WaitThenRetry`). **High confidence**: this is the single most actionable fix — add a configurable timeout to `HumanCheckpointRequested`. [source: research-4.md#L77-L95] [source: research-5.md#L52-L65] [source: research-6.md#L84-L92]

### CP2: Reactive Gates Over Proactive Pauses (3/3 reports)
All reports converge on reactive (fire-on-failure) checkpoints being superior to proactive (pause-before-every-task) ones. Research-4 shows the cooldown dialog adds dead time to every task regardless of outcome. Research-5 recommends checkpoint markers only at phase boundaries, not between tasks. Research-6 classifies the ecosystem patterns and shows the most successful systems (Signs & Gates, backpressure verification, dual exit gate) are all reactive. **High confidence**: default behavior should be no pause on success, intervention only on failure. [source: research-4.md#L35-L50] [source: research-5.md#L82-L107] [source: research-6.md#L111-L115]

### CP3: File-Based State Persistence Is Non-Negotiable (2/3 reports)
Research-4 identifies "Provide Guidance" as anti-pattern because it creates state not persisted to files. Research-6 identifies state checkpointing as a key missing feature for crash recovery. Both converge on the principle: if state matters, it must be on disk. Guidance should write to knowledge.md; loop state should be serializable for resume. [source: research-4.md#L63-L70] [source: research-6.md#L93-L100]

### CP4: Permission-Level Model Resolves Config Explosion (2/3 reports)
Research-4 proposes a 3-mode system (supervised/standard/headless) inspired by VS Code's permission levels. Research-5 notes that split PRDs partly solve this by allowing different config per session. Both point to the same root cause: 40+ config fields paper over the contradiction of being both automated and supervised. A clean mode selection replaces most boolean flags. [source: research-4.md#L117-L145] [source: research-5.md#L75-L81]

### CP5: Dependency Graph Preservation Constrains Checkpoint Architecture (2/3 reports)
Research-5 shows that split PRDs lose the dependency graph — cross-PRD dependencies require manual tracking. Research-6 confirms that all documented checkpoint patterns operate within a single execution context. This constrains the architecture: checkpoint solutions must work within a single PRD/session to preserve `parseDependsOn()` and `pickReadyTasks()` functionality. [source: research-5.md#L44-L50] [source: research-6.md#L111-L115]

---

## Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---------|--------|--------|--------------------------|
| Add timeout to `HumanCheckpointRequested` | **Critical** — unblocks unattended operation | **Low** — add configurable timeout to existing spin-wait | [research-4.md#L77-L95](research-4.md#L77-L95), [research-5.md#L52-L65](research-5.md#L52-L65), [research-6.md#L84-L92](research-6.md#L84-L92) |
| Default cooldown dialog to OFF / 0s | **High** — eliminates 4+ min dead time per PRD run | **Low** — change default config value | [research-4.md#L35-L50](research-4.md#L35-L50), [research-6.md#L13-L19](research-6.md#L13-L19) |
| Backpressure verification gate | **High** — prevents false completions without latency penalty | **Low** — evidence check before `markTaskComplete` | [research-6.md#L57-L68](research-6.md#L57-L68) |
| Persist "Provide Guidance" to knowledge.md | **Medium** — fixes audit trail gap | **Low** — write to file before injecting into prompt | [research-4.md#L63-L70](research-4.md#L63-L70) |
| PRD checkpoint annotations (`<!-- CHECKPOINT -->`) | **High** — enables phase boundaries without split PRDs | **Low-Medium** — add marker detection to `parsePrd()` | [research-5.md#L82-L107](research-5.md#L82-L107) |
| Headless/supervised mode toggle | **High** — replaces 40+ config fields with clear intent | **Medium** — define mode presets, wire to config | [research-4.md#L117-L145](research-4.md#L117-L145) |
| State checkpointing for crash recovery | **High** — enables resume after interruption | **Medium-High** — serialize loop state, implement resume | [research-6.md#L93-L100](research-6.md#L93-L100) |
| Hook suspend policies (WaitForResume/RetryBackoff) | **Medium** — enables explicit pause primitives | **Medium** — requires iteration-level hooks first | [research-6.md#L84-L92](research-6.md#L84-L92) |
| Auto-commit at checkpoint boundaries | **Medium** — clean git history per phase | **Low** — call `atomicCommit()` before pause | [research-5.md#L134-L136](research-5.md#L134-L136) |

---

## Gaps

1. **No quantitative data on checkpoint frequency**: None of the reports measure how often `HumanCheckpointRequested` actually fires in real PRD runs — stagnation tier 3 and diff validation exhaustion may be rare enough that the indefinite-block issue is theoretical rather than practical.

2. **No analysis of checkpoint UX in competing tools**: How do Cursor, Windsurf, Aider, or other agent loops handle human checkpoints? Research-6 mentions LangGraph and CrewAI architecturally but doesn't assess their UX patterns.

3. **No cost-benefit analysis of the verifier chain**: Research-4 questions whether 7 verification layers are warranted but doesn't measure false-positive/false-negative rates of each layer. Which layers actually catch issues the dual exit gate misses?

4. **Missing: checkpoint interaction with parallel task execution**: Research-5 and research-6 assume serial task execution. If ralph-loop's `pickReadyTasks()` runs multiple tasks in parallel, checkpoint boundaries become more complex — what happens when one parallel task hits a checkpoint but others are still running?

5. **No user research on supervision preferences**: The "headless mode" proposal assumes users want fully unattended operation. Some users may want selective checkpoints (e.g., only pause on destructive operations). No data on actual user preferences.

6. **Phase visibility in agent context**: Research-5 raises whether Phase 2 tasks should be hidden from the agent during Phase 1 but doesn't analyze whether LLM behavior changes when future tasks are visible in the prompt.

---

## Sources
- research-4.md — Risk of checkpoint overuse deviating from ralph's fully-automated philosophy
- research-5.md — Split PRDs vs inline checkpoints as structural alternatives
- research-6.md — Checkpoint/pause patterns catalogued across existing ralph-loop research and ecosystem analysis
