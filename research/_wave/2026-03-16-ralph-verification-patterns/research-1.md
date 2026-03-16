# Research Report: ralph-loop VerifierRegistry Architecture

**Wave ID**: 2026-03-16-ralph-verification-patterns
**Report Index**: 1
**Date**: 2026-03-16
**Question**: What is ralph-loop's `VerifierRegistry` architecture — how are verifiers registered, chained, and how do inline task verification specs (frontmatter) drive which verifiers run per task?

---

## Findings

### 1. VerifierRegistry: Registration & Lookup

The `VerifierRegistry` class (`src/verify.ts` L7–19) is a lightweight typed map wrapping `Map<string, VerifierFn>`:

- **`register(type, fn)`** — stores a verifier under a string key.
- **`get(type)`** — retrieves by key, throws `Error('Unknown verifier type: …')` if missing.

The registry is intentionally open — any string key can be registered, enabling user-defined verifiers alongside builtins.

### 2. Built-in Verifier Catalog (`createBuiltinRegistry`)

`createBuiltinRegistry()` (`src/verify.ts` L21–85) instantiates a `VerifierRegistry` pre-loaded with 7 verifiers:

| Verifier | Behavior | Args |
|---|---|---|
| `checkbox` | Reads PRD.md, checks if the task's checkbox is `[x]` | `prdPath` (optional, defaults to `<root>/PRD.md`) |
| `fileExists` | `fs.existsSync(args.path)` | `path` |
| `fileContains` | Reads file, checks `content.includes(args.content)` | `path`, `content` |
| `commandExitCode` | `execSync(args.command)`, pass on exit 0 | `command` |
| `tsc` | `npx tsc --noEmit`, pass on exit 0 | none |
| `vitest` | `npx vitest run`, pass on exit 0 | none |
| `custom` | Runs `args.command` as shell (`/bin/sh`), pass on exit 0 | `command` |

All verifiers are `async (task, workspaceRoot, args?) => VerifyCheck` where `VerifyCheck = { name, result: Pass|Fail|Skip, detail? }`.

### 3. Verifier Chaining: `runVerifierChain`

`runVerifierChain(task, workspaceRoot, configs, registry, logger)` (`src/verify.ts` L87–93) executes verifiers **sequentially with no short-circuit**:

```
for each config in configs:
    fn = registry.get(config.type)
    results.push(await fn(task, workspaceRoot, config.args))
return results
```

All verifiers run regardless of earlier failures. The caller decides what to do with the composite result via `allChecksPassed()` (requires every check to be `Pass` or `Skip`).

### 4. Verifier Resolution: `resolveVerifiers`

`resolveVerifiers(task, config, registry)` (`src/verify.ts` L96–118) determines *which* verifiers run. The resolution is a **3-tier priority cascade**:

1. **Explicit override** (`config.verifiers`): If `RalphConfig.verifiers` is set and non-empty, use it directly. This is the project-level override.
2. **Template matching** (`config.verificationTemplates`): Each `VerificationTemplate` has a `name` and `verifiers[]`. The task description is lowercased and matched via `descLower.includes(tmpl.name.toLowerCase())`. First match wins.
3. **Default fallback**: Returns `[{ type: 'checkbox' }, { type: 'tsc' }]`. If `config.autoClassifyTasks` is enabled, additional verifiers are appended by keyword detection (e.g., task description containing "test" → appends `vitest`).

### 5. Frontmatter / Spec-Driven Verification Context

There are **two distinct frontmatter mechanisms**:

#### 5a. SpecFrontmatter (type definitions only — not wired to verifier resolution)

`SpecFrontmatter` (`src/types.ts` L550–561) defines:
```ts
interface SpecFrontmatter {
    type: 'spec';
    id: number;
    phase: number;
    tasks: number[];
    research?: number;
    principles?: string[];
    verification?: string[];    // ← verification commands
    completion_steps?: string[];
}
```

The `verification` field holds an array of command strings. However, this is **not currently wired** into `resolveVerifiers` or the `VerifierRegistry`. Instead, it flows through the prompt system.

#### 5b. Spec Context Injection via `buildSpecContextLine`

`extractSpecReference(taskDescription)` (`src/prompt.ts` L88–93) parses `→ Spec: path LN-LN` patterns from task descriptions. When found, `buildSpecContextLine` (`src/prompt.ts` L95–123):

1. Reads the spec file and parses its YAML frontmatter via `parseFrontmatter()`.
2. Extracts `phase`, `principles`, `verification`, and `research` fields.
3. For `verification`, it extracts abbreviated command names: `v.split(' ').slice(1, 3).join(' ')`.
4. Returns a one-liner like `[Spec context: Phase 3 | principles: TDD, KISS | verify: tsc --noEmit+vitest run]`.

This context line is **injected into the prompt text** sent to the LLM — it's an **advisory** signal telling the model which verification commands the spec expects, not a programmatic trigger for `runVerifierChain`.

#### 5c. `parseFrontmatter` — Generic YAML-like Parser

