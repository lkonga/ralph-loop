# Ralph-Starter Architecture Analysis

> Source: `multivmlabs/ralph-starter` (npm v0.4.5, TypeScript 98.6%, 238 commits, MIT)
> Purpose: Extract patterns applicable to ralph-loop VS Code extension development.

## 1. Core Loop Engine (`src/loop/executor.ts`, ~1712 lines)

### Loop Flow
```
runLoop(LoopOptions) → LoopResult
  ├─ Initialize: CircuitBreaker, RateLimiter, ProgressTracker, CostTracker
  ├─ Detect validation commands (lint, build, test)
  ├─ Load project memory (.ralph/memory.md)
  ├─ Build spec summary for later iterations
  ├─ FOR each iteration 1..maxIterations:
  │   ├─ Check circuit breaker → break if tripped
  │   ├─ Check rate limiter → wait if throttled
  │   ├─ Parse IMPLEMENTATION_PLAN.md → get current task + progress
  │   ├─ Build iteration context (progressive trimming)
  │   ├─ Run agent (subprocess or SDK)
  │   ├─ Detect completion (RALPH_COMPLETE file, .ralph-done, all [x])
  │   ├─ Check file changes (filesystem snapshot diff)
  │   ├─ Task-aware stall detection (consecutiveIdleIterations)
  │   ├─ Tiered validation (lint intermediate, build final)
  │   ├─ Record circuit breaker success/failure
  │   ├─ Auto-commit if enabled
  │   ├─ Cost tracking per iteration
  │   └─ Append iteration log (.ralph/iteration-log.md)
  └─ Return LoopResult with stats
```

### Key Design Decisions

**Completion Detection**: Single-pass `detectCompletionWithReason()` checks multiple signals:
- File markers: `RALPH_COMPLETE`, `.ralph-done`
- Output markers: `<TASK_DONE>`, `<TASK_COMPLETE>`, `TASK COMPLETED`
- Plan markers: All `[x]` checked in IMPLEMENTATION_PLAN.md
- Blocked markers: `<TASK_BLOCKED>`, `Cannot proceed`

**Dynamic Iteration Budget**: Auto-adjusts `maxIterations` when the plan expands mid-loop.

**Stall Detection**: Tracks `consecutiveIdleIterations` by checking: file changes + task progress + validation failures + design activity. Not just "no output" — semantic analysis of whether forward progress occurred.

**Filesystem Quiescence**: `waitForFilesystemQuiescence()` waits for FS to settle before declaring completion. Prevents race conditions with async file writes.

### Applicability to ralph-loop
- **ralph-loop already has**: Loop states, task parsing from PRD, circuit breakers
- **Should adopt**: Tiered validation (lint vs build), iteration memory log, filesystem quiescence, dynamic iteration budget, multi-signal completion detection

---

## 2. Circuit Breaker (`src/loop/circuit-breaker.ts`, 189 lines)

### Architecture
```typescript
CircuitBreakerConfig {
  maxConsecutiveFailures: 3    // default
  maxSameErrorCount: 5         // default
  cooldownMs: 30000            // default 30s
}

CircuitBreakerState {
  consecutiveFailures: number
  errorHistory: Map<string, number>  // hash → count (never cleared by success)
  isOpen: boolean
  lastFailure?: Date
  totalFailures: number              // never reset by success
}
```

### Error Hashing (Deduplication)
Normalizes errors before hashing with MD5 (first 8 chars):
- Hex addresses → `HEX`
- Stack traces → `STACK`
- Timestamps → `TIMESTAMP` (BEFORE `:line:col` to avoid mangling)
- File:line:col → `:N:N`
- Lowercase + trim + truncate to 500 chars

### Key Behavior
- `recordSuccess()`: Resets consecutiveFailures to 0, but does NOT clear errorHistory
- `recordFailure()`: Increments consecutive + total, hashes error, checks trip condition
- `isTripped()`: Returns false after cooldown expires (half-open state allows retry)
- Trip reasons: "N consecutive failures" OR "Same error repeated N times"

