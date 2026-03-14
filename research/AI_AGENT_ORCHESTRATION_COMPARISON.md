# AI Agent Orchestration Systems: Comparative Analysis

## Executive Summary

This report compares ralph-loop's approach to seven leading AI agent orchestration systems, analyzing their task orchestration patterns, safety mechanisms, git integration, hook systems, and TDD enforcement approaches.

**Research Date**: March 14, 2026
**Systems Analyzed**: Aider, Continue.dev, Cursor, Cline, AutoGen, CrewAI, LangGraph
**Focus Areas**: Orchestration loops, circuit breakers, stagnation detection, git integration, hooks, safety mechanisms, DAG support, TDD enforcement
---

## 1. System Comparisons

### Aider (aider-chat)

**Architecture**: Terminal-based AI pair programmer  
**Orchestration**: Single-turn conversational (user-driven)  
**Git Integration**: ✅ Native, automatic commits

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | Interactive chat-based, no autonomous loops. User drives each iteration. |
| **Circuit Breaker** | ❌ Not applicable - single-turn model |
| **Stagnation Detection** | ❌ User monitors progress manually |
| **Git Integration** | ✅ Excellent - automatically commits changes with sensible messages, stages uncommitted changes before modifications |
| **Hook System** | ✅ Pre-commit hooks for linting/testing integration |
| **Safety Mechanisms** | - Git diff review before each commit<br>- Read-only file operations<br>- No autonomous execution |
| **DAG/Parallel Support** | ❌ Single-agent sequential |
| **TDD Enforcement** | ✅ Can lint/test automatically after each change (configurable) |
| **Unique Strength** | Git-native workflow, clean diff review, strong context management via repomap |

---

### Continue.dev

**Architecture**: VS Code extension with CLI agents  
**Orchestration**: Agent mode with tools, plan mode for exploration  
**Git Integration**: ✅ CI/CD status checks

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | Agent mode equips LLM with tools for autonomous decision-making. Plan mode = read-only exploration. |
| **Circuit Breaker** | ⚠️ Tool policies can exclude/auto-approve specific tools |
| **Stagnation Detection** | ⚠️ Relies on model self-correction, no explicit detection |
| **Git Integration** | ✅ Runs agents on PRs as GitHub status checks. Each agent = markdown file in `.continue/checks/` |
| **Hook System** | ✅ MCP (Model Context Protocol) tools for extensibility |
| **Safety Mechanisms** | - Permission prompts before tool use<br>- Tool policies for allow/auto-approve/deny<br>- Local-first architecture (air-gappable) |
| **DAG/Parallel Support** | ⚠️ Limited - primarily sequential tool use |
| **TDD Enforcement** | ⚠️ No built-in TDD gates, but can define custom checks |
| **Unique Strength** | Source-controlled AI checks in CI, open-source, multi-model support |

**Key Feature**: Checks-as-code - define agents as markdown files, enforce in CI pipeline

---

### Cursor

**Architecture**: AI-first IDE with agent mode  
**Orchestration**: Autonomous coding with human-in-the-loop  
**Git Integration**: ✅ Native git workflows

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | Agent mode for multi-step tasks with permissioned actions |
| **Circuit Breaker** | ⚠️ Documented but not publicly detailed (proprietary) |
| **Stagnation Detection** | ⚠️ Likely exists (not documented) |
| **Git Integration** | ✅ Git-smart diffs/commits integrated into workflow |
| **Hook System** | ❌ Not publicly documented |
| **Safety Mechanisms** | - Human-in-the-loop approvals<br>- Permissioned terminal/file operations |
| **DAG/Parallel Support** | ⚠️ Unknown (proprietary) |
| **TDD Enforcement** | ❌ No explicit TDD gates |
| **Unique Strength** | Best-in-class IDE integration, autonomy with oversight |

**Note**: Cursor is closed-source, making detailed architectural analysis difficult.

---

### Cline (formerly Claude Dev)

