# Research Report: Compaction Algorithm Implementation

## Question
What is the compaction algorithm implementation — how does it compact conversation history and what logic determines the compacted output?

## Findings

### 1. Three Compaction Mechanisms

The codebase implements three distinct compaction pathways:

#### a) Manual `/compact` Command (Foreground)
- **Entry**: `AgentIntent.handleSummarizeCommand()` in `src/extension/intents/node/agentIntent.ts:210`
- User triggers via `/compact` slash command
- Calls `SummarizedConversationHistoryPropsBuilder.getProps()` to determine what to summarize
- Renders `SummarizedConversationHistory` prompt with `triggerSummarize: true`
- Result summary text is attached to the latest tool call round via `SummarizedConversationHistoryMetadata`

#### b) Automatic Foreground Summarization (Budget Exceeded)
- **Entry**: `AgentIntentInvocation.buildPrompt()` in `src/extension/intents/node/agentIntent.ts:~500`
- Triggered when `PromptRenderer.render()` throws `BudgetExceededError`
- Falls through to `renderWithSummarization()` which re-renders with `triggerSummarize: true`
- Gate: `ConfigKey.SummarizeAgentConversationHistory` must be enabled AND prompt must be `AgentPrompt`
- Disabled when Responses API context management is active (`isResponsesCompactionContextManagementEnabled`)

#### c) Background Compaction (Proactive)
- **Entry**: `AgentIntentInvocation.buildPrompt()` post-render checks, `_startBackgroundSummarization()`
- **State machine**: `BackgroundSummarizer` (`src/extension/prompts/node/agent/backgroundSummarizer.ts`)
  - States: `Idle → InProgress → Completed/Failed`
- **Dual-threshold approach**:
  - **≥75% context used, Idle/Failed**: Kick off background summarization speculatively
  - **≥95% context used, InProgress**: Block and wait for background result before rendering
  - **Completed (any ratio)**: Apply pre-computed result immediately before rendering
- Background work: snapshots current prompt props, creates a `PromptRenderer` with `triggerSummarize: true`, runs off the main path

#### d) Responses API Context Management (Server-Side)
- **Entry**: `toolCallingLoop.ts:1187-1220`
- When `endpoint.apiType === 'responses'` and context management is enabled, the server returns a `contextManagement` delta in the streaming response
- This is an `OpenAIContextManagementResponse` attached to the `ToolCallRound.compaction` field
- Mutually exclusive with client-side summarization

### 2. The Summarization Algorithm

The core summarization is an **LLM-based process** — the conversation is NOT algorithmically compressed, it is **re-sent to the LLM with a summarization prompt** that asks the model to produce a structured summary.

#### Two Modes: Full vs Simple

**Full mode** (`ConversationHistorySummarizationPrompt` in `summarizedConversationHistory.tsx`):
- System message contains a detailed summarization prompt requesting:
  - Analysis process (chronological review, intent mapping, technical inventory, code archaeology, progress assessment)
  - 8-section summary structure: Conversation Overview, Technical Foundation, Codebase Status, Problem Resolution, Progress Tracking, Active Work State, Recent Operations, Continuation Plan
- Uses `tool_choice: 'none'` to prevent the summarization model from calling tools
- Includes full tool schemas for context
- Can optionally use prompt caching (`AgentPromptWithSummaryPrompt` appends the summary prompt to the full `AgentPrompt`)

**Simple mode** (`SimpleSummarizedHistory` in `simpleSummarizedHistoryPrompt.tsx`):
- Fallback when full mode fails (conversation too long, errors)
- Renders a single `UserMessage` with a compressed text-based representation
- Tool results truncated to `maxToolResultLength / 2`
- Tool arguments truncated to 200 chars
- Uses `PrioritizedList` to pack as much history as fits, with first user message having highest priority
- Designed for cases like model switches (large→small context window), failed previous summarizations, etc.

#### What Gets Summarized (PropsBuilder Logic)
`SummarizedConversationHistoryPropsBuilder.getProps()` determines the summarization boundary:

1. **Multiple tool call rounds in current turn**: Exclude the last round (it caused the overflow). Summarize up to the second-to-last round.
2. **Single or zero tool call rounds**: Summarize from the last round of the last historical turn. Mark as `isContinuation` to exclude the current user message.
3. The `summarizedToolCallRoundId` identifies the boundary round — everything before it (inclusive) gets summarized.

### 3. How Summaries Are Applied

Once a summary is generated:

1. **In-memory**: `addSummaryToHistory()` / `_applySummaryToRounds()` sets `round.summary = summaryText` on the identified `toolCallRoundId` round
2. **Persistence**: `_persistSummaryOnTurn()` stores summary in `turn.resultMetadata.summaries[]`
3. **Restoration**: `normalizeSummariesOnRounds()` runs at the start of each request to restore `round.summary` from persisted `resultMetadata` — necessary because summaries may reference rounds from previous turns

### 4. How Summarized History Is Rendered

`ConversationHistory.render()` walks turns in reverse:
- When it encounters a round with `round.summary`, it renders a `<conversation-summary>` tag with the summary text instead of the original messages
- All preceding turns before the summary are **discarded** (not included in the prompt)
- Tool call rounds after the summary boundary are rendered verbatim
- For GPT-4.1, a `<reminderInstructions>` tag is included after the summary
- If transcript lookup is enabled, a note tells the model it can use `ReadFile` to look up the full uncompacted transcript at a JSONL file path

### 5. Pre-Compact Hook

Before summarization, a `PreCompact` hook is executed (`chatHookService.executeHook('PreCompact', ...)`), allowing hook scripts to archive transcripts or perform cleanup before compaction.

### 6. Budget Calculation

```
baseBudget = min(configOverride ?? modelMaxPromptTokens, modelMaxPromptTokens)
budgetThreshold = floor((baseBudget - toolTokens) * 0.85)
```
- 85% safety margin applied
- Tool tokens subtracted from available budget
- Summary size is validated: if `summaryTokens > effectiveBudget`, summarization is rejected as "too large"

### 7. Summarization Model

- By default uses the same model as the conversation
- Configurable via `ConfigKey.Advanced.AgentHistorySummarizationForceGpt41` to force GPT-4.1 as the summarization model (only if its context window is >= current model's)
- Anthropic thinking data is preserved across summarization boundaries

## Patterns

| Pattern | Details |
|---------|---------|
| **LLM-based compaction** | Not algorithmic — sends full history to LLM with structured summary prompt |
| **Dual-threshold background** | 75% = speculative start, 95% = blocking wait, Completed = immediate apply |
| **Fallback chain** | Full mode → Simple mode → No cache breakpoints/no safety buffer render |
| **Round-based boundaries** | Summaries anchor to specific `toolCallRoundId`; everything before is replaced |
| **Idempotent restoration** | `normalizeSummariesOnRounds()` re-applies summaries from metadata each turn |
| **Mutual exclusivity** | Client-side summarization disabled when Responses API context management is active |

## Applicability

- The compaction system is tightly coupled to the agent mode (`AgentPrompt`) and tool-calling loop
- Background compaction requires feature flag (`ConfigKey.BackgroundCompaction`) and experiment gating
- The summarization prompt is extensive (~150 lines of structured instructions) — tuning it affects compaction quality
- `SimpleSummarizedHistory` is a robust fallback that works by text truncation rather than LLM summarization

## Open Questions

1. **Recursive summarization**: The code explicitly notes it could summarize recursively over chunks but chose not to ("I don't want to make the user wait for multiple rounds"). Is there a plan to revisit this?
2. **Summary quality validation**: Beyond token-count checks (`summarySize > effectiveBudget`), is there any semantic validation that the summary preserved critical information?
3. **Transcript JSONL**: The transcript lookup feature (`ReadFile` on the JSONL path) is gated behind `ConfigKey.ConversationTranscriptLookup` — what's the adoption/reliability of this fallback?
4. **Server-side context management**: The `OpenAIContextManagementResponse` from the Responses API is captured but how exactly does it interact with the prompt on subsequent iterations? It's stored on `ToolCallRound.compaction` but the rendering path for it isn't fully clear.
5. **Claude Opus special handling**: The summarization prompt includes `isOpus` check to add "Do NOT call any tools" — is Opus particularly prone to tool-calling during summarization?