### Preset-Specific Thresholds
| Preset | Consecutive | Same-Error | Rationale |
|--------|-------------|------------|-----------|
| feature | 3 | 5 | Balanced |
| tdd-red-green | 5 | 3 | Red-green cycles look like failures |
| refactor | 2 | 3 | Tight guardrails |
| incident-response | 2 | 2 | Must work fast or escalate |
| migration-safety | 1 | 2 | Strictest — data loss risk |

### Applicability to ralph-loop
- ralph-loop has circuit breakers but uses a different pattern (MaxRetriesBreaker, MaxNudgesBreaker, etc.)
- **Should adopt**: Error hashing/deduplication (same error repeated detection), cooldown with half-open retry, preset-specific thresholds, the distinction between "consecutive failures" and "same error accumulation across the entire loop"

---

## 3. Context Builder (`src/loop/context-builder.ts`, 484 lines)

### Progressive Context Trimming Strategy
```
Iteration 1:  Full spec + skills + full implementation plan + preamble
Iteration 2-3: Abbreviated spec summary + current task only + compressed feedback
Iteration 4+:  Current task only + 500-char error summary + spec key points
```

### Key Interfaces
```typescript
ContextBuildOptions {
  fullTask, taskWithSkills, currentTask, taskInfo,
  iteration, maxIterations, validationFeedback,
  maxInputTokens, specSummary, iterationLog, ...
}
BuiltContext {
  prompt: string
  estimatedTokens: number
  wasTrimmed: boolean
  debugInfo: string
}
```

### Token Budget Enforcement
- `estimateTokens()`: ~4 chars/token for prose, ~3.5 for code
- Semantic trimming: Cuts at paragraph/line boundaries, never mid-instruction
- `compressValidationFeedback()`: Strips ANSI, truncates to maxChars

### Iteration Memory
- `appendIterationLog()`: Writes to `.ralph/iteration-log.md` after each iteration
- `readIterationLog()`: Returns last N entries for context injection on iterations 2+
- Gives agent inter-iteration memory without session continuity

### Applicability to ralph-loop
- **Critical pattern**: Progressive context trimming is essential for token efficiency
- ralph-loop should implement equivalent windowing in its prompt builder
- Iteration log pattern maps well to ralph-loop's prompt.ts

---

## 4. Cost Tracking (`src/loop/cost-tracker.ts`, 593 lines)

### Model Pricing
15+ models with per-million-token pricing (input/output/cache-write/cache-read):
- Claude 4.5 Sonnet: $3/$15
- Claude 4 Sonnet: $3/$15
- Claude 3 Opus: $15/$75
- GPT-4: $30/$60
- Gemini, Grok, DeepSeek, Qwen, etc.

### CostTracker Class
```typescript
CostTracker(config: { model, maxIterations, maxCost?, planBudget? })

Methods:
  recordIteration(input, output)       // Estimate tokens from text
  recordIterationWithUsage(usage)      // Direct token counts + cache metrics
  recordVisionCall()
  getStats() → CostTrackerStats
  isOverBudget() → boolean
  formatStats() → string              // Human-readable
  formatSummary() → string            // Markdown table for activity.md
  getPlanPercentage() → number        // % of plan budget used
```

### CostTrackerStats
```typescript
{
  totalIterations, totalTokens, totalCost,
  avgTokensPerIteration, avgCostPerIteration,
  projectedCost,      // After 3+ iterations, extrapolates
  totalCacheSavings   // Tracks prompt caching savings
}
```

### Budget Controls
- `maxCost`: Hard USD ceiling → exit with `cost_ceiling` reason
- `PlanBudget`: { name, monthlyLimit } — pro=$100, max=$200, team=$150
- `getPlanPercentage()`: Shows % of monthly plan consumed

### Applicability to ralph-loop
- ralph-loop doesn't directly call LLMs (Copilot handles this), so per-token tracking is less relevant
- **Should adopt**: Iteration cost estimation for user visibility, projected cost warnings, budget ceiling concept (iteration count as proxy for cost)

---

