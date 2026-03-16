---
type: research
id: 1
sources:
  - Analysis of microsoft/vscode-copilot-chat repository (March 2026)
session: e1c501d2-3106-4e0a-9212-1443d7efd5f2
---
# VS Code Copilot Chat Extension — Internal Architecture

> Source: Analysis of `microsoft/vscode-copilot-chat` repository (March 2026)
> Session: `e1c501d2-3106-4e0a-9212-1443d7efd5f2`

---

## 1. Agent Mode System Prompt

The base system prompt explicitly tells the model:

- "Don't make assumptions — gather context first"
- "NEVER print out a codeblock with file changes unless the user asked for it. Use the appropriate edit tool instead."
- "NEVER print out a codeblock with a terminal command... Use the `run_in_terminal` tool instead."

## 2. Autopilot Permission Level

Three tiers defined in the proposed VS Code API:

| Level | Behavior |
|---|---|
| *(default)* | Interactive — tool calls require user confirmation |
| `autoApprove` | Auto-approve all tool calls + retry on errors |
| `autopilot` | Everything `autoApprove` does **plus** continues looping until the task is explicitly finished |

The key difference: in autopilot, the model **cannot stop working just because it ran out of things to say**. It must call `task_complete` to signal it's done.

```tsx
isAutopilot && <SystemMessage priority={80}>
  When you have fully completed the task, call the task_complete tool to signal that you are done.
  IMPORTANT: Before calling task_complete, you MUST provide a brief text summary...
</SystemMessage>
```

## 3. Model-Specific Tool Selection

Different models get different edit tools:

- Models supporting `ApplyPatch` get that exclusively (no `EditFile`)
- Models supporting `ReplaceString` exclusively get that instead
- `MultiReplaceString` is enabled only if the model supports it
- Grok-code models have `ManageTodoList` **disabled**

## 4. Auto Mode Router

The "Auto" model selection uses a **router model** to pick the best endpoint per prompt, with fallback logic and telemetry tracking when routing fails.

## 5. SwitchAgent Tool

Only supports "Plan" agent:

```ts
if (agentName !== 'Plan') {
  throw new Error('Only "Plan" agent is supported. Received: "{0}"');
}
```

Switches the chat mode and injects `PlanAgentProvider.buildAgentBody()` instructions.

## 6. Anthropic Beta Features (BYOK)

The BYOK Anthropic provider enables cutting-edge betas:

- `interleaved-thinking-2025-05-14` — thinking between tool calls
- `context-management-2025-06-27` — memory tool support
- `advanced-tool-use-2025-11-20` — tool search/deferred loading
- Supports **adaptive thinking** with effort levels

## 7. Explore Agent

The Explore subagent defaults to `Claude Haiku 4.5 (copilot)` for cost/speed efficiency.

## 8. Default Read-Only Tools

Read-only agents (Plan, Ask, Explore) share this tool set:

```ts
const DEFAULT_READ_TOOLS = [
  'search', 'read', 'web', 'vscode/memory',
  'github/issue_read', 'github.vscode-pull-request-github/issue_fetch',
  'github.vscode-pull-request-github/activePullRequest',
  'execute/getTerminalOutput', 'execute/testFailure'
];
```

## 9. Claude Agent Wizard

Slash command with model choices:

- **Sonnet** — "Balanced performance - best for most agents"
- **Opus** — "Most capable for complex reasoning tasks"
- **Haiku** — "Fast and efficient for simple tasks"
- **Inherit** — "Use the same model as the main conversation"

## 10. Inline Chat Retry Logic

The inline chat tool-calling strategy has a retry loop:

- If only read-only tool calls happen (no edits), retries up to **9 read-only rounds**
- If edits fail, retries up to **5 failed edits** before giving up
- Shows `"Looking not yet good, trying again..."` on failures

## 11. Language Model Proxy Server

A local HTTP server proxying Anthropic Messages API requests, with model name mapping logic (e.g., `claude-sonnet-4-20250514` → `claude-sonnet-4.5`).

## 12. Multiline Completion Decision Tree

Ghost text completions use a gradient-boosted decision tree with ~130+ numerical features and hardcoded weights to decide whether to show single vs. multiline completions.

---

## Key Takeaways for Ralph Loop

| Finding | Relevance |
|---------|-----------|
| Binary `task_complete` — deterministic harness | Ralph uses the same pattern with PRD checkbox |
| Model-specific tool selection | Ralph could hint model capabilities in prompt |
| Explore agent uses cheaper model | Ralph could use tiered models for planning vs execution |
| Read-only tool set separation | Ralph could define tool restrictions per task type |
| Retry logic (9 read-only / 5 edit rounds) | Ralph's nudge system mirrors this pattern |
