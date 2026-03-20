## Aggregation Report 2

### Source Reports

**research-4.md** — Compaction-Related Git History Changes (v0.38 → v0.41)
- Identified **three distinct compaction systems**: Responses API (server-side), Background Compaction (client-side), and Foreground Summarization (fallback) [source: research-4.md#L11-L16]
- Documented four key configuration settings governing compaction behavior [source: research-4.md#L27-L32]
- Mapped the dual-threshold approach for background compaction (75% kick-off, 95% blocking) [source: research-4.md#L47-L52]
- Traced CHANGELOG evidence from v0.32 through v0.40 showing compaction evolution [source: research-4.md#L58-L69]
- Identified architecture flow and progressive compaction hierarchy [source: research-4.md#L89-L101]

### Deduplicated Findings

1. **Three-tier compaction hierarchy**: Server-side Responses API compaction (preferred) → background client-side summarization → foreground client-side summarization (fallback). Server-side disables client-side entirely via mutual exclusion. [source: research-4.md#L11-L16]

2. **Responses API compaction threshold**: `compact_threshold = Math.floor(endpoint.modelMaxPromptTokens * 0.9)` with fallback `50000`. Excludes `gpt-5`, `gpt-5.1`, `gpt-5.2`. Uses opaque encrypted round-trip data via `CompactionDataContainer`. [source: research-4.md#L36-L42]

3. **Background compaction dual-threshold state machine**:
   - Budget calculation: `budgetThreshold = Math.floor((baseBudget - toolTokens) * 0.85)`
   - ≥95% context + InProgress → block and wait
   - ≥95% context + Completed → apply immediately
   - ≥75% context + Idle/Failed → kick off background compaction
   - State machine: `Idle → InProgress → Completed/Failed → (consumeAndReset) → Idle`
   [source: research-4.md#L44-L55]

4. **Configuration flags**: `chat.backgroundCompaction` (experiment, default false), `chat.responsesApiContextManagement.enabled` (experiment, default false), `chat.summarizeAgentConversationHistory.enabled` (default true), `chat.advanced.summarizeAgentConversationHistoryThreshold` (optional override). [source: research-4.md#L27-L32]

5. **Foreground summarization fallback**: Triggered on `BudgetExceededError` during prompt rendering. Falls back through: try with `triggerSummarize: true` → render without cache breakpoints. [source: research-4.md#L56-L57]

6. **Key files**: `agentIntent.ts` (orchestration), `backgroundSummarizer.ts` (state machine), `responsesApi.ts` (server-side), `compactionDataContainer.tsx` (data round-trip), `openai.ts` (API integration). [source: research-4.md#L11-L16]

7. **v0.38 introduced `/compact` slash command** and Claude agent compaction rendering. Plans persist across compaction via session memory. [source: research-4.md#L60-L64]

8. **Telemetry instrumentation**: Every compaction decision path emits telemetry events (`backgroundSummarizationApplied`, `triggerSummarizeFailed`). [source: research-4.md#L107]

### Cross-Report Patterns

N/A — Single source report in this aggregation group.

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Dual-threshold background compaction (75%/95%) | High — prevents context overflow while avoiding premature compaction | Medium — state machine implementation | [research-4.md#L44-L55](research-4.md#L44-L55) |
| Server-side vs client-side mutual exclusion | High — architectural decision for compaction strategy | Low — boolean guard | [research-4.md#L36-L42](research-4.md#L36-L42) |
| 0.85 budget safety margin | Medium — empirical tuning value for compaction trigger | Low — single constant | [research-4.md#L45](research-4.md#L45) |
| Experiment gating for rollout | Medium — risk mitigation for new compaction paths | Low — flag checks | [research-4.md#L105-L106](research-4.md#L105-L106) |
| `/compact` slash command for user-triggered compaction | Medium — user control over compaction timing | Low — command wiring | [research-4.md#L60-L64](research-4.md#L60-L64) |

### Gaps

- No direct git diff available — exact commit-by-commit changes between v0.38 and v0.41 remain unknown
- Experiment rollout percentages for `BackgroundCompaction` and `ResponsesApiContextManagement` not determined
- Threshold tuning rationale (data-driven vs heuristic) not established
- Interaction between user-triggered `/compact` and automatic background compaction unclear
- Model exclusion rationale for gpt-5 family not explained

### Sources

- research-4.md (Compaction-related git history changes v0.38 → v0.41: three compaction systems, thresholds, and architecture)
