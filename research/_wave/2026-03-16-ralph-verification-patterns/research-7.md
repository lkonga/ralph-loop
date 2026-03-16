# Research 7: Framework Documentation for Pluggable Hook/Verification Systems in Agent Loops

**Wave**: 2026-03-16-ralph-verification-patterns
**Question**: What framework documentation or developer guides exist for building pluggable hook/verification systems in agent loops — e.g., LangChain callbacks, CrewAI task validation, AutoGen verification, Semantic Kernel planners?
**Date**: 2026-03-16
**Sources**: Framework documentation (LangChain, CrewAI, AutoGen/AG2, Semantic Kernel), codebase analysis of ralph-loop and vscode-copilot-chat hook systems

---

## Findings

### 1. LangChain Callbacks — The Event-Driven Observer Pattern

LangChain provides the most mature pluggable hook system among agent frameworks through its **Callbacks** API.

**Architecture:**
- **`BaseCallbackHandler`**: Abstract class with ~20 lifecycle methods (`on_llm_start`, `on_llm_end`, `on_chain_start`, `on_chain_end`, `on_tool_start`, `on_tool_end`, `on_tool_error`, `on_agent_action`, `on_agent_finish`, `on_retry`, etc.)
- **`CallbackManager`**: Orchestrates multiple handlers, supports both sync and async variants
- **`RunManager`**: Scoped to a single chain/tool/LLM invocation; child managers inherit parent callbacks

**Verification hooks specifically:**
- `on_agent_finish(finish: AgentFinish)` — fires when the agent produces a final answer. Users can inspect the `finish.return_values` dict and raise exceptions to force retry
- `on_tool_end(output: str)` — fires after each tool execution, letting users validate tool output before the agent processes it
- `on_chain_error(error: Exception)` — fires on chain failures for custom error handling and retry logic

**Registration model:**
```python
# Instance-level (per-invocation)
chain.invoke(input, config={"callbacks": [MyHandler()]})

# Constructor-level (permanent)
chain = LLMChain(..., callbacks=[MyHandler()])

# Global (all chains)
import langchain
langchain.callbacks.manager.set_handler(MyHandler())
```

