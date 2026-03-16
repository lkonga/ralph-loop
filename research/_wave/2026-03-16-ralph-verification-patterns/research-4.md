# Research Report 4: External Agent Verification Patterns

**Wave**: `2026-03-16-ralph-verification-patterns`
**Question**: What open-source autonomous coding agent projects outside the ralph ecosystem implement pluggable verification registries or configurable verification chains?
**Date**: 2026-03-16

---

## Findings

### 1. SWE-agent (princeton-nlp/SWE-agent)

**Verification approach**: Test-execution-as-oracle with configurable evaluation harnesses.

SWE-agent does not implement a pluggable verification registry in the ralph-loop sense. Instead, verification is externalized to the **SWE-bench evaluation harness**:

- **Task completion signal**: The agent calls a `submit` command that patches the repo and exits. There is no internal verification chain before submission.
- **Post-hoc evaluation**: SWE-bench runs the repository's existing test suite against the agent's patch. Pass/fail is determined entirely by whether previously-failing tests now pass AND previously-passing tests still pass.
- **Configurable evaluation scripts**: Each SWE-bench task instance includes a `test_patch` and `eval_script` field — essentially a per-task verification config, but defined externally in the benchmark dataset, not by the agent itself.
- **No registry pattern**: Verification logic lives outside the agent loop. The agent has no awareness of what checks will be run — it's a "blind submission" model.

**Key insight**: SWE-agent decouples the agent from verification entirely. The agent focuses purely on code generation; verification is a separate, external concern.

### 2. Aider (paul-gauthier/aider)

**Verification approach**: Configurable lint/test commands with auto-fix loops.

From both local research (`AI_AGENT_ORCHESTRATION_COMPARISON.md`) and Aider's source:

- **`--lint-cmd` and `--test-cmd` flags**: Users configure lint and test commands per-project. After each code edit, Aider optionally runs these commands.
- **Auto-fix loop**: When lint or tests fail, Aider can automatically attempt to fix the issues (up to a configurable retry limit). This creates a verify→fix→verify chain.
- **Pre-commit hook integration**: Aider integrates with git pre-commit hooks, leveraging existing project verification infrastructure.
- **No formal registry**: The verification "chain" is linear and hardcoded: (1) lint, (2) test. Users can't add custom verifier types or reorder stages without modifying source.
- **`--auto-test` and `--auto-lint`**: Boolean flags that enable/disable each verification step. This is the extent of "configurability."

**Key insight**: Aider's verification is pragmatic but not pluggable. It's a fixed two-stage pipeline (lint → test) with on/off switches, not a registry of composable verifiers.

### 3. OpenHands / OpenDevin (All-Hands-AI/OpenHands)

**Verification approach**: Evaluation framework with pluggable evaluators and sandboxed execution.

OpenHands has the most sophisticated verification architecture among the projects surveyed:

- **`Evaluator` base class**: Provides a pluggable evaluation framework. Each benchmark (SWE-bench, HumanEval, GPQA, etc.) implements its own evaluator class that defines how to assess the agent's output.
- **Sandboxed execution**: All verification runs inside Docker containers, isolating the agent's environment from the host.
- **`evaluation/` directory structure**: Each evaluator lives in its own subdirectory with a `run_infer.py` script, making it easy to add new evaluation types.
- **Runtime verification hooks**: The `EventStream` architecture allows observers to monitor agent actions in real-time. The `AgentController` can terminate execution based on configurable conditions (max iterations, budget limits).
- **Browsing evaluator**: Unique among surveyed projects — OpenHands has evaluators for web browsing tasks, not just code generation.
- **No in-loop verification registry**: The evaluator framework is primarily for post-hoc assessment, not for gating the agent mid-loop. The agent itself decides when it's "done" (typically by issuing a `finish` action).

**Key insight**: OpenHands has a _pluggable evaluation framework_ but uses it for benchmarking, not as an in-loop verification gate. The agent loop itself has no configurable verification chain.

### 4. Devon (entropy-research/Devon)

**Verification approach**: Session-based with test execution hooks.

- **Session architecture**: Devon wraps agent execution in `Session` objects that manage state, tools, and event streams.
- **Tool-based verification**: Verification happens through tool calls — the agent can invoke `test` or `lint` tools during execution. The agent decides when to verify, not the harness.
- **Event-driven feedback**: Test results flow back through the event stream, allowing the agent to react to failures.
- **No verification registry**: Devon does not have a formal verification registry or configurable chain. Verification is agent-initiated, not harness-enforced.

