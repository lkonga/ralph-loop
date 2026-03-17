## Aggregation Report 3

### Source Reports

1. **research-7.md** — Streamlining custom verifiers into the research→spec→PRD pipeline. Key finding: spec frontmatter `verification` field is never parsed into `VerifierConfig[]`, `autoClassifyTasks` has only a single "test"→vitest rule, and `VerificationTemplate` is defined but unused. Proposes a `compileVerificationStrings()` compiler, extended keyword rules, and inline `[verify: ...]` annotations in PRD task descriptions.

2. **research-8.md** — Human-in-the-loop patterns across 7 external systems (Aider, Continue.dev, Cursor, Cline, AutoGen, CrewAI, LangGraph) and 4 Ralph ecosystem implementations. Key finding: mature systems use graduated escalation (retry→fallback→strategy change→circuit breaker→PAUSE) and deterministic gates as human proxies, avoiding per-action approval fatigue. Ralph Playbook's "human OVER the loop" philosophy and preset-driven trust levels are best-fit for ralph-loop.

3. **research-9.md** — Dependency-driven implicit checkpoints via `depends:` + verification failure. Key finding: dependencies work reliably only in parallel mode (`pickReadyTasks`); sequential mode (`pickNextTask`) ignores them entirely. The configurable `runVerifierChain()` is built but disconnected from the orchestrator's main loop. Pre-complete hooks are the only currently reliable gate mechanism.

### Deduplicated Findings

#### Verifier Infrastructure: Built but Disconnected

All three reports converge on the same critical gap: ralph-loop has a complete verifier registry (7 types), a resolution chain (`resolveVerifiers`), and a verification chain runner (`runVerifierChain`), but the orchestrator's main loop does not use them. [source: research-7.md#L13-L20] [source: research-9.md#L70-L75]

