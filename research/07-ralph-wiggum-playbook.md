---
type: research
id: 7
sources:
  - ghuntley/how-to-ralph-wiggum
---
# Ralph Wiggum Playbook — Deep Research

> Source: `ghuntley/how-to-ralph-wiggum` (Clayton Farr's compilation of Geoffrey Huntley's methodology)
> Files: README.md (~1226 lines), index.html (~3339 lines), files/loop.sh (70 lines), files/PROMPT_build.md (~20 lines), files/PROMPT_plan.md (~10 lines), references/sandbox-environments.md (~682 lines)

---

## 1. Core Philosophy

**"No sophisticated orchestration needed — just a dumb bash loop."**

The entire methodology reduces to: run an LLM in a continuous loop using file-based state. Each iteration reads a plan, picks one task, implements it, tests it, commits it, then the context is cleared and the next iteration starts fresh.

Key principles:
- **Context is everything** — 200K+ tokens advertised ≈ 176K truly usable; 40–60% utilization is the "smart zone"
- **Let Ralph Ralph** — lean into LLM self-identification, self-correction, self-improvement; eventual consistency through iteration
- **Move outside the loop** — the human engineers setup/environment, observes, and course-corrects; "tune it like a guitar"
- **Use protection** — `--dangerously-skip-permissions` requires a sandbox; "It's not if it gets popped, it's when. And what is the blast radius?"
- **Plan is disposable** — regenerate when wrong/stale; cheap vs. going in circles
- **Simplicity and brevity win** — verbose inputs degrade determinism; prefer markdown over JSON for token efficiency

---

## 2. Three Phases, Two Prompts, One Loop

### Phase 1: Define Requirements (human + LLM conversation)
- Discuss project ideas → identify Jobs to Be Done (JTBD)
- Break individual JTBD into topic(s) of concern
- Use subagents to load info from URLs into context
- LLM writes `specs/FILENAME.md` for each topic

### Phase 2: PLANNING Mode (Ralph loop)
- Gap analysis: specs vs code
- Output: `IMPLEMENTATION_PLAN.md` — prioritized bullet-point list
- No implementation, no commits

### Phase 3: BUILDING Mode (Ralph loop)
- Pick most important task from plan
- Implement → test → commit → update plan
- Same loop mechanism, different prompt

| Mode       | When to use                       | Prompt focus                                              |
|------------|-----------------------------------|-----------------------------------------------------------|
| PLANNING   | No plan exists, or plan is stale  | Generate/update `IMPLEMENTATION_PLAN.md` only             |
| BUILDING   | Plan exists                       | Implement from plan, commit, update plan as side effect   |

---

## 3. Project File Structure

```
project-root/
├── loop.sh                    # Ralph loop script (outer loop orchestration)
├── PROMPT_build.md            # Build mode instructions
├── PROMPT_plan.md             # Plan mode instructions
├── PROMPT_plan_work.md        # Work-scoped planning (enhancement)
├── AGENTS.md                  # Operational guide loaded each iteration
├── IMPLEMENTATION_PLAN.md     # Prioritized task list (generated/updated by Ralph)
├── AUDIENCE_JTBD.md           # Audience & Jobs To Be Done (enhancement)
├── specs/                     # Requirement specs (one per JTBD topic)
│   ├── [jtbd-topic-a].md
│   └── [jtbd-topic-b].md
├── src/                       # Application source code
└── src/lib/                   # Shared utilities & components
```

### Who modifies what:

| File                    | Modified by     |
|-------------------------|-----------------|
| `loop.sh`               | You (setup)     |
| `PROMPT_*.md`           | You (tuning)    |
| `AGENTS.md`             | Ralph + You     |
| `IMPLEMENTATION_PLAN.md`| Ralph           |
| `specs/*`               | You + Ralph     |

---

## 4. Prompt Templates (Verbatim)

### PROMPT_plan.md (from `files/PROMPT_plan.md`)