## 5. Multi-Agent Swarm (`src/loop/swarm.ts`, 440 lines)

### Three Strategies
1. **Race**: Parallel execution via `Promise.allSettled()`, first success wins, uses git worktrees for isolation
2. **Consensus**: All agents run, compare outputs, pick best result
3. **Pipeline**: Sequential chain (Agent A builds → Agent B reviews/fixes), shared worktree

### Agent Adapter Pattern (`src/loop/agents.ts`, 394 lines)
```typescript
AgentType = 'claude-code' | 'cursor' | 'codex' | 'opencode' | 'openclaw' | 'amp' | 'anthropic-sdk' | 'opencode-sdk' | 'amp-sdk'

runAgent(agent, options): Promise<AgentResult>
  → Switch on agent.type
  → Build CLI args per agent
  → Dispatch to runSubprocessAgent() or SDK-specific runners

AgentRunOptions {
  task, cwd, auto, maxTurns, model, env, timeoutMs,
  onOutput, streamOutput, headless, apiKey, ampMode
}
```

### Subprocess Management
- Spawns child process per agent
- Silence detection: 30s warning, 60s timeout
- Output collection and streaming
- Agent availability detection: `detectAvailableAgents()`, `detectBestAgent()`

### Applicability to ralph-loop
- ralph-loop uses VS Code Copilot as its sole agent (not subprocess-based)
- **Relevant**: The concept of agent availability detection, timeout/silence monitoring maps to ralph-loop's nudge mechanism, the pipeline strategy concept (build → review) could apply to multi-phase tasks

---

## 6. Integration Pattern (`src/integrations/`)

### Base Interface
```typescript
Integration {
  name, displayName, description, website, authMethods
  isAvailable(): Promise<boolean>
  fetch(options): Promise<IntegrationResult[]>
}
WritableIntegration extends Integration {
  listTasks(), createTask(), updateTask(), closeTask(), addComment()
}
AuthMethod = 'cli' | 'api-key' | 'oauth' | 'none'
```

### GitHub Integration (394 lines)
- Auth: Prefers `gh` CLI → falls back to API token
- Read: GitHub Search API with `is:issue` filter
- Write: All via `gh` CLI (createTask, closeTask, addComment)
- URL parsing: handles `github.com/owner/repo`, `owner/repo`, issue URLs

### Linear Integration (720 lines)
- Auth: Linear CLI → API key → OAuth (PKCE)
- API: GraphQL at `https://api.linear.app/graphql`
- Complex resolvers: resolveTeamId, resolveLabelIds, resolveStateId, resolveAssigneeId
- IssueFilter: project/team/label/status grouping

### Notion Integration (589 lines)
- Read-only (no WritableIntegration)
- Auth: `none` for public pages, `api-key` for private
- Public fetch: HTML → markdown conversion
- Private: Notion API v2022-06-28, full block pagination, recursive child fetching

### Applicability to ralph-loop
- ralph-loop's PRD source is local files; integrations are less critical now
- **Should adopt**: The `Integration` + `WritableIntegration` interface pattern for future extensibility (fetching tasks from GitHub Issues, Linear, etc.)

---

## 7. Preset/Config System (`src/presets/`, `src/config/`)

### PresetConfig
```typescript
{
  name, description, maxIterations, validate, commit,
  completionPromise?, promptPrefix?, rateLimit?,
  circuitBreaker?: { maxConsecutiveFailures, maxSameErrorCount }
}
```

### Notable Presets
- `spec-driven`: Reads spec files, marks tasks complete, 40 iterations
- `tdd-red-green`: Red-green-refactor cycle, 50 iterations
- `migration-safety`: Strictest circuit breaker (1 consecutive failure stops)
- `scientific-method`: Hypothesis-driven, 40 iterations
- `gap-analysis`: Compare spec to implementation, 20 iterations

### Custom Presets
`loadCustomPresets(cwd)` reads `.ralph/presets/*.json` — user-defined presets per project.

