---
type: research
id: 2
sources:
  - Reverse-engineered from microsoft/vscode-copilot-chat (March 2026)
---
# Autopilot Mode — Complete Deep Dive

> Source: Reverse-engineered from `microsoft/vscode-copilot-chat` (March 2026)
> File references: `toolCallingLoop.ts`, `agentIntent.ts`, prompt TSX components

---

## What Is Autopilot?

Autopilot is the **highest permission level** for VS Code Copilot's agent mode. It represents a fully autonomous execution mode where the model works through an entire task independently.

### Permission Level Hierarchy

| Level | Behavior |
|---|---|
| *(default)* | Interactive — tool calls require user confirmation |
| `autoApprove` | Auto-approve all tool calls + retry on errors |
| `autopilot` | Everything `autoApprove` does **plus** continues looping until explicitly finished |

Autopilot is **not user-configurable inside the extension**. VS Code itself sets `request.permissionLevel = 'autopilot'` on the `ChatRequest` object.

---

## The `task_complete` Tool

The **only tool that differs between autopilot and other modes**:

```ts
// agentIntent.ts
allowTools['task_complete'] = request.permissionLevel === 'autopilot';
```

- Built-in tool registered in VS Code core
- Extension opts into it only for autopilot
- When called, signals "I'm done with the entire task"

### Prompt Injection

When autopilot is active, a high-priority system message is injected:

```
When you have fully completed the task, call the task_complete tool to signal that you are done.
IMPORTANT: Before calling task_complete, you MUST provide a brief text summary of what was
accomplished in your message. The task is not complete until both the summary and the
task_complete call are present.
```

The model **must** produce a text summary AND call the tool — neither alone is sufficient.

---

## The Continuation Loop

Four state variables track autopilot state in `toolCallingLoop.ts`:

```ts
MAX_AUTOPILOT_RETRIES = 3;       // auto-retry on transient errors
MAX_AUTOPILOT_ITERATIONS = 5;    // max nudges before giving up
autopilotRetryCount = 0;
autopilotIterationCount = 0;
autopilotStopHookActive = false;
taskCompleted = false;
```

### The Deterministic Check

**100% deterministic at the core.** Zero LLM-based heuristic in the harness:

```ts
protected shouldAutopilotContinue(result): string | undefined {
    if (this.taskCompleted) {
        return undefined;  // STOP
    }

    const calledTaskComplete = this.toolCallRounds.some(
        round => round.toolCalls.some(tc => tc.name === 'task_complete')
    );
    if (calledTaskComplete) {
        this.taskCompleted = true;
        return undefined;  // STOP
    }

    if (this.autopilotIterationCount >= 5) {
        return undefined;  // GIVE UP AND STOP
    }

    this.autopilotIterationCount++;
    return 'You have not yet marked the task as complete...';  // NUDGE TEXT
}
```

No embeddings, no classifier, no "is this done?" heuristic. **Binary check: tool called or not.**

---

## Nudge Injection Mechanism

### The Nudge Message

When the model tries to stop without calling `task_complete`:

```
You have not yet marked the task as complete using the task_complete tool.
You MUST call task_complete when done — whether the task involved code changes,
answering a question, or any other interaction.

Do NOT repeat or restate your previous response. Pick up where you left off.
If you were planning, stop planning and start implementing.
You are not done until you have fully completed the task.

IMPORTANT: Do NOT call task_complete if:
- You have open questions or ambiguities — make good decisions and keep working
- You encountered an error — try to resolve it or find an alternative approach
- There are remaining steps — complete them first

When you ARE done, first provide a brief text summary, then call task_complete.
Keep working autonomously until the task is truly finished.
```

### Three-Stage Injection

The nudge flows through three stages to appear as a user message:

**Stage 1:** Attach to the completed round
```ts
result.round.hookContext = formatHookContext([autopilotContinue]);
```

**Stage 2:** On next loop iteration, inject as the "user query"
```ts
if (this.stopHookReason) {
    query = formatHookContext([this.stopHookReason]);
    this.stopHookReason = undefined;
    hasStopHookQuery = true;
}
```

**Stage 3:** Rendered as a `<UserMessage>` in the prompt TSX
```tsx
if (round.hookContext) {
    children.push(<UserMessage>{round.hookContext}</UserMessage>);
}
```

The nudge appears as if **the user said it**. Not a system message — a user message. This is deliberate: user messages have the highest compliance rate with instruction-following models.

---

## Self-Resetting Counter

The iteration counter **resets if the model does productive work**:

```ts
if (this.autopilotStopHookActive
    && result.round.toolCalls.length
    && !result.round.toolCalls.some(tc => tc.name === 'task_complete')) {
    this.autopilotStopHookActive = false;
    this.autopilotIterationCount = 0;  // ← RESET!
}
```