**Architecture**: VS Code extension for autonomous coding  
**Orchestration**: Plan/Act modes with transparent steps  
**Git Integration**: ✅ Native git workflows

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | - Plan mode: Read-only exploration<br>- Act mode: Autonomous execution with permissions<br>- MCP integration for tools |
| **Circuit Breaker** | ✅ Human-in-the-loop permissions on every action |
| **Stagnation Detection** | ⚠️ Limited - relies on token/cost tracking to alert user |
| **Git Integration** | ✅ Works with git workflows, clean diffs for review |
| **Hook System** | ✅ MCP (Model Context Protocol) for extensibility |
| **Safety Mechanisms** | - Permission buttons before tool use<br>- Token/cost tracking per request<br>- Terminal command execution approval |
| **DAG/Parallel Support** | ⚠️ Sequential task execution (no DAG) |
| **TDD Enforcement** | ⚠️ No explicit TDD gates |
| **Unique Strength** | Open-source, strong community, Plan Mode for safe exploration |

**Known Issue**: Can get stuck in loops, sometimes resets context or fails file writes (per user reports)

---

### AutoGen (Microsoft)

**Architecture**: Multi-agent framework (succeeded by Microsoft Agent Framework)  
**Orchestration**: Conversational agents with GroupChat  
**Git Integration**: ⚠️ Application-specific

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | Multi-agent conversations via GroupChat orchestrator. All messages flow through single orchestrator for audit logs. |
| **Circuit Breaker** | ✅ Max_turns parameter to limit iterations |
| **Stagnation Detection** | ⚠️ Relies on termination conditions, not explicit detection |
| **Git Integration** | ⚠️ Not built-in - must be implemented per application |
| **Hook System** | ✅ Code execution hooks, tool integration |
| **Safety Mechanisms** | - Human-in-the-loop support<br>- Message flow audit logs<br>- Max iteration limits |
| **DAG/Parallel Support** | ⚠️ Limited - primarily sequential conversations |
| **TDD Enforcement** | ❌ No built-in TDD gates |
| **Unique Strength** | Multi-agent collaboration patterns, enterprise features from Semantic Kernel merger |

**Successor**: Microsoft Agent Framework (AutoGen + Semantic Kernel features)

---

### CrewAI

**Architecture**: Role-based multi-agent orchestration  
**Orchestration**: Crews and Flows architecture  
**Git Integration**: ⚠️ Application-specific

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | - Role-based agents with goals/backstories<br>- Flows: orchestrate start/listen/router steps<br>- Processes: sequential, hierarchical, or hybrid |
| **Circuit Breaker** | ✅ Built-in tools for infinite loop prevention |
| **Stagnation Detection** | ✅ Real-time tracing of every step (tool calls, validation) |
| **Git Integration** | ⚠️ Not built-in - application-specific |
| **Hook System** | ✅ Callbacks, human-in-the-loop triggers |
| **Safety Mechanisms** | - Guardrails baked in<br>- Memory and knowledge integration<br>- Observability via real-time tracing |
| **DAG/Parallel Support** | ✅ Flows support complex orchestration patterns |
| **TDD Enforcement** | ❌ No explicit TDD gates |
| **Unique Strength** | Role-based architecture, production-ready observability |

**Key Feature**: Real-time tracing details every agent step for debugging

---

### LangGraph

**Architecture**: Graph-based agent orchestration framework  
**Orchestration**: Low-level primitives for custom workflows  
**Git Integration**: ⚠️ Application-specific

| Aspect | Details |
|--------|---------|
| **Task Orchestration** | - Graph-based state machines<br>- Single/multi-agent, hierarchical workflows<br>- Map-reduce via Send API for dynamic parallel tasks |
| **Circuit Breaker** | ⚠️ User-defined via graph logic |
| **Stagnation Detection** | ⚠️ User-defined (no built-in) |
| **Git Integration** | ⚠️ Not built-in - must be implemented |
| **Hook System** | ✅ Interrupts for human-in-the-loop, middleware |
| **Safety Mechanisms** | - Human-in-the-loop interrupts<br>- State checkpointing<br>- Memory persistence |
| **DAG/Parallel Support** | ✅ Excellent - Send API enables dynamic parallelization |
| **TDD Enforcement** | ❌ No built-in TDD gates |
| **Unique Strength** | Low-level flexibility, expressive workflows, enterprise-ready with LangSmith |

**Key Feature**: Balance agent control with agency through customizable workflows

---

## 2. Safety Mechanisms Deep Dive

### Circuit Breaker Patterns

