# Parsed Links from awesomeclaude.ai + snwfdhmp/awesome-ralph

> Extracted: 2026-03-14

## Sources
- https://awesomeclaude.ai/ralph-wiggum
- https://github.com/snwfdhmp/awesome-ralph

## Key Wisdom Extracted

### From awesomeclaude.ai
- "Ralph is a Bash loop" - the simplest form: `while :; do cat PROMPT.md | claude ; done`
- **Iteration > Perfection**: Don't aim for perfect on first try. Let the loop refine.
- **Failures Are Data**: Deterministically bad means failures are predictable and informative.
- **Operator Skill Matters**: Success depends on writing good prompts, not just having a good model.
- **Persistence Wins**: Keep trying until success. The loop handles retry logic automatically.
- Official plugin: `/ralph-loop:ralph-loop` with `--completion-promise` and `--max-iterations`
- 6 repos generated overnight at Y Combinator hackathon
- $50k contract delivered for $297 in API costs
- CURSED language built over 3 months
- **Prompt Tuning Technique**: Start with no guardrails → add signs when Ralph fails → iterate on failures → eventually defects disappear
- Git worktree parallel loops recommended for parallel development
- Multi-phase chaining: separate Ralph loops for core→API→frontend

### From snwfdhmp/awesome-ralph
- **3 Phases, 2 Prompts, 1 Loop**: Define Requirements → Planning → Building
- **Signs & Gates**: upstream guidance (signs) + downstream backpressure (gates)
- **One task per loop iteration**: keeps context in "smart zone" (~40-60% of usable window)
- **Plan is disposable**: regeneration cheaper than fixing stale plans
- **AGENTS.md must stay lean** (~60 lines max)
- **"Don't assume not implemented"**: critical instruction to prevent code rewriting

## GitHub Repositories to Analyze

### Already Deeply Analyzed
1. https://github.com/aymenfurter/ralph (VS Code extension, visual control panel)
2. https://github.com/giocaizzi/ralph-copilot (4 .agent.md files, pure prompt engineering)
3. https://github.com/vinitm/ralph-loop (Claude Code plugin, 2-agent TDD)
4. https://github.com/hehamalainen/Ralph (minimal VS Code extension, 348 lines)
5. https://github.com/snwfdhmp/awesome-ralph (curated list)

### HIGH Relevance - To Be Analyzed
6. https://github.com/anthropics/claude-plugins-official (official ralph-loop plugin)
7. https://github.com/mikeyobrien/ralph-orchestrator (Rust, Hat System, 7 backends)
8. https://github.com/mj-meyer/choo-choo-ralph (5-phase, compounding knowledge)
9. https://github.com/rubenmarcus/ralph-starter (cost tracking, workflow presets)
10. https://github.com/tzachbon/smart-ralph (spec-driven development)
11. https://github.com/agrimsingh/ralph-wiggum-cursor (context rotation at 80k tokens)
12. https://github.com/Th0rgal/opencode-ralph-wiggum (mid-loop injection, struggle detection)
13. https://github.com/vercel-labs/ralph-loop-agent (verification callbacks, context summarization)
14. https://github.com/humanlayer/advanced-context-engineering-for-coding-agents
15. https://github.com/ClaytonFarr/ralph-playbook (signs & gates methodology)
16. https://github.com/ghuntley/how-to-ralph-wiggum (official playbook)
17. https://github.com/frankbria/ralph-claude-code (circuit breaker, semantic analyzer)
18. https://github.com/snarktank/ralph (auto-branching, flowchart)

### MEDIUM Relevance
19. https://github.com/alfredolopez80/multi-agent-ralph-loop (multi-agent parallel)
20. https://github.com/subsy/ralph-tui (terminal UI orchestrator)
21. https://github.com/iannuttall/ralph (minimal agent loop)
22. https://github.com/nitodeco/ralph (CLI, sequential tasks)
23. https://github.com/marcindulak/ralph-wiggum-bdd (BDD with Ralph)
24. https://github.com/vivganes/oh-my-ralph (Python Ralph)
25. https://github.com/pentoai/ml-ralph (ML agent)
