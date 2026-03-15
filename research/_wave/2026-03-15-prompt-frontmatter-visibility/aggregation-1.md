## Aggregation Report 1

### Source Reports

1. **Research 1 — Frontmatter Schema Parsing**: Mapped the complete `PromptHeaderAttributes` namespace (20 fields), typed getters on `PromptHeader`, per-file-type field constraints, and the custom YAML parser. Confirmed **no `hidden`/`visibility` field exists** in the schema.

2. **Research 2 — Prompt File Discovery & Listing**: Traced the split discovery architecture (VS Code core handles `.prompt.md` filesystem discovery; extension adds agents/instructions/skills via proposed API). Confirmed frontmatter controls behavior, not discovery. `user-invokable` and `target` filtering are implemented in VS Code core, not the extension.

3. **Research 3 — Visibility/Hidden Controls**: Identified the two-axis visibility model (`user-invokable` for user visibility, `disable-model-invocation` for model invocability), the older `hiddenFromUser` mechanism for slash commands, and the `isListedCapability` flag for prompt-level capability listing. Confirmed `user-invokable: false` is the only frontmatter-based hiding mechanism, used by the Explore agent.

### Deduplicated Findings

#### 1. Complete Frontmatter Schema (20 fields)
All recognized fields in `PromptHeaderAttributes`:

| Field | Type | Has Getter | File Types |
|-------|------|-----------|------------|
| `name` | string | Yes | all |
| `description` | string | Yes | all |
| `agent` / `mode` | string | Yes (aliased) | .prompt.md, .agent.md |
| `model` | string \| string[] | Yes | .prompt.md, .agent.md |
| `applyTo` | string (glob) | Yes | .instructions.md |
| `tools` | string[] \| object | Yes | .prompt.md, .agent.md |
| `handoffs` | IHandOff[] | Yes | .agent.md |
| `argument-hint` | string | Yes | .prompt.md, .agent.md |
| `target` | string | Yes | .agent.md |
| `infer` | boolean | Yes | undocumented |
| `agents` | string[] | Yes | .agent.md |
| `user-invokable` | boolean | Yes | .agent.md (de facto) |
| `disable-model-invocation` | boolean | Yes | .agent.md (de facto) |
| `excludeAgent` | – | **No** | unknown |
| `advancedOptions` | – | **No** | unknown |
| `license` | – | **No** | unknown |
| `compatibility` | – | **No** | unknown |
| `metadata` | – | **No** | unknown |
| `mcp-servers` | – | GitHub-only | .agent.md |

Five fields (`excludeAgent`, `advancedOptions`, `license`, `compatibility`, `metadata`) are defined in the namespace but have no typed getter and no known consumer.

#### 2. Two-Axis Visibility Model
- **User visibility**: `user-invokable: false` hides from user-facing UI. Used by Explore subagent and GitHub org agents.
- **Model invocability**: `disable-model-invocation: true` prevents the model from auto-invoking. Used by Plan, Ask, and EditMode built-in agents.
- These axes are independent — an agent can be hidden from users but callable by other agents.

#### 3. No Generic Hidden/Visibility Field Exists
All three reports confirm: there is **no** `hidden`, `visible`, `isInternal`, `isPrivate`, or `enabled` frontmatter field. `user-invokable` is the closest mechanism, and it's designed for `.agent.md` files.

#### 4. Discovery is File-Extension Based, Not Frontmatter Based
VS Code core discovers prompt files by matching the `.prompt.md` extension via file watchers. Frontmatter is parsed **after** discovery and controls behavior (mode, tools, model), not whether the file appears. The extension adds sources (org agents, extension contributions) but does not filter the picker.

#### 5. Split Architecture: Core vs Extension
- **VS Code core**: File discovery, watcher/glob, picker UI, `user-invokable`/`target` filtering.
- **Copilot extension**: Frontmatter parsing, additional source registration, prompt rendering, `.copilotIgnored` filtering at build time.

#### 6. Three Distinct Hiding Mechanisms (Different Layers)

| Mechanism | Layer | Scope | Used By |
|-----------|-------|-------|---------|
| `user-invokable: false` | Frontmatter (YAML) | Agent/prompt files | Explore agent, org agents |
| `hiddenFromUser: true` | TypeScript interface | Slash commands/intents | generateCode, unknown intents |
| `isListedCapability: false` | TypeScript interface | Capabilities in system prompt | setupTests intent |

#### 7. Parser Accepts Unknown Fields Without Error
The custom YAML parser parses all frontmatter into a generic `attributes` array. Unknown fields are silently accepted — no validation rejects them. This means custom fields (e.g., `ralph-internal: true`) could be added and read manually, though they'd have no built-in effect.

### Cross-Report Patterns

1. **`user-invokable: false` is the answer** (Reports 1, 2, 3): All three independently confirm this is the only frontmatter mechanism for hiding prompts from users. High confidence.

2. **Per-file-type field differentiation** (Reports 1, 2): `.prompt.md`, `.instructions.md`, and `.agent.md` share the same parser but have different valid field sets. `user-invokable` is contextually associated with `.agent.md` — whether it works on `.prompt.md` is unconfirmed.

3. **Five ghost fields with no consumers** (Reports 1, 3): `excludeAgent`, `advancedOptions`, `license`, `compatibility`, `metadata` are defined but unused. Potential for future use or custom extension.

4. **Filtering happens in VS Code core, not the extension** (Reports 2, 3): The extension parses `user-invokable` and `target` but does not filter picker items. The actual hiding logic is in `microsoft/vscode` — tracing it requires looking at the core repo.

5. **Spelling inconsistency: `user-invokable` vs `userInvocable`** (Reports 1, 3): Frontmatter uses `user-invokable` (hyphenated), TypeScript uses `userInvocable` (camelCase, different spelling of "invocable"). Both reports flag this — potential source of bugs.

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Use `user-invokable: false` to hide orchestration prompts | High | Low | R1, R2, R3 |
| Convert internal `.prompt.md` to `.agent.md` for `user-invokable` support | High | Low | R1, R2 |
| Trace `user-invokable` filtering in VS Code core repo | Medium | Medium | R2, R3 |
| Investigate `excludeAgent` for agent-scoped visibility | Medium | Medium | R1, R3 |
| Leverage silent unknown-field acceptance for custom metadata | Low | Low | R1 |
| Resolve `invokable` vs `invocable` spelling inconsistency | Low | Low | R1, R3 |

### Gaps

1. **VS Code core filtering logic untraced**: All three reports identify that `user-invokable` filtering happens in `microsoft/vscode`, not the extension. No report traced the actual core implementation — we don't know the exact behavior (picker hiding? complete exclusion?).

2. **`.prompt.md` + `user-invokable` combination untested**: The field is used on `.agent.md` files (Explore agent). Whether setting `user-invokable: false` on a plain `.prompt.md` file hides it from the prompt picker is unverified.

3. **`excludeAgent` consumer unknown**: Defined in the parser namespace but no getter and no usage found. Could be consumed by VS Code core or be dead code.

4. **`target` field filtering behavior**: How `target: github-copilot` vs `target: vscode` affects visibility in VS Code is not traced.

5. **User-level prompts directory discovery**: The exact mechanism for `~/...User/prompts/` discovery and whether `user-invokable` is respected there is unexamined.

6. **Runtime verification**: No report tested setting `user-invokable: false` on a live `.prompt.md` file to observe actual behavior. All findings are from static code analysis.
