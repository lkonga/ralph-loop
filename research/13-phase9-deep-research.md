---
type: research
id: 13
phase: 9
date: 2026-03-14
sources:
  - vercel-labs/ralph-loop-agent
  - mikeyobrien/ralph-orchestrator
  - ClaytonFarr/ralph-playbook
  - mj-meyer/choo-choo-ralph
  - aymenfurter/ralph
  - vscode-copilot-chat
methodology: wave-explore-fast-direct x12 + github_repo + crawl4ai
derived_specs: [14]
tags: [context-management, knowledge-harvest, thrashing-detection, plan-regeneration, backpressure, search-gate, workflow-presets, cooldown, fs-signals, session-isolation]
---

# Phase 9 Deep Research: Implementation Patterns for Tasks 61-74

## Research Sources

| Source | Key Patterns Found |
|--------|-------------------|
| `vercel-labs/ralph-loop-agent` | `RalphContextManager`: token estimation (chars/3.5), LRU file eviction, iteration summarization, budget tracking (files/changeLog/summaries), context-aware tool wrappers |
| `mikeyobrien/ralph-orchestrator` | `EventSignature` fingerprinting (hash-based stale loop), `LoopThrashing` termination after 3 redispatches, task-level block counts, `MarkdownMemoryStore` with budget-aware truncation |
| `ClaytonFarr/ralph-playbook` | "plan is disposable" regeneration, "don't assume not implemented" search gate, backpressure-driven convergence, subagent-based search before implementation |
| `mj-meyer/choo-choo-ralph` | Label-based harvest (`learnings`/`learnings-harvested`), 6-step pipeline (query→enrich→scan→dedup→date→plan), TOML formula system for composable pipelines |
| `aymenfurter/ralph` | `CountdownTimer` (12s default, webview SVG), `InactivityMonitor` (60s, 10s check interval), `ActivityWatcher` via FileSystemWatcher |
| `vscode-copilot-chat` | `showQuotaExceededDialog` delegates to VS Code command, 2s git checkout cooldown, no auto-accept timer in VS Code API (need `Promise.race` pattern) |
| Anthropic Context Editing API | Server-side `clear_tool_uses_20250919` + `clear_thinking_20251015`, `clear_at_least` threshold, cache invalidation on clear, Memory Tool (`memory_20250818`) |

---

## 1. Context/Token Management (Task 61)

### Key Findings

**vercel-labs/ralph-loop-agent `RalphContextManager`** is the primary reference:

```typescript
interface RalphContextConfig {
  maxContextTokens?: number;       // Default: 150,000
  changeLogBudget?: number;        // Default: 5,000
  fileContextBudget?: number;      // Default: 50,000
  maxFileChars?: number;           // Default: 30,000
  enableSummarization?: boolean;   // Default: true
  recentIterationsToKeep?: number; // Default: 2
  summarizationModel?: LanguageModel;
}
```

**Token estimation**: `estimateTokens(text) = Math.ceil(text.length / 3.5)` — conservative chars-to-tokens approximation

**Budget tracking**: `getTokenBudget()` returns `{ total, used: { files, changeLog, summaries }, available }`

**Summarization trigger**: When `totalTokens > maxContextTokens * 0.7`, older iterations get summarized to 2-3 sentences via LLM call

**LRU eviction**: `evictFilesIfNeeded()` sorts tracked files by `lastAccessed` and removes oldest until under budget

**Context-aware tools**: `createContextAwareTools()` wraps readFile/writeFile/editFile to automatically track file operations

**Compaction vs handoff** (from Anthropic docs):
- **Compaction**: Server-side context editing clears tool results and thinking blocks. Client-side SDK compaction generates summaries replacing full history. Good for long single-task iterations
- **Handoff**: Ralph-loop's current approach — fresh chat session per task. Clean context but loses iteration history within a task

### Key Insight for ralph-loop

Ralph-loop operates DIFFERENTLY from `ralph-loop-agent`. Ralph-loop gets one Copilot chat session per task, with iterations within that session. The token budget concern is:
1. Within a single task's iterations, context grows (iteration history, nudges, retry prompts)
2. Ralph-loop's `prompt.ts` already has 3-tier progressive trimming (full → abbreviated → minimal)
3. Anthropic's context editing operates at the VS Code Copilot layer, transparently to ralph-loop
4. Ralph-loop doesn't need its own full context manager — it needs **token awareness annotations** injected into prompts

