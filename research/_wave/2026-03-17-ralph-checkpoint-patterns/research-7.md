# Research-7: Streamlining Custom Verifiers into the Research → Spec → PRD Pipeline

**Question:** How should custom verifiers (commandExitCode, fileExists, custom) be streamlined into the research→spec→PRD pipeline so they're auto-generated per task type?

**Date:** 2026-03-17
**Method:** Full source trace of `src/verify.ts` (registry, resolution chain, template system), `src/types.ts` (VerifierConfig, VerificationTemplate, SpecFrontmatter), PRD task structure, and spec frontmatter conventions.

---

## Findings

### 1. Current Verifier Resolution Chain (`resolveVerifiers`)

The resolution chain in `src/verify.ts` follows a strict 3-tier fallback:

1. **Explicit config** (`config.verifiers`): If `RalphConfig.verifiers` is set globally, use those for ALL tasks. This is a blunt instrument — same verifiers for every task.
2. **Template matching** (`config.verificationTemplates`): Iterates `VerificationTemplate[]`, matches when `task.description.toLowerCase()` contains `tmpl.name.toLowerCase()`. First match wins. This is the closest thing to per-task-type verifiers but requires manual template setup in config.
3. **Defaults**: Falls back to `[{ type: 'checkbox' }, { type: 'tsc' }]`. If `autoClassifyTasks` is true, appends `vitest` when the description contains "test".

**Critical gap:** There is NO path from spec frontmatter `verification: [...]` or PRD task descriptions into `resolveVerifiers()`. The spec's `verification` field (e.g., `["npx tsc --noEmit", "npx vitest run"]`) is a human-readable list — it is never parsed into `VerifierConfig[]` objects.

### 2. The SpecFrontmatter → VerifierConfig Disconnect

The `SpecFrontmatter` interface in `src/types.ts` has:
```typescript
verification?: string[];     // e.g., ["npx tsc --noEmit", "npx vitest run"]
completion_steps?: string[];  // e.g., ["append to progress.txt", "mark checkbox"]
```

These are free-form strings used only for documentation and prompt injection. They are never:
- Parsed into `VerifierConfig` objects
- Mapped to the builtin registry types (`commandExitCode`, `tsc`, `vitest`, etc.)
- Passed to `resolveVerifiers()` or `runVerifierChain()`

The research file `14-phase9-refined-tasks.md` demonstrates this: its `verification: ["npx tsc --noEmit", "npx vitest run"]` is used as prompt context but never machine-executed via the verifier system.

### 3. The `autoClassifyTasks` Mechanism — Primitive but Extensible

When `autoClassifyTasks: true`, `resolveVerifiers()` does basic keyword matching:
```typescript
if (descLower.includes('test')) {
    defaults.push({ type: 'vitest' });
}
```

This single rule is the **entire** auto-classification system. No rules exist for:
- File creation tasks → `fileExists`
- Script execution tasks → `commandExitCode`
- Content generation → `fileContains`
- Custom commands → `custom`

### 4. Builtin Verifier Registry — 7 Types Available

`createBuiltinRegistry()` registers exactly 7 verifier types:

| Type | Args | Use Case |
|------|------|----------|
| `checkbox` | `prdPath?` | PRD checkbox marked complete |
| `fileExists` | `path` | File was created at expected location |
| `fileContains` | `path`, `content` | File contains expected content |
| `commandExitCode` | `command` | Command exits 0 |
| `tsc` | — | TypeScript compiles cleanly |
| `vitest` | — | Test suite passes |
| `custom` | `command` | Arbitrary shell command |

### 5. VerificationTemplate — The Underused Bridging Mechanism

`VerificationTemplate { name: string; verifiers: VerifierConfig[] }` was designed to bridge task categories to verifier configs. Currently:
- No templates are defined in `DEFAULT_CONFIG`
- No code generates templates from spec frontmatter
- Template matching is by substring in task description — fragile but functional

---

## Patterns

### Pattern A: Spec Frontmatter → VerifierConfig Compiler

Transform `SpecFrontmatter.verification` strings into machine-executable `VerifierConfig[]`:

```typescript
function compileVerificationStrings(verification: string[]): VerifierConfig[] {
    return verification.map(v => {
        if (v === 'npx tsc --noEmit') return { type: 'tsc' };
        if (v === 'npx vitest run') return { type: 'vitest' };
        if (v.startsWith('file:')) return { type: 'fileExists', args: { path: v.slice(5) } };
        if (v.startsWith('contains:')) {
            const [path, content] = v.slice(9).split('::');
            return { type: 'fileContains', args: { path, content } };
        }
        return { type: 'commandExitCode', args: { command: v } };
    });
}
```

This bridges the spec → verifier gap without changing existing interfaces.

### Pattern B: Task Description Keyword → Verifier Inference Rules

Extend `autoClassifyTasks` with a rules table:

