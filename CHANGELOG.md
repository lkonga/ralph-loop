# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — Phase 9

### Added
- Add frontmatter parsing to `buildPrompt()` with spec file context injection (#Task69)
- Add YAML frontmatter to research files 13-14 for machine-readable PD navigation (#Task70)

## Phase 8 — Advanced Patterns

### Added
- Add bearings phase (pre-flight health check) to validate TypeScript and test baselines before task execution
- Add linked cancellation token combining manual stop, timeout, and VS Code abort signals
- Add custom prompt template support with `{{variable}}` substitution
- Add confidence-based completion scoring with threshold-gated verification
- Add session persistence for crash recovery with 24-hour expiration and resume dialog

### Fixed
- Fix dual exit gate requiring both model signal and machine verification before task completion

## Phase 7 — Operational Excellence

### Added
- Add mid-loop operator context injection via command for human-in-the-loop steering
- Add structured review report with verdict extraction and issue detection
- Add 3-signal struggle detection (no-progress, short-iteration, repeated-error) with configurable thresholds
- Add atomic git commits per task with conventional commit messages
- Add error hash deduplication in circuit breaker with MD5 normalization

### Fixed
- Fix process kill to use graceful SIGTERM→SIGKILL pattern with timeout
- Fix shell command rejection feedback as context injection for agent self-correction

### Changed
- Change task identification to sequential Task IDs (Task-001, Task-002) across all subsystems

## Phase 6 — Knowledge & Resilience

### Added
- Add compounding knowledge system with learning/gap extraction, persistence, and relevance filtering
- Add auto-decomposition on 3-fail threshold with sub-task generation and PRD injection
- Add input sanitization gate for control characters, code fence injection, and prompt injection tags
- Add dangerous shell pattern pre-gate with metacharacter detection
- Add progressive context trimming with 3-tier reduction (Full/Abbreviated/Minimal) per iteration

### Fixed
- Fix all 22 failing verify.test.ts tests to establish green baseline

## Phase 5 — Deterministic Loop Hardening & Validation Hooks

### Added
- Add mandatory TDD gate prompt section with red-green-refactor cycle enforcement
- Add multi-verifier system with DSL configuration and composable verifier chains
- Add composable circuit breaker system with 5 breaker types and priority-ordered chain
- Add pre-completion validation hook chain with progressive results accumulation
- Add post-task diff validation with human checkpoint escalation
- Add review-after-execute pattern with same-session and new-session modes
- Add parallel monitor for in-flight task observation with stagnation escalation
- Add PreCompact session reset with consistency checker and state preservation
- Add stagnation detection via progress hashing with self-resetting counters

## Phase 4 — Agentic Proxy Patterns

### Added
- Add task invocation ID (UUID) threading through state, events, and telemetry
- Add isolated task conversation with fresh chat session per task
- Add forced conclusion nudge on final iteration
- Add task execution strategy interface for pluggable backends (command vs API)
- Add synthetic model awareness with model-specific prompt instructions
- Add task parallelization with DAG dependencies and maxParallelTasks config
- Add SubagentStop hook for completion verification gate
- Add permission level escalation to autopilot mode via proposed API
- Add config-gated feature system with VS Code settings integration

## Phase 3 — Extended Autopilot Patterns

### Added
- Add external yield request with graceful loop termination
- Add auto-expand iteration limit in autopilot (50% expansion capped at 50)
- Add external shell command hooks with JSON input/output and exit code semantics
- Add prompt enrichment blocks (security, safety, discipline, brevity) with configurable injection
- Add deferred tool/capability awareness section in prompts
- Add Copilot hook registration as agentic proxy via proposed ChatHookCommand API
- Add session identity tracking with pause-on-switch

## Phase 2 — Autopilot Patterns

### Added
- Add nudge system with premature-stop detection, inactivity timeout, and configurable max nudges
- Add reset inactivity timer on file activity
- Add anti-premature-termination checklist with "DO NOT STOP IF" conditions
- Add auto-retry with error classification (transient vs fatal) and MAX_RETRIES_PER_TASK
- Add decision logic extraction for testability (shouldContinueLoop, shouldNudge, shouldRetry)
- Add hook type definitions with IRalphHookService interface
- Add hook integration in orchestrator with action-based control flow

## Phase 1 — Foundation

### Added
- Add autonomous coding agent ROLE & BEHAVIOR prompt section
- Add maxProgressLines parameter to buildPrompt with smart truncation
- Add filtered PRD rendering showing only unchecked tasks with completion summary
- Add comprehensive test suite for prompt building