### Two Approaches (per user request)

**Approach A: Memories + Compaction + Pruning**
- Read VS Code settings for context editing mode (`github.copilot.chat.anthropic.contextEditing.mode`)
- Inject token budget awareness into prompt ("you have ~X tokens remaining")
- Use prompt-level progressive trimming (already exists) enhanced with iteration history
- Complement rather than compete with server-side context editing

**Approach B: Token Logging + Handoff to New Session**
- Track iteration count and prompt size growth
- When estimated context usage exceeds threshold, trigger "mid-task handoff"
- Save current state to session file, stop current chat, start new chat with state summary
- Simpler but requires reliable state serialization

---

## 2. Knowledge Harvest (Task 64)

### Key Findings

**choo-choo-ralph** has the most complete harvest pattern:
- Label-based state tracking (`learnings` / `learnings-harvested`)
- 6-step pipeline: query → enrich with git → scan existing docs for dedup → categorize → date → generate harvest plan
- Dedup by scanning existing documentation (substring match, not embeddings)
- Skip criteria: already documented, too specific, actually bugs/fixes
- Output categorization: technology patterns → `docs/<tech>.md`, repeated workflows → skills, critical guidance → root config

**ralph-orchestrator** uses typed memories (`MemoryType::Pattern | Decision | Fix | Context`) with budget-aware injection and configurable filters

### Implementation Design

The harvest phase runs **after each completed task** (not in-context during task execution). It:
1. Reads new `[LEARNING]` and `[GAP]` entries from the task's output
2. Scans existing `knowledge.md` for dedup (substring matching)
3. Categorizes: operational learnings vs pattern discoveries vs gap identifications
4. Appends deduplicated entries
5. Optionally consolidates related entries into summaries

This is an **upgrade over current [LEARNING] tag extraction**, composable as a pipeline stage:
```
Extract → Dedup → Categorize → Score → Persist
```

Each stage is a pure function `(entries: Learning[]) → Learning[]` — toggleable and configurable.

---

## 3. Knowledge GC (Task 65)

### Key Findings

**No repo implements automated GC.** The closest patterns:
- `ralph-orchestrator`: `truncate_to_budget()` limits injected context, `memory delete <id>` manual only
- `ralph-playbook`: Implicit GC via constraint — "bloated AGENTS.md pollutes every future loop's context"
- `choo-choo-ralph`: Harvest marks entries as processed, but never deletes — promotes to skills/docs

### Run-Count Based Design

```typescript
interface GCPolicy {
  triggerEveryNRuns: number;   // e.g., every 10 completed loops
  maxEntries: number;          // hard cap, e.g., 200
  stalenessThreshold: number;  // N runs since last retrieval hit
}
```

- **Run counter**: Increment in `.ralph/meta.json` on each orchestrator completion
- **Trigger**: `runCount % triggerEveryNRuns === 0`
- **GC pass**: Score each learning by (a) retrieval hit count (how often `getRelevantLearnings` matched it), (b) age in run-count, (c) specificity
- **Archive**: Move low-scoring entries to `knowledge-archive.md` (not delete — recoverable)

---

## 4. Thrashing Detection (Task 66)

### Key Findings

**ralph-orchestrator** has the primary thrashing implementation:

```rust
pub enum TerminationReason {
    LoopThrashing,     // 3 redispatches of abandoned tasks
    LoopStale,         // Same event signature 3+ times consecutively
    // ...
}
```

**EventSignature fingerprinting**:
```rust
struct EventSignature {
    topic: String,
    source: Option<HatId>,
    payload_fingerprint: u64,  // hash of payload
}
```

**Backpressure signals table** (from orchestrator docs):
| Signal | Action |
|--------|--------|
| `build.done` without evidence | Synthesize `build.blocked` |
| 3 consecutive `build.blocked` | Emit `build.task.abandoned` |
| 3 redispatches of abandoned | Terminate with `LoopThrashing` |
| 3 consecutive `event.malformed` | Terminate with `ValidationFailure` |

**Task-level block counts**: Per-task tracking via `task_block_counts: HashMap<String, u32>` — tasks abandoned after 3+ blocks