**Key insight**: Devon trusts the agent to know when to verify, rather than enforcing verification structurally.

### 5. Mentat (AbanteAI/mentat)

**Verification approach**: Minimal — relies on user-driven verification.

- **Interactive model**: Mentat is primarily interactive (user reviews each change). No autonomous verification loop.
- **Auto-context system**: Uses codebase understanding to select relevant files, but this is for context, not verification.
- **Benchmarking via SWE-bench**: Like SWE-agent, Mentat uses external benchmarks for evaluation. The agent itself has no internal verification mechanism.
- **No verification chain**: No registry, no configurable pipeline. Verification is fully external.

**Key insight**: Mentat delegates all verification to the human user or external benchmarks.

### 6. AutoCodeRover (nus-apr/auto-code-rover)

**Verification approach**: AST-aware patch validation with test re-execution.

- **Stratified context retrieval**: Uses AST analysis to identify relevant code locations (classes, methods, functions) before generating patches. This is "pre-verification" — ensuring the agent operates on the right code.
- **Patch validation loop**: After generating a patch, AutoCodeRover applies it and runs the project's test suite. If tests fail, it generates a new patch (up to a retry limit).
- **SWE-bench evaluation**: Like SWE-agent, final assessment uses the external SWE-bench harness.
- **No pluggable registry**: The validation loop is hardcoded: apply patch → run tests → check results → retry or accept. Users cannot add custom verifier types.
- **Unique AST-based verification**: The stratified context retrieval acts as a form of structural verification — the agent verifies it's modifying the right code elements before generating patches.

**Key insight**: AutoCodeRover's AST-based approach is a form of "verification before action" (structural validation), which is distinct from ralph-loop's "verification after action" (behavioral validation).

### 7. Cline (saoudrizwan/claude-dev)

**Verification approach**: Human-in-the-loop with MCP extensibility.

From local research:

- **Permission-gated execution**: Every tool call requires user approval (unless auto-approved), acting as a manual verification gate.
- **MCP tools**: Users can extend Cline with custom MCP servers, theoretically enabling pluggable verification. However, MCP tools are general-purpose — there's no specific "verification registry" pattern.
- **No autonomous verification chain**: Cline does not enforce any verification before marking a task complete. The user is the verification layer.

### 8. Continue.dev

**Verification approach**: Checks-as-code in CI.

From local research:

- **`.continue/checks/*.md`**: Define AI agents as markdown files that run as GitHub status checks. Each check file acts as a verification step.
- **Tool policies**: Allow/deny/auto-approve tool access per check, creating configurable verification boundaries.
- **CI-oriented**: Verification is designed for pull request workflows, not in-loop agent gating.

**Key insight**: Continue's "checks as code" is the closest external pattern to a verification registry, but it operates at the CI level, not within the agent's execution loop.

---

## Patterns

### Pattern 1: Externalized Verification (SWE-agent, Mentat, AutoCodeRover)
Verification is completely separate from the agent loop. The agent submits its work; an external harness (typically SWE-bench) evaluates the result. The agent has no awareness of or control over verification.

- **Pros**: Clean separation of concerns, benchmark-standardized
- **Cons**: Agent can't self-correct during execution, no configurable verification per task

### Pattern 2: Fixed Pipeline Verification (Aider)
A small, hardcoded set of verification steps (lint, test) runs after each change. Steps are toggleable but not composable or extendable.

- **Pros**: Simple, predictable, pragmatic
- **Cons**: Not extensible, can't add domain-specific checks, fixed ordering

### Pattern 3: Agent-Initiated Verification (Devon, Cline)
The agent decides when and how to verify, using available tools (test runners, linters). No structural enforcement from the harness.

- **Pros**: Flexible, can verify at the right moment for the context
- **Cons**: Agent may skip verification, no guarantee of quality gates

### Pattern 4: Evaluation Framework (OpenHands)
A pluggable evaluator architecture exists but is used for post-hoc benchmarking, not in-loop gating.

- **Pros**: Extensible evaluation, supports diverse task types
- **Cons**: Doesn't influence the agent's behavior during execution

### Pattern 5: CI-Level Verification (Continue.dev)
Verification defined as code artifacts that run in CI pipelines, gating merges rather than agent turns.

