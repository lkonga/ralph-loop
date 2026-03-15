# FINAL REPORT: Post-Wave Implementation — Handoffs, Subagents & Mode Restoration

## Executive Summary

**Q1: Can handoffs to a coder solve wave's read-only limitation?** Yes. Two proven mechanisms exist: (a) `handoffs:` YAML frontmatter renders UI buttons that switch to coder/agent mode with full tool access (edit, terminal, create files), and (b) `runSubagent` dispatches a coder programmatically with full implementation tools. Both require zero code changes — only `.agent.md` frontmatter edits.

**Q2: Will context be lost?** No. Handoffs pass `sessionResource` to `toggleAgentMode`, continuing the same chat session. The target agent sees the complete conversation history including all research turns and FINAL-REPORT. Subagents are isolated (receive only the invocation prompt), making handoffs strongly preferred for context-rich research output.

**Q3: Can subagent dispatch be optional?** Yes. The LLM's tool-calling loop is inherently conditional — it only calls `runSubagent` when warranted. Adding an `--implement` flag plus conditional instructions ("if actionable items exist, dispatch coder") is sufficient. No programmatic gating code needed.

**Q4: Can we return to Agent mode after wave-explore-fast?** Yes. Add `handoffs: [{label: "Continue with Agent Mode", agent: agent, prompt: "Continue in Agent Mode.", send: true}]` to the agent frontmatter. Mode is sticky per-session, so without a handoff, users must manually switch via the mode dropdown or start a new chat.

---

## Consolidated Findings

### 1. Context Preservation Across Handoffs

Handoffs use `sessionResource` URI — the same chat session continues. The target agent inherits the **full conversation thread** (all prior turns, tool calls, and outputs). The handoff `prompt` is injected as a new user message on top of existing history — additive, not replacing. Disk session resources (files written via `ChatDiskSessionResources`) survive with 8h TTL.

**Caveat**: While history survives mechanically, the context window is finite. Long research sessions may see older turns truncated by prompt-tsx token budgeting in the new agent — this is a rendering constraint, not a handoff limitation.

**Subagent contrast**: `runSubagent` creates an isolated session — the child receives only the invocation prompt string, not parent history. This makes subagents unsuitable when rich, unstructured research context is needed by the implementer.

### 2. Coder Subagent Capabilities

`runSubagent` grants full tool access per the target agent's `.agent.md` frontmatter. The coder agent declares: `edit/editFiles`, `edit/createFile`, `execute/runInTerminal`, `read/readFile`, `read/problems`, `search`, `agent` (sub-delegation), and web tools. No tool stripping or restriction code exists for `runSubagent` children.

**Critical distinction**: `search_subagent` (used by Explore) is read-only — it filters to grep/glob/semantic search only. Always use `runSubagent` (the `agent` tool) for implementation dispatch.

### 3. Implementation Strategy — Two Viable Approaches

**Approach A: Handoff (Recommended for wave)**
- User-gated via UI button after FINAL-REPORT renders
- Full conversation context preserved (no serialization needed)
- Terminal for the orchestrator — cannot verify implementation results
- Supports `model:` override for routing to a stronger implementation model
- Pattern proven by Plan agent ("Start Implementation" → Agent mode)

**Approach B: Subagent**
- Orchestrator-controlled, can verify results and iterate
- Isolated context — must serialize key findings into the prompt
- Parent survives, enabling multi-step coordination and error recovery
- Better for phased implementation requiring orchestrator oversight

**Recommendation**: Use handoffs for wave. Research output is rich and unstructured — serializing it into a subagent prompt is lossy. The handoff's context preservation is decisive.

### 4. Conditional Implementation Pattern

Three patterns identified:

| Pattern | Mechanism | User Control | Automation |
|---------|-----------|-------------|------------|
| **A: User-Gated** | `handoffs:` button, `send: false` | Full — user clicks to trigger | None |
| **B: LLM-Decided** | `--implement` flag + conditional instructions | None — LLM decides | Full |
| **C: Hybrid** | Auto-detect + `askQuestions` confirmation | Confirmation only | Detection automated |

**Recommended**: Pattern A (handoff button with `send: false`) as the default, with Pattern B (`--implement` flag) as an opt-in for automation. The LLM's tool-calling loop is inherently conditional — no gating code needed, just clear conditional instructions.

### 5. Mode Restoration

Mode is **per-session and sticky**. Custom agent completion does not trigger a mode switch. Three restoration methods:

