## ContextBrief

**Project**: Ralph Loop — deterministic VS Code Copilot Agent Mode orchestrator
**Stack**: TypeScript 5.4, VS Code Extension API 1.93+, Vitest 3.2, Node.js 20
**Structure**: `src/` (27 modules), `test/`, `cli/ralph.ts`, `research/`, `.ralph/`

### Completed
- Phases 1–5: Core loop, prompt builder, nudge/retry, circuit breakers, verification (7 verifiers), TDD gate
- Phases 6–15: Stagnation/struggle detection, knowledge extraction, presets, session persistence, git ops, hook system
- Phase 16: Startup latency & preflight transparency
- Phase 17–18: Feature branch enforcement (linear model)
- Phase 19: Status bar idle/processing consistency (partial — Task 143 pending)
- Phase 20: CPU load reduction — config-first test runner (Task 144 done, 145–147 pending)

### In Progress
- Task 143: Status bar regression coverage (Phase 19)
- Tasks 145–147: Config-first test runner verification and pool rationale (Phase 20)

### Numbering
- Last phase: 20 | Next: 21
- Last task: 147 | Next: 148
- Last research file: 18 | Next: 19

### Codebase Fingerprint
- **Top files by churn**: orchestrator.ts (79), types.ts (69), extension.ts (33), prompt.ts (23), prd.ts (19)
- **Key modules**: orchestrator.ts (async generator loop), verify.ts (7 verifiers), circuitBreaker.ts (7 breakers), statusBar.ts, copilot.ts, hookBridge.ts
- **Dependencies**: typescript 5.4, vitest 3.2, @types/vscode 1.93, @types/node 20
- **Cross-repo**: Status bar in copilot-chat fork is `src/extension/prompt/node/forkStatusBar.ts` (NOT `ralphStatusBar.ts`)

### Conventions
- Task naming: `Task NNN — Title` with conventional commit messages `feat(Task-NNN):`
- Phases: `## Phase N — Title` in PRD.md; research files: `NN-description.md`
- TDD mandatory: red-green-refactor, `npx tsc --noEmit` + `npx vitest run` before checkbox
- Config via `RalphConfig` / `RalphFeatures` in `src/types.ts`, VS Code settings under `ralph-loop.*`

### Do NOT Research
- Loop architecture, nudge/retry/circuit-breaker patterns — fully implemented (Phases 2–5)
- Verification system, hook bridge, shell hooks — complete with 7 verifiers
- Git ops, atomic commits, session persistence — done
- Knowledge extraction, stagnation/struggle detection — done
- Status bar basic lifecycle — exists in `src/statusBar.ts` (ralph-loop) and `forkStatusBar.ts` (copilot-chat fork)