| System | Rate Limiting | Pattern Detection | Hard Stops |
|--------|---------------|-------------------|------------|
| **Aider** | N/A | N/A | Git diff review |
| **Continue** | Tool policies | ⚠️ Limited | Permission prompts |
| **Cursor** | ⚠️ Unknown | ⚠️ Unknown | Human-in-the-loop |
| **Cline** | Token/cost tracking | ⚠️ Limited | Permission approvals |
| **AutoGen** | Max_turns parameter | ⚠️ Limited | Termination conditions |
| **CrewAI** | ✅ Built-in | ✅ Real-time tracing | Guardrails |
| **LangGraph** | User-defined | User-defined | Interrupts |
| **Ralph-loop** | ✅ Per-agent token buckets | ✅ Sliding window pattern detection | ✅ Kill switches + OPA policy |

**Best Practice** (from IBM research): Per-agent state isolation prevents one noisy agent from affecting others.

### Stagnation Detection Approaches

| System | Method | Effectiveness |
|--------|--------|---------------|
| **Aider** | N/A (user-driven) | N/A |
| **Continue** | Model self-correction | ⚠️ Limited |
| **Cursor** | Unknown | Unknown |
| **Cline** | Token/cost alerts | ⚠️ Reactive |
| **AutoGen** | Termination conditions | ⚠️ Basic |
| **CrewAI** | Real-time tracing | ✅ Proactive |
| **LangGraph** | User-defined | Variable |
| **Ralph-loop** | ✅ Explicit stagnation detection + inactivity timeout | ✅ Proactive |

**Key Insight**: Only CrewAI and ralph-loop have explicit stagnation detection mechanisms.

### Runaway Agent Prevention

From IBM's "Kill Switches and Circuit Breakers" research:

1. **Agent-level kill switch**: Boolean flag stored externally (Redis, feature flags, DynamoDB)
2. **Action-level circuit breakers**: Token bucket rate limiting per agent
3. **Objective-based circuit breakers**: Sliding window pattern detection (e.g., >5 identical actions in 2 seconds)
4. **Policy-level hard stops**: OPA/Rego rules for semantic conditions (file size, action budgets, data boundaries)
5. **System-level kill switch**: Revoke SPIFFE identity for cryptographic shutdown

**AWS Agentic AI Security Matrix** scopes:
- Scope 1: No agency (read-only)
- Scope 2: Prescribed agency (human approval required)
- Scope 3: Supervised agency (autonomous within bounds)
- Scope 4: Full agency (self-initiating, needs advanced controls)

---

## 3. Git Integration Comparison

| System | Integration Style | Atomic Commits | Commit Messages | Review Workflow |
|--------|-------------------|----------------|-----------------|-----------------|
| **Aider** | ✅ Native | ✅ Automatic | ✅ Sensible auto-generated | ✅ Diff review before commit |
| **Continue** | ✅ CI/CD checks | ⚠️ N/A (CI only) | N/A | ✅ PR status checks |
| **Cursor** | ✅ Native | ⚠️ Unknown | ⚠️ Unknown | ✅ Git-smart diffs |
| **Cline** | ✅ Native | ⚠️ Manual | ⚠️ Manual | ✅ Clean diffs |
| **AutoGen** | ⚠️ App-specific | ❌ | ❌ | ❌ |
| **CrewAI** | ⚠️ App-specific | ❌ | ❌ | ❌ |
| **LangGraph** | ⚠️ App-specific | ❌ | ❌ | ❌ |
| **Ralph-loop** | ✅ Native | ✅ Enforced | ✅ PRD task-based | ✅ Post-commit review |

**Key Finding**: Only Aider and ralph-loop enforce atomic commits with auto-generated messages.

---

## 4. Hook and Plugin Systems

| System | Extension Mechanism | Tool API | Hooks | Configuration |
|--------|---------------------|----------|-------|---------------|
| **Aider** | ⚠️ Limited | ✅ Pre-commit hooks | Lint/test | Config file |
| **Continue** | ✅ MCP tools | ✅ Yes | Tool policies | `.continue/checks/*.md` |
| **Cursor** | ❌ Proprietary | ⚠️ Unknown | ❌ Unknown | ⚠️ Unknown |
| **Cline** | ✅ MCP tools | ✅ Yes | ⚠️ Limited | Config file |
| **AutoGen** | ✅ Code execution | ✅ Function calling | ✅ Middleware | Python code |
| **CrewAI** | ✅ Tools + callbacks | ✅ Yes | ✅ Callbacks | YAML configs |
| **LangGraph** | ✅ Middleware | ✅ Yes | ✅ Interrupts | Python/graph |
| **Ralph-loop** | ✅ Multi-verifier DSL | ✅ Planned | ✅ Pre/post-commit | YAML + hooks |