### Ralph-loop Design

For ralph-loop, thrashing means the agent is editing the same file regions back and forth without net progress:

```typescript
interface ThrashingDetector {
  // Track file regions being edited
  recordEdit(file: string, regionHash: string): void;
  // Check if region has been edited N+ times
  isThrashing(): { thrashing: boolean; file?: string; editCount?: number };
  // Configurable thresholds
  config: {
    regionRepetitionThreshold: number;  // default: 3
    windowSize: number;                 // last N edits to consider
  };
}
```

Region hashing: Hash the file path + line range being edited. If the same region-hash appears 3+ times in the last N edits, it's thrashing.

Composable with existing `StagnationDetector` — thrashing is a sub-signal of stagnation (agent IS changing files but going in circles).

---

## 5. Plan Regeneration (Task 67)

### Key Findings

**ralph-playbook** is the canonical source:
- "Plan is disposable", "regeneration cost is one Planning loop"
- Plan regeneration is an explicit human action: switch to PLANNING mode, let loop re-plan
- Automated regeneration: "regenerate when Ralph is going off track"

**Escalation chain** currently in ralph-loop:
1. `nudge` (gentle redirect)
2. `AutoDecomposer` (split task into sub-tasks after 3 failures)
3. `skip` (move to next task)
4. `stop` (halt loop)

**Missing**: `regenerate` between `decompose` and `skip`

### Implementation: Composable Circuit Breaker Action

Add `regenerate` as a new `CircuitBreakerAction`:

```typescript
type CircuitBreakerAction = 'continue' | 'retry' | 'nudge' | 'regenerate' | 'skip' | 'stop';
```

New `PlanRegenerationBreaker` in the chain:
- Triggers after decomposition has been tried AND still failing
- Action: re-run bearings/planning phase with "previous approach failed" context
- Configurable: `maxRegenerations: number` (default: 1), `triggerAfterDecompFailures: number` (default: 2)

Escalation chain becomes: nudge → decompose → regenerate → skip → stop

---

## 6. Backpressure Classification (Task 68)

### Key Findings

**ralph-orchestrator's backpressure model**:
- `build.done` without evidence → synthesize `build.blocked` (NOT productive)
- Evidence checking: looks for "tests passed", "lint passed" keywords in output
- Consecutive blocked events → escalation

**Convergence metrics** (synthesized from multiple sources):
- Error count delta: decreasing = productive, flat/increasing = stagnant
- Test pass delta: increasing pass rate = productive
- Unique vs repeated errors: new errors = exploring (potentially productive), same errors = stuck
- Code change diversity: touching new files = productive, re-editing same lines = thrashing

### Ralph-loop Design

```typescript
interface BackpressureClassifier {
  classify(signals: StruggleSignal[]): 'productive' | 'stagnant' | 'thrashing';
}

// Convergence tracking
interface ConvergenceState {
  errorCountHistory: number[];     // last N error counts
  testPassHistory: number[];       // last N test pass counts
  uniqueErrorRatio: number;        // unique_errors / total_errors
  editDiversity: number;           // unique_files_edited / total_edits
}
```

Classification rules:
- `productive`: error count decreasing OR test pass count increasing
- `stagnant`: error count flat, same errors repeating
- `thrashing`: same file regions being re-edited (delegates to ThrashingDetector)

Composable with `StruggleDetector` — classifier sits on top, interprets signals rather than just detecting them.

---

## 7. Search-Before-Implement Gate (Task 69)

### Key Findings

**ralph-playbook** is explicit: "don't assume not implemented" — this is called the "Achilles' heel" of coding agents

Implementation pattern from ralph-playbook:
```
4. Investigate — subagents study relevant /src ("don't assume not implemented")
```

### Ralph-loop Design

**Tier 1 (Prompt Gate)**: Add instruction to prompt.ts:
```
Before implementing any new functionality:
1. Search the existing codebase for similar implementations
2. Check if the pattern already exists in a different form
3. Only implement new code if no existing implementation serves the purpose
```

**Tier 2 (Tracker Issue)**: Create GitHub issue for future tooling:
- Codebase search via grep/AST before each implementation step
- Reference library search via configured external repos/RAG
- This is deferred — just create the tracking issue

---