- **Pros**: Source-controlled, team-reviewable, integrates with existing workflows
- **Cons**: Latency (runs after completion), not real-time

### Pattern 6: Pluggable Registry with In-Loop Gating (ralph-loop — UNIQUE)
A formal `VerifierRegistry` with composable, configurable verification chains that gate task completion within the agent's execution loop. Supports verification templates, auto-classification, and custom verifier types.

- **Pros**: Extensible, composable, enforced, configurable per task
- **Cons**: Additional complexity, tight coupling between verifier and loop

---

## Applicability

### Ralph-Loop's Position

Ralph-loop's `VerifierRegistry` pattern is **unique among surveyed projects**. No other open-source autonomous coding agent implements:

1. **A formal registry** (`Map<string, VerifierFn>`) for composable verifier functions
2. **Configurable chains** (`runVerifierChain` iterating over `VerifierConfig[]`)
3. **Template-based resolution** (`verificationTemplates` matching task descriptions to verifier sets)
4. **Auto-classification** (`autoClassifyTasks` adding verifiers based on task content)
5. **In-loop gating** (verification results determine whether the loop continues or marks a task complete)

### Adoptable Patterns from External Projects

| Pattern | Source | Applicability to ralph-loop |
|---------|--------|-----------------------------|
| **AST-based pre-verification** | AutoCodeRover | HIGH — Could add a `structuralCheck` verifier that validates the agent modified the expected files/functions before running tests |
| **Sandboxed verification execution** | OpenHands | MEDIUM — Running verifiers in isolated containers would prevent side effects |
| **Checks-as-code** | Continue.dev | LOW — Ralph already has YAML-configured verifiers; markdown-defined checks add little value |
| **Auto-fix loop on verification failure** | Aider | HIGH — Ralph has feedback injection from research (gap identified in `09-ecosystem-patterns-synthesis.md` §2.1) but could formalize it as a verifier-level retry strategy |
| **Agent-initiated verification timing** | Devon | MEDIUM — Allow the agent to request specific verifiers mid-task, not just at completion gate |
| **Evaluation framework for benchmarking** | OpenHands | LOW — Orthogonal to ralph's in-loop verification; useful for measuring ralph-loop's own effectiveness |

### Design Recommendations

1. **Retain the registry pattern** — It is a genuine differentiator. No surveyed project has equivalent functionality.
2. **Add a retry/fix strategy to verifier configs** — Inspired by Aider's auto-fix loops. A `VerifierConfig` could include `{ retryOnFail: boolean, maxRetries: number }` to enable verify→fix→re-verify cycles at the individual verifier level.
3. **Consider structural pre-verification** — AutoCodeRover's AST-based approach could be adapted as a `structuralCheck` verifier type that confirms the agent edited the expected files before running expensive test suites.
4. **Evaluation harness as separate concern** — Following OpenHands' pattern, ralph-loop could have a separate evaluation/benchmarking system for measuring loop effectiveness without coupling it to the in-loop registry.

---

## Open Questions

1. **Should verifiers support async streaming results?** All surveyed verifiers are synchronous (run → result). For long-running test suites, a streaming verifier that reports partial results could enable faster feedback loops.

2. **Is there a community convergence toward MCP-based verification?** Both Cline and Continue.dev use MCP for extensibility. Could ralph-loop expose its `VerifierRegistry` as an MCP server, allowing external tools to register verifiers?

3. **How do multi-agent systems (CrewAI, AutoGen) handle cross-agent verification?** The surveyed systems are primarily single-agent. In multi-agent scenarios, how should verification responsibilities be distributed — per-agent registries or a centralized verification coordinator?

4. **Should verification templates be defined in the PRD itself?** Currently ralph-loop resolves verifiers from `RalphConfig`. An alternative is embedding verification requirements directly in PRD task descriptions (e.g., `- [x] Implement login form <!-- verify: checkbox, tsc, vitest, fileContains:src/login.tsx -->`).

5. **What about non-deterministic verification?** All of ralph-loop's built-in verifiers are deterministic. The ecosystem patterns synthesis (§2.5) identified "LLM-as-Judge" for subjective criteria. Should the registry support a `llm-judge` verifier type with configurable rubrics?

6. **SWE-agent's "blind submission" model vs ralph-loop's "gated completion" model** — Is there empirical data on which approach produces better outcomes? SWE-agent's approach is simpler but the agent can't self-correct; ralph-loop's approach adds overhead but enables closed-loop improvement.
