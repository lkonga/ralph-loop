---
type: research
id: 5
sources:
  - 10 plan variants evaluated by expert review subagents (March 2026)
---
# Expert Review — Plan Scoring & Rankings

> Source: 10 plan variants evaluated by expert review subagents (March 2026)
> Context: 5 architectural plans × 2 variants each = 10 total candidates

---

## Scoring Matrix

| Rank | Plan | Score | Verdict |
|------|------|-------|---------|
| **#1** | **B2: CLI-First Minimal** | **8.00** | ~500 LOC, 1 dep, EventEmitter pipeline |
| **#2** | **E2: Modular Core Minimal** | **7.85** | ~700 LOC, async generator, functional core |
| #3 | B1: CLI Full | 6.55 | Over-engineered monorepo |
| #4 | E1: Modular Full | 6.45 | Over-engineered monorepo |
| #5 | C1: Bash+Ext | 6.00 | Fragile sed/grep parsing |
| #6 | A2: Pure Ext Min | 5.60 | **No CLI** — fails requirement |
| #7 | D1: Agent.md Multi | 5.40 | **Non-deterministic** — fatal flaw |
| #8 | D2: Agent.md Single | 5.15 | **Non-deterministic** — fatal flaw |
| #9 | C2: Make+jq | 4.85 | Alien Makefile DSL |
| #10 | A1: Pure Ext Full | 3.85 | Massive overkill (25 files, 2500 LOC) |

---

## Winning Plan: Hybrid B2 + E2

**Combined score: ~8.3**

Takes B2's minimalism + E2's async generator pattern:

```
ralph-loop/
├── package.json          # single package, bin: { ralph }
├── src/
│   ├── ralph.ts          # CLI entry (raw process.argv, no commander)
│   ├── config.ts         # TOML/YAML parsing (~60 lines)
│   ├── core.ts           # async generator orchestrator (~200 lines)
│   ├── verify.ts         # 6 verification types (~100 lines)
│   └── drivers.ts        # AgentDriver interface + shell/vscode impls (~80 lines)
```

**~450 LOC for Phase 1.** Key choices:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DSL format | TOML | No indentation hell, simpler than YAML |
| Orchestrator | Async generator | Composable, cancellable, testable |
| Phase 1 driver | Shell (`claude --print`) | Works from day 1 without VS Code |
| Phase 2 driver | VS Code URI handler | ~40 lines extension |
| Phase 3 driver | HTTP endpoint wrapper | For maestro integration |

---

## Why Plans Were Rejected

| Plan | Fatal Flaw |
|------|-----------|
| **A1/A2 (Pure Extension)** | No CLI tool — can't be source of truth for task management |
| **B1/E1 (Full Monorepo)** | Over-engineered for v1 — dozens of files, hundreds of abstractions |
| **C1/C2 (Bash+Extension)** | Fragile bash parsing with sed/grep; C2 uses alien Makefile DSL |
| **D1/D2 (Agent.md)** | **Non-deterministic** — delegates control to LLM agent instructions. Circuit breaker becomes prose, not code. Fatal for reliability. |

### The Non-Determinism Problem (D Plans)

The `.agent.md` approach (giocaizzi/ralph-copilot style) looks elegant but has a fundamental flaw: the "circuit breaker" and "verification" become **prompt instructions** rather than **executable code**. The LLM can:
- Ignore the circuit breaker prose
- Hallucinate verification results
- Skip steps or reorder them
- Behave differently across model versions

Ralph's entire value proposition is **deterministic control over a non-deterministic system**. Delegating the control plane to the same non-deterministic system defeats the purpose.

---

## Key Architectural Decisions

### 1. Async Generator Over EventEmitter

The async generator pattern was chosen over EventEmitter because:

```typescript
// Generator pattern — consumer controls flow
for await (const event of orchestrator.run()) {
    if (event.kind === LoopEventKind.TaskCompleted) {
        console.log(`Done: ${event.task.description}`);
    }
    if (shouldAbort) break; // consumer can cancel naturally
}
```

vs.

```typescript
// EventEmitter pattern — producer controls flow
orchestrator.on('taskCompleted', (task) => {
    console.log(`Done: ${task.description}`);
});
orchestrator.on('error', (err) => { /* must handle */ });
orchestrator.start(); // fire and forget, harder to cancel
```

Generators provide:
- **Backpressure** — consumer pulls events, not pushed
- **Cancellation** — `break` stops the loop cleanly
- **Testability** — just iterate and assert
- **Composability** — can chain/filter/transform streams

### 2. TOML Over YAML

TOML was initially preferred but the actual implementation uses **PRD.md with markdown checkboxes** as the DSL — which is even simpler. The PRD.md format:

```markdown
- [ ] Task 1 description
- [ ] Task 2 description
- [x] Completed task
```

This is the simplest possible DSL: human-readable, version-controllable, and the completion signal is just a checkbox flip.

### 3. Shell Driver as Phase 1

The `claude --print` shell driver allows testing the loop without VS Code:

```bash
cat prompt.md | claude --dangerously-skip-permissions --print
```

The actual Phase 1 implementation went directly to VS Code workbench commands, since that's where Copilot lives. The CLI handles task management only (`init`, `status`, `next`).

---

## Open Questions (from original research)

1. **PreCompact hook**: Should ralph use `PreCompact` to trigger session reset? (Requires proposed API)
2. **Chat participant vs. command**: Should ralph register as `@ralph` participant or stay command-based?
3. **Git integration**: Should each task auto-commit? (giocaizzi pattern)
4. **Multi-verifier**: Should verification expand beyond checkbox checking? (Gsaecy's 6 types)
5. **Parallel tasks**: When should parallel execution be enabled? (DAG dependencies)
6. **Model tiering**: Should planning use a cheaper model than execution? (Explore agent pattern)
7. **Context budget**: How to measure and cap context usage per task?
8. **Telemetry**: What metrics should Ralph track for optimization?