The lifecycle:

```
Model works → tries to stop → nudge #1 → model does real work → counter resets to 0
→ model works more → tries to stop again → nudge #1 (again!) → ...
```

`MAX_AUTOPILOT_ITERATIONS = 5` only triggers when the model is **consecutively unproductive** — nudged 5 times in a row without making a single tool call. A well-behaved model could run indefinitely (bounded only by the 200 tool call hard cap).

---

## Three-Tier Stop Hook Architecture

| Order | Hook Type | Where | Who Controls It |
|---|---|---|---|
| 1st | **External Stop Hook** | VS Code API `StopHookInput/Output` | User-configured hook scripts |
| 2nd | **Subagent Stop Hook** | Same API, for child agents | Parent agent's hook config |
| 3rd | **Autopilot Internal Hook** | Hardcoded in `toolCallingLoop.ts` | The extension itself |

The autopilot hook **reuses the same plumbing** as external hooks (`hookContext`, `stopHookReason`, `formatHookContext`) but is hardcoded — not configurable, not overridable.

```ts
// STEP 3 in the stop sequence (after external hooks already evaluated)
if (this.options.request.permissionLevel === 'autopilot' && result.response.type === Success) {
    const autopilotContinue = this.shouldAutopilotContinue(result);
    if (autopilotContinue) {
        this.stopHookReason = autopilotContinue;
        result.round.hookContext = formatHookContext([autopilotContinue]);
        this.autopilotStopHookActive = true;
        continue;  // ← BACK TO TOP OF WHILE LOOP
    }
}
```

---

## Safety Guardrails

### 1. Max Nudge Iterations: 5

After 5 consecutive nudges with no productive work, the loop stops:

```
'[ToolCallingLoop] Autopilot: hit max iterations (5), letting it stop'
```

### 2. Auto-Retry on Errors: 3 attempts

Transient network/fetch errors are retried automatically. Never retried:
- Rate limits
- Quota exceeded
- Cancellation
- Off-topic errors

### 3. Tool Call Hard Cap: 200

In autopilot, when the tool call limit is hit, instead of a confirmation dialog, the limit is silently expanded by 50% — hard-capped at 200:

```ts
if (permLevel === 'autopilot' && this.options.toolCallLimit < 200) {
    this.options.toolCallLimit = Math.min(
        Math.round(this.options.toolCallLimit * 3 / 2), 200
    );
}
```

**The 200 is an auto-expansion ceiling, not a universal cap.** The user setting `chat.agent.maxRequests` can be set to any number. If the user sets it to 500, the auto-expansion code never fires — the condition `< 200` is false. The 200 only constrains automatic expansion from lower starting values.

### 4. Yield Requests Suppressed

VS Code can send "yield requests" (graceful pause signals when the user types a new message). In autopilot, these are **ignored** unless `taskCompleted` is true:

```ts
if (this.options.request.permissionLevel !== 'autopilot' || this.taskCompleted) {
    break;   // only breaks if NOT autopilot, or if task IS done
}
```

---

## Autopilot is NOT a Subagent

Autopilot runs in the **exact same conversation, same process, same loop** as regular agent mode. No parent/child relationship:

```
VS Code Core
  └─ ChatRequest { permissionLevel: 'autopilot' }
       └─ Same ToolCallingLoop instance
            └─ Same while loop
                 └─ task_complete = just a flag flip: this.taskCompleted = true
```

`task_complete` doesn't "report back" to anything. It sets a boolean that causes `shouldAutopilotContinue()` to return `undefined`, and the loop exits normally.

---

## Full State Machine

```
┌──────────────────────────────────────────────────┐
│              TOOL CALLING LOOP                    │
│                                                   │
│  while (true) {                                   │
│    result = callModel()                           │
│                                                   │
│    if (has tool calls) {                          │
│      execute tools                                │
│      if (productive + was nudged) → reset counter │
│      push round → continue                       │
│    }                                              │
│                                                   │
│    // Model wants to stop (no tool calls)         │
│    ① Check cancellation → break                  │
│    ② Check transient error → auto-retry (max 3)  │
│    ③ Run external stop hooks → maybe continue    │
│    ④ Run autopilot check:                        │
│       task_complete called? → break               │
│       iteration >= 5? → break                     │
│       else → inject nudge as UserMessage          │
│              → continue                           │
│    ⑤ break                                       │
│  }                                                │
└──────────────────────────────────────────────────┘
```

---

## Key Design Principles

1. **Deterministic harness** — all intelligence pushed into the model via nudge prompts
2. **Binary completion check** — the harness only asks "did you call `task_complete`?"
3. **Resilient counters** — productive work resets stall detection
4. **Nudges as user messages** — highest compliance rate with LLMs
5. **Multiple safety valves** — iteration cap, tool call cap, error limits prevent runaway execution
