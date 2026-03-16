## Aggregation Report 4

### Source Reports

**research-10.md — VS Code Extension Configuration Surface**
- Comprehensive mapping of declared (9) vs undeclared (~25+) settings, 6 commands (2 undeclared), feature flags, preset system, hook bridge, CLI surface, and proposed API dependencies. [source: research-10.md#L1-L5]
- Critical gap: most configuration is "dark" — inaccessible via Settings UI. [source: research-10.md#L123-L127]

**research-11.md — Test Infrastructure and Verify System**
- 17 test files with 1:1 source module mapping, Vitest 3.2.4, clean mocking patterns, pure unit tests, TDD markers. [source: research-11.md#L3-L8]
- Verify system is the most sophisticated subsystem: 7 builtin verifiers, confidence scoring, dual exit gate, feedback formatting. [source: research-11.md#L73-L85]

**research-12.md — Evolution & Ecosystem Positioning**
- 9-phase evolutionary trajectory (56+ tasks), ecosystem analysis across 13 implementations, deterministic control plane as core differentiator, PreCompact reset as key innovation. [source: research-12.md#L5-L10]
- Self-hosting validation: ralph-loop executes its own PRD to bootstrap development. [source: research-12.md#L137-L139]

---

### Deduplicated Findings

#### 1. Configuration Architecture — Declared vs Dark Settings
Ralph-loop has a significant split between its public and hidden configuration surfaces. Only 9 of ~35+ settings are declared in `package.json`. The remaining ~25+ scalar, object, and feature flag settings are readable only via manual `settings.json` edits. Two of six commands (`yield`, `injectContext`) are similarly undeclared and invisible in the Command Palette. [source: research-10.md#L26-L82]

The preset system (`general`/`feature`/`bugfix`/`refactor`) provides meaningful workflow customization but is only discoverable via the `ralph-loop.preset` enum — no documentation exists outside source code. Config resolution follows: `DEFAULT_CONFIG → preset → user overrides → workspaceRoot`. [source: research-10.md#L98-L108]

Configuration is read once at loop start with no `onDidChangeConfiguration` listener — changes require loop restart. [source: research-10.md#L130-L131]

#### 2. Feature Flags as Progressive Opt-In
Five boolean feature flags under `ralph-loop.features.*` control advanced capabilities: `useHookBridge`, `useSessionTracking`, `useAutopilotMode`, `useParallelTasks`, `useLlmConsistencyCheck`. All default to `false`, embodying the design principle of progressive opt-in. [source: research-10.md#L83-L91] [source: research-12.md#L116-L118]

This aligns with the broader architectural philosophy: "Every advanced feature is behind config flags defaulting to false/off." [source: research-12.md#L114-L118]

#### 3. Test Infrastructure Maturity
17 test files maintain 1:1 mapping with source modules. Framework is Vitest 3.2.4 with `vscode` aliased to `__mocks__/vscode.ts`. Tests are pure unit tests — no VS Code extension host is spun up. Mocking covers `vscode`, `fs`, `child_process`, and fake timers. [source: research-11.md#L3-L18]

Notable patterns: TDD markers in verify tests, helper factories (`makeTask()`, `makeState()`, etc.), self-contained test files with no shared utility module, temp filesystem for integration-style checks. [source: research-11.md#L55-L68]

Modules without tests: `extension.ts` (needs integration tests), `strategies.ts` (possibly dead code), `types.ts` (type-only). `decisions.ts` is tested indirectly via `orchestrator.test.ts`. [source: research-11.md#L50-L54]

#### 4. Verification System — Multi-Layer Architecture
The verify system is ralph-loop's most sophisticated subsystem and a key ecosystem differentiator:

- **VerifierRegistry**: Plugin registry mapping 7 type strings to async verifier functions (`checkbox`, `fileExists`, `fileContains`, `commandExitCode`, `tsc`, `vitest`, `custom`). [source: research-11.md#L73-L74]
- **Resolution strategy**: explicit config → verificationTemplates matching → defaults (`[checkbox, tsc]`) with optional auto-classification. [source: research-11.md#L77-L78]
- **Confidence scoring**: Weighted composite — checkbox=100, vitest=20, tsc=20, diff=20, no_errors=10, progress_updated=10 (max=180). [source: research-11.md#L79-L80]
- **Dual exit gate**: Both model signal (PRD checkbox) AND machine verification must pass. [source: research-11.md#L80-L81]
- **Feedback injection**: Human-readable failure summaries for nudge messages. [source: research-11.md#L82-L83]

This multi-signal approach goes beyond simple pass/fail and is identified as a core differentiator versus the 12 other ecosystem implementations. [source: research-12.md#L54-L57]

#### 5. Evolutionary Architecture — 9 Phases
Ralph-loop evolved through 9 phases following a clear trajectory: **Foundation → Autonomy → Safety → Learning → Operational Maturity → Ecosystem Parity**. Key milestones:

- Phase 1-2: Prompt building, nudge system, auto-retry
- Phase 3-4: Hook bridge, session tracking, subagent model with DAG parallelization
- Phase 5-6: Multi-verifier system, 5-breaker circuit chain, knowledge extraction, input sanitization
- Phase 7-8: Struggle detection, atomic commits, bearings pre-flight, session persistence
- Phase 9 (in progress): Verification feedback, context budget tracking, thrashing detection, plan regeneration

[source: research-12.md#L11-L31]

Each phase adds safety mechanisms before capabilities — circuit breakers (Phase 5) came before knowledge system (Phase 6), bearings pre-flight (Phase 8) before ecosystem synthesis (Phase 9). [source: research-12.md#L141-L142]

#### 6. Ecosystem Positioning — Unique Niche
Among 13 analyzed Ralph implementations, ralph-loop occupies a unique position:

- **Only implementation** with deterministic code-level control plane (not prompt prose). This is the "fatal flaw" of `.agent.md` approaches: delegating verification to LLM text makes it non-deterministic. [source: research-12.md#L62-L65]
- **Highest test count** in ecosystem (361+ vs most at 0). [source: research-12.md#L57]
- **Async generator architecture** chosen over EventEmitter for consumer-controlled flow, natural cancellation, and composable backpressure. [source: research-12.md#L119-L121]
- **Two-mode design**: VS Code extension + standalone CLI on shared core. [source: research-10.md#L113-L120]

#### 7. PreCompact Reset — Key Innovation
Instead of arbitrary iteration limits, ralph-loop hooks into the LLM's own compaction signal. When context is about to degrade, state is saved and a fresh session starts. This contrasts with every other implementation using fixed iteration counts or token estimates. [source: research-12.md#L100-L107]

This is enabled via the hook bridge writing to Copilot Chat's `chat.hooks` configuration — a cross-extension coupling that is mitigated by the `useHookBridge` feature flag. [source: research-10.md#L110-L116]

#### 8. External Dependencies & Graceful Degradation
The extension depends on VS Code proposed APIs (`chatHooks`, `activeChatPanelSessionResource`) and Copilot Chat workbench commands (`chat.toggleAgentMode`, `chat.submit`, etc.). All proposed API usage is wrapped in try/catch with warning logs, enabling operation with reduced functionality. [source: research-10.md#L134-L140]

This presents an upstream dependency risk — these APIs may change or be rejected. Feature flags mitigate but don't eliminate the risk. [source: research-12.md#L157-L158]

#### 9. CLI Surface
The `ralph` CLI provides 4 subcommands (`status`, `next`, `init`, `help`) with `--prd` and `--cwd` options. This gives non-VS-Code access to PRD parsing and task navigation. [source: research-10.md#L113-L120]

#### 10. Security Consideration — Command Injection Surface
The `commandExitCode` and `custom` verifiers use `execSync` with user-provided command strings. `shellHookProvider.ts` has `containsDangerousChars` (blocking `&&`, `||`, `|`, `>`, `<`, backticks, `$()`, `${}`), but `verify.ts` doesn't apply this check. [source: research-11.md#L96-L97]

Shell hook tests confirm the dangerous pattern detection works (`shellHook.test.ts`), but the protection isn't uniformly applied across all command execution paths. [source: research-11.md#L39]

---

### Cross-Report Patterns

**P1: Progressive opt-in as architectural principle (3 reports, HIGH confidence)**
All three reports independently confirm progressive opt-in: undeclared settings as power-user features (R10), feature flags defaulting to false (R10, R12), safety-first layering where each phase adds protection before capability (R12). This is embedded in the codebase structure, not just documentation. [source: research-10.md#L83-L91] [source: research-12.md#L114-L118] [source: research-12.md#L141-L142]

**P2: Deterministic control plane as core differentiator (2 reports, HIGH confidence)**
R11's verify system analysis and R12's ecosystem positioning both emphasize that ralph-loop's distinction is treating verification, circuit breaking, and loop control as executable code rather than prompt instructions. The 17 unit test files are a direct consequence — you can't meaningfully test prose-based control. [source: research-11.md#L73-L85] [source: research-12.md#L62-L65]

**P3: Documentation/discoverability gap (2 reports, MEDIUM confidence)**
R10 identifies ~25+ undeclared settings, 2 undeclared commands, and hidden feature flags. R12 notes the preset system and Phase 9 scope are undocumented. This creates a split: power users who read source can access everything; typical users see only ~25% of the configuration surface. [source: research-10.md#L123-L131] [source: research-12.md#L97-L99]

**P4: Testing validates architecture but misses integration layer (2 reports, MEDIUM confidence)**
R11 confirms 17 well-structured unit tests covering the engine. R12 cites 361+ tests as ecosystem-leading. However, both note the absence of integration/E2E tests that exercise the full loop with real PRD files. Extension activation (`extension.ts`) has no tests. [source: research-11.md#L50-L53] [source: research-12.md#L57]

**P5: Self-hosting creates unique validation but introduces bootstrapping risk (2 reports, LOW confidence)**
R12 identifies self-hosting (ralph-loop executes its own PRD) as both a validation strategy and a risk — a bug during self-hosted development creates a recursive failure mode. R11's session persistence test coverage partially addresses recovery. [source: research-12.md#L137-L139] [source: research-12.md#L159-L161]

---

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Deterministic control plane positioning | High | None (document) | [research-12.md#L62-L65], [research-11.md#L73-L85] |
| Verify system as feature highlight | High | None (document) | [research-11.md#L73-L85], [research-12.md#L54-L57] |
| Configuration reference (all ~35 settings) | High | Medium | [research-10.md#L26-L91] |
| Preset system documentation | Medium | Low | [research-10.md#L98-L108] |
| Feature flags documentation | Medium | Low | [research-10.md#L83-L91] |
| CLI usage section | Medium | Low | [research-10.md#L113-L120] |
| Evolution narrative (9 phases) | Medium | Low | [research-12.md#L11-L31] |
| Missing `package.json` declarations | Medium | Medium | [research-10.md#L25-L26], [research-10.md#L123-L127] |
| Command injection surface audit | High | Low | [research-11.md#L96-L97] |
| Integration/E2E test gap | Medium | High | [research-11.md#L50-L53] |

---

### Gaps

1. **No test count authority** — Three different numbers appear across research docs (322, 361, 188). The README needs an authoritative count from a current `npm test` run. [source: research-12.md#L149-L150]
2. **Phase 9 completion status unclear** — How many of the 8 Phase 9 capabilities are implemented vs. planned? The CHANGELOG shows only Tasks 69-70 under `[Unreleased]`. [source: research-12.md#L151-L152]
3. **`strategies.ts` untested and unexamined** — Neither R10 nor R11 investigated this module. Could be dead code or a missing test gap. [source: research-11.md#L51]
4. **No performance metrics** — None of the three reports cover execution time, memory usage, or context window utilization. These would strengthen README quality claims.
5. **No comparison to non-Ralph tools** — Ecosystem positioning is within the Ralph family only. How does ralph-loop compare to Aider, Continue, Cline, or other general-purpose AI coding tools?

---

### Sources

- research-10.md — VS Code extension configuration surface: activation, commands, declared/undeclared settings, feature flags, presets, hook bridge, CLI, proposed APIs
- research-11.md — Test infrastructure: Vitest setup, 17 test files, mocking patterns, verify system deep-dive, modules without tests
- research-12.md — Evolution (9 phases, 56+ tasks), ecosystem positioning (13 implementations), architectural influences, design philosophy, PreCompact innovation, gap analysis
