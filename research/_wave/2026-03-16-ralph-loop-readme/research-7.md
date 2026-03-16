## Research 7: Knowledge & Session Persistence

### Findings

#### Knowledge System (`src/knowledge.ts`)

The knowledge system provides **compounding learning across loop iterations** via two complementary subsystems:

**1. KnowledgeManager (original layer)**
- Constructor: `knowledgePath` (default `'knowledge.md'`), `maxInjectLines` (default 15)
- `extractLearnings(output)` — scans text for `[LEARNING]` tags (case-insensitive), returns stripped content
- `extractGaps(output)` — scans for `[GAP]` tags, returns content
- `persist(workspaceRoot, learnings, gaps)` — appends timestamped entries to `knowledge.md` under `## Learnings` / `## Gaps` sections; creates file with headers if missing
- `getRelevantLearnings(workspaceRoot, taskDescription)` — keyword-overlap filtering: splits task description into words >= 4 chars, matches learnings containing >= 2 keywords, returns up to `maxInjectLines` most recent

**2. HarvestPipeline (composable pipeline upgrade — Task 58)**
- Stages: `extract` → `dedup` → `categorize` → `persist` (configurable via `HarvestConfig.stages`)
- `extract()` — parses `[LEARNING]` and `[GAP]` tags into `KnowledgeEntry` objects with MD5 content hashes
- `dedup()` — removes entries whose hash already exists in `knowledge.md` via `<!-- hash:hex -->` annotations; also deduplicates within a batch
- `categorize()` — keyword classification: fix/resolve/error→`'fix'`, pattern/approach/strategy→`'pattern'`, `[GAP]`→`'gap'`, rest→`'context'`
- `persist()` — appends to `knowledge.md` with hash annotations for next-harvest dedup

**3. KnowledgeGC (garbage collection)**
- Governed by `GCPolicy`: `triggerEveryNRuns` (default 10), `maxEntries` (default 200), `stalenessThreshold` (default 20)
- Tracks per-entry metadata in `knowledge-meta.json`: hits, `createdAtRun`, `lastHitRun`
- `collectGarbage()` — archives stale entries (0 hits beyond staleness threshold), enforces max entry cap by score
- Moves archived entries to `knowledge-archive.md`, rewrites `knowledge.md` with kept entries only

**Types** (in `src/types.ts`):
- `KnowledgeEntry`: `{ content, category: KnowledgeCategory, timestamp, taskId, hash }`
- `KnowledgeCategory`: `'pattern' | 'fix' | 'context' | 'gap'`
- `KnowledgeConfig`: `{ enabled, path, maxInjectLines, harvest?: HarvestConfig }`
- `GCPolicy`: `{ triggerEveryNRuns, maxEntries, stalenessThreshold }`

#### Prompt Integration (`src/prompt.ts`)

- `buildPrompt()` accepts optional `learnings?: string[]` parameter
- When non-empty, inserts a `PRIOR LEARNINGS` section (boxed with `===` lines) after `AVAILABLE CAPABILITIES` as bullet points
- Context trimming applies: beyond `abbreviatedUntil` iteration threshold, learnings are dropped to save tokens
- Template system supports `{{learnings}}` variable for custom prompt templates

#### Session Persistence (`src/sessionPersistence.ts`)

- **Purpose**: Resumable loop state across process restarts
- **Storage**: `.ralph/session.json` in workspace root
- **Serialized state** (`SerializedLoopState`): `currentTaskIndex`, `iterationCount`, `nudgeCount`, `retryCount`, `circuitBreakerState`, `timestamp`, `version`, `sessionId`, `pid`, `workspacePath`
- **Atomic writes**: Uses tmp-file + rename pattern to prevent corruption
- **Session isolation**:
  - Rejects sessions from different workspace paths
  - Rejects sessions where the original PID is still alive (`isPidAlive()` via `process.kill(pid, 0)` — handles EPERM for permission-denied cases)
- **Expiration**: Default 24 hours (`DEFAULT_EXPIRE_MS = 86400000`)
- **Version gating**: Only loads sessions matching `CURRENT_VERSION = 1`
- Methods: `save()`, `load()`, `clear()`, `hasIncompleteSession()`

#### Orchestrator Integration (`src/orchestrator.ts`)

**Knowledge flow in the loop:**
1. Pre-task: `knowledgeManager.getRelevantLearnings()` retrieves keyword-filtered learnings → passed to `buildPrompt()` → injected as `PRIOR LEARNINGS` section
2. Post-task completion: reads `progress.txt`, calls `extractLearnings()` + `extractGaps()`, persists to `knowledge.md`

**Session persistence flow:**
1. Constructor: creates `SessionPersistence` instance if `config.sessionPersistence.enabled` (default true)
2. On loop exit (AllDone, MaxIterations, YieldRequested, Stopped): calls `sessionPersistence.clear()`
3. Config: `sessionPersistence?: { enabled: boolean; expireAfterMs: number }` on `RalphConfig`

#### Configuration Defaults
- Knowledge: `{ enabled: true, path: 'knowledge.md', maxInjectLines: 15, harvest: { stages: ['extract','dedup','categorize','persist'] } }`
- GC Policy: `{ triggerEveryNRuns: 10, maxEntries: 200, stalenessThreshold: 20 }`
- Session: `{ enabled: true, expireAfterMs: 86400000 }`

### Patterns

1. **Tag-based extraction**: AI output is scanned for special inline tags (`[LEARNING]`, `[GAP]`) — the AI model is prompted to emit these within its output, enabling structured knowledge capture from free-form text
2. **Hash-based deduplication**: MD5 content hashes embedded as HTML comments (`<!-- hash:hex -->`) in the markdown file serve double duty: dedup and GC metadata tracking
3. **Composable pipeline**: HarvestPipeline uses a stage-based architecture where stages can be toggled on/off via config, allowing flexible harvesting workflows
4. **Keyword-overlap retrieval**: Simple but effective — filters learnings by matching >= 2 words (>= 4 chars) from the task description. Not embedding-based, so zero external dependencies
5. **Atomic file writes**: Session persistence uses tmp+rename pattern; knowledge uses append-only writes
6. **Session isolation**: Triple guard — version check, workspace path match, PID liveness check — prevents stale/cross-workspace session conflicts
7. **Tiered GC**: Staleness-first archival, then score-based cap enforcement, with archived entries preserved in a separate file rather than deleted

### Applicability

- **README documentation**: The knowledge system is a key differentiating feature — it enables cross-session learning and should be prominently described
- The session persistence enables crash recovery and resumable loops — important for reliability documentation
- The harvest pipeline's composability and the GC system show maturity beyond a simple append-log
- Configuration surface is well-designed with sensible defaults — document the config options for users

### Open Questions

1. **GC integration gap**: `KnowledgeGC.runGC()` exists as a class but there's no visible call site in `orchestrator.ts` — is it triggered elsewhere, or is it not yet wired into the main loop?
2. **HarvestPipeline vs KnowledgeManager**: Both exist in the same file. The orchestrator uses `KnowledgeManager` (the original layer), not `HarvestPipeline`. Are they intended to coexist, or should one replace the other?
3. **Session persistence save**: The constructor sets up `SessionPersistence` and `clear()` is called on exit, but there's no visible `save()` call in the orchestrator excerpt read — need to verify if mid-loop saves happen for crash recovery
4. **Knowledge retrieval scoring**: The keyword-overlap approach (>= 2 matching words) is simple but may produce false positives/negatives — is there a plan for embedding-based retrieval?
