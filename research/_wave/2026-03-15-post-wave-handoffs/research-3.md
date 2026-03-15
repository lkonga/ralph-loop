# Q3: Conditional Implementation Subagent Pattern

## Findings

### 1. VS Code's Handoff Mechanism (Plan Agent → Implementation)

The Plan agent in VS Code Copilot Chat uses a **handoff button pattern** — not programmatic auto-dispatch. Key evidence:

- `PlanAgentProvider` defines `AgentHandoff` objects with `{ label, agent, prompt, send, showContinueOn, model }` (see `agentTypes.ts`).
- The Plan agent creates a "Start Implementation" handoff button: `{ label: 'Start Implementation', agent: 'agent', prompt: 'Start implementation', send: true }`.
- The Plan agent is explicitly instructed "Your SOLE responsibility is planning. NEVER start implementation." It tells users: "Approval given → acknowledge, the user can now use handoff buttons."
- This is a **user-gated** transition: the LLM produces a plan, renders handoff buttons, and the *user* clicks to dispatch implementation.
- `send: true` means clicking the button automatically sends the prompt without requiring user edit. `showContinueOn: false` hides the "Open in Editor" continuation.

### 2. LLM Tool Call Decisions Are Inherently Conditional

The tool calling loop (`ToolCallingLoop` in `src/extension/intents/node/toolCallingLoop.ts`) works by:
- Sending messages with available tools list to the LLM
- LLM decides which tools to call (or none) based on context
- The loop iterates until the LLM stops requesting tool calls

This means the LLM can **already conditionally skip steps** — it simply doesn't call `runSubagent` if it determines no action is needed. No special programmatic gating is required for optional dispatch.

### 3. Subagent Dispatch in Wave Orchestrator

The wave orchestrator (`wave-orchestrator.agent.md`) uses `agents: ['wave-decompose', 'wave-research', 'wave-aggregate', 'coder']` and follows a fixed pipeline: decompose → research → aggregate. Every step always runs. There is no conditional "skip aggregation if results are trivial" logic — only the `--direct` and `--same` flags bypass stages, set by the *user* at invocation time.

### 4. Hook-Based Decision Points

The orchestrator has a `Stop` hook (`wave-orchestrator-stop.py`) that fires when the orchestrator completes. This is post-hoc — it could be used to trigger implementation, but hooks currently run shell commands for side effects (e.g., logging), not for dispatching new agents.

## Patterns

### Pattern A: User-Gated Handoff (VS Code Plan Agent Pattern)
```
Orchestrator completes wave → writes FINAL-REPORT.md
→ Presents summary + handoff button: "Implement Changes"
→ User clicks → dispatches coder subagent with FINAL-REPORT context
```
**Pros**: Safe, user retains control, no wasted compute on unwanted changes.
**Cons**: Requires user interaction, breaks full automation.

**Implementation**: Add `handoffs` to `wave-orchestrator.agent.md`:
```yaml
handoffs:
  - label: Implement Changes
    agent: coder
    prompt: 'Read FINAL-REPORT.md and implement the recommended changes'
    send: false  # user reviews prompt before sending
```

### Pattern B: LLM-Decided Conditional Dispatch (Recommended)
```
Orchestrator completes wave → reads FINAL-REPORT.md
→ LLM evaluates: "Does this report contain actionable implementation items?"
→ If yes: dispatches coder subagent with extracted action items
→ If no: presents report and stops
```
**Pros**: Fully automated, LLM makes contextual judgment.
**Cons**: Risk of unwanted implementation, harder to audit decision.

**Implementation**: Add a Step 5 to the orchestrator's aggregate mode instructions:
```markdown
### Step 5: Conditional Implementation (optional, when --implement flag is set)
Read FINAL-REPORT.md. If it contains concrete, actionable code changes:
1. Extract the implementation items
2. Dispatch 1 **coder** subagent with the extracted plan
3. Coder implements changes and reports results
If FINAL-REPORT contains only analysis/research with no actionable items, skip this step.
```

### Pattern C: Hybrid — Auto-Detect + User Confirmation
```
Orchestrator reads FINAL-REPORT → detects actionable items
→ Uses askQuestions tool: "FINAL-REPORT contains N actionable items. Implement?"
→ User confirms → dispatches coder
```
**Pros**: Best of both worlds — automated detection, user confirmation.
**Cons**: Adds one interaction step.

## Applicability

### Adding to wave-explore-fast

The most practical approach combines Pattern B with an opt-in flag:

1. **Add `--implement` flag** to `wave-explore-fast.prompt.md` input parsing:
   ```
   - `--implement` = after FINAL-REPORT, dispatch coder to implement actionable items
   ```

2. **Add Step 5** to aggregate mode in both orchestrator and prompt:
   ```markdown
   ### Step 5: Conditional Implementation (when --implement flag is present)
   Read FINAL-REPORT.md. Extract sections labeled "Recommended Plan" or "Action Items".
   If actionable items exist, dispatch 1 **coder** subagent that:
   - Reads FINAL-REPORT.md
   - Implements each recommended change
   - Writes implementation log to research/_wave/{WAVE_ID}/IMPLEMENTATION.md
   Present implementation summary alongside the report.
   ```

3. **The LLM naturally handles the "no actionable items" case** — if the report is pure research with no concrete changes, instructing the LLM "if actionable items exist" is sufficient. The LLM simply won't dispatch.

4. **No code changes needed** — this is purely agent instruction changes in `.agent.md` and `.prompt.md` files.

### Decision Mechanism

The orchestrator can make this decision programmatically because:
- LLMs excel at classifying text content ("does this contain action items?")
- The FINAL-REPORT already has a `Recommended Plan` section by design
- The `runSubagent` tool call is inherently optional — the LLM only calls it when warranted
- No special gating logic is needed beyond clear conditional instructions

## Open Questions

1. **Scope control**: How to prevent the coder from making broad changes when the report recommends large refactors? Need a mechanism to limit scope (e.g., "implement only items marked P0").
2. **Verification**: Should the orchestrator verify coder output, or trust-and-report? A verification step would add another subagent dispatch.
3. **Conflict with `--direct` mode**: Direct mode has no files — how would implementation work without FINAL-REPORT.md? Likely `--implement` should only work with aggregate mode.
4. **Token budget**: The coder subagent has an 8k output cap. Large implementation plans may need multiple coder dispatches (phase-by-phase).
5. **Rollback**: If implementation fails, should the orchestrator revert changes or just report the failure?