### Config Manager
```typescript
RalphConfig {
  llm?: { provider, model }
  providers?: { anthropic, openai, openrouter }
  agent?: { default, usesClaudeCodeCLI }
  setupCompleted?, setupVersion?
}
// Stored in ~/.ralph/config.json
```

### Applicability to ralph-loop
- **Should adopt**: Preset concept for ralph-loop strategies (VS Code settings → presets). The custom presets pattern (per-project `.ralph/presets/`) maps well to VS Code workspace settings.

---

## 8. Session Persistence (`src/loop/session.ts`, 353 lines)

### SessionState
```typescript
{
  id, createdAt, updatedAt, status, iteration, maxIterations,
  task, cwd, agent,
  options: { validate, commit, push, pr, trackProgress, trackCost, model },
  commits: string[],
  stats: { totalDuration, validationFailures, costStats? },
  pauseReason?, error?, lastValidationFeedback?,
  exitReason: 'completed' | 'blocked' | 'max_iterations' | 'circuit_breaker' | 'rate_limit' | 'file_signal' | 'paused'
}
```

### Capabilities
- `saveSession()`: Persists to `.ralph-session.json`
- `loadSession()`: Restores full state
- `resumeSession()`: Reconstructs agent, calculates remaining iterations
- `canResume()`: Validates session is in resumable state

### Applicability to ralph-loop
- ralph-loop should implement session persistence for pause/resume across VS Code restarts
- The exit reason taxonomy is valuable — ralph-loop should adopt similar categorization

---

## 9. Task Management (`src/loop/task-counter.ts`, 213 lines)

### Plan Parsing
Parses `IMPLEMENTATION_PLAN.md` in two formats:
1. Hierarchical: `### Task N: Title` headers + `- [ ] subtask` checkboxes
2. Flat: Simple checkbox list

### Key Functions
- `parsePlanTasks()`: Returns structured task list with completion status
- `getCurrentTask()`: First uncompleted task
- `calculateOptimalIterations()`: Smart iteration count based on task complexity
- `estimateTasksFromContent()`: Estimate task count from spec when no plan exists
- Mtime-based caching to avoid redundant file reads

### Applicability to ralph-loop
- ralph-loop already has PRD parsing in `prd.ts`
- **Should adopt**: Dynamic iteration estimation, mtime-based cache for file reads

---

## 10. Project Memory (`src/loop/memory.ts`, 75 lines)

### Design
- Persistent file: `.ralph/memory.md` (survives across `ralph run` invocations)
- Max size: 8KB to keep context window usage reasonable
- Functions: `readProjectMemory()`, `appendProjectMemory()`, `formatMemoryPrompt()`
- Injected into agent context on each run

### Applicability to ralph-loop
- Could implement per-workspace memory for learning project conventions
- Useful for accumulating "what works" across loop runs

---

## Key Architectural Patterns Summary

| Pattern | ralph-starter | ralph-loop Status | Action |
|---------|--------------|-------------------|--------|
| Progressive context trimming | 3-tier (full → abbreviated → minimal) | Not implemented | **Adopt** |
| Error hash deduplication | MD5 of normalized error text | Not implemented | **Adopt** |
| Tiered validation | Lint intermediate, build final | Not implemented | **Adopt** |
| Iteration memory log | `.ralph/iteration-log.md` | Not implemented | **Adapt** (use VS Code output channel) |
| Filesystem quiescence | Wait for FS to settle | Not implemented | **Adopt** |
| Dynamic iteration budget | Auto-expand when plan grows | Not implemented | **Adopt** |
| Multi-signal completion | File markers + output + plan state | Partial (PRD checkbox) | **Enhance** |
| Preset system | 15+ workflow presets | Uses strategies.ts | **Enhance** |
| Session persistence | `.ralph-session.json` | Not implemented | **Adopt** |
| Cost tracking | Per-iteration token estimation | Not applicable (Copilot) | **Skip** (track iteration count instead) |
| Project memory | `.ralph/memory.md`, 8KB cap | Not implemented | **Consider** |
| Error normalization order | Timestamps BEFORE :line:col | Not implemented | **Adopt** in circuit breaker |
