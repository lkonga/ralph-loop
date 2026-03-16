## Research 1: ralph-loop Core Value Proposition

### Findings

**Identity & Metadata**
- **Name**: `ralph-loop` | **Display name**: "Ralph Loop — Autonomous PRD Loop"
- **Description**: "Drives Copilot Agent Mode in a deterministic loop from PRD tasks."
- **Version**: 0.4.1 | **Publisher**: ralph-loop | **License**: MIT
- **Categories**: AI, Other | **Engine**: VS Code ^1.93.0
- **Activation**: `workspaceContains:PRD.md` — activates when a PRD file is present

**Core Value Proposition**
Ralph-loop is a VS Code extension that turns a markdown PRD (Product Requirements Document) with checkbox tasks into a fully autonomous execution loop. The fundamental insight, shared across the broader Ralph ecosystem (20+ implementations), is:

> **Context rot is unsolvable within a session, so nuke the context and persist state in files.**

The extension reads `- [ ]` checkbox tasks from `PRD.md`, opens a **fresh** Copilot Agent Mode session for each task, sends a crafted prompt, monitors for checkbox completion via file watchers, and advances to the next task — repeating until all tasks are done or limits are hit.

**What Makes It Unique vs. Other Ralph Implementations**
Ralph-loop is the most feature-rich VS Code extension implementation in the ecosystem. Compared to the original snarktank/ralph (113-line bash script) or frankbria/ralph-claude-code (1900-line bash for Claude CLI), ralph-loop:

1. **Deeply integrates with VS Code** — uses internal workbench commands (`chat.newEditSession`, `chat.open`), proposed APIs (`chatHooks`, `chatParticipantPrivate`), and file watchers
2. **Has the richest guardrail system** — circuit breakers (5 types: max-retries, max-nudges, stagnation, error-rate, time-budget), struggle detection (3 signals), stagnation detection via progress hashing, input sanitization, shell command safety gates
3. **Supports compounding knowledge** — `[LEARNING]`/`[GAP]` tag extraction persisted to `knowledge.md`, re-injected into future task prompts via keyword matching
4. **Implements TDD as mandatory gate** — the stop hook verifies `tsc --noEmit` and `vitest run` before allowing task completion
5. **Has been self-hosting since Phase 1** — the PRD is "being executed BY ralph-loop ON itself"

**Architecture Summary**
- 21 source modules in `src/` covering: PRD parsing, prompt building, Copilot interaction (3-level fallback), verification (multi-verifier registry), orchestration (async generator loop), circuit breakers, stagnation/struggle detection, knowledge persistence, git ops, hook bridge, session persistence, diff validation, consistency checking
- CLI companion (`ralph init/status/next`) for PRD management outside VS Code
- 9 phases of development completed (Phase 1 basic loop → Phase 9 frontmatter/PD navigation)
- ~361+ tests via Vitest

**The Loop in One Sentence**
Parse PRD → pick next `[ ]` task → fresh Copilot session → build prompt (task + context + gates + learnings) → send → watch for `[x]` → verify (checkbox + tsc + vitest) → nudge/retry/decompose if stuck → commit → next task → repeat.

**Dual Delivery**
- **VS Code Extension**: The actual loop — must run inside VS Code because Copilot's workbench commands only exist in the extension host
- **CLI** (`npx ralph`): PRD/task file management (`init`, `status`, `next`) — works from any terminal

### Patterns

1. **Fresh-session-per-task**: Every task gets a clean Copilot context — no accumulated history pollution
2. **File-based state persistence**: `PRD.md` (task list), `progress.txt` (execution log), `knowledge.md` (learnings), git commits (ground truth)
3. **Dual exit gate**: Model claims done (checkbox) AND machine verifies (tsc + vitest pass)
4. **Progressive escalation**: nudge → retry → decompose → human checkpoint → stop
5. **Self-resetting counters**: Productive file changes reset nudge/stagnation counters
6. **PRD as single source of truth**: Two-tier task format — inline (≤3 sentences) or PD-reference (points to spec file with YAML frontmatter)
7. **Defense-in-depth prompting**: ROLE & BEHAVIOR → DO NOT STOP IF → TDD GATE → prompt blocks (security/safety/discipline/brevity) → AVAILABLE CAPABILITIES

### Applicability

This identity information matters for a README because:
- The **one-liner** ("Drives Copilot Agent Mode in a deterministic loop from PRD tasks") is the elevator pitch
- The **activation event** (`workspaceContains:PRD.md`) defines the zero-config UX — just drop a PRD.md
- The **ecosystem context** (20+ Ralph implementations) positions this as the most mature VS Code-native variant
- The **self-hosting fact** ("executed BY ralph-loop ON itself") is both a credibility signal and usage example
- The **architecture diagram** from the current README is concise and effective
- The **phase history** (9 phases, 361+ tests) communicates maturity and active development

### Open Questions

1. **Target audience clarity**: Is this for solo developers automating their own PRDs, or teams? The README doesn't specify.
2. **Marketplace readiness**: Version 0.4.1 with publisher "ralph-loop" — is this published to the VS Code Marketplace or install-from-source only?
3. **Model agnosticism**: The extension drives "Copilot Agent Mode" — does it work with any model Copilot exposes, or is it tuned for specific models? (`modelHint` config suggests awareness but unclear UX.
4. **Relationship to snarktank/ralph**: Is this a fork/spiritual successor, or independent? The ecosystem analysis treats them as peers.
5. **Minimum viable README scope**: The current README is already comprehensive (~120 lines with architecture diagram). What's the target revision — shorter/friendlier, or expanded with ecosystem positioning?