`parseFrontmatter(content)` (`src/prompt.ts` L44–86) handles `---`-delimited YAML blocks with:
- Key-value parsing (strings and numbers)
- Inline array syntax `[a, b, c]`
- YAML-style list items (`- item` under a parent key)

### 6. Orchestrator Integration

The orchestrator (`src/orchestrator.ts`) does **not** call `resolveVerifiers` or `runVerifierChain` in its main loop. Instead, it uses two verification mechanisms directly:

#### 6a. Dual Exit Gate (L830–845)
Constructs ad-hoc `VerifyCheck[]` array with:
- `checkbox`: re-reads PRD to check if task is marked complete.
- `diff`: checks if `hadFileChanges` is true.

Calls `dualExitGateCheck(modelSignal, checks)` — requires **both** model signal (task completed) AND machine checks to pass.

#### 6b. Confidence Scoring (L883–913)
After a task passes the dual exit gate, constructs another `VerifyCheck[]` with hardcoded assumptions (`vitest: Pass`, `tsc: Pass`, etc.) and calls `computeConfidenceScore()`. If score < threshold (default 100), the task is rejected and re-entered.

### 7. Type Contracts

```ts
type VerifierFn = (task: Task, workspaceRoot: string, args?: Record<string, string>) => Promise<VerifyCheck>;

interface VerifierConfig {
    type: string;
    args?: Record<string, string>;
    stages?: string[];           // declared but not used in resolution
}

interface VerificationTemplate {
    name: string;
    verifiers: VerifierConfig[];
}
```

`VerifierConfig.stages` exists in the type but is not consumed by any runtime code — it's a placeholder for future stage-gated verification.

---

## Patterns

1. **Registry Pattern**: Classic type-keyed registry with factory function. Extensible by calling `registry.register()` before passing to `runVerifierChain`.

2. **No Short-Circuit Chain**: All verifiers always run. This ensures comprehensive reporting — the caller sees all failures, not just the first one.

3. **Priority Cascade Resolution**: Explicit config > template match > defaults. Clean separation of concerns: users override at project level, templates match by keyword, defaults are always safe.

4. **Advisory vs. Programmatic Verification**: Frontmatter `verification` fields are injected as prompt instructions (advisory), not as programmatic verifier triggers. The LLM is told to run `tsc --noEmit` etc., but the system doesn't enforce it through `runVerifierChain`.

5. **Dual-Signal Completion**: Both model self-assessment AND machine verification must agree. Neither alone is sufficient — prevents both false-positive model claims and false-positive machine checks.

6. **Confidence Scoring as Soft Gate**: Unlike the hard dual exit gate, confidence scoring provides a weighted composite that can reject tasks below a threshold, pushing them back into the loop.

---

## Applicability

For the vscode-copilot-chat codebase:

- **Registry pattern** is directly applicable for tool validation — register validators per tool type and chain them before/after tool execution.
- **No-short-circuit chaining** is valuable for agent tool-use verification where you want to report all issues, not just the first.
- **Template-based resolution** could map to agent mode configurations — different verification suites for "edit mode" vs "agent mode" vs "ask mode".
- **Advisory frontmatter injection** is analogous to how system prompts already carry verification hints — the pattern of extracting structured metadata from task specs and flattening it into prompt context is reusable.
- **Dual exit gate** pattern (model signal + machine verification) maps directly to agent task completion — the agent's "I'm done" should be validated by machine checks before accepting.
- The `stages` field on `VerifierConfig` (declared but unused) indicates planned support for running different verifiers at different lifecycle stages — relevant for pre-tool-use vs post-tool-use validation.

---

## Open Questions

1. **Why isn't `resolveVerifiers`/`runVerifierChain` called in the orchestrator?** The orchestrator uses ad-hoc `VerifyCheck[]` construction instead of the registry system. This appears to be a gap — the registry infrastructure exists but isn't fully wired into the main loop. The orchestrator hardcodes `vitest: Pass` and `tsc: Pass` in confidence scoring rather than actually running those verifiers.

2. **What is `VerifierConfig.stages` for?** Declared in the type but never consumed. Likely intended for stage-gated verification (e.g., run `tsc` only in "pre-complete" stage, run `vitest` only in "post-task" stage) but not yet implemented.

3. **How should frontmatter `verification` commands become programmatic?** Currently they're advisory text in the prompt. A natural evolution would be to parse `SpecFrontmatter.verification` into `VerifierConfig[]` and feed them to `resolveVerifiers` — closing the loop between spec declarations and machine verification.

4. **Template matching is substring-based** — `descLower.includes(tmpl.name.toLowerCase())`. This could false-match (e.g., a template named "test" would match "contest" or "testing"). No evidence of this causing issues yet, but it's fragile.

5. **Confidence scoring hardcodes pass assumptions** — `vitest: Pass` and `tsc: Pass` are assumed rather than actually verified. This weakens the confidence signal. Wiring `runVerifierChain` with actual `tsc` and `vitest` verifiers would strengthen it.
