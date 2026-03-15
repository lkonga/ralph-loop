# Aggregation B: Mode Restoration, Tradeoffs & Existing Patterns

## Deduplicated Findings

### F1: Mode is per-session and sticky — no auto-restore exists
Mode persists across all turns in a chat session. Custom agent completion does **not** trigger a mode switch. This is intentional design, not a gap. (R4, R6)

### F2: Handoffs are the declarative mode-transition mechanism
The `handoffs:` YAML frontmatter is a first-class feature parsed by `promptFileParser.ts`. It supports `agent`, `label`, `prompt`, `send`, `showContinueOn`, and `model` fields. No code changes needed to add handoffs to any `.agent.md`. (R4, R5, R6)

### F3: Handoffs preserve full conversation context; subagents are isolated
Handoff continues the same session — target agent sees all prior turns. Subagents receive only the invocation prompt string. This makes handoffs strongly preferred when research output is rich and unstructured. (R5)

### F4: Handoff is terminal for the source agent — no verification loop
The orchestrator "dies" on handoff. It cannot verify implementation results. Subagents allow the parent to survive, inspect output, and iterate. (R5)

### F5: Every existing research→implement transition is human-gated
Plan agent renders buttons. Claude SDK uses `ExitPlanMode` with confirmation dialog. No auto-implement pipeline exists in the codebase. (R6)

### F6: wave-orchestrator currently has zero handoffs defined
After research completes, it outputs FINAL-REPORT and stops. Post-wave action is entirely manual. (R6)

### F7: Plan agent demonstrates the canonical hybrid pattern
Uses **subagents** (Explore) for research fan-out, then **handoff** for implementation. Research benefits from orchestrator-controlled iteration; implementation benefits from full context. (R5, R6)

### F8: Model switching is supported in handoffs
The `model:` field in handoff config allows routing implementation to a different (stronger/cheaper) model than used for research. (R4, R5, R6)

## Cross-Report Patterns

### CP1: Handoff-as-phase-gate consensus
All three reports converge on handoffs being the right mechanism for wave's research→implement transition. R4 recommends it for mode restoration, R5's decision framework selects it for terminal implementation, R6 confirms it requires zero code changes.

### CP2: Context preservation is the decisive factor
R4 shows mode carries conversation history. R5 quantifies: handoff = full history, subagent = serialized prompt only. R6 confirms Plan agent relies on implicit context carry (not structured data passing). The pattern is clear: rich research output demands handoff, not subagent dispatch.

### CP3: Human-in-the-loop as intentional design
R4: no auto-restore. R5: handoff creates "natural review point." R6: every transition is button-gated or dialog-confirmed. The codebase consistently treats research→implement transitions as user-controlled gates.

### CP4: Memory/file bridging gap
R4 doesn't address artifact persistence. R5 raises session memory question. R6 identifies that Plan uses `vscode/memory` but wave writes files directly. No automatic mechanism connects research artifacts to implementation context across the handoff boundary.

## Priority Matrix

| Priority | Finding | Source | Action |
|----------|---------|--------|--------|
| **P0** | wave-orchestrator has no handoffs | R6/F6 | Add `handoffs:` to `wave-orchestrator.agent.md` with `agent: coder` or `agent: agent` |
| **P0** | Handoff is zero-code-change | R4/R6/F2 | Use YAML frontmatter — no extension modification needed |
| **P1** | `send: false` for user review gate | R5/F5 | Set `send: false` so user can edit prompt before dispatching implementation |
| **P1** | Model override for implementation | R5/R6/F8 | Add `model:` field to route implementation to stronger model |
| **P2** | "Open in Editor" secondary handoff | R6 | Add second handoff exporting FINAL-REPORT as `.prompt.md` for refinement |
| **P2** | Session memory bridging | R5/R6/CP4 | Bake FINAL-REPORT file path into handoff prompt string (no template engine exists) |
| **P3** | Chained handoff validation | R4/R6 | Test whether handoff targets can define their own handoffs (supported but untested) |

## Gaps

1. **No path interpolation in handoff prompts** — FINAL-REPORT path must be hardcoded or the prompt must instruct the target to find it. No template engine exists for dynamic prompt construction in handoffs.
2. **`send: true` still requires a button click** — there is no truly automatic fire-and-forget handoff. R5 and R6 both flag this but neither found a workaround.
3. **Subagent token budget limits unknown** — R5 asks about max prompt size for subagents but no report answers it. Relevant if the fallback is subagent-based implementation.
4. **`switchAgentTool` is Plan-only** — R4 notes it rejects non-Plan agent names. Whether `toggleAgentMode` accepts custom agent names is unconfirmed.
5. **No verification after handoff** — all three reports acknowledge the orchestrator cannot verify implementation results post-handoff. The hybrid pattern (subagent verify + handoff implement) is theorized in R5 but not validated.
6. **Default mode for new chats** — R4 asks if this is configurable; no report answers. Affects the "start new chat" escape hatch UX.
