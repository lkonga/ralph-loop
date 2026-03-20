## Aggregation Report 1

### Source Reports

**research-2.md** — Compaction Algorithm Implementation
- Deep dive into the three compaction mechanisms: manual `/compact`, automatic foreground summarization, and background compaction
- Documents the LLM-based summarization algorithm (full vs simple modes)
- Details the dual-threshold background compaction approach (75%/95%)
- Covers summary persistence, rendering, budget calculation, and pre-compact hooks
[source: research-2.md#L1-L5]

**research-4.md** — Compaction-Related Git History Changes (v0.38 → v0.41)
- Inventories all compaction-related files and configuration settings
- Documents the Responses API server-side compaction system (90% threshold)
- Traces the evolution of compaction features from v0.32 through v0.41
- Maps the progressive compaction hierarchy and experiment gating
[source: research-4.md#L1-L5]

**NOTE**: research-1.md and research-3.md were requested but do not exist in the wave directory. This aggregation covers research-2.md and research-4.md only.

### Deduplicated Findings

#### 1. Three-Tier Compaction Architecture
The codebase implements a **progressive compaction hierarchy** with mutual exclusion:
1. **Server-side (Responses API)** — Preferred when available. Sends `context_management` with `compact_threshold = floor(modelMaxPromptTokens * 0.9)` to the API; server returns encrypted compaction data round-tripped via `CompactionDataContainer`. Model exclusions: `gpt-5`, `gpt-5.1`, `gpt-5.2`. [source: research-4.md#L30-L38]
2. **Background client-side** — Dual-threshold state machine (`BackgroundSummarizer`): ≥75% context → speculative start; ≥95% → blocking wait; Completed → immediate apply. [source: research-2.md#L30-L40]
3. **Foreground client-side** — Synchronous fallback when `BudgetExceededError` is thrown during prompt rendering. [source: research-2.md#L22-L28]

When server-side compaction is active, client-side summarization is fully disabled. [source: research-4.md#L37-L38] [source: research-2.md#L48-L50]

#### 2. LLM-Based Summarization (Not Algorithmic)
Conversation history is re-sent to the LLM with a structured summarization prompt, not algorithmically compressed. Two modes:
- **Full mode** (`ConversationHistorySummarizationPrompt`): Detailed 8-section summary structure (Overview, Technical Foundation, Codebase Status, Problem Resolution, Progress Tracking, Active Work State, Recent Operations, Continuation Plan). Uses `tool_choice: 'none'`. [source: research-2.md#L56-L66]
- **Simple mode** (`SimpleSummarizedHistory`): Fallback with text truncation — tool results halved, arguments capped at 200 chars, `PrioritizedList` packing. Used for model switches or failed prior summarizations. [source: research-2.md#L68-L74]

#### 3. Summarization Boundary Logic
`SummarizedConversationHistoryPropsBuilder.getProps()` determines what to summarize:
- Multiple tool call rounds in current turn → exclude last round, summarize up to second-to-last
- Single/zero rounds → summarize from last round of previous turn, mark as `isContinuation`
- Summary anchors to a specific `toolCallRoundId`; everything before is replaced in prompt rendering
[source: research-2.md#L77-L83]

#### 4. Summary Persistence and Rendering
- In-memory: `round.summary = summaryText` on the identified round
- Persistence: `turn.resultMetadata.summaries[]`
- Restoration: `normalizeSummariesOnRounds()` re-applies each request start
- Rendering: `ConversationHistory.render()` replaces summarized turns with `<conversation-summary>` tag; all preceding turns discarded
- Optional transcript JSONL lookup via `ReadFile` tool (gated behind `ConfigKey.ConversationTranscriptLookup`)
[source: research-2.md#L85-L100]

#### 5. Budget Calculation
```
baseBudget = min(configOverride ?? modelMaxPromptTokens, modelMaxPromptTokens)
budgetThreshold = floor((baseBudget - toolTokens) * 0.85)
```
85% safety margin applied. Summary rejected if `summaryTokens > effectiveBudget`. [source: research-2.md#L106-L112]

#### 6. Configuration and Experiment Gating
| Setting | Default | Purpose |
|---------|---------|---------|
| `chat.backgroundCompaction` | `false` (experiment) | Enables background dual-threshold compaction |
| `chat.responsesApiContextManagement.enabled` | `false` (experiment) | Enables server-side Responses API compaction |
| `chat.summarizeAgentConversationHistory.enabled` | `true` | Enables foreground summarization |
| `chat.advanced.summarizeAgentConversationHistoryThreshold` | `undefined` | Token threshold override |
[source: research-4.md#L20-L28]

#### 7. Pre-Compact Hook
A `PreCompact` hook is executed before summarization via `chatHookService.executeHook('PreCompact', ...)`, enabling transcript archival or cleanup. [source: research-2.md#L102-L103]

#### 8. Feature Evolution Timeline
- **v0.32** (~2025-08): First introduction of foreground summarization
- **v0.38** (2026-03-05): `/compact` slash command, Claude agent compaction improvements, session memory surviving compaction
- **v0.39+**: Background compaction system and Responses API context management (experiment-gated)
[source: research-4.md#L62-L76]

### Cross-Report Patterns

1. **Dual-threshold background compaction (75%/95%)** — Confirmed independently in both reports with identical details. High confidence. [source: research-2.md#L30-L40] [source: research-4.md#L42-L50]

2. **Mutual exclusion of server-side and client-side compaction** — Both reports independently document that Responses API compaction disables client-side summarization. High confidence. [source: research-2.md#L48-L50] [source: research-4.md#L37-L38]

3. **State machine pattern** (`Idle → InProgress → Completed/Failed`) — Consistent across both reports. [source: research-2.md#L34-L36] [source: research-4.md#L49]

4. **Experiment gating for newer features** — Both reports confirm `BackgroundCompaction` and `ResponsesApiContextManagement` are behind experiment flags, suggesting active A/B testing. [source: research-2.md#L131] [source: research-4.md#L86-L87]

5. **Budget safety margins** — Both reports reference the 0.85 multiplier for budget threshold and the 0.9 compact threshold for Responses API. [source: research-2.md#L106-L112] [source: research-4.md#L89]

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Dual-threshold background compaction (75%/95%) | High — core async compaction logic | Medium — state machine + threshold tuning | [research-2.md#L30-L40](research-2.md#L30-L40), [research-4.md#L42-L50](research-4.md#L42-L50) |
| Server-side vs client-side mutual exclusion | High — architectural decision | Low — feature flag toggle | [research-2.md#L48-L50](research-2.md#L48-L50), [research-4.md#L37-L38](research-4.md#L37-L38) |
| LLM-based summarization with full/simple fallback | High — compaction quality | High — prompt engineering + fallback chain | [research-2.md#L56-L74](research-2.md#L56-L74) |
| PreCompact hook integration point | Medium — extensibility | Low — single hook call | [research-2.md#L102-L103](research-2.md#L102-L103) |
| Budget calculation (85% safety margin) | Medium — prevents overflow | Low — single formula | [research-2.md#L106-L112](research-2.md#L106-L112), [research-4.md#L89](research-4.md#L89) |
| Transcript JSONL lookup fallback | Low — gated feature | Low — optional retrieval | [research-2.md#L97-L100](research-2.md#L97-L100) |

### Gaps

1. **Missing reports**: research-1.md and research-3.md were requested but do not exist — their topics are unknown and may contain critical findings not covered here
2. **Summary quality metrics**: Neither report provides data on how well compacted summaries preserve critical information (semantic fidelity)
3. **Telemetry data**: Both reports note rich telemetry but neither provides actual metrics on compaction frequency, success rates, or threshold hit rates
4. **User experience impact**: No data on how compaction affects perceived response quality or conversation coherence from the user's perspective
5. **Recursive summarization**: Research-2 notes the code explicitly chose not to implement recursive summarization over chunks — no analysis of whether this is a limitation in practice
6. **Exact git diffs**: Research-4 acknowledges inability to run `git log` directly, so precise commit-level changes between versions are missing

### Sources
- research-2.md (Compaction Algorithm Implementation — mechanisms, LLM summarization, persistence, budget)
- research-4.md (Compaction Git History Changes v0.38→v0.41 — file inventory, config settings, evolution timeline, architecture flow)
