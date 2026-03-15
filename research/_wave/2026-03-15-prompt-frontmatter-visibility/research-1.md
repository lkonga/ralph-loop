## Research Report 1: Frontmatter Schema Parsing

### Findings

#### 1. Core Parser: `PromptFileParser` class (copied from microsoft/vscode)

**File**: `src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts`

The canonical frontmatter parser is `PromptFileParser.parse(uri, content)` → `ParsedPromptFile`. It splits on `---` delimiters, extracts YAML between them, and parses via a custom lightweight YAML parser (`src/util/vs/base/common/yaml.ts` — NOT the `yaml` npm package).

```typescript
// Line 20-49: Core parse method
public parse(uri: URI, content: string): ParsedPromptFile {
    // Detects --- delimiters, extracts header range + body range
    if (linesWithEOL[0].match(/^---[\s\r\n]*$/)) { ... }
    header = new PromptHeader(range, linesWithEOL);
    body = new PromptBody(range, linesWithEOL, uri);
}
```

#### 2. Complete Schema: `PromptHeaderAttributes` namespace (Lines 66-87)

All recognized frontmatter field names are defined in this namespace:

```typescript
export namespace PromptHeaderAttributes {
    export const name = 'name';                           // string
    export const description = 'description';             // string
    export const agent = 'agent';                         // string ('ask' | 'edit' | 'agent')
    export const mode = 'mode';                           // string (alias for 'agent')
    export const model = 'model';                         // string | string[]
    export const applyTo = 'applyTo';                     // string (glob pattern)
    export const tools = 'tools';                         // string[] | object (nested booleans)
    export const handOffs = 'handoffs';                   // IHandOff[] (complex nested objects)
    export const advancedOptions = 'advancedOptions';     // (defined but no getter)
    export const argumentHint = 'argument-hint';          // string
    export const excludeAgent = 'excludeAgent';           // (defined but no getter)
    export const target = 'target';                       // string ('vscode' | 'github-copilot')
    export const infer = 'infer';                         // boolean
    export const license = 'license';                     // (defined but no getter)
    export const compatibility = 'compatibility';         // (defined but no getter)
    export const metadata = 'metadata';                   // (defined but no getter)
    export const agents = 'agents';                       // string[]
    export const userInvokable = 'user-invokable';        // boolean
    export const disableModelInvocation = 'disable-model-invocation'; // boolean
}

// GitHub-specific extension (Line 88-90):
export namespace GithubPromptHeaderAttributes {
    export const mcpServers = 'mcp-servers';
}
```

#### 3. Typed Accessors on `PromptHeader` class (Lines 168-331)

The `PromptHeader` class provides typed getters for most attributes:

| Getter | Type | Line |
|--------|------|------|
| `name` | `string \| undefined` | 171 |
| `description` | `string \| undefined` | 175 |
| `agent` | `string \| undefined` (falls back to `mode`) | 179 |
| `model` | `readonly string[] \| undefined` | 183 |
| `applyTo` | `string \| undefined` | 187 |
| `argumentHint` | `string \| undefined` | 191 |
| `target` | `string \| undefined` | 195 |
| `infer` | `boolean \| undefined` | 199 |
| `tools` | `string[] \| undefined` | 207 |
| `handOffs` | `IHandOff[] \| undefined` | 235 |
| `agents` | `string[] \| undefined` | 322 |
| `userInvokable` | `boolean \| undefined` | 325 |
| `disableModelInvocation` | `boolean \| undefined` | 329 |

**Fields WITHOUT getters** (defined in namespace but no accessor): `advancedOptions`, `excludeAgent`, `license`, `compatibility`, `metadata`. These are parsed into the generic `attributes` array but have no typed accessor.

#### 4. Per-File-Type Field Constraints (`promptFileContextService.ts`, Lines 100-170)

The context service tells Copilot's own completions which fields are valid per file type:

| File Type | Valid Frontmatter Fields |
|-----------|------------------------|
| `.prompt.md` | `name`, `description`, `argument-hint`, `agent` (ask/edit/agent), `model`, `tools` |
| `.instructions.md` | `name`, `description`, `applyTo` |
| `.agent.md` | `name`, `description`, `argument-hint`, `target`, `model`, `tools`, `handoffs` |

#### 5. Agent Config Builder (`agentTypes.ts`, Lines 55-115)

`buildAgentMarkdown(config: AgentConfig)` generates `.agent.md` content with these fields:
- `name`, `description`, `argument-hint`, `model` (string or array), `target`, `disable-model-invocation`, `user-invocable`, `tools` (array), `agents` (array), `handoffs` (block-style nested objects with `label`, `agent`, `prompt`, `send?`, `showContinueOn?`, `model?`)

#### 6. GitHub Org Agent Generation (`githubOrgCustomAgentProvider.ts`, Lines 119-155)

`generateAgentMarkdown()` uses the `yaml` npm library (`YAML.stringify`) for GitHub org agents, serializing: `name`, `description`, `tools`, `argument-hint`, `target`, `model`, `disable-model-invocation`, `user-invocable`.

#### 7. Custom YAML Parser (`src/util/vs/base/common/yaml.ts`)

The extension uses a custom lightweight YAML parser (not the `yaml` npm package for parsing). It returns typed `YamlNode` objects (string, number, boolean, null, array, object). This is a deliberate design choice — the comment in `githubOrgCustomAgentProvider.ts` notes: "The custom YAML parser doesn't support multi-line strings."

### Patterns

1. **Two-layer architecture**: The `PromptHeaderAttributes` namespace defines ALL known field names. The `PromptHeader` class selectively implements typed getters for fields that have runtime consumers. Unrecognized fields are still parsed and available via `attributes` array.

2. **File-type differentiation**: `.prompt.md`, `.instructions.md`, and `.agent.md` share the same parser but expose different subsets of fields as "valid."

3. **Fallback/alias**: `agent` falls back to `mode` (Line 180: `this.getStringAttribute('agent') ?? this.getStringAttribute('mode')`).

4. **Tools parsing is polymorphic**: Supports both array format (`tools: [a, b]`) and object format (`tools: { group: { tool: true } }`), collecting leaf boolean keys.

5. **No validation enforcement**: The parser doesn't reject unknown fields — it parses everything into `attributes`. Validation is soft (context hints to Copilot completions).

6. **No `hidden` or `visibility` field**: There is NO frontmatter field for hiding/showing prompts. No `hidden`, `visible`, `enabled`, or similar attribute exists in the schema.

### Applicability

**HIGH** — This directly answers whether prompts can be hidden via frontmatter. They cannot. The complete schema has no visibility/hidden field. Prompt visibility would need to be controlled via file system placement, not frontmatter metadata.

### Open Questions

1. **`excludeAgent` field**: Defined in the namespace but has no getter — is it consumed anywhere downstream? Could it be repurposed for visibility control?
2. **`advancedOptions` field**: Also defined but no getter — what was its intended use?
3. **`metadata` field**: Generic metadata field exists — could arbitrary key-value pairs be used for custom visibility flags?
4. Does the VS Code core (not this extension) have additional frontmatter schema evolution planned? The parser is copied from `microsoft/vscode`.