| Keyword Pattern | Inferred Verifier | Args Source |
|----------------|-------------------|-------------|
| `"create" + file path` | `fileExists` | Extract path from description |
| `"write test" / "add test"` | `vitest` | — |
| `"run" + command` | `commandExitCode` | Extract command from description |
| `"copy" / "move" + path` | `fileExists` | Extract target path |
| `"install"` | `commandExitCode` | `npm ls <package>` |
| `"compile" / "build"` | `tsc` | — |
| `"add" + "to" + file` | `fileContains` | Extract file and content hint |

Implementation: a `TaskClassifier` that returns `VerifierConfig[]` from task description analysis, using regex or simple NLP patterns.

### Pattern C: Pipeline-Integrated Verifier Generation

The full pipeline flow:

```
Research Finding
  ↓ (wave-spec-generator)
Spec File (frontmatter: verification: [...])
  ↓ (compileVerificationStrings)
VerifierConfig[]
  ↓ (merged into VerificationTemplate)
PRD task (description embeds verifier hints)
  ↓ (resolveVerifiers with template matching)
runVerifierChain() at runtime
```

Each stage adds specificity:
1. **Research** identifies what needs verification (e.g., "file must exist at src/foo.ts")
2. **Spec** codifies it as `verification: ["file:src/foo.ts"]`
3. **PRD generator** embeds category hints (e.g., `[Verify: fileExists src/foo.ts]`)
4. **resolveVerifiers** matches templates or parses inline hints

### Pattern D: Inline Verifier Annotations in PRD Task Descriptions

Embed machine-parseable verifier hints directly in PRD task descriptions:

```markdown
- [ ] **Create user service** [verify: fileExists(src/user.ts), tsc, vitest]
```

`resolveVerifiers` could parse these annotations using a regex like:
```
/\[verify:\s*(.+?)\]/
```

This keeps verifier config co-located with the task definition — no external config needed.

---

## Applicability

### Immediate (No breaking changes)

1. **Extend `autoClassifyTasks` rules** in `resolveVerifiers()`: Add 4-5 keyword→verifier mappings beyond the existing "test"→vitest rule. Minimal change, high impact.

2. **Add `compileVerificationStrings()`** utility: Parses spec frontmatter `verification` strings into `VerifierConfig[]`. Standalone function, no interface changes needed.

3. **Populate `verificationTemplates`** in default config with common task categories: `["create-file", "write-test", "run-script", "build", "deploy"]` each mapping to appropriate verifier sets.

### Medium-term (Requires pipeline tooling)

4. **Wire spec frontmatter into PRD generation**: When a wave-spec-generator or wave-prd-generator tool creates PRD tasks from specs, it should call `compileVerificationStrings()` on the spec's `verification` field and embed the result as inline annotations or store as `verificationTemplates`.

5. **Add inline annotation parsing** to `resolveVerifiers()`: Look for `[verify: ...]` patterns in task descriptions before falling back to templates/defaults.

### Future (Requires new abstractions)

6. **TaskClassifier service**: A dedicated NLP-lite classifier that analyzes task descriptions and returns scored verifier suggestions. Could use the knowledge system to learn which verifiers worked for similar past tasks.

7. **Bidirectional verification feedback**: When verifiers fail, feed the failure detail back into the spec/PRD annotation so future runs know the expected verification pattern.

---

## Open Questions

1. **Arg extraction reliability**: Keyword-based arg extraction from task descriptions (e.g., extracting file paths from "Create src/user.ts") is fragile. Should this use regex patterns or delegate to an LLM for extraction?

2. **Template vs. inline priority**: If both `verificationTemplates` match AND the task description has inline `[verify: ...]` annotations, which takes precedence? The current `resolveVerifiers` cascade (explicit → template → default) would need a 4th tier or inline annotations would need to merge with template matches.

3. **Spec frontmatter `verification` field semantics**: Currently free-form strings. Should the format be formalized with a DSL (e.g., `"type:args"` syntax) or should `compileVerificationStrings()` handle the current natural-language format with heuristics?

4. **Where does `compileVerificationStrings()` live?**: In `verify.ts` alongside the registry? In a new `specCompiler.ts`? In `prompt.ts` since it bridges spec content to runtime config?

5. **Research-to-spec verifier propagation**: When research identifies a verification need (e.g., "this feature needs fileExists checks"), how does that signal survive through the spec-generation process? Currently there's no structured field in `ResearchFrontmatter` for proposed verifiers — only `derived_specs` links.

6. **`formatVerificationFeedback` gap**: The orchestrator imports `formatVerificationFeedback` from `verify.ts` but the function doesn't exist yet. This is the planned feedback injection path (per research-7 in `2026-03-16-ralph-deep-verification`). The verifier streamlining work should coordinate with this — auto-generated verifiers should produce `detail` strings rich enough for meaningful feedback injection.