**Best Practice**: MCP (Model Context Protocol) emerging as standard for VS Code extensions (Continue, Cline).

---

## 5. DAG and Parallel Task Support

| System | DAG Support | Parallelization | Dynamic Task Creation | Map-Reduce |
|--------|------------|-----------------|----------------------|------------|
| **Aider** | ❌ | ❌ | ❌ | ❌ |
| **Continue** | ⚠️ Limited | ⚠️ Limited | ❌ | ❌ |
| **Cursor** | ⚠️ Unknown | ⚠️ Unknown | ❌ | ❌ |
| **Cline** | ❌ | ❌ | ❌ | ❌ |
| **AutoGen** | ⚠️ Limited | ⚠️ GroupChat | ❌ | ❌ |
| **CrewAI** | ✅ Flows | ✅ Yes | ⚠️ Limited | ❌ |
| **LangGraph** | ✅ Graph | ✅ Send API | ✅ Yes | ✅ Yes |
| **Ralph-loop** | ✅ PRD task DAG | ✅ Independent tasks | ✅ Dynamic task discovery | ⚠️ Planned |

**Leader**: LangGraph with Send API for dynamic parallelization and map-reduce patterns.

---

## 6. TDD Enforcement Mechanisms

| System | Test Gates | Auto-run Tests | Fail-fast | Verification |
|--------|------------|----------------|-----------|--------------|
| **Aider** | ✅ Configurable | ✅ After changes | ⚠️ Optional | ✅ Can fix failures |
| **Continue** | ⚠️ Custom checks | ⚠️ CI-based | ⚠️ Optional | ⚠️ Suggested diffs |
| **Cursor** | ❌ | ❌ | ❌ | ❌ |
| **Cline** | ⚠️ Manual | ⚠️ Manual | ❌ | ❌ |
| **AutoGen** | ❌ | ❌ | ❌ | ❌ |
| **CrewAI** | ❌ | ❌ | ❌ | ❌ |
| **LangGraph** | ❌ | ❌ | ❌ | ❌ |
| **Ralph-loop** | ✅ Enforced | ✅ Mandatory | ✅ Before commit | ✅ Multi-verifier DSL |

**Key Finding**: Only Aider and ralph-loop have explicit TDD enforcement. Ralph-loop is unique with mandatory test gates.

---

## 7. Best Practices from Research

### AI Agent Safety (IBM)

1. **Least Privilege**: Never give agents root access
2. **Permission Gating**: Explicit approval before tool use
3. **Audit Logging**: All actions logged to tamper-proof sidecar
4. **Memory Constraints**: Token limits to prevent data accumulation
5. **Tool Validation**: Research each tool before integration
6. **Per-Agent State**: Isolated circuit breakers and histories

### Agent Orchestration (Microsoft)

1. **Explicit Control**: Workflows for well-defined steps
2. **Session Management**: State persistence for long-running tasks
3. **Middleware**: Interceptor pattern for actions
4. **Type Safety**: Strong typing for routing and state

### Multi-Agent Systems (CrewAI)

1. **Role-Based Design**: Clear roles, goals, backstories
2. **Real-Time Tracing**: Every step logged
3. **Guardrails**: Built-in safety constraints
4. **Observability**: First-class debugging support

### Security Scoping (AWS)

1. **Scope Classification**: No/Prescribed/Supervised/Full agency
2. **Identity Context**: Agent attestation and delegation
3. **Memory Protection**: State encryption and validation
4. **Behavioral Monitoring**: Anomaly detection for Scope 3-4

### VS Code Extension Security

**No direct research found**, but inferred best practices:
1. **Command Validation**: Whitelist allowed shell commands
2. **Sandboxing**: Isolate execution environment
3. **Permission Prompts**: User approval for destructive operations
4. **Audit Trails**: Log all extension actions

---

## 8. Ralph-Loop's Unique Position

### Advantages Over Competitors