## 8. Workflow Presets (Task 70)

### Key Findings

**ralph-orchestrator** has the closest config pattern:
```yaml
memories:
  budget: 2000
  filter:
    recent: 30
    types: [fix, pattern]
```

**ralph-loop** already has `RalphConfig` and `RalphFeatures` with configurable fields.

### Design: Named Presets

```typescript
interface RalphPreset {
  name: string;
  config: Partial<RalphConfig>;
  features: Partial<RalphFeatures>;
}

const PRESETS: Record<string, RalphPreset> = {
  general: { /* balanced defaults — the smart general-purpose config */ },
  feature: { /* higher retry tolerance, TDD strict */ },
  bugfix:  { /* aggressive error tracking, lower timeout */ },
  refactor: { /* higher stagnation tolerance, conservative */ },
};
```

**General Default**: Current `DEFAULT_CONFIG` values with all Phase 9 features enabled at conservative thresholds. This IS the smart default.

Advanced options (DSL config, task-type auto-detection) deferred to tracker ticket.

---

## 9. Inter-Task Cooldown Dialog (Task 71)

### Key Findings

**aymenfurter/ralph**: `CountdownTimer` (12s), `InactivityMonitor` (60s), webview-based UI

**vscode-copilot-chat**: No auto-accept pattern. `showQuotaExceededDialog` delegates to VS Code commands. No countdown timers in dialogs.

**VS Code API limitation**: `showInformationMessage` has no auto-dismiss. Must use `Promise.race`:

```typescript
async function showAutoAcceptDialog(
  message: string, timeoutMs: number, buttons: string[]
): Promise<string | 'auto-accepted'> {
  const userChoice = vscode.window.showWarningMessage(message, ...buttons);
  const autoAccept = new Promise<'auto-accepted'>(resolve =>
    setTimeout(() => resolve('auto-accepted'), timeoutMs)
  );
  return Promise.race([userChoice, autoAccept]);
}
```

**Limitation**: Dialog stays visible after auto-accept (no programmatic dismiss API).

### Ralph-loop Design

During existing `LoopEventKind.Countdown` loop, add dialog:
1. Show `showInformationMessage` with buttons: "Pause", "Stop", "Edit Next Task"
2. Race against countdown timer
3. Auto-accept (continue to next task) if countdown wins
4. Handle button press if user clicks before timeout
5. Config: `ralph.cooldownSeconds` (default 12), `ralph.cooldownShowDialog` (default true)

---

## 10. Filesystem Activity Signal (Task 72)

### Key Findings

**aymenfurter/ralph**: `InactivityMonitor` at 60s, `ActivityWatcher` via `vscode.workspace.createFileSystemWatcher('**/*')`

**ralph-loop existing**: `strategies.ts` already has FileSystemWatcher + inactivity timeout, `inactivityTimeoutMs` in config

**vscode-copilot-chat**: 2s cooldown after git checkout (very short, specific use case)

### Threshold Recommendation

| Scenario | Threshold | Rationale |
|----------|-----------|-----------|
| Small JS/TS project | 90s | npm install + compile <60s |
| Medium compiled project | 120s | TypeScript/Rust 30-90s |
| Large monorepo | 180s | Full rebuilds, Docker |
| **Default** | **120s** | 2x original 60s, safe for most |

Make configurable: `ralph.inactivityTimeoutMs` (default 120000).

Graduated response:
- Warning at 50% threshold (log only)
- Action at full threshold (existing multi-button dialog)

---

## 11. Session Isolation (Task 74)

### Key Findings

**Atomic writes pattern** (well-established Node.js pattern):
```typescript
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}
```

**Session ID**: `crypto.randomUUID()` stored in session state, validated on load.

**Multi-window safety**: PID-based lock file or advisory locking.

### Ralph-loop Design

```typescript
interface SerializedLoopState {
  // existing fields...
  sessionId: string;          // NEW: UUID
  pid: number;                // NEW: process PID for lock checking
  workspacePath: string;      // NEW: workspace root for isolation
}
```

- Atomic writes: `writeFileSync(tmp)` → `renameSync(tmp, target)`
- Session ID: Generated on `startLoop()`, validated on `resumeLoop()`
- Lock check: Verify PID is still running before resuming (prevents cross-window interference)
