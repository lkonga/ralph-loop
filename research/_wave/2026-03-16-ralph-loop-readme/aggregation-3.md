## Aggregation Report 3

### Source Reports

**research-7.md — Knowledge & Session Persistence**
- Key findings: Two-layer knowledge system (KnowledgeManager + HarvestPipeline), tag-based extraction (`[LEARNING]`/`[GAP]`), MD5 hash deduplication, keyword-overlap retrieval, GC with staleness archival, session persistence via `.ralph/session.json` with atomic writes and triple-guard isolation (version, workspace, PID).

**research-8.md — Presets & Strategy System**
- Key findings: Four named presets (general/feature/bugfix/refactor) with layered config resolution (`DEFAULT ← preset ← user`), GoF Strategy pattern for task execution (CopilotCommandStrategy active, DirectApiStrategy stub), pure decision functions extracted for testability (`shouldContinueLoop`, `shouldNudge`, `shouldRetryError`).

**research-9.md — CLI Tool**
- Key findings: Standalone Node.js CLI (`cli/ralph.ts`) with three commands (`status`, `next`, `init`), shares PRD parsing/verification logic with the extension, zero external CLI dependencies, read-only operations (never triggers the loop), registered via `package.json` `bin` field.

### Deduplicated Findings

#### Knowledge System Architecture
Ralph-loop implements a **compounding learning system** across loop iterations via two complementary subsystems in `src/knowledge.ts`: [source: research-7.md#L7-L23]

1. **KnowledgeManager** (original layer) — extracts `[LEARNING]`/`[GAP]` tags from AI output, persists to `knowledge.md`, retrieves relevant entries via keyword-overlap filtering (≥2 matching words of ≥4 chars from task description, capped at `maxInjectLines`).
2. **HarvestPipeline** (Task 58 upgrade) — composable 4-stage pipeline: `extract → dedup → categorize → persist`. Uses MD5 content hashes embedded as HTML comments for deduplication, keyword-based categorization into `fix`/`pattern`/`gap`/`context` categories.

**Integration note**: The orchestrator currently uses KnowledgeManager, not HarvestPipeline. Both coexist in the same file. [source: research-7.md#L86-L87]

#### Knowledge Garbage Collection
`KnowledgeGC` prevents unbounded knowledge growth via staleness-first archival then score-based cap enforcement: [source: research-7.md#L30-L37]
- Tracks per-entry metadata (`hits`, `createdAtRun`, `lastHitRun`) in `knowledge-meta.json`
- Archives stale entries (0 hits beyond threshold) to `knowledge-archive.md`
- Defaults: trigger every 10 runs, max 200 entries, staleness threshold 20 runs
- **Gap**: No visible call site in orchestrator — may not be wired into the main loop yet. [source: research-7.md#L85-L86]

#### Prompt Integration for Learnings
`buildPrompt()` in `src/prompt.ts` accepts optional `learnings` parameter, inserting a `PRIOR LEARNINGS` section (boxed with `===`) after `AVAILABLE CAPABILITIES`. Context trimming drops learnings beyond the `abbreviatedUntil` iteration threshold. Template system supports `{{learnings}}` variable. [source: research-7.md#L46-L51]

#### Session Persistence
Resumable loop state via `.ralph/session.json`: [source: research-7.md#L53-L66]
- Serializes: task index, iteration/nudge/retry counts, circuit breaker state, session ID, PID, workspace path
- **Atomic writes**: tmp-file + rename pattern prevents corruption
- **Triple isolation guard**: version check, workspace path match, PID liveness check (`process.kill(pid, 0)`)
- 24-hour expiration default; version-gated loading (only `CURRENT_VERSION = 1`)

#### Preset System
Four named presets provide task-type-specific configuration overrides: [source: research-8.md#L7-L15]

| Preset | Purpose | Key Tuning |
|--------|---------|------------|
| `general` | Balanced defaults | No overrides |
| `feature` | Higher retry tolerance, strict TDD | `maxNudgesPerTask: 5`, `maxIterations: 30` |
| `bugfix` | Aggressive error tracking | 3min inactivity timeout, circuit breakers enabled |
| `refactor` | Higher stagnation tolerance | `maxNudgesPerTask: 6`, `maxStaleIterations: 4` |

Resolution order: `DEFAULT_CONFIG ← preset.overrides ← user overrides ← { workspaceRoot }`. Merge is **shallow** — nested objects replaced wholesale. [source: research-8.md#L17-L20]

**UI gap**: PRD task 64 specifies `ralph-loop.preset` as a VS Code setting, but `package.json` has no `contributes.configuration` entry for it. [source: research-8.md#L22-L23]

#### Strategy Pattern for Task Execution
Two `ITaskExecutionStrategy` implementations in `src/strategies.ts`: [source: research-8.md#L27-L38]
- **CopilotCommandStrategy** (active) — drives Copilot via VS Code commands, watches for file changes and PRD checkbox completion via filesystem watchers + 5-second polling
- **DirectApiStrategy** (stub) — throws immediately; forward-looking placeholder for `chatProvider` proposed API

#### Decision Functions
Three pure functions in `src/decisions.ts` extracted for testability: [source: research-8.md#L40-L51]
- `shouldContinueLoop()` — stop if: requested, no tasks, or iteration limit
- `shouldNudge()` — nudge if task incomplete and under nudge cap
- `shouldRetryError()` — retry only transient network errors under `MAX_RETRIES_PER_TASK` (3)

**Drift risk**: Only `shouldRetryError` is imported by the orchestrator; the other two have inline equivalents that have evolved beyond the extracted functions. [source: research-8.md#L72-L73]

#### CLI Tool
Standalone Node.js CLI (`cli/ralph.ts`) with three commands: [source: research-9.md#L5-L14]
- `ralph status [--prd <path>]` — PRD progress counts + per-task checklist
- `ralph next [--prd <path>]` — next pending task description
- `ralph init [--prd <path>]` — scaffold a blank PRD template

Manual `process.argv` parsing (no CLI framework). Global install via `npm link` or `npm install -g ralph-loop`. Read-only operations — never modifies existing PRDs or triggers the loop. [source: research-9.md#L22-L30]

**Code reuse**: Imports `readPrdSnapshot`, `pickNextTask`, `resolvePrdPath`, `progressSummary` from the extension's `src/prd.ts` and `src/verify.ts` — single source of truth, no duplication. [source: research-9.md#L35-L37]

### Cross-Report Patterns

**1. Composable architecture with clear separation of concerns** (HIGH CONFIDENCE — 3 reports)
All three subsystems follow the same architectural principle: clean module boundaries with focused responsibilities. Knowledge system separates extraction/dedup/categorization/persistence. Presets separate configuration from execution. CLI separates inspection from orchestration. [source: research-7.md#L72-L78] [source: research-8.md#L55-L64] [source: research-9.md#L35-L37]

**2. Testability-first design** (HIGH CONFIDENCE — 2 reports)
Pure decision functions extracted from the orchestrator for unit testing without VS Code. Knowledge types use plain readonly interfaces. CLI reuses core logic rather than reimplementing. [source: research-8.md#L61-L62] [source: research-9.md#L35-L37]

**3. Sensible defaults with progressive override** (HIGH CONFIDENCE — 3 reports)
Knowledge system has balanced defaults (15 lines, 200 max entries). Presets cascade `DEFAULT ← preset ← user`. CLI defaults to `PRD.md` and `process.cwd()`. Users get working behavior out of the box with tuning available at every layer. [source: research-7.md#L79-L82] [source: research-8.md#L17-L20] [source: research-9.md#L16-L18]

**4. Implementation gaps vs PRD specifications** (MEDIUM CONFIDENCE — 2 reports)
HarvestPipeline exists but isn't wired into the orchestrator (still uses KnowledgeManager). GC has no visible call site. Preset VS Code setting not in `package.json`. Decision functions partially abandoned. These suggest the codebase has architectural scaffolding ahead of full integration. [source: research-7.md#L85-L91] [source: research-8.md#L22-L23]

**5. Read-only external interfaces** (MEDIUM CONFIDENCE — 2 reports)
Session persistence is internal (read/write) but the CLI is intentionally read-only — it inspects but never drives. This creates a safe boundary: automation lives exclusively in the VS Code extension, external tools can only observe. [source: research-9.md#L41-L42] [source: research-7.md#L53-L66]

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Knowledge system (compounding learning) | **High** — key differentiator | Low (document existing) | [research-7.md#L7-L50](research-7.md#L7-L50) |
| Preset taxonomy (general/feature/bugfix/refactor) | **High** — user-facing workflow selection | Low (document existing) | [research-8.md#L7-L23](research-8.md#L7-L23) |
| CLI companion tool | **High** — standalone utility, CI/CD use | Low (document existing) | [research-9.md#L5-L30](research-9.md#L5-L30) |
| Session persistence (crash recovery) | **Medium** — reliability story | Low (document existing) | [research-7.md#L53-L66](research-7.md#L53-L66) |
| Strategy pattern extensibility | **Medium** — architecture feature | Low (document existing) | [research-8.md#L27-L38](research-8.md#L27-L38) |
| Knowledge GC and archival | **Medium** — maturity indicator | Low (document existing) | [research-7.md#L30-L37](research-7.md#L30-L37) |
| Pure decision function pattern | **Low** — internal design detail | Low (mention briefly) | [research-8.md#L40-L51](research-8.md#L40-L51) |
| Implementation gaps (pipeline/GC/preset UI) | **Low** — internal state | N/A (omit from README) | [research-7.md#L85-L91](research-7.md#L85-L91), [research-8.md#L22-L23](research-8.md#L22-L23) |

### Gaps

1. **GC wiring verification**: Research-7 flagged KnowledgeGC having no visible call site in the orchestrator. Need to verify if it's triggered elsewhere (e.g., post-run hook or separate script) before documenting it as a feature.

2. **CLI test coverage**: Research-9 found no direct tests for `cli/ralph.ts` — argument parsing, exit codes, and output formatting are untested. Underlying functions are tested via `src/` tests.

3. **Preset programmatic-only access**: The preset system is fully functional but only accessible programmatically (via `resolveConfig()`), not through VS Code settings UI. The README should document the programmatic API without promising a settings UI.

4. **HarvestPipeline vs KnowledgeManager coexistence**: Both exist in `src/knowledge.ts` but only KnowledgeManager is used by the orchestrator. Unclear if HarvestPipeline is the intended replacement or a parallel system. README should document the active system (KnowledgeManager) and mention the pipeline as an advanced/emerging feature.

5. **Session persistence save timing**: Research-7 noted `save()` call is not visible in the orchestrator excerpt — need to verify mid-loop saves occur for crash recovery to be effective (not just cleanup on exit).

### Sources
- research-7.md — Knowledge & Session Persistence system analysis
- research-8.md — Presets, strategies, and decision function analysis
- research-9.md — CLI tool analysis
