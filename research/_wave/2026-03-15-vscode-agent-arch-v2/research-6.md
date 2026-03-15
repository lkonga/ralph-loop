# Q6: Handoffs vs Ralph-Loop Workbench Commands

## Findings

### Layer Analysis

These are **different architectural layers** that cannot substitute for each other:

| Dimension | Handoffs | Ralph-Loop |
|---|---|---|
| **Layer** | Declarative agent-level (YAML frontmatter in `.agent.md`) | Imperative extension API (`vscode.commands.executeCommand`) |
| **Trigger** | User clicks a button rendered in chat UI | `LoopOrchestrator.runLoop()` async generator fires commands programmatically |
| **Scope** | Intra-session agent persona transition | Cross-session multi-task lifecycle orchestration |
| **Awareness** | Full conversation context carries across | Black-box — only observes file-system side effects (PRD checkboxes, mtime) |
| **Data model** | `IHandOff { agent, label, prompt, send?, showContinueOn?, model? }` | `LoopState`, `TaskState`, `ExecutionResult`, circuit breakers, stagnation detectors |

### Ralph-Loop's Command Surface

Ralph-loop uses exactly **4 workbench commands** via `copilot.ts`:

1. **`workbench.action.chat.openEditSession`** — primary: opens agent mode with a prompt (Level 1 fallback)
2. **`workbench.action.chat.open`** — secondary: opens chat panel with `{ query }` (Level 2 fallback)
3. **`workbench.action.chat.newEditSession`** — creates fresh agent session per task
4. **`workbench.action.chat.newChat`** — creates fresh chat session (fallback)

All wrapped in `tryCommand()` with graceful clipboard fallback. The `CopilotCommandStrategy` also passes `permissionLevel: 'autopilot'` when autopilot mode is enabled.

### VS Code's Handoff Command Surface

Handoffs use exactly **1 workbench command** internally:

- **`workbench.action.chat.toggleAgentMode`** — called by `SwitchAgentTool.invoke()` with `{ modeId, sessionResource }`

The `SwitchAgentTool` is the only programmatic handoff path, and currently **only "Plan" agent is supported**. All other handoffs are UI-button-only with no command equivalent.

## Patterns

### What Each Can Do That the Other Cannot

**Handoffs exclusively:**
- Switch agent persona within a live session (Plan → Agent, Edit → Agent)
- Override the LLM model per transition (`model` field in handoff config)
- Carry full conversation history across the transition
- Escalate tool/file scope (Edit Mode's allowlist → Agent Mode's full access)

**Ralph-loop exclusively:**
- Automated multi-task iteration from PRD without human intervention
- Per-task fresh session isolation via `startFreshChatSession()`
- Stagnation detection (file mtime monitoring, nudge counts, retry counts)
- Circuit breakers with error hash tracking
- Pre-complete hook verification (tsc + vitest gate before task completion)
- Diff validation and atomic git commits per task
- Inactivity timeout detection via `FileSystemWatcher` polling
- Struggle detection and auto-decomposition of stuck tasks

### The Integration Gap

Ralph-loop cannot trigger handoffs because:
1. `SwitchAgentTool` is a **model-invoked tool** (the LLM calls it), not an extension command
2. Handoff buttons are **rendered UI elements** with no `executeCommand` equivalent
3. `toggleAgentMode` is the only command, and it only accepts `"Plan"` as `modeId`

Handoffs cannot replace ralph-loop because:
1. No concept of task lists, iteration, or completion tracking
2. No verification/gating mechanism (hooks, tsc, tests)
3. Single-session scope — no cross-session orchestration
4. User-initiated only — no autonomous execution loop

## Applicability

### Could Ralph-Loop Trigger Handoffs?

**Not with current APIs.** Three hypothetical paths:

1. **Direct `toggleAgentMode` call** — ralph-loop could call `workbench.action.chat.toggleAgentMode` but would need to know the `sessionResource` URI (not exposed to extensions) and only "Plan" is supported today.

2. **Custom agent provider** — ralph-loop could register as a `ChatCustomAgentProvider` with handoffs in its agent config, but the handoffs would still require user clicks.

3. **Tool-based switching** — ralph-loop could instruct Copilot via prompt to invoke `switch_agent` tool, but this requires the tool to be registered and currently only supports Plan mode.

**Verdict:** Ralph-loop's imperative `executeCommand` approach is strictly more powerful for automation than handoffs. Handoffs add value only for human-in-the-loop agent transitions.

### Could Handoffs Replace Ralph-Loop Functionality?

**No.** They are complementary layers:

- Handoffs = "which agent handles the next turn" (identity routing)
- Ralph-loop = "what tasks get done, in what order, with what verification" (lifecycle management)

### Best Integration Strategy

Ralph-loop could **generate task-specific `.agent.md` files** with custom handoff configurations, then instruct Copilot to use them. Example: a "Verify & Commit" handoff that runs pre-complete hooks before marking a task done. This would bring ralph-loop's verification gates into the agent-level UI without replacing the orchestration loop.

## Open Questions

1. **`toggleAgentMode` expansion** — If VS Code exposes arbitrary `modeId` values (not just "Plan"), ralph-loop could programmatically switch between custom agents mid-task.
2. **Handoff event API** — If handoff transitions emitted events (e.g., `onDidSwitchAgent`), ralph-loop could observe and react to agent transitions instead of just file-system changes.
3. **Session resource access** — If the `sessionResource` URI were accessible to extensions, ralph-loop could use `toggleAgentMode` to perform in-session agent transitions.
4. **Autopilot + handoffs convergence** — As `permissionLevel: 'autopilot'` matures, it may subsume some handoff use cases (auto-sending without button clicks), but ralph-loop's verification layer remains uniquely valuable regardless.