```
0a. Study `specs/*` with up to 250 parallel Sonnet subagents to learn the application specifications.
0b. Study @IMPLEMENTATION_PLAN.md (if present) to understand the plan so far.
0c. Study `src/lib/*` with up to 250 parallel Sonnet subagents to understand shared utilities & components.
0d. For reference, the application source code is in `src/*`.

1. Study @IMPLEMENTATION_PLAN.md (if present; it may be incorrect) and use up to 500 Sonnet subagents to study existing source code in `src/*` and compare it against `specs/*`. Use an Opus subagent to analyze findings, prioritize tasks, and create/update @IMPLEMENTATION_PLAN.md as a bullet point list sorted in priority of items yet to be implemented. Ultrathink. Consider searching for TODO, minimal implementations, placeholders, skipped/flaky tests, and inconsistent patterns. Study @IMPLEMENTATION_PLAN.md to determine starting point for research and keep it up to date with items considered complete/incomplete using subagents.

IMPORTANT: Plan only. Do NOT implement anything. Do NOT assume functionality is missing; confirm with code search first. Treat `src/lib` as the project's standard library for shared utilities and components. Prefer consolidated, idiomatic implementations there over ad-hoc copies.

ULTIMATE GOAL: We want to achieve [project-specific goal]. Consider missing elements and plan accordingly. If an element is missing, search first to confirm it doesn't exist, then if needed author the specification at specs/FILENAME.md. If you create a new element then document the plan to implement it in @IMPLEMENTATION_PLAN.md using a subagent.
```

### PROMPT_build.md (from `files/PROMPT_build.md`)

```
0a. Study `specs/*` with up to 500 parallel Sonnet subagents to learn the application specifications.
0b. Study @IMPLEMENTATION_PLAN.md.
0c. For reference, the application source code is in `src/*`.

1. Your task is to implement functionality per the specifications using parallel subagents. Follow @IMPLEMENTATION_PLAN.md and choose the most important item to address. Before making changes, search the codebase (don't assume not implemented) using Sonnet subagents. You may use up to 500 parallel Sonnet subagents for searches/reads and only 1 Sonnet subagent for build/tests. Use Opus subagents when complex reasoning is needed (debugging, architectural decisions).
2. After implementing functionality or resolving problems, run the tests for that unit of code that was improved. If functionality is missing then it's your job to add it as per the application specifications. Ultrathink.
3. When you discover issues, immediately update @IMPLEMENTATION_PLAN.md with your findings using a subagent. When resolved, update and remove the item.
4. When the tests pass, update @IMPLEMENTATION_PLAN.md, then `git add -A` then `git commit` with a message describing the changes. After the commit, `git push`.
99999. Important: When authoring documentation, capture the why — tests and implementation importance.
999999. Important: Single sources of truth, no migrations/adapters. If tests unrelated to your work fail, resolve them as part of the increment.
9999999. As soon as there are no build or test errors create a git tag (start at 0.0.0, increment patch).
99999999. You may add extra logging if required to debug issues.
999999999. Keep @IMPLEMENTATION_PLAN.md current with learnings using a subagent — future work depends on this to avoid duplicating efforts.
9999999999. When you learn something new about how to run the application, update @AGENTS.md using a subagent but keep it brief.
99999999999. For any bugs you notice, resolve them or document them in @IMPLEMENTATION_PLAN.md using a subagent even if it is unrelated to the current piece of work.
999999999999. Implement functionality completely. Placeholders and stubs waste efforts and time redoing the same work.
9999999999999. When @IMPLEMENTATION_PLAN.md becomes large periodically clean out the items that are completed from the file using a subagent.
99999999999999. If you find inconsistencies in the specs/* then use an Opus 4.5 subagent with 'ultrathink' requested to update the specs.
999999999999999. IMPORTANT: Keep @AGENTS.md operational only — status updates and progress notes belong in `IMPLEMENTATION_PLAN.md`. A bloated AGENTS.md pollutes every future loop's context.
```

### Prompt Structure

| Section              | Purpose                                              |
|----------------------|------------------------------------------------------|
| Phase 0 (0a, 0b, 0c)| Orient: study specs, source location, current plan   |
| Phase 1–4            | Main instructions: task, validation, commit          |
| 999... numbering     | Guardrails/invariants (higher number = more critical)|

---

## 5. AGENTS.md Template

```markdown
## Build & Run
Succinct rules for how to BUILD the project

## Validation
Run these after implementing:
- Tests: `[test command]`
- Typecheck: `[typecheck command]`
- Lint: `[lint command]`

## Operational Notes
Succinct learnings about how to RUN the project

### Codebase Patterns
```

Rules:
- NOT a changelog or progress diary (~60 lines, operational only)
- Contains loopback/self-evaluation commands (build, test, typecheck, lint)
- Status/progress belongs in `IMPLEMENTATION_PLAN.md`

---

## 6. IMPLEMENTATION_PLAN.md

- Prioritized bullet-point list from gap analysis (specs vs code)
- Created via PLANNING mode, updated during BUILDING mode
- **Can be regenerated** — Geoff: "I have deleted the TODO list multiple times"
- Self-correcting — building mode can create new specs if missing
- No pre-specified template — let LLM dictate format
- The circularity is intentional: eventual consistency through iteration

---

## 7. loop.sh (Actual Source — `files/loop.sh`, 70 lines)

```bash
#!/bin/bash
# Usage: ./loop.sh [plan] [max_iterations]
if [ "$1" = "plan" ]; then
    MODE="plan"
    PROMPT_FILE="PROMPT_plan.md"
    MAX_ITERATIONS=${2:-0}
elif [[ "$1" =~ ^[0-9]+$ ]]; then
    MODE="build"
    PROMPT_FILE="PROMPT_build.md"
    MAX_ITERATIONS=$1
else
    MODE="build"
    PROMPT_FILE="PROMPT_build.md"
    MAX_ITERATIONS=0
fi

ITERATION=0
CURRENT_BRANCH=$(git branch --show-current)

# ... status display, prompt file verification ...

while true; do
    if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then break; fi

    cat "$PROMPT_FILE" | claude -p \
        --dangerously-skip-permissions \
        --output-format=stream-json \
        --model opus \
        --verbose

    git push origin "$CURRENT_BRANCH" || { git push -u origin "$CURRENT_BRANCH"; }

    ITERATION=$((ITERATION + 1))
done
```

### CLI Flags
- `-p` — headless/pipe mode
- `--dangerously-skip-permissions` — YOLO mode (requires sandbox)
- `--output-format=stream-json` — structured output
- `--model opus` — can also use sonnet for speed
- `--verbose` — detailed logging

### Max-iterations
Limits outer loop iterations (tasks attempted), NOT tool calls within a task. Each iteration = one fresh context = one task = one commit.

---

## 8. Building Mode Loop Lifecycle (10 Steps)

1. **Orient** — subagents study `specs/*`
2. **Read plan** — study `IMPLEMENTATION_PLAN.md`
3. **Select** — pick most important task
4. **Investigate** — subagents study relevant `/src` ("don't assume not implemented")
5. **Implement** — N subagents for file operations
6. **Validate** — 1 subagent for build/tests (backpressure)
7. **Update IMPLEMENTATION_PLAN.md** — mark done, note discoveries
8. **Update AGENTS.md** — if operational learnings
9. **Commit** — `git add -A && git commit && git push`
10. **Loop ends** → context cleared → next iteration fresh

---

## 9. Context Management

- **200K+ tokens advertised ≈ 176K truly usable**
- **40–60% context utilization = "smart zone"**
- Tight tasks + 1 task per loop = 100% smart zone utilization
- Use main agent/context as scheduler, spawn subagents for actual work
- Each subagent gets ~156KB that's garbage collected after completion
- Context loaded each iteration: `PROMPT.md` + `AGENTS.md` + `specs/*`
- **Fresh context per iteration** — no accumulated drift
- Simplicity and brevity win — verbose inputs degrade determinism
- Prefer markdown over JSON for token efficiency

---

## 10. Steering: Signs and Gates

### Steer Upstream (Signs)
- Allocate first ~5,000 tokens for specs
- Every loop's context allocated with same files (deterministic)
- Existing code shapes what gets generated
- Add/update utilities to steer toward correct patterns
- Signs = anything Ralph can discover: prompt guardrails, AGENTS.md, utilities in codebase

### Steer Downstream (Gates)
- Tests, typechecks, lints, builds reject invalid work
- PROMPT.md says "run tests" generically; AGENTS.md specifies actual commands
- LLM-as-judge for subjective criteria (creative quality, aesthetics, UX)

### "Tune It Like a Guitar"
- Observe failure patterns → add signs
- Philosophy: observe → course-correct → iterate
- Escape hatches: Ctrl+C, `git reset --hard`, regenerate plan

---

## 11. Key Language Patterns (Geoff's Specific Phrasing)

- **"study"** (not "read" or "look at")
- **"don't assume not implemented"** (critical — the Achilles' heel)
- **"using parallel subagents"** / **"up to N subagents"**
- **"only 1 subagent for build/tests"** (backpressure control)
- **"Think extra hard"** (now "Ultrathink")
- **"capture the why"**
- **"keep it up to date"**
- **"if functionality is missing then it's your job to add it"**
- **"resolve them or document them"**

---

## 12. Concepts & Terminology

| Term                   | Definition                                                     |
|------------------------|----------------------------------------------------------------|
| Job to be Done (JTBD)  | High-level user need or outcome                                |
| Topic of Concern       | A distinct aspect/component within a JTBD                      |
| Spec                   | Requirements doc for one topic of concern (`specs/FILENAME.md`)|
| Task                   | Unit of work derived from comparing specs to code              |
| Activity (enhancement) | Verb in a journey ("upload photo") vs capability ("color extraction") |

Relationships:
- 1 JTBD → multiple topics of concern
- 1 topic of concern → 1 spec
- 1 spec → multiple tasks

Topic Scope Test: **"One Sentence Without 'And'"** — Can you describe the topic of concern in one sentence without conjoining unrelated capabilities?

---

## 13. Enhancement: Acceptance-Driven Backpressure

### Architecture: Three-Phase Connection

```
Phase 1: Requirements Definition
    specs/*.md + Acceptance Criteria
    ↓
Phase 2: Planning (derives test requirements)
    IMPLEMENTATION_PLAN.md + Required Tests
    ↓
Phase 3: Building (implements with tests)
    Implementation + Tests → Backpressure
```

### Phase 1: Requirements Definition
- Discuss JTBD → break into topics of concern
- Define acceptance criteria — observable, verifiable outcomes
- Keep criteria behavioral (outcomes), not implementation (how)
- Acceptance criteria become foundation for test derivation in planning

### Phase 2: Planning Mode Enhancement
Add to PROMPT_plan.md instruction 1:
```
For each task in the plan, derive required tests from acceptance criteria in specs - what specific outcomes need verification (behavior, performance, edge cases). Tests verify WHAT works, not HOW it's implemented. Include as part of task definition.
```

### Phase 3: Building Mode Enhancement
Add to PROMPT_build.md instruction 1:
```
Tasks include required tests - implement tests as part of task scope.
```

New guardrail:
```
999. Required tests derived from acceptance criteria must exist and pass before committing.
```

### The Prescriptiveness Balance
- Acceptance criteria (in spec) = Observable behaviors
- Required tests (in plan) = WHAT to verify
- Implementation approach (up to Ralph) = Technical decisions

**Key: "Specify WHAT to verify (outcomes), not HOW to implement (approach)"**

---

## 14. Enhancement: Non-Deterministic Backpressure (LLM Review)

For subjective criteria: creative quality, aesthetic judgments, UX quality, content appropriateness.

### `src/lib/llm-review.ts` — Binary Pass/Fail API

```typescript
interface ReviewResult {
  pass: boolean;
  feedback?: string;
}

function createReview(config: {
  criteria: string;      // What to evaluate (behavioral, observable)
  artifact: string;      // Text content OR screenshot path
  intelligence?: "fast" | "smart";  // defaults to 'fast'
}): Promise<ReviewResult>;
```

- **Multimodal**: text evaluation or vision evaluation (auto-detects .png/.jpg)
- **Intelligence levels**: `fast` (Gemini Flash — cheap/quick), `smart` (GPT — nuanced judgment)
- **Discovery**: Ralph learns from `llm-review.test.ts` examples during `src/lib` exploration (Phase 0c)

### Test Examples (from `llm-review.test.ts`)

```typescript
// Text evaluation
const result = await createReview({
  criteria: "The text should be a valid haiku with 5-7-5 syllable structure",
  artifact: "An old silent pond / A frog jumps into the pond / Splash! Silence again"
});

// Vision evaluation
const result = await createReview({
  criteria: "The button should have sufficient color contrast for accessibility",
  artifact: "/path/to/screenshot.png"
});

// Smart intelligence
const result = await createReview({
  criteria: "The marketing copy should feel authentic and avoid corporate jargon",
  artifact: marketingText,
  intelligence: "smart"
});
```

### Philosophy
**"Deterministically bad in an undeterministic world"** — the loop provides eventual consistency.

### Prompt Modifications
Planning: "Identify whether verification requires programmatic validation or human-like judgment... explore src/lib for non-deterministic evaluation patterns"

Building guardrail:
```
9999. Create tests to verify implementation meets acceptance criteria and include both conventional tests and perceptual quality tests.
```

---

## 15. Enhancement: Ralph-Friendly Work Branches

### Why: Scoping at Plan Creation (Deterministic) NOT Task Selection (Probabilistic)
- Wrong approach: ask Ralph to "filter" tasks at runtime → unreliable (70–80%)
- Right approach: create scoped plan upfront per work branch

### Workflow

1. **Full Planning** (on main): `./loop.sh plan`
2. **Create Work Branch**: `git checkout -b ralph/user-auth-oauth`
3. **Scoped Planning**: `./loop.sh plan-work "user authentication system with OAuth and session management"`
4. **Build from Plan**: `./loop.sh`
5. **PR Creation**: user creates PR normally

### Work-Scoped Loop Script (Enhanced `loop.sh`)
Adds `plan-work` mode:
- Validates branch (not main/master)
- Warns about uncommitted `IMPLEMENTATION_PLAN.md` changes
- Exports `WORK_SCOPE` env var
- Uses `envsubst` for prompt substitution
- MAX_ITERATIONS defaults to 5 for plan-work

### PROMPT_plan_work.md Template
Identical to PROMPT_plan.md but adds scoping:
```
IMPORTANT: This is SCOPED PLANNING for "${WORK_SCOPE}" only. Create a plan containing ONLY tasks directly related to this work scope. Be conservative - if uncertain whether a task belongs to this work, exclude it. The plan can be regenerated if too narrow. Plan only. Do NOT implement anything. Do NOT assume functionality is missing; confirm with code search first.

ULTIMATE GOAL: We want to achieve the scoped work "${WORK_SCOPE}". Consider missing elements related to this work and plan accordingly. If an element is missing, search first to confirm it doesn't exist, then if needed author the specification at specs/FILENAME.md.
```

---

## 16. Enhancement: JTBD → Story Map → SLC Release

### Topics of Concern → Activities
Reframe topics as verbs in a journey:
- Topics: "color extraction", "layout engine" → capability-oriented
- Activities: "upload photo", "see extracted colors", "arrange layout" → journey-oriented

### Activities → User Journey (Story Map)
```
UPLOAD    →   EXTRACT    →   ARRANGE     →   SHARE

basic         auto           manual          export
bulk          palette        templates       collab
batch         AI themes      auto-layout     embed
```

### User Journey → Release Slices
Horizontal slices through the map:
```
                  UPLOAD    →   EXTRACT    →   ARRANGE     →   SHARE

Release 1:        basic         auto                           export
                  ───────────────────────────────────────────────────
Release 2:                      palette        manual
                  ───────────────────────────────────────────────────
Release 3:        batch         AI themes      templates       embed
```

### SLC Criteria (Jason Cohen)
- **Simple** — Narrow scope you can ship fast
- **Complete** — Fully accomplishes a job within that scope (not a broken preview)
- **Lovable** — People actually want to use it
- Why SLC over MVP? MVPs optimize for learning at the customer's expense

### Operationalizing with Ralph

**Requirements Phase:**
1. Define audience + JTBDs → `AUDIENCE_JTBD.md`
2. Define activities per JTBD → `specs/*.md` (one per activity)

**Planning Phase (Updated PROMPT_plan_slc.md):**
```
0a. Study @AUDIENCE_JTBD.md to understand who we're building for and their Jobs to Be Done.
0b. Study `specs/*` with up to 250 parallel Sonnet subagents to learn JTBD activities.
0c. Study @IMPLEMENTATION_PLAN.md (if present) to understand the plan so far.
0d. Study `src/lib/*` with up to 250 parallel Sonnet subagents to understand shared utilities & components.
0e. For reference, the application source code is in `src/*`.

1. Sequence the activities in `specs/*` into a user journey map for the audience in @AUDIENCE_JTBD.md. Consider how activities flow into each other and what dependencies exist.

2. Determine the next SLC release. Use up to 500 Sonnet subagents to compare `src/*` against `specs/*`. Use an Opus subagent to analyze findings. Ultrathink. Given what's already implemented recommend which activities (at what capability depths) form the most valuable next release. Prefer thin horizontal slices - the narrowest scope that still delivers real value. A good slice is Simple (narrow, achievable), Lovable (people want to use it), and Complete (fully accomplishes a meaningful job, not a broken preview).

3. Use an Opus subagent (ultrathink) to analyze and synthesize the findings, prioritize tasks, and create/update @IMPLEMENTATION_PLAN.md as a bullet point list sorted in priority of items yet to be implemented for the recommended SLC release. Begin plan with a summary of the recommended SLC release (what's included and why), then list prioritized tasks for that scope.

IMPORTANT: Plan only. Do NOT implement anything.

ULTIMATE GOAL: We want to achieve the most valuable next release for the audience in @AUDIENCE_JTBD.md.
```

### Cardinalities
- One audience → many JTBDs
- One JTBD → many activities
- One activity → can serve multiple JTBDs

---

## 17. Enhancement: AskUserQuestion for Planning

During Phase 1 (Define Requirements):
- Invoke: "Interview me using AskUserQuestion to understand [JTBD/topic/acceptance criteria/...]"
- Flow: Start with known info → Claude interviews → Iterate until clear → Write specs → Proceed
- No code/prompt changes needed — uses existing Claude Code capabilities

---

## 18. Sandbox Environments

**Security philosophy: "It's not if it gets popped, it's when. And what is the blast radius?"**

### Primary Options

| Provider              | Isolation          | Cold Start | Max Duration | Best For              |
|-----------------------|--------------------|------------|--------------|----------------------|
| Sprites (Fly.io)      | Firecracker microVM| <1s        | Persistent   | Long-running agents  |
| E2B                   | Firecracker microVM| ~150ms     | 24h (Pro)    | AI agent loops       |
| Modal                 | gVisor container   | 2–5s       | 24h          | Python ML workloads  |
| Cloudflare            | Container          | 1–5s       | Configurable | Edge apps            |
| Daytona               | Container          | ~90ms      | Configurable | Dev environments     |
| Google Cloud Run      | gVisor/microVM     | 2–5s       | 60min/req    | Serverless           |
| Replit                | Agent 3            | N/A        | 200min       | Autonomous coding    |

### Docker Local Sandbox

```bash
docker sandbox run claude                  # Basic
docker sandbox run -w ~/my-project claude  # Custom workspace
docker sandbox run claude "your task"      # With prompt
docker sandbox run claude -c               # Continue last session
```

- `--dangerously-skip-permissions` enabled by default
- Base image: Node.js, Python 3, Go, Git, Docker CLI, GitHub CLI, ripgrep, jq

### Recommendations
- **Production/Multi-tenant**: E2B (pre-built Claude template, 24h sessions, Firecracker isolation)
- **Long-Running Persistent**: Sprites (no time limits, transactional snapshots, auto-sleep)
- **Local Development**: Docker Sandboxes (free, unlimited duration)

---

## 19. Mapping to ralph-loop Extension

| Ralph Playbook Concept              | ralph-loop Equivalent                   | Notes                                                    |
|--------------------------------------|-----------------------------------------|----------------------------------------------------------|
| `loop.sh` outer loop                | Async generator orchestrator            | Replace bash with VS Code extension lifecycle            |
| `cat PROMPT.md \| claude -p`         | Copilot Agent Mode invocation           | 3-level fallback: sendChatRequest → commands → CLI       |
| Fresh context per iteration          | Fresh Copilot session per task          | Already implemented                                      |
| `IMPLEMENTATION_PLAN.md`             | Task DAG / task list                    | Consider file-based state like Ralph                     |
| `AGENTS.md`                          | `.github/copilot-instructions.md`       | Loaded automatically by Copilot                          |
| `specs/*`                            | PRD.md / specs directory                | Already have PRD.md                                      |
| Max-iterations                       | Circuit breaker                         | Already implemented                                      |
| Signs (upstream steering)            | Nudge system, prompt engineering        | Already implemented                                      |
| Gates (downstream backpressure)      | TDD gates, diff validation              | Already implemented                                      |
| 999... guardrails                    | Prompt guardrails in orchestrator       | Consider adopting numbering convention                   |
| `git add -A && git commit`           | Atomic git commits (gitOps)             | Already implemented                                      |
| Subagents for parallel work          | N/A (Copilot doesn't expose this)       | Primary gap — single-threaded execution                  |
| `git push` after each iteration      | Not implemented                         | Consider adding optional auto-push                       |
| Work branches (`ralph/*`)            | Not implemented                         | Consider scoped planning per branch                      |
| LLM-as-judge review                  | Not implemented                         | Could add as optional gate                               |
| Acceptance-driven backpressure       | Partially (TDD gates)                   | Could enhance with spec-derived test requirements        |
| `AUDIENCE_JTBD.md`                   | Not applicable                          | Extension doesn't do product planning                    |
| Stagnation → regenerate plan         | Stagnation detector                     | Already implemented                                      |
| `git reset --hard` escape hatch      | Circuit breaker abort                   | Already implemented                                      |

### Key Gaps to Address

1. **File-based state persistence**: Ralph's `IMPLEMENTATION_PLAN.md` is elegant — survives crashes, readable by humans, editable. Consider adopting this pattern instead of in-memory state.
2. **Prompt structure**: Adopt Phase 0/1-4/999... structure for orchestrator prompts.
3. **"Don't assume not implemented"**: Critical instruction to include in Copilot prompts.
4. **Auto-push after commit**: Simple but valuable — keeps remote in sync.
5. **Work branch scoping**: Deterministic scoping at plan creation, not runtime filtering.
6. **LLM review gate**: For subjective quality criteria beyond test pass/fail.

---

## 20. Key Takeaways for ralph-loop

1. **Simplicity over sophistication** — Ralph's power comes from dumb repetition with fresh context, not clever orchestration. ralph-loop may be over-engineering some aspects.

2. **File-based state is the killer feature** — `IMPLEMENTATION_PLAN.md` as shared state between iterations is brilliantly simple. It survives crashes, is human-readable, and the LLM naturally understands it.

3. **The "smart zone" matters** — Keep prompts tight, tasks small. Don't try to do too much per iteration.

4. **Backpressure is the control mechanism** — Tests/lints/typechecks are the real governance, not prompt complexity. The prompt just says "run tests"; AGENTS.md says which commands.

5. **Plan is cheap, iteration is expensive** — Invest in good specs and plans up front. When Ralph circles, regenerate the plan rather than trying to fix behavior in-flight.

6. **"Don't assume not implemented"** — The single most important instruction. Without it, the LLM will rewrite existing code from scratch.

7. **Guardrail numbering (999...)** — Higher numbers = more critical. Elegant way to signal priority without restructuring the prompt.
