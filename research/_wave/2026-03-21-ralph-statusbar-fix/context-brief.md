## ContextBrief
**Project**: Ralph Loop — self-hosting VS Code extension + CLI that runs PRD tasks through fresh Copilot sessions; PRD.md shows Phases 1–18 complete with 0 unchecked tasks, so current state is post-Phase-18 maintenance.
**Stack**: TypeScript, Node.js, VS Code Extension API, Vitest, Git CLI.
**Structure**: `src/` loop engine, `cli/` helper CLI, `research/` numbered studies/specs, `docs/` patterns/specs, `agents.source/` agent definitions, `test/` unit suite, `.ralph/` runtime state/cache.
**Numbering**: Last phase: 18 | Next: 19 | Last task: 137 | Next: 138 | Last research: 16 | Next: 17
**Key files**: src/orchestrator.ts, src/extension.ts, src/types.ts, src/statusBar.ts, src/stateNotification.ts
**Key functions**: runBearings(), getStateSnapshot(), updateStatusBar(), fireStateChangeNotification(), showStatusBarIdle()
