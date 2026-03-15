## Aggregation Report 2

### Source Reports

| Report | Focus | Key Finding |
|--------|-------|-------------|
| **research-4.md** | Prompt-to-prompt invocation (source code) | No `${prompt:...}` variable or recursive chaining exists. `#file:` references are parsed but NOT recursively expanded at runtime. `handoffs` provide agent-level delegation only. |
| **research-5.md** | Official docs & community (online) | Definitive 6-field frontmatter schema. No `hidden`/`visibility` field. `.agent.md` files DO have `user-invocable: false`. The visibility gap is intentional by design. |
| **research-6.md** | Empirical field survey (315 files) | 13 unique frontmatter fields found across the wild. Zero visibility-related fields in any file. Location-based scoping is the only implicit visibility mechanism. |

### Deduplicated Findings

**F1: The .prompt.md frontmatter schema has exactly 6 official fields — none control visibility.**
`description`, `name`, `argument-hint`, `agent`, `model`, `tools`. Confirmed by official docs (R5) and corroborated by source code parser (R4). The parser accepts additional fields silently (R6 found `tested_with`, `title`, `phase`, `id`, `date` in the wild), but they have no runtime effect.

**F2: No prompt-to-prompt invocation mechanism exists.**
R4 confirmed via source: no `${prompt:...}`, `#prompt:`, or `#include` syntax. `#file:other.prompt.md` is parsed as a file reference but `PromptFile.getBodyContent()` reads flat text without recursion. R5 confirmed via docs: "There is NO mechanism for one prompt to invoke another prompt."

**F3: The agent system IS the visibility/hiding mechanism.**
`.agent.md` provides `user-invocable: false` (hides from dropdown, accessible only as subagent) and `disable-model-invocation` (prevents subagent use). R5 found this in official docs; R4 found it architecturally via handoffs. This is the intended abstraction for internal/hidden prompts.

**F4: Location-based scoping is the only implicit visibility control for prompts.**
`.github/prompts/` (project-shared), user profile `prompts/` (personal), `assets/prompts/` (bundled with extension). R6 empirically confirmed this is how the ecosystem handles scope. R5 confirmed no `chat.promptFiles.locations` trick enables hiding.

**F5: The frontmatter schema is actively evolving.**
`model` was added post-launch (R5). `infer` was deprecated and split into `user-invocable` + `disable-model-invocation` (R5). Community requests for `newChat: true` are in backlog (R5). R6 found 7 unofficial fields in the wild, showing users already extend the schema informally.

**F6: The `handoffs` mechanism enables agent-level delegation, not prompt inclusion.**
R4 confirmed `IHandOff` interface with `agent`, `label`, `prompt`, `send`, `model` fields. Used by `planAgentProvider.ts` for Plan→Coder transitions. This is UI-level delegation (buttons), not prompt file composition.

### Cross-Report Patterns

**P1: No visibility control for .prompt.md — unanimous across all 3 reports (HIGH CONFIDENCE)**
R4 (source code), R5 (official docs), R6 (315-file empirical survey) all independently confirm: zero visibility/hidden/internal/private fields exist or are used.

**P2: Agent system is the correct abstraction for hiding — confirmed by 2 reports (HIGH CONFIDENCE)**
R4 (handoffs architecture) and R5 (official docs with `user-invocable: false`) converge: if you need hidden/internal prompts, use `.agent.md` files.

**P3: No recursive prompt composition — confirmed by 2 reports (HIGH CONFIDENCE)**
R4 (source code: no recursion in `PromptFile.getBodyContent()`) and R5 (docs: no prompt-to-prompt mechanism) agree: the only cross-invocation path is prompt → agent → subagent.

**P4: Schema extensibility exists informally — confirmed by 2 reports (MEDIUM CONFIDENCE)**
R4 (parser accepts unknown fields) and R6 (7 unofficial fields found in the wild) suggest a custom `visibility` field could be added without breaking the parser, but it would have no VS Code runtime effect.

**P5: The prompt vs agent design split is intentional — confirmed by 2 reports (MEDIUM CONFIDENCE)**
R5 (docs say prompts are "user-facing slash commands") and R6 (zero visibility fields across 315 files) suggest prompts are deliberately simple/user-facing while agents handle complex lifecycle/visibility concerns.

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Use `.agent.md` with `user-invocable: false` for hidden prompts | **High** — solves the core visibility need | **Low** — built-in, documented | R4, R5 |
| Implement ralph-loop filter layer for custom `visibility` field | **Medium** — enables prompt-level hiding outside VS Code | **Medium** — custom parser + filter | R4, R6 |
| Location-based scoping (separate folders per visibility tier) | **Medium** — implicit hiding via folder structure | **Low** — convention only | R5, R6 |
| Advocate for `hidden` frontmatter field upstream | **High** — native solution | **High** — requires VS Code core change + adoption | R5 |
| Prompt-to-agent wrapping (wrap hidden prompts in `.agent.md`) | **High** — full visibility + tool control | **Medium** — one agent per hidden prompt | R4, R5 |

### Gaps

1. **Undocumented parser behavior**: Does the VS Code core parser (not the extension copy) handle `#file:` references to `.prompt.md` files differently? R4 flagged this but didn't resolve it. The `resolveVariablesInPrompt` path in the core chat system may do recursive expansion.

2. **Extension-contributed prompts**: R5 noted extensions can contribute prompts. Do they have additional metadata/visibility controls not available to user prompts? No report investigated this.

3. **`chat.promptFilesRecommendations` setting**: R5 mentioned this setting for suggesting prompts in new sessions. Could its inverse (exclusion list) serve as a hiding mechanism? Unexplored.

4. **Runtime behavior of unofficial fields**: R6 found 7 unofficial fields but didn't test whether the parser preserves them on the parsed object. If they're preserved, ralph-loop could read `visibility: internal` from parsed frontmatter without custom parsing.

5. **Future schema roadmap**: No report found a VS Code roadmap or RFC for prompt file schema evolution. The `newChat: true` backlog item (R5) suggests the schema will grow, but direction is unclear.

6. **Multi-prompt orchestration patterns**: How do power users currently chain prompts in practice? R6 counted files but didn't analyze prompt body content for `#file:*.prompt.md` cross-references.
