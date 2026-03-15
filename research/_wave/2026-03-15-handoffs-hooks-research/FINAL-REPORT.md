# Final Report: VS Code Agent Handoffs, Hooks, and Ralph-Loop Gap Analysis

## Executive Summary

Research across 12 agents covering handoff behavior, hook taxonomy, and ralph-loop coverage reveals:

1. **Handoff `send: true` = click-to-auto-submit, NOT fire-without-click.** All handoffs require a user button click. There is NO mechanism for fully automated handoff execution without user interaction. The button behavior is implemented in VS Code core (microsoft/vscode repo), not the Copilot Chat extension.

2. **Button position is always at END of response** — controlled by VS Code core rendering. The "appearing at start" observation is due to streaming: the button renders as soon as the frontmatter is parsed, before the response body finishes streaming.

3. **VS Code has 10 hook types; ralph-loop implements 5 in types and registers only 3 with VS Code.** Five hooks are completely missing: `PreToolUse`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `SessionEnd`, `ErrorOccurred`. The highest-value gap is `PreToolUse` which could unify ralph-loop's command blocking.

4. **No auto-switch mechanism exists.** The only way to programmatically route to another agent is `nextQuestion` in `ChatResult`, which auto-fills but does NOT auto-submit. Handoff buttons with `send: true` are the closest, but still require a click.

## Consolidated Findings

### A. Handoff System Architecture

| Property | Behavior |
|----------|----------|
| `send: true` | On button click: fills prompt AND auto-submits to target agent |
| `send: false` / absent | On button click: fills prompt, user must press Enter |
| `agent: agent` | Maps to `editsAgentName` = `github.copilot.editsAgent` (Agent mode) |
| Button position | Always at END of response (VS Code core rendering) |
| Auto-fire (no click) | **Not possible** — no mechanism exists |
| `nextQuestion` | Separate system — auto-fills input, no auto-submit, no button |
| `showContinueOn` | Separate "continue working" UI affordance, same boolean type as `send` |

**Three separate mechanisms exist:**
- `handoffs:` (button-based, click required, `send` controls auto-submit)
- `nextQuestion` (programmatic, auto-fill only, no submit)
- `autoSend` (inline chat only, full auto-execute — not applicable to panel chat)

### B. Hook Type Taxonomy

**VS Code defines 10 hooks (ChatHookType):**

| Hook | Fires When | Can Block? | Can Inject Context? | Ralph-Loop Status |
|------|-----------|:---:|:---:|---|
| `SessionStart` | New chat session | No (errors ignored) | Yes additionalContext | Type exists, not registered |
| `SessionEnd` | Chat session ends | N/A | N/A | **Missing** |
| `UserPromptSubmit` | User sends prompt | Yes decision: block | Yes additionalContext | **Missing** |
| `PreToolUse` | Before each tool call | Yes permissionDecision: deny | Yes updatedInput, additionalContext | **Missing (HIGH VALUE)** |
| `PostToolUse` | After each tool call | Yes can block result | Yes additionalContext | Implemented |
| `PreCompact` | Context compaction | No | Yes additionalContext | Implemented |
| `SubagentStart` | Before subagent spawns | No (errors ignored) | Yes additionalContext | **Missing** |
| `SubagentStop` | After subagent returns | Yes decision: block | Yes additionalContext | **Missing** |
| `Stop` | Agent wants to stop | Yes decision: block | Yes reason (becomes next turn) | Registered (not in RalphHookType) |
| `ErrorOccurred` | Error in agent | Defined but unimplemented | N/A | **Missing** |

**Claude Agent SDK adds 10 more** (20 total): `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Setup`, `TeammateIdle`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate/Remove`.

### C. Hook Execution Protocol

**VS Code protocol (NodeHookExecutor):**
- Spawn shell command via `child_process.spawn`, `stdio: 'pipe'`
- Input: JSON on stdin (with URI-to-path replacer)
- Output: JSON on stdout
- Exit codes: 0 = success, 2 = blocking error, other = non-blocking warning
- Timeout: 30s default, configurable per-hook
- Kill: SIGTERM then 5s then SIGKILL
- Sequential execution with early-stop on `stopReason`

**Ralph-loop protocol (ShellHookProvider):**
- Same spawn pattern, JSON stdin/stdout
- Exit codes: 0 = success, 1 = warning, 2 = block
- Timeout: 30s
- Kill: SIGTERM then 1s then SIGKILL
- Security: regex pre-gate for shell metacharacters

**HookBridge:**
- Generates Node.js scripts as template literals to temp files (mode 0755)
- Registers via VS Code `chat.hooks` workspace config
- Stop hook: 4 verification gates (PRD checkbox, progress.txt mtime, tsc, vitest)
- PreCompact hook: injects resumption context (progress tail, git diff, current task)
- PostToolUse hook: touches marker file for inactivity detection

### D. Gap Analysis — Ralph-Loop vs VS Code Hooks

**5 gaps with integration opportunities:**

1. **PreToolUse (HIGH VALUE):** Could unify ralph-loop's CommandBlocked logic and circuit breaker into a VS Code-level gate. Deny dangerous commands (rm -rf, git push --force) BEFORE tool execution. Currently ralph-loop only detects bad commands after the fact.

2. **UserPromptSubmit (MEDIUM):** Could auto-inject current task context when user sends manual prompts during a ralph session. Block conflicting prompts.

3. **SubagentStart (MEDIUM):** Could inject task context when handoffs trigger agent switches. Enable ralph-loop awareness of subagent spawning.

4. **SubagentStop (LOW):** Could verify subagent output quality before returning results to parent.

5. **SessionStart (LOW):** Already typed but not registered. Could auto-inject PRD + knowledge blocks at session start.

6. **SessionEnd / ErrorOccurred (LOW):** Cleanup and telemetry opportunities.

### E. Handoff Auto-Switch — Why It Did Not Work

The `send: true` handoff button requires a user click. The button appeared but no auto-execution happened because:

1. **Handoffs are declarative UI elements** — the extension writes YAML frontmatter, VS Code core renders buttons. No programmatic auto-fire path exists.
2. **nextQuestion** (the programmatic route) only auto-fills the input box — it does NOT auto-submit.
3. **autoSend** exists only for inline chat (Ctrl+I), not panel chat.

**Possible workarounds (none are clean):**
- Use `vscode.commands.executeCommand('workbench.action.chat.sendMessage')` after a delay — requires extension API access, not available from `.agent.md` instructions.
- Accept the click requirement — handoff buttons with `send: true` are the best available UX.

## Actionable Items (for user to implement)

1. **Accept click requirement for handoffs** — `send: true` is the maximum automation available. The button click is by design.
2. **Register SessionStart hook in hookBridge** — ralph-loop already has the type, just missing the bridge registration.
3. **Add PreToolUse hook** — highest-value gap for command safety.
4. **Add Stop to RalphHookType** — type-bridge gap, already registered but not in the union type.
5. **Update aichat CLI skill** — document wave system findings.
6. **Button-at-start is a streaming artifact** — not a configuration problem, normal behavior.

## Source Chain
- research-1.md through research-12.md
- Key source files: promptFileParser.ts, agentTypes.ts, planAgentProvider.ts, hookCommandTypes.ts, chatHookService.ts, hookExecutor.ts, hookResultProcessor.ts, toolCallingLoop.ts, ralph-loop/types.ts, ralph-loop/hookBridge.ts, ralph-loop/shellHookProvider.ts