**Key design decisions:**
- Callbacks are **observational by default** — they receive events but cannot modify the agent's control flow unless they raise exceptions
- `on_tool_start` receives the tool input but cannot modify it (unlike VS Code's `PreToolUse` which can deny/modify)
- No built-in "verification gate" — users must build their own by combining `on_agent_finish` with exception-raising
- Handlers can be **async** (`AsyncCallbackHandler`) for non-blocking telemetry, logging, streaming

**LangGraph (successor for agent loops):**
LangGraph introduces a more powerful verification pattern through **conditional edges** in the graph:
```python
graph.add_conditional_edges(
    "agent",
    should_continue,  # Verification function
    {"continue": "action", "end": END}
)
```
This is structurally closer to ralph-loop's `dualExitGateCheck` — a deterministic function that decides whether to continue or terminate the loop.

**LangGraph also offers:**
- **`NodeInterrupt`** — pause execution mid-graph for human-in-the-loop verification
- **State channels with reducers** — accumulate verification results across nodes
- **Breakpoints** — programmatic checkpoints where external verification can occur before resuming

### 2. CrewAI Task Validation — The Declarative Criteria Pattern

CrewAI takes a declarative approach to task verification, embedding completion criteria directly in task definitions.

**Architecture:**
- **`Task`** objects have an `output_validator` parameter — a callable that receives the task output and returns `True`/`False`
- Built-in `expected_output` string — used for LLM-based validation ("does this output match the expected format?")
- `max_retry_on_error` — automatic retry count when validation fails
- `human_input` flag — requires human approval before marking complete

**Verification model:**
```python
task = Task(
    description="Analyze dataset",
    expected_output="A summary report with key metrics",
    output_validator=lambda output: "metrics" in output.lower(),
    max_retry_on_error=3,
    human_input=True,  # Human gate
)
```

**CrewAI's validation flow:**
1. Agent executes task
2. `output_validator` callable runs (if provided) — deterministic check
3. If `expected_output` is set, an LLM grades the output against the expected description — LLM-based check
4. If `human_input=True`, prompts user for approval — human gate
5. On failure, retry up to `max_retry_on_error` times
6. Final result includes `TaskOutput.quality_score` when grading is enabled

**Key design decisions:**
- **Dual-gate verification** (deterministic validator + LLM grading) closely mirrors ralph-loop's `dualExitGateCheck` (machine verification + model signal)
- `output_validator` is a simple callable — no registry or handler class hierarchy
- No pre-execution hooks — CrewAI focuses exclusively on post-execution validation
- **Delegation** between agents provides a natural retry escalation path

**Crew-level callbacks:**
- `step_callback(step_output)` — fires after each agent step (similar to LangChain's `on_agent_action`)
- `task_callback(task_output)` — fires after each task completes
- These are observational, not blocking — they can log but not prevent completion

### 3. AutoGen / AG2 — The Conversation-Based Verification Pattern

AutoGen (now AG2) uses a fundamentally different model: verification emerges from multi-agent conversation patterns.

**Architecture:**
- **`ConversableAgent`** is the base class; agents communicate via `send()`/`receive()` message passing
- **Termination** is controlled by `is_termination_msg` — a callable on each agent that evaluates incoming messages
- **`UserProxyAgent`** provides human-in-the-loop verification by forwarding messages to the user

**Verification hooks:**
```python
# Termination check — evaluated on every received message
agent = ConversableAgent(
    name="verifier",
    is_termination_msg=lambda msg: "APPROVED" in msg.get("content", ""),
)

# Code execution verification — built into UserProxyAgent
proxy = UserProxyAgent(
    name="user_proxy",
    code_execution_config={"work_dir": "coding"},
    human_input_mode="TERMINATE",  # Ask human only at termination
)
```

**AG2 (AutoGen 0.4+) introduces more structured hooks:**
- **`HandoffTermination`** — terminates when an agent hands off to a specific target
- **`TextMentionTermination`** — terminates on keyword detection in output
- **`MaxMessageTermination`** — hard limit on conversation turns (similar to ralph-loop's `maxIterations`)
- **`StopMessageTermination`** — agent explicitly signals completion
- **`SourceMatchTermination`** — terminate when a specific agent speaks
- **Custom termination** via `TerminationCondition` subclass with `__call__` returning `StopMessage | None`

**Verification patterns available:**
- **Critic agent pattern**: A dedicated `ConversableAgent` reviews another agent's output and approves/rejects
- **Nested chats**: Run a verification sub-conversation before accepting results
- **`register_reply()`**: Register custom reply functions that fire at specific positions in the reply chain — can intercept and modify the conversation flow

**Key design decisions:**
- Verification is modeled as **conversation between agents** rather than hooks/callbacks
- `is_termination_msg` is the closest analog to ralph-loop's `Stop` hook — evaluates every message for completion signals
- No built-in deterministic verification (tests, file checks) — this must be implemented via custom agents or `register_reply()`
- **Code execution sandbox** provides implicit verification: if code runs without errors, it passes

### 4. Semantic Kernel — The Planner + Filter Pattern

Microsoft's Semantic Kernel uses a compositional approach with **filters** (hooks) and **planners** (verification of multi-step plans).

**Filters (Hook system):**
```csharp
// Pre/Post execution hooks on any kernel function
public class VerificationFilter : IFunctionInvocationFilter
{
    public async Task OnFunctionInvocationAsync(
        FunctionInvocationContext context,
        Func<FunctionInvocationContext, Task> next)
    {
        // Pre-execution: validate inputs
        if (!IsValid(context.Arguments))
        {
            context.Result = new FunctionResult("Invalid input");
            return; // Block execution
        }
        
        await next(context); // Execute
        
        // Post-execution: verify output
        if (!context.Result.IsValid())
        {
            context.Result = new FunctionResult("Verification failed");
        }
    }
}
```

**Filter types:**
- **`IFunctionInvocationFilter`** — wraps any kernel function call (pre + post), can block execution or modify results
- **`IPromptRenderFilter`** — fires before prompt rendering, can modify the prompt
- **`IAutoFunctionInvocationFilter`** — specifically for auto-invoked functions (tool calls from LLM), can terminate auto-invocation loop

**Planner verification:**
- **Stepwise Planner** generates a multi-step plan, then executes steps one at a time with verification between each step
- **Handlebars Planner** generates a template-based plan that can include verification steps
- Plans can be **reviewed before execution** — the planner outputs a structured plan that can be inspected/modified
- **`FunctionCallBehavior.AutoInvokeKernelFunctions`** with `MaxAutoInvokeAttempts` provides retry limits

**Key design decisions:**
- Filters are **middleware-style** (wrap execution), not observer-style — they can block, modify, or retry
- Extremely close to ralph-loop's hook protocol: pre-execution check → execute → post-execution verification → decide continue/block
- `IAutoFunctionInvocationFilter` is the direct analog of VS Code's `PreToolUse` hook
- Built-in support for **termination decisions** within the filter chain
- Type-safe, dependency-injected — filters registered via `kernel.FunctionInvocationFilters.Add()`

### 5. Claude Code / Anthropic Agent SDK — The Shell Hook Pattern

Documented in the vscode-copilot-chat codebase, the Claude Agent SDK defines **20 hook events** with a shell-based execution model.

**Architecture:**
- Hooks are shell commands registered in `.claude/settings.json` under `hooks` key
- Each hook receives JSON on stdin and returns JSON on stdout
- Exit codes control flow: 0 = success, 2 = blocking error, other = warning

**Hook events relevant to verification:**
- `Stop` — fires when the agent wants to stop; returning an error forces continuation
- `PreToolUse` — fires before each tool call; can deny execution
- `PostToolUse` — fires after each tool call; can inject context
- `TaskCompleted` — fires on task completion for validation
- `SubagentStart` / `SubagentStop` — fires around subagent execution

**This is the pattern ralph-loop already implements** via `hookBridge.ts` and `ShellHookProvider`.

---

## Patterns

### Pattern 1: Observer vs. Interceptor

| Framework | Pattern | Can Block? | Can Modify? |
|-----------|---------|:---:|:---:|
| LangChain Callbacks | Observer | Via exceptions only | No |
| CrewAI task_callback | Observer | No | No |
| CrewAI output_validator | Interceptor | Yes | No |
| AutoGen is_termination_msg | Interceptor | Yes (terminates) | No |
| AutoGen register_reply | Interceptor | Yes | Yes |
| Semantic Kernel Filters | Middleware | Yes | Yes |
| VS Code ChatHooks | Interceptor | Yes (some hooks) | Yes (additionalContext) |
| Ralph-loop VerifierRegistry | Interceptor | Yes (fail → retry) | No |

**Insight**: Ralph-loop's `VerifierRegistry` is closest to CrewAI's `output_validator` in concept but uses Semantic Kernel's middleware/filter architecture in execution (chain of verifiers, each producing pass/fail, aggregated by `allChecksPassed`).

### Pattern 2: Dual-Gate Verification

Multiple frameworks converge on a two-layer verification model:

| Layer | CrewAI | Ralph-loop | LangGraph |
|-------|--------|------------|-----------|
| Deterministic | `output_validator` callable | `VerifierRegistry` chain (tsc, vitest, fileExists) | Conditional edge function |
| LLM-based | `expected_output` grading | `IConsistencyChecker.runLlmVerification` (stub) | LLM node in graph |
| Human | `human_input=True` | `HumanCheckpointRequested` event | `NodeInterrupt` |

Ralph-loop's `dualExitGateCheck(modelSignal, machineVerification)` is a formalization of this pattern — combining agent self-assessment (model signal) with deterministic machine checks.

### Pattern 3: Registry vs. Inline vs. Declarative

Three distinct registration models emerge:

1. **Registry** (ralph-loop `VerifierRegistry`, Semantic Kernel filters): Named verifiers registered in a central map, resolved by type string
2. **Inline** (CrewAI `output_validator`, AutoGen `is_termination_msg`): Callables passed directly to task/agent constructors
3. **Declarative** (VS Code `chat.hooks`, Claude Code settings.json): Shell commands declared in configuration files

Ralph-loop uniquely bridges all three: `VerifierRegistry` (registry), `PreCompleteHookConfig` (declarative), and the orchestrator's inline verification logic.

### Pattern 4: Template-Based Verification Selection

Ralph-loop's `VerificationTemplate` system (matching verifier configs to tasks by keyword) has no direct equivalent in any other framework:

```typescript
// ralph-loop's unique pattern
verificationTemplates: [
    { name: "test", verifiers: [{ type: "vitest" }, { type: "tsc" }] },
    { name: "api", verifiers: [{ type: "tsc" }, { type: "commandExitCode", args: { command: "curl..." } }] }
]
```

This is a hybrid between CrewAI's per-task validators and a rule engine. No other framework auto-classifies tasks and selects verification strategies based on description keywords.

### Pattern 5: Stagnation/Loop Detection

| Framework | Mechanism | Ralph-loop Equivalent |
|-----------|-----------|----------------------|
| LangChain/LangGraph | `max_iterations` on AgentExecutor | `maxIterations`, `hardMaxIterations` |
| AutoGen/AG2 | `MaxMessageTermination` | `maxNudgesPerTask` |
| Semantic Kernel | `MaxAutoInvokeAttempts` | `maxDiffValidationRetries` |
| CrewAI | `max_retry_on_error` | `MAX_RETRIES_PER_TASK` |
| None | — | `StagnationDetector` (file hash-based) |
| None | — | `StruggleDetector` (short iteration detection) |
| None | — | `CircuitBreakerChain` (error pattern detection) |

Ralph-loop's `StagnationDetector` and `StruggleDetector` are original patterns not found in any major framework — they detect lack of progress through file content hashing and iteration timing analysis rather than simple counters.

---

## Applicability

### What Ralph-loop Can Adopt

1. **LangGraph's conditional edges**: Ralph-loop's `dualExitGateCheck` already implements this conceptually, but could benefit from making the verification graph explicit — allowing different verification paths (fast-path for simple tasks, full-suite for complex ones) as a DAG rather than a linear chain.

2. **Semantic Kernel's middleware composition**: Ralph-loop's `runVerifierChain` is sequential. Semantic Kernel's filter model allows wrapping (pre+post in one filter). This could simplify ralph-loop's separate `PreCompleteHookConfig` + `VerifierConfig` into a unified middleware chain.

3. **CrewAI's LLM grading**: Ralph-loop has `IConsistencyChecker.runLlmVerification` as a stub. CrewAI's `expected_output` grading against a reference description is a well-documented pattern for implementing this — the LLM compares actual output to task description.

4. **AutoGen's critic agent pattern**: Instead of a single LLM verification call, ralph-loop could use a dedicated "reviewer" agent (already partially implemented via `ReviewAfterExecuteConfig`) that operates as a separate verification conversation.

### What Ralph-loop Already Does Better

1. **Deterministic verification registry**: No other framework provides a named, typed, extensible registry of verification functions that can include tsc compilation, test execution, file existence checks, and custom commands.

2. **Confidence scoring**: `computeConfidenceScore` with weighted verification results is unique to ralph-loop. Other frameworks use binary pass/fail.

3. **Stagnation detection via file hashing**: Original pattern not found elsewhere.

4. **Hook bridge adapter pattern**: The dual hook system (internal `IRalphHookService` + external VS Code `chat.hooks` bridge) is architecturally sophisticated — it decouples ralph-loop's verification logic from the host platform's hook API.

5. **PreCompact context injection**: Injecting resumption context during context compaction is a novel pattern specific to long-running agent loops.

### Integration Recommendations

| Priority | Action | Source Framework | Rationale |
|----------|--------|-----------------|-----------|
| **High** | Implement LLM grading for `runLlmVerification` | CrewAI's expected_output | Stub already exists; proven pattern |
| **Medium** | Add conditional verification paths by task type | LangGraph conditional edges | `autoClassifyTasks` + `verificationTemplates` already half-implement this |
| **Medium** | Unify `PreCompleteHookConfig` + `VerifierConfig` | Semantic Kernel filters | Reduce conceptual overhead of two separate verification systems |
| **Low** | Add verification DAG support | LangGraph | Over-engineering for current use case |
| **Low** | Multi-agent review conversation | AutoGen critic pattern | `ReviewAfterExecuteConfig` already covers this simpler |

---

## Open Questions

1. **Should ralph-loop adopt LangChain's callback handler class hierarchy?** Currently, verifiers are bare functions (`VerifierFn`). A class-based hierarchy would enable stateful verifiers (tracking verification history across tasks) but adds complexity. The current `VerifierFn` type is simpler and sufficient.

2. **Is the `VerificationTemplate` keyword-matching system robust enough?** The current `descLower.includes(tmpl.name.toLowerCase())` matching is fragile. CrewAI uses per-task declarations, which are explicit but verbose. Would a regex or glob-based matcher be a better middle ground?

3. **Should `dualExitGateCheck` become a pluggable strategy?** Currently hardcoded logic. Other frameworks (LangGraph, AutoGen) make the termination decision function fully user-configurable. Ralph-loop could accept a `(modelSignal, checks) => { canComplete, reason }` function to allow project-specific completion logic.

4. **How do other frameworks handle verification across agent handoffs?** When CrewAI delegates to another agent, the delegating agent validates the result. Ralph-loop's `SubagentStart`/`SubagentStop` hooks (currently unregistered) could enable cross-agent verification — but no framework has a documented pattern for this in the context of VS Code's chat hook system.

5. **Does any framework implement "progressive verification"?** Ralph-loop already does quick checks first (checkbox) and expensive checks later (vitest). Is there documentation on formally modeling this as a cost-ordered verification pipeline? Semantic Kernel's filter ordering is the closest, but doesn't document cost-aware ordering.

6. **What is the interaction between `confidenceThreshold` and `dualExitGateCheck`?** Ralph-loop computes a confidence score from verification weights but the dual exit gate uses boolean pass/fail. Should confidence score influence the gate decision (e.g., allow completion at score > 80 even if one non-critical check fails)?
