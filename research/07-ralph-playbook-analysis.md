---
type: research
id: 7
sources:
  - ClaytonFarr/ralph-playbook
---
# Ralph Playbook — Complete Architectural Analysis

> Source: [ClaytonFarr/ralph-playbook](https://github.com/ClaytonFarr/ralph-playbook)
> Purpose: Extract patterns applicable to ralph-loop VS Code extension

---

## 1. Core Philosophy

**Ralph** is an autonomous coding methodology running an LLM in a continuous loop with file-based state. Each loop: read plan → pick task → implement → test → commit → clear context → repeat.

**Why it works:** Fresh context each iteration keeps the AI in its "smart zone." File-based memory (specs, plan, agents file) persists learnings. Backpressure (utilities, tests, builds) forces self-correction.

### Four Driving Principles

1. **Context Is Everything** — 200K tokens advertised ≈ 176K usable, 40-60% utilization = "smart zone". Tight tasks + 1 task/loop = 100% smart zone utilization.
2. **Steering via Patterns + Backpressure** — Signals & gates are CRITICAL. Steer upstream (deterministic setup) and downstream (backpressure).
3. **Let Ralph Ralph** — Specify WHAT to verify, not HOW to implement. Ralph decides implementation details.
4. **Move Outside the Loop** — Human oversight is OVER the loop, not IN it.

---

## 2. Three Phases, Two Prompts, One Loop

### Phase 1: Define Requirements (Human + LLM conversation)
- Discuss ideas → identify Jobs to Be Done (JTBD)
- Break JTBD into topics of concern
- LLM writes `specs/FILENAME.md` for each topic

### Phase 2: Planning Mode (PROMPT_plan.md)
- Gap analysis: compare specs vs existing code
- Output: prioritized `IMPLEMENTATION_PLAN.md`
- No implementation, no commits

### Phase 3: Building Mode (PROMPT_build.md)
- Pick task from plan → implement → test → commit → loop
- Each iteration = 1 fresh context = 1 task = 1 commit

---

## 3. Signs & Gates Methodology

### Signs = Discoverable Guidance
"Signs" are anything the agent can discover to guide its behavior:
- **Prompt guardrails** — Instructions in PROMPT.md
- **AGENTS.md** — Operational learnings (commands, patterns, gotchas)
- **Code patterns** — Utilities in `src/lib/` that steer toward correct patterns
- **Specs** — Requirements that constrain scope

**Philosophy: "Tune it like a guitar"**
- Start with minimal signs (empty AGENTS.md)
- Observe failures during loop runs
- Add signs reactively when Ralph fails in specific, repeatable ways
- "When Ralph fails a specific way, add a sign to help him next time"

### Gates = Backpressure Mechanisms
Two steering directions:

**Upstream (Deterministic Setup):**
- Allocate first ~5,000 tokens for specs
- Every loop starts from known state (PROMPT.md + AGENTS.md)
- Existing code patterns shape what gets generated
- If wrong patterns emerge, add/update utilities to steer

**Downstream (Backpressure):**
- Tests, typechecks, lints, builds that REJECT invalid work
- PROMPT says "run tests" generically
- AGENTS.md specifies actual project-specific commands
- Binary pass/fail — no ambiguity

**Key insight:** "Creating the right signals & gates to steer Ralph's successful output is CRITICAL"

---

## 4. Prompt Engineering Patterns

### Prompt Structure (999... Numbering Convention)

| Section | Purpose |
|---------|---------|
| Phase 0 (0a, 0b, 0c) | Orient: study specs, source, plan |
| Phase 1-4 | Main instructions: task, validation, commit |
| 999... numbering | Guardrails/invariants (higher number = MORE critical) |

### Key Language Patterns (Geoff's phrasing)
- **"study"** — not "read" or "look at" (deeper engagement)
- **"don't assume not implemented"** — CRITICAL, the "Achilles' heel"
- **"using parallel subagents" / "up to N subagents"** — fan-out control
- **"only 1 subagent for build/tests"** — backpressure control
- **"Ultrathink"** — deep reasoning trigger
- **"capture the why"** — documentation intent
- **"if functionality is missing then it's your job to add it"**

### Guardrail Hierarchy (ascending criticality)
| Number | Guardrail |
|--------|-----------|
| 99999 | Capture the why in documentation |
| 999999 | Single sources of truth, no migrations |
| 9999999 | Git tag on no errors (semver) |
| 99999999 | Extra logging for debugging |
| 999999999 | Keep IMPLEMENTATION_PLAN.md current |
| 9999999999 | Update AGENTS.md with operational learnings |
| 99999999999 | Document bugs even if unrelated |
| 999999999999 | Implement completely, no placeholders/stubs |
| 9999999999999 | Clean completed items from plan |
| 99999999999999 | Fix spec inconsistencies with Opus ultrathink |
| 999999999999999 | Keep AGENTS.md operational only (no status/progress) |

---

## 5. Building Mode Loop Lifecycle (10 Steps)

1. **Orient** — subagents study `specs/*` (up to 500 parallel Sonnet)
2. **Read plan** — study `IMPLEMENTATION_PLAN.md`
3. **Select** — pick the most important task
4. **Investigate** — subagents study relevant `/src` ("don't assume not implemented")
5. **Implement** — N subagents for file operations
6. **Validate** — 1 subagent for build/tests (backpressure)
7. **Update IMPLEMENTATION_PLAN.md** — mark done, note discoveries/bugs
8. **Update AGENTS.md** — if operational learnings
9. **Commit** — git add -A, commit, push
10. **Loop ends** → context cleared → next iteration starts fresh

---

## 6. File Architecture

```
project-root/
├── loop.sh                    # Loop orchestration
├── PROMPT_build.md            # Build mode instructions
├── PROMPT_plan.md             # Plan mode instructions
├── AGENTS.md                  # Operational guide (~60 lines max)
├── IMPLEMENTATION_PLAN.md     # Prioritized task list (Ralph-generated)
├── specs/                     # One .md per JTBD topic
└── src/lib/                   # Shared utilities & components
```

| File | Purpose | Modified By |
|------|---------|-------------|
| loop.sh | Loop orchestration | You (setup) |
| PROMPT_*.md | Instructions per mode | You (tuning) |
| AGENTS.md | Operational guide | Ralph + You |
| IMPLEMENTATION_PLAN.md | Prioritized tasks | Ralph |
| specs/* | Requirements per topic | You + Ralph |

### AGENTS.md Structure
```markdown
## Build & Run
Succinct rules for how to BUILD the project

## Validation
- Tests: `[test command]`
- Typecheck: `[typecheck command]`
- Lint: `[lint command]`

## Operational Notes
Succinct learnings about how to RUN the project

## Codebase Patterns
```

### IMPLEMENTATION_PLAN.md
- Prioritized bullet-point list from gap analysis
- **Disposable** — "I have deleted the TODO list multiple times" (Geoff)
- **Self-correcting** — building mode can create new specs if missing
- **No pre-specified template** — let the LLM manage format
- Circularity is intentional: eventual consistency through iteration

---

## 7. Context Management Strategy

### Main Agent as Scheduler
- Don't allocate expensive work to main context
- Spawn subagents whenever possible
- Each subagent gets ~156kb that's garbage collected
- Fan out to avoid polluting main context

### Context Allocation Rules
- First ~5,000 tokens reserved for specs
- Every loop starts with: PROMPT.md + AGENTS.md (known state)
- IMPLEMENTATION_PLAN.md is read within the loop
- 1 task per iteration = 1 commit = fresh context

### File-Based Memory
- **Specs** — persistent requirements (source of truth)
- **IMPLEMENTATION_PLAN.md** — shared state between iterations
- **AGENTS.md** — operational learnings that persist
- Key insight: "The IMPLEMENTATION_PLAN.md file persists on disk between iterations and acts as shared state between otherwise isolated loop executions"

---

## 8. Quality Gate Definitions

### Acceptance-Driven Backpressure (Enhancement)
Three-tier separation:
1. **Acceptance criteria** (in specs) = Behavioral outcomes, observable results
   - ✓ "Extracts 5-10 dominant colors from any uploaded image"
   - ✓ "Processes images <5MB in <100ms"
2. **Test requirements** (in plan) = Verification points derived from criteria
   - ✓ "Required tests: Extract 5-10 colors, Performance <100ms"
3. **Implementation approach** (up to Ralph) = Technical decisions
   - ✗ AVOID: "Use K-means clustering with 3 iterations"

### Non-Deterministic Backpressure (Enhancement)
- LLM-as-Judge tests with binary pass/fail
- For subjective quality (visual design, UX, brand consistency)
- Non-deterministic by nature — loop provides eventual consistency
- Uses `src/lib/llm-review.ts` fixture pattern

### Topic Scope Test
**"One Sentence Without 'And'"** — Can you describe the topic in one sentence without conjoining unrelated capabilities?
- ✓ "The color extraction system analyzes images to identify dominant colors"
- ✗ "The user system handles authentication, profiles, and billing" → 3 topics

---

## 9. Enhancements Catalog

### AskUserQuestionTool for Planning
Use Claude's built-in interview tool during Phase 1 to systematically clarify JTBD, edge cases, and acceptance criteria.

### Ralph-Friendly Work Branches
- **Wrong:** Create full plan, filter at runtime → unreliable (70-80%)
- **Right:** Create scoped plan per branch upfront → deterministic
- `plan-work` mode with `WORK_SCOPE` env var
- Each session operates monolithically on ONE body of work per branch

### JTBD → Story Map → SLC Release
- Activities → Journey Maps → Release Slices
- SLC = Simple, Lovable, Complete (not MVP)
- Separate `AUDIENCE_JTBD.md` artifact as single source of truth

### Specs Audit
- Dedicated loop mode for maintaining spec quality
- Enforces: behavioral outcomes only, no code blocks, proper topic scoping
- File naming: `NN-kebab-case.md`

### Reverse Engineering Brownfield Projects
- Two-phase: Phase 1 investigates code, Phase 2 writes specs
- Documents actual behavior (bugs included), not intended behavior
- Zero implementation details in output specs

---

## 10. Applicability to ralph-loop

### Direct Mappings

| Ralph Playbook (CLI) | ralph-loop (VS Code Extension) |
|---|---|
| `loop.sh` bash loop | Orchestrator driving Copilot Agent Mode |
| `PROMPT_build.md` piped to stdin | Prompt constructed and sent to Copilot chat |
| `AGENTS.md` loaded per iteration | Extension reads AGENTS.md into context |
| `IMPLEMENTATION_PLAN.md` on disk | Same — file-based shared state |
| `specs/*` on disk | Same — file-based requirements |
| `git commit` per iteration | gitOps module commits per cycle |
| `--dangerously-skip-permissions` | VS Code extension has inherent permissions |
| Subagent fan-out | N/A (Copilot Agent Mode handles internally) |
| Context window clearing (process exit) | Must synthesize/simulate context reset |

### Key Architectural Insights for ralph-loop

1. **One task per cycle is non-negotiable** — this keeps context in the "smart zone"
2. **Backpressure is the primary quality mechanism** — tests/builds/lints MUST gate commits
3. **Plan is disposable** — regeneration is cheaper than fixing stale plans
4. **Signs are reactive, not proactive** — don't over-engineer upfront guardrails
5. **AGENTS.md must stay lean** — bloated operational notes pollute every future cycle
6. **"Don't assume not implemented"** — the #1 failure mode to guard against
7. **File-based state is the memory model** — not in-memory state between iterations
8. **Deterministic setup + non-deterministic execution = eventual consistency**

### Translation Challenges

1. **Context clearing** — CLI exits process; VS Code extension must manage Copilot chat sessions
2. **Subagent orchestration** — CLI spawns Claude subprocesses; VS Code relies on Copilot's internal handling
3. **Permission model** — CLI uses `--dangerously-skip-permissions`; VS Code extension operates within sandbox
4. **Loop control** — CLI uses bash while loop; extension needs event-driven state machine
5. **Prompt injection** — CLI pipes file to stdin; extension must construct prompts through API