1. **Handoff button** (recommended): Add `handoffs: [{agent: agent, label: "Continue with Agent Mode", send: true}]` to the agent frontmatter
2. **Manual dropdown**: User clicks mode selector → "Agent"
3. **New chat**: `Cmd/Ctrl+Shift+I` starts fresh in default mode

The `switchAgentTool` only supports switching to Plan — it cannot programmatically return to Agent. Handoff frontmatter is the only declarative solution.

### 6. Recommended Architecture for wave-explore-fast

Add to `wave-orchestrator.agent.md` frontmatter:

```yaml
handoffs:
  - label: Implement Findings
    agent: coder
    prompt: 'Read the FINAL-REPORT above and implement the recommended changes. Follow the priority matrix — start with P0 items.'
    send: false
  - label: Continue with Agent Mode
    agent: agent
    prompt: 'Continue in full Agent Mode with all tools available.'
    send: true
  - label: Open Report in Editor
    agent: agent
    prompt: '#createFile the FINAL-REPORT into an untitled file for review and editing.'
    showContinueOn: false
    send: true
```

For `--implement` automation, add Step 5 to aggregate mode instructions:

```markdown
### Step 5: Conditional Implementation (when --implement flag is present)
Read FINAL-REPORT.md. If it contains concrete action items or a priority matrix:
1. Extract P0/P1 items into a focused implementation plan
2. Dispatch 1 **coder** subagent with the extracted plan
3. Write results to research/_wave/{WAVE_ID}/IMPLEMENTATION.md
If no actionable items exist, skip this step and present report only.
```

---

## Priority Matrix

| Priority | Item | Impact | Effort | Recommendation |
|----------|------|--------|--------|----------------|
| **P0** | Add `handoffs:` to wave-orchestrator.agent.md | Enables post-research implementation | 5 min — YAML only | Add 3 handoff buttons (implement, agent mode, open in editor) |
| **P0** | Verify context survives in practice | Confirms core assumption | 10 min — manual test | Run wave, click handoff, verify coder sees history |
| **P1** | Add `--implement` flag to wave-explore-fast | Opt-in automation | 15 min — prompt edits | Add flag parsing + Step 5 conditional dispatch |
| **P1** | Document 8k coder output cap workaround | Prevents failed large implementations | 5 min — instructions | Add "chunk action items into phases" guidance |
| **P2** | Test chained handoffs (orchestrator → coder → agent) | Validates multi-hop flow | 15 min — manual test | Verify coder can also hand off back |
| **P2** | Add `model:` override to implementation handoff | Route to stronger model | 2 min — YAML field | Add `model: 'Claude Opus 4.6 (fast mode) (Preview) (copilot)'` |
| **P3** | Investigate token budgeting across handoffs | Understand context truncation risk | Research task | Check if prompt-tsx re-budgets on agent switch |
| **P3** | Design post-implementation verification step | Validate coder output | Design task | Explore subagent for test running after implementation |

## Recommended Implementation Plan

1. **Add `handoffs:` frontmatter** to `wave-orchestrator.agent.md` — three buttons: "Implement Findings" (coder, `send: false`), "Continue with Agent Mode" (agent, `send: true`), "Open Report in Editor" (agent, `showContinueOn: false`)
2. **Test the handoff flow** — run wave-explore-fast, verify handoff preserves context, verify coder has edit/terminal tools
3. **Add `--implement` flag** to `wave-explore-fast.prompt.md` input parsing and Step 5 conditional dispatch in orchestrator instructions
4. **Add chunking guidance** to orchestrator instructions for splitting large implementation plans across multiple coder dispatches (8k output cap)
5. **Document the workflow** — update wave documentation with post-research implementation options

## Gaps & Future Research

1. **Token budgeting across handoffs** — Does prompt-tsx re-render the context window on agent switch, potentially dropping critical earlier turns? No codebase evidence available (logic is in VS Code core).
2. **`runSubagent` parallelism** — Unknown whether multiple `runSubagent` calls run concurrently or serialize. Affects multi-phase implementation dispatch.
3. **Approval propagation** — Whether `permissionLevel: 'autoApprove'` inherits to `runSubagent` children is unverified. If not, coder subagents block on file edit approvals.
4. **Handoff prompt templating** — No path interpolation exists. FINAL-REPORT file path must be hardcoded in the prompt or the coder must find it via conversation history.
5. **Rollback on failure** — No mechanism for reverting partial coder changes if implementation fails. Git stash/branch strategies could mitigate but aren't built in.
6. **`switchAgentTool` target restriction** — Currently Plan-only. Extending to arbitrary agents for programmatic handoff would require VS Code core changes.