- The dual exit gate in the orchestrator only checks checkbox status + diff presence inline [source: research-9.md#L71-L75]
- `resolveVerifiers()` and `runVerifierChain()` are available but never invoked in the primary execution path [source: research-9.md#L72-L75]
- The `formatVerificationFeedback` function is imported but doesn't exist yet [source: research-7.md#L138-L139]

#### Spec Frontmatter → Runtime Verifier Gap

The `SpecFrontmatter.verification` field (e.g., `["npx tsc --noEmit", "npx vitest run"]`) is a human-readable list that is never compiled into machine-executable `VerifierConfig[]` objects. [source: research-7.md#L27-L39] This means the research→spec→PRD pipeline produces verification metadata that is used only as prompt context, never as runtime enforcement.

#### Sequential Mode Ignores Dependencies

`pickNextTask()` (sequential/default mode) returns the first pending task regardless of `dependsOn` annotations. Only `pickReadyTasks()` (parallel mode) respects the dependency graph. [source: research-9.md#L31-L36] This makes `depends:` annotations unreliable for most users since sequential is the default.

#### `autoClassifyTasks` Is Minimal

The entire auto-classification system is a single rule: if the task description contains "test", append a vitest verifier. No rules exist for file creation→fileExists, script execution→commandExitCode, compilation→tsc, or content generation→fileContains. [source: research-7.md#L41-L50]

#### Pre-Complete Hooks Are the Only Reliable Gate Today

Unlike the disconnected verifier chain, pre-complete hooks (`PreCompleteHookConfig`) ARE wired into the orchestrator and can reliably block completion via `action: 'retry'` or `action: 'stop'`. [source: research-9.md#L95-L98] This is the only currently-working mechanism for custom completion gates.

#### Graduated Escalation Is the Correct Model

Across all surveyed systems, the pattern of graduated escalation outperforms per-action approval: automated retry → fallback injection → strategy change → circuit breaker → human pause. [source: research-8.md#L93-L100] Ralph-loop already has nudges and circuit breakers; the missing terminal step is explicit human pause. [source: research-8.md#L117-L119]

#### Deterministic Gates Replace Human Approval

Ralph Playbook's core insight — tests, typechecks, and lints serve as human-approval proxies — aligns with the verifier registry's capability. If the verifier chain were wired in, tsc + vitest + fileExists would provide deterministic approval for most tasks without human intervention. [source: research-8.md#L106-L112] [source: research-7.md#L52-L64]

### Cross-Report Patterns

**Pattern A: Wire `runVerifierChain()` Into the Orchestrator** (3/3 reports, highest confidence)

All three reports independently identify the disconnected verifier chain as the critical integration gap. Research-7 maps the full resolution chain and proposes `compileVerificationStrings()` to feed it. Research-8 identifies deterministic gates as the correct human-approval proxy. Research-9 confirms the chain exists but is unused and recommends wiring it in.

- research-7: Verifier resolution chain documented, compilation function proposed [source: research-7.md#L13-L20]
- research-8: Deterministic gates as human proxy pattern [source: research-8.md#L106-L112]
- research-9: `runVerifierChain()` exists but is not called in main loop [source: research-9.md#L70-L75]

**Pattern B: Sequential Mode Must Respect Dependencies** (2/3 reports)

Research-9 documents the `pickNextTask()` vs `pickReadyTasks()` divergence. Research-8's analysis of dependency-driven checkpoints assumes dependencies are enforced, which they aren't in default mode. Fixing sequential mode to respect `dependsOn` is prerequisite for any dependency-based checkpoint strategy.

- research-9: Sequential path ignores dependencies entirely [source: research-9.md#L33-L36]
- research-8: Dependency-driven checkpoints assumed to work [source: research-8.md#L130-L133]

**Pattern C: Graduated Escalation With Terminal Human Pause** (2/3 reports)

Research-8 establishes the graduated escalation pattern across the ecosystem. Research-9 identifies that stagnation detection already fires `HumanCheckpointRequested` but the path is indirect and slow. The combination suggests: wire verifiers into the exit gate → verifier failure triggers targeted escalation → terminal step is explicit human pause.

- research-8: Graduated escalation chain pattern [source: research-8.md#L93-L100]
- research-9: Stagnation→HumanCheckpointRequested is slow and indirect [source: research-9.md#L88-L91]

**Pattern D: Spec Frontmatter Verification Should Compile to Runtime Config** (2/3 reports)

Research-7 proposes `compileVerificationStrings()` to bridge spec metadata and runtime. Research-9's verifier analysis confirms the infrastructure exists to receive compiled configs. The pipeline gap is purely a missing compiler step.

- research-7: Compilation function with pattern matching [source: research-7.md#L67-L80]
- research-9: Verifier registry accepts VerifierConfig[], just needs input [source: research-9.md#L52-L64]

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Wire `runVerifierChain()` into orchestrator exit gate | **Critical** — unlocks all verifier-based patterns | M — replace inline checks with resolution+chain call | [research-7.md#L13-L20](research-7.md#L13-L20), [research-9.md#L70-L75](research-9.md#L70-L75) |
| Fix sequential mode to respect `dependsOn` | **High** — prerequisite for reliable dependency checkpoints | S — add dependency check to `pickNextTask()` | [research-9.md#L31-L36](research-9.md#L31-L36) |
| Extend `autoClassifyTasks` rules (5+ keyword→verifier mappings) | **High** — immediate per-task verification without config | S — add regex patterns in `resolveVerifiers()` | [research-7.md#L41-L50](research-7.md#L41-L50), [research-7.md#L83-L95](research-7.md#L83-L95) |
| Add `compileVerificationStrings()` for spec frontmatter | **Medium** — enables pipeline-driven verifier config | S — standalone function, no interface changes | [research-7.md#L67-L80](research-7.md#L67-L80) |
| Implement preset-driven trust levels | **Medium** — maps human involvement to task risk | M — config schema + preset definitions | [research-8.md#L121-L124](research-8.md#L121-L124) |
| Add dependency cycle detection to `pickReadyTasks()` | **Medium** — prevents silent deadlocks | S — DFS cycle check on dependency graph | [research-9.md#L107-L109](research-9.md#L107-L109) |
| Add `DeadlockDetected` event | **Low** — improves diagnostics for dependency issues | S — check when pickReadyTasks returns empty with pending tasks | [research-9.md#L118-L120](research-9.md#L118-L120) |
| Unify pre-complete hooks and verifiers | **Low** — reduces gate duplication | L — architectural decision needed | [research-9.md#L127-L128](research-9.md#L127-L128) |

### Gaps

1. **No report analyzed the `HumanCheckpointRequested` event consumer side** — how does the VS Code extension surface a human pause? What UI is available? Research-8 asked this as an open question but none of the reports traced the event handler implementation.

2. **State persistence on pause is unexamined** — Research-8 mentions session state needs (`.ralph-session.json`) and VS Code lifecycle concerns, but no report traced what ralph-loop actually persists when `HumanCheckpointRequested` fires.

3. **Verifier performance impact is unknown** — wiring `runVerifierChain()` into every exit gate check means running tsc/vitest on every iteration. No report measured verifier execution time or discussed caching/throttling strategies.

4. **`parseTaskId()` naming mismatch** — Research-9 identifies that dependencies resolve against bold text or slugified descriptions, not sequential `Task-001` IDs. This usability issue could make dependency annotations unreliable in practice, but no report proposes a fix.

5. **No report covered multi-workspace or multi-session isolation** — if ralph-loop runs in multiple workspaces simultaneously, how do checkpoint states, approval files, and circuit breaker states stay isolated?

### Sources

- research-7.md — Streamlining custom verifiers into the research→spec→PRD pipeline
- research-8.md — Human-in-the-loop patterns in agent orchestration systems
- research-9.md — Dependency-driven implicit checkpoints via `depends:` + verification failure