| Feature | Ralph-Loop | Closest Competitor | Advantage |
|---------|------------|-------------------|-----------|
| **Circuit Breakers** | ✅ Per-agent token buckets + pattern detection | CrewAI (real-time tracing) | ✅ Combined rate + pattern |
| **Stagnation Detection** | ✅ Explicit + inactivity timeout | CrewAI (real-time tracing) | ✅ Timeout-based |
| **Git Integration** | ✅ Atomic commits + auto-messages | Aider (auto-commits) | ✅ PRD task-based |
| **TDD Gates** | ✅ Mandatory before commit | Aider (optional) | ✅ Enforced |
| **DAG Support** | ✅ PRD task dependency | LangGraph (graph) | ✅ Simpler model |
| **Parallel Tasks** | ✅ Independent tasks | LangGraph (Send API) | ✅ Automatic |
| **Hooks** | ✅ Multi-verifier DSL | CrewAI (callbacks) | ✅ Domain-specific |
| **Review-After-Execute** | ✅ Post-commit review | Continue (CI checks) | ✅ Workflow-integrated |
| **Kill Switches** | ✅ Multi-level | IBM research | ✅ Production-ready |

### Unique Innovations

1. **PRD-Driven Orchestration**: Task definitions drive the loop (vs. conversational)
2. **Deterministic Verification**: Checkbox state without LLM involvement
3. **Fresh Session Per Task**: Prevents context pollution
4. **Multi-Verifier DSL**: Domain-specific language for verification logic
5. **3-Level Copilot Fallback**: agent → chat → clipboard for resilience

### Areas for Enhancement

Based on competitor analysis:

1. **Real-Time Tracing**: Learn from CrewAI's observability
2. **Dynamic Parallelization**: Study LangGraph's Send API
3. **MCP Integration**: Consider for tool extensibility (Continue/Cline)
4. **State Checkpointing**: Add for long-running workflows (LangGraph)
5. **Policy-as-Code**: Integrate OPA for semantic rules (IBM research)

---

## 9. Common Pitfalls in AI Agent Loops

### Identified Patterns

1. **Infinite Loops**: Agents repeat same action without progress
   - **Solution**: Objective-based circuit breakers (pattern detection)
   
2. **Context Pollution**: Long sessions accumulate irrelevant context
   - **Solution**: Fresh sessions per task (ralph-loop approach)
   
3. **Runaway Costs**: Uncontrolled API calls
   - **Solution**: Token bucket rate limiting per agent
   
4. **Stagnation**: Agent stops making progress without signaling completion
   - **Solution**: Inactivity timeout + explicit stagnation detection
   
5. **Cascading Failures**: One agent failure affects others
   - **Solution**: Per-agent state isolation
   
6. **Prompt Injection**: Malicious instructions override system rules
   - **Solution**: Policy enforcement + role-based constraints
   
7. **Memory Poisoning**: Persistent state accumulates sensitive data
   - **Solution**: Token limits + memory constraints

### Detection Strategies

| Pitfall | Detection Method | System Example |
|---------|-----------------|----------------|
| Infinite loops | Sliding window pattern detection | IBM research, ralph-loop |
| Context pollution | Session token limits | Aider, ralph-loop |
| Runaway costs | Per-agent rate limiting | All production systems |
| Stagnation | Inactivity timeout + progress tracking | ralph-loop |
| Cascading failures | Per-agent state isolation | IBM research |
| Prompt injection | Policy-as-code (OPA) | IBM research |
| Memory poisoning | Token memory constraints | IBM BeeAI framework |

---

## 10. Recommendations for Ralph-Loop

### Short-Term (Priority)

1. **Add Real-Time Tracing**: Learn from CrewAI's observability
   - Log every decision point
   - Show agent reasoning in UI
   - Enable playback/debugging

2. **Implement MCP Integration**: For tool extensibility
   - Follow Continue/Cline patterns
   - Community tool ecosystem
   - Standard protocol

3. **Add State Checkpointing**: For long-running workflows
   - Resume after interruption
   - Audit trail recovery
   - Learn from LangGraph

### Medium-Term

4. **Dynamic Task Discovery**: Beyond PRD file
   - Scan codebase for TODOs
   - Detect dependency violations
   - Auto-generate tasks

5. **Map-Reduce Pattern**: For parallel verification
   - Study LangGraph Send API
   - Aggregate test results
   - Parallel linting

