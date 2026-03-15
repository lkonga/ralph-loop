# Ralph Loop — Research Index

> Research conducted March 14, 2026
> Source session: `e1c501d2-3106-4e0a-9212-1443d7efd5f2` (VS Code Insiders)
> Method: Multi-wave parallel subagent research with expert review ranking

---

## Documents

| # | File | Contents |
|---|------|----------|
| 01 | [copilot-chat-internals](01-copilot-chat-internals.md) | 12 key findings from `microsoft/vscode-copilot-chat` repo: system prompts, model routing, tool selection, agent wizard, retry logic |
| 02 | [autopilot-deep-dive](02-autopilot-deep-dive.md) | Complete reverse-engineering of autopilot mode: permission levels, `task_complete` tool, continuation loop, nudge injection, self-resetting counter, safety guardrails, state machine |
| 03 | [ralph-ecosystem-analysis](03-ralph-ecosystem-analysis.md) | Analysis of 7 Ralph implementations (snarktank, frankbria, hehamalainen, Gsaecy, aymenfurter, giocaizzi, awesome-ralph), convergent patterns, workbench commands |
| 04 | [implementation-plan](04-implementation-plan.md) | Architecture design, autopilot-to-ralph pattern mapping, integration options (A/B/C), PreCompact reset innovation, API design, file structure, phased delivery |
| 05 | [expert-review-rankings](05-expert-review-rankings.md) | 10-plan scoring matrix, why Hybrid B2+E2 won, rejection reasons, async generator vs EventEmitter, open questions |
| 13 | [phase9-deep-research](13-phase9-deep-research.md) | Consolidated research from 13 GitHub repos: context/token management, knowledge harvest/GC, thrashing detection, plan regeneration, backpressure, search-before-implement, workflow presets, cooldown, FS signals, session isolation |
| 14 | [phase9-refined-tasks](14-phase9-refined-tasks.md) | Detailed specifications for 12 Phase 9 tasks (57-68): interfaces, config schemas, test expectations, design decisions. Used as PD reference targets from PRD.md |

## Raw Data

| File | Description |
|------|-------------|
| [_raw-session-e1c501d2](_raw-session-e1c501d2.md) | Full extracted conversation (85KB, 1846 lines) from the original research session |

---

## Research Methodology

1. **Wave 1**: 10 parallel subagents — repo analysis, autopilot reverse-engineering, pattern extraction
2. **Wave 2**: Aggregation — synthesize findings into coherent analysis
3. **Wave 3**: 5 implementation plans generated (2 variants each = 10 total)
4. **Wave 4**: Expert review — scored and ranked all 10 plan variants
5. **Result**: Hybrid B2+E2 selected (score 8.3/10), implemented as ralph-loop

## Key Conclusions

1. **Determinism is non-negotiable** — the control plane must be executable code, not LLM prompts
2. **PreCompact reset** is the killer innovation — hook into compaction signals to reset at the exact right moment
3. **Async generators** beat EventEmitters for orchestration — better backpressure, cancellation, testability
4. **PRD.md checkboxes** are the simplest viable DSL — human-readable, git-friendly, completion detection is a regex
5. **Nudges as user messages** have the highest LLM compliance rate — not system messages
