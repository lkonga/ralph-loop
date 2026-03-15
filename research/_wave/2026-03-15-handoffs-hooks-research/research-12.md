# Research Report 12: Gap Analysis — VS Code Hooks vs Ralph-Loop

## Findings

### VS Code `ChatHookType` (full union — 10 hooks)

Source: [vscode.proposed.chatHooks.d.ts](../../vscode-copilot-chat/src/extension/vscode.proposed.chatHooks.d.ts#L13)

```typescript
export type ChatHookType = 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit'
  | 'PreToolUse' | 'PostToolUse' | 'PreCompact'
  | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'ErrorOccurred';
```

Each hook has typed input/output interfaces defined in [chatHookService.ts](../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts) lines 93–270.

### Ralph-Loop `RalphHookType` (5 hooks)

Source: [types.ts](../src/types.ts#L454)

```typescript
export type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'PreComplete' | 'TaskComplete';
```

### Ralph-Loop `hookBridge.ts` — actually registers only 3 VS Code hooks

Source: [hookBridge.ts](../src/hookBridge.ts#L289-L303)

The bridge writes 3 VS Code hooks via `chat.hooks` config:
1. **`Stop`** — verification gate (PRD checkbox, progress.txt, tsc, vitest) before agent stops
2. **`PostToolUse`** — writes a timestamp marker for inactivity detection
3. **`PreCompact`** — injects session resumption context (git diff, progress summary, current task)

### Gap Matrix

| VS Code Hook        | Ralph `RalphHookType` | Ralph `hookBridge.ts` (registered) | Status              |
|----------------------|----------------------|-------------------------------------|---------------------|
| `SessionStart`       | ✅ Yes                | ❌ Not registered                   | **Type-only gap**   |
| `SessionEnd`         | ❌ Missing            | ❌ Not registered                   | **Full gap**        |
| `UserPromptSubmit`   | ❌ Missing            | ❌ Not registered                   | **Full gap**        |
| `PreToolUse`         | ❌ Missing            | ❌ Not registered                   | **Full gap**        |
| `PostToolUse`        | ✅ Yes                | ✅ Registered                       | ✅ Implemented       |
| `PreCompact`         | ✅ Yes                | ✅ Registered                       | ✅ Implemented       |
| `SubagentStart`      | ❌ Missing            | ❌ Not registered                   | **Full gap**        |
| `SubagentStop`       | ❌ Missing            | ❌ Not registered                   | **Full gap**        |
| `Stop`               | ❌ Missing from type  | ✅ Registered                       | **Type-bridge gap** |
| `ErrorOccurred`      | ❌ Missing            | ❌ Not registered                   | **Full gap**        |

Ralph-only hooks (no VS Code equivalent):
- `PreComplete` — ralph-loop concept, maps loosely to `Stop` in VS Code
- `TaskComplete` — ralph-loop concept, no VS Code equivalent

### Detailed Gap Analysis

#### 1. `SessionStart` — Type exists, bridge missing

Ralph declares `SessionStart` in `RalphHookType` and has `IRalphHookService.onSessionStart()` ([types.ts L497](../src/types.ts#L497)), plus `ShellHookProvider.onSessionStart()` ([shellHookProvider.ts L63](../src/shellHookProvider.ts#L63)). However, `registerHookBridge()` does **not** register a `SessionStart` script with VS Code's `chat.hooks`. This means the shell hook provider can be invoked programmatically but never fires from VS Code's actual session start event.

**VS Code behavior**: `SessionStart` fires at [toolCallingLoop.ts L413](../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L413) with `SessionStartHookInput { source: 'new' }`. Output can inject `additionalContext` into the session.

**Integration opportunity**: Register a `SessionStart` hook script that reads ralph-loop's PRD and injects task context + knowledge blocks at session inception, eliminating the need for manual prompt injection.

#### 2. `PreToolUse` — Full gap

Not in `RalphHookType`, not registered in bridge.

**VS Code behavior**: Fires before every tool call ([chatHookService.ts L39-L53](../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts#L39-L53)). Can return `permissionDecision: 'allow' | 'deny' | 'ask'` and `updatedInput` to modify tool parameters, plus `additionalContext`.

**Integration opportunity (HIGH)**: Ralph-loop's `CommandBlocked` logic ([types.ts L81](../src/types.ts#L81)) and circuit breaker system could be unified into a `PreToolUse` hook. This would let ralph-loop deny dangerous commands (rm -rf, git push --force) at the VS Code level before the tool even executes. Currently ralph-loop can only detect bad commands after the fact.

#### 3. `UserPromptSubmit` — Full gap

Not in `RalphHookType`, not registered.

**VS Code behavior**: Fires when a user submits a prompt ([defaultIntentRequestHandler.ts L367](../../vscode-copilot-chat/src/extension/prompt/node/defaultIntentRequestHandler.ts#L367)). Can return `decision: 'block'` to prevent submission, or inject `additionalContext`.

**Integration opportunity (MEDIUM)**: Ralph-loop could intercept user prompts to:
- Auto-inject current task context from PRD when user sends manual prompts during a ralph session
- Block prompts that would conflict with the current task pipeline
- Detect when users send handoff-style prompts and correlate them with the active task

#### 4. `SubagentStart` — Full gap

Not in `RalphHookType`, not registered.

**VS Code behavior**: Fires when a subagent (e.g., Plan agent) starts ([toolCallingLoop.ts L456](../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L456)). Input includes `agent_id` and `agent_type`. Output can inject `additionalContext`.

**Integration opportunity (HIGH for handoffs)**: When handoffs trigger a subagent (e.g., handoff from Plan → Agent), ralph-loop could:
- Inject the current task's instruction set and knowledge blocks into the subagent
- Track which subagent is executing which ralph task
- Correlate handoff transitions with task state machine events
- This is the **primary missed handoff-to-hook integration opportunity**

#### 5. `SubagentStop` — Full gap

Not in `RalphHookType`, not registered.

**VS Code behavior**: Fires when a subagent finishes ([toolCallingLoop.ts L499](../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#L499)). Can return `decision: 'block'` to prevent the subagent from stopping.

**Integration opportunity (MEDIUM)**: Ralph-loop could prevent a subagent from stopping until its verification gates pass, analogous to the current `Stop` hook behavior but scoped to subagent sessions.

#### 6. `SessionEnd` — Full gap

Not in `RalphHookType`, not registered.

**VS Code behavior**: Fires when a session ends. Not currently invoked in the codebase (appears only in the type definition), suggesting it may be reserved for future use.

**Integration opportunity (LOW)**: Would be useful for cleanup and final state persistence, but since VS Code doesn't invoke it yet, this is speculative.

#### 7. `ErrorOccurred` — Full gap

Not in `RalphHookType`, not registered.

**VS Code behavior**: Present in `ChatHookType` but no input/output types are defined in `chatHookService.ts` yet. Appears to be reserved/planned.

**Integration opportunity (MEDIUM)**: Ralph-loop's `CircuitBreakerTripped` and `Error` events could feed into this hook for bidirectional error coordination.

#### 8. `Stop` — Type-bridge gap

`Stop` is **not** in `RalphHookType` but **is** registered in `hookBridge.ts` as the primary verification gate. This is a naming disconnect: ralph-loop maps its internal `PreComplete` concept to VS Code's `Stop` hook.

### Handoff-to-Hook Integration Opportunities

Based on research from [wave research-1](../research/_wave/2026-03-15-post-wave-handoffs/research-1.md), handoffs in VS Code use `SwitchAgentTool` or frontmatter `handoffs:` to transition between agents while preserving session context. The key missed integrations:

1. **SubagentStart + Handoff correlation**: When a handoff triggers `toggleAgentMode`, the `SubagentStart` hook fires. Ralph-loop should register a `SubagentStart` hook that injects the current task's verification requirements and continuation context into the new agent's session.

2. **UserPromptSubmit + Handoff prompt**: The handoff `prompt` field gets auto-submitted. A `UserPromptSubmit` hook could detect these handoff prompts and automatically wrap them with ralph-loop's task context, knowledge blocks, and safety constraints.

3. **PreToolUse + SwitchAgentTool**: When the LLM programmatically calls `SwitchAgentTool`, a `PreToolUse` hook could intercept this and ensure the handoff is appropriate for the current task state (e.g., don't switch to Agent mode if verification hasn't passed).

## Patterns

| Pattern | Description |
|---------|-------------|
| **Hook bridge as adapter** | Ralph-loop generates Node.js scripts at runtime and registers them via `chat.hooks` config — clean adapter pattern between ralph-loop's internal hook system and VS Code's external hook API |
| **Dual hook systems** | Ralph has both `IRalphHookService` (internal, programmatic) and `hookBridge.ts` (external, VS Code integration). Only 3 of 5 internal hook types have VS Code equivalents registered |
| **Exit code convention** | VS Code hooks use exit codes: 0=success, 1=warning, 2=error/block. Ralph's `ShellHookProvider` follows the same convention |
| **Context injection pattern** | Both `SessionStart`, `SubagentStart`, `PreCompact`, and `UserPromptSubmit` share `additionalContext` in their output — standardized context injection mechanism |
| **Verification-as-Stop** | Ralph maps its verification gate to VS Code's `Stop` hook, but doesn't have `Stop` in its own type system — semantic mismatch |

## Applicability

**HIGH** — This gap analysis reveals 5 unimplemented VS Code hooks with concrete integration opportunities. The highest-value additions are:

1. **`PreToolUse`** (HIGH): Unifies ralph-loop's command blocking with VS Code's permission system
2. **`SubagentStart`** (HIGH): Enables seamless handoff context injection for multi-agent workflows
3. **`SessionStart` registration** (HIGH): Auto-injects task context at session inception
4. **`UserPromptSubmit`** (MEDIUM): Detects and augments handoff-triggered prompts
5. **`SubagentStop`** (MEDIUM): Extends verification gates to subagent sessions

The `SessionEnd` and `ErrorOccurred` hooks are low-priority since VS Code doesn't fully implement them yet.

## Open Questions

1. **Should `RalphHookType` include `Stop`?** The hookBridge registers a `Stop` hook but it's missing from the type union. Is this intentional (keeping internal semantics separate) or an oversight?

2. **Will `ErrorOccurred` get input/output types?** No interfaces are defined yet in `chatHookService.ts`. Ralph-loop should wait for stabilization.

3. **Handoff detection heuristic**: If ralph-loop registers a `UserPromptSubmit` hook, how should it differentiate user-typed prompts from handoff-injected prompts? The handoff system uses the same input mechanism.

4. **Subagent identity mapping**: When `SubagentStart` fires with `agent_type`, how does ralph-loop map that to its internal task graph? The `agent_id` appears to be opaque.

5. **Hook registration timing**: `registerHookBridge()` writes to `chat.hooks` workspace config. If multiple ralph sessions overlap, hooks could conflict. Should hooks be registered per-session instead of per-workspace?

6. **`PreComplete` vs `Stop` reconciliation**: Ralph-loop's `PreComplete` and VS Code's `Stop` serve similar purposes but with different semantics. Should ralph-loop maintain `PreComplete` as an internal concept and map it entirely to `Stop`, or should they remain separate?