6. **Policy-as-Code Integration**: OPA for semantic rules
   - File size limits
   - Data boundary checks
   - Action budgets

### Long-Term

7. **Multi-Agent Coordination**: Beyond single Copilot
   - Study AutoGen GroupChat
   - Specialized verifiers
   - Agent-to-agent communication

8. **Formal Verification**: Prove safety properties
   - Learn from Sakura Sky Part 9
   - Verify loop termination
   - Prove circuit breaker correctness

9. **Distributed Execution**: Across workspaces/machines
   - Study Sakura Sky Part 13
   - Coordination protocols
   - Distributed state

---

## 11. Conclusion

### Market Position

Ralph-loop occupies a unique position:

- **More structured** than Aider/Cline (PRD-driven vs conversational)
- **More enforced** than Continue/Cursor (mandatory TDD vs optional)
- **Simpler** than LangGraph (PRD tasks vs graph workflows)
- **More VS Code-integrated** than CrewAI/AutoGen (IDE-native vs CLI frameworks)

### Key Differentiators

1. **PRD-First Design**: Task definitions drive automation
2. **Mandatory TDD**: Enforced test gates (unique in market)
3. **Deterministic Verification**: No LLM involvement in completion detection
4. **Atomic Git Operations**: Auto-generated sensible commits
5. **Multi-Level Safety**: Circuit breakers + stagnation detection + kill switches

### Competitive Advantages

- **Safety**: Multi-layer protection (rate limiting, pattern detection, timeouts)
- **Reliability**: Deterministic verification without LLM flakiness
- **Observability**: Clear progress tracking via PRD checkboxes
- **Simplicity**: Easy to understand (checkbox-driven vs complex graphs)

### Vulnerabilities

- **Tool Ecosystem**: Smaller than MCP-based tools (Continue/Cline)
- **Dynamic Orchestration**: Less flexible than LangGraph graphs
- **Multi-Agent**: Single-agent vs AutoGen/CrewAI multi-agent patterns
- **Enterprise Features**: Less mature than Microsoft Agent Framework

---

## 12. Sources

### Primary Research

1. **Aider GitHub**: https://github.com/Aider-AI/aider
2. **Continue.dev GitHub**: https://github.com/continuedev/continue
3. **Continue.dev Docs**: https://docs.continue.dev/
4. **Cline GitHub**: https://github.com/cline/cline
5. **CrewAI Docs**: https://docs.crewai.com/
6. **LangGraph**: https://www.langchain.com/langgraph
7. **Microsoft Agent Framework**: https://learn.microsoft.com/en-us/agent-framework/overview

### Safety Research

8. **IBM AI Agent Security**: https://www.ibm.com/think/tutorials/ai-agent-security
9. **Sakura Sky - Kill Switches**: https://www.sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-6
10. **AWS Agentic AI Matrix**: https://aws.amazon.com/ai/security/agentic-ai-scoping-matrix
11. **CrewAI Infinite Loops**: https://markaicode.com/fix-infinite-loops-multi-agent-chat/

### Community Analysis

12. **Ry Walker Research**: https://rywalker.com/research/ai-coding-assistants
13. **Various Medium articles**: Cursor, Cline, AutoGen comparisons
14. **IBM BeeAI Framework**: Permission gating and audit logging examples

### Ralph-Loop Context

15. **Ralph-Loop README**: https://github.com/lkonga/ralph-loop
16. **Local Codebase**: /home/lkonga/codes/ralph-loop/

---

## Appendix: Terminology

- **Circuit Breaker**: Stops repeated operations (rate limiting or pattern-based)
- **Stagnation Detection**: Identifies when agent stops making progress
- **DAG**: Directed Acyclic Graph - task dependency structure
- **MCP**: Model Context Protocol - tool integration standard
- **OPA**: Open Policy Agent - policy-as-code engine
- **TDD**: Test-Driven Development - tests before implementation
- **HITL**: Human-in-the-Loop - manual approval for actions
- **SPIFFE**: SPIFFE Identity - cryptographic agent identity
- **Send API**: LangGraph API for dynamic parallel task creation

---

**Report Generated**: 2026-03-14  
**Analyst**: Wave-02 Analyzer (GLM-4.7)  
**Status**: Research Complete (20 iterations)
