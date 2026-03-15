## Research Report 2: Prompt File Discovery & Listing

### Findings

#### 1. Discovery is split between VS Code Core and the Copilot Extension

**Primary discovery happens in VS Code core**, not in the Copilot Chat extension. The extension delegates to VS Code's proposed API surface defined in [vscode.proposed.chatPromptFiles.d.ts](src/extension/vscode.proposed.chatPromptFiles.d.ts).

VS Code core scans for `.prompt.md` files using file watchers/glob patterns across:
- **Workspace folders** (`.github/prompts/`, `.vscode/prompts/`)
- **User-level prompts directory** (`~/.config/Code/User/prompts/` or equivalent)
- Files are matched by extension constant `PROMPT_FILE_EXTENSION = '.prompt.md'` defined at [src/platform/customInstructions/common/promptTypes.ts:29](src/platform/customInstructions/common/promptTypes.ts#L29)

The extension can **add additional prompt files** from external sources (GitHub org repos, extensions) via `vscode.chat.registerPromptFileProvider()` ([vscode.proposed.chatPromptFiles.d.ts:158](src/extension/vscode.proposed.chatPromptFiles.d.ts#L158)).

#### 2. Provider Registration Architecture

The `PromptFileContribution` class at [src/extension/agents/vscode-node/promptFileContrib.ts:20](src/extension/agents/vscode-node/promptFileContrib.ts#L20) is the main contribution point. It registers:
- `registerCustomAgentProvider()` — for `.agent.md` files (EditMode, Plan, Ask, Explore, GitHub Org agents)
- `registerInstructionsProvider()` — for `.instructions.md` files (GitHub Org instructions)
- `registerSkillProvider()` — for `SKILL.md` files (built-in agent customization skill)

**Notably, the extension does NOT call `registerPromptFileProvider()` itself** — meaning `.prompt.md` discovery is entirely handled by VS Code core's built-in watcher. The extension only extends agents, instructions, and skills from external sources.

The registration is gated on API availability checks:
```typescript
if ('registerCustomAgentProvider' in vscode.chat) { ... }
if ('registerInstructionsProvider' in vscode.chat) { ... }
if ('registerSkillProvider' in vscode.chat) { ... }
```

#### 3. Frontmatter Parsing & Header Attributes

The `PromptFileParser` at [src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts:15](src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L15) parses YAML frontmatter. Key attributes that affect visibility/behavior:

| Attribute | Purpose | Location |
|-----------|---------|----------|
| `name` | Display name in picker | L173 |
| `description` | Description shown in UI | L177 |
| `mode` / `agent` | Which agent mode to use | L181 |
| `tools` | Tools to enable/restrict | L199 |
| `applyTo` | Glob pattern for auto-attachment | L189 |
| `target` | Platform targeting (`vscode` vs `github-copilot`) | L193 |
| `user-invokable` | Whether user can invoke directly | L325 |
| `disable-model-invocation` | Prevent model from auto-invoking | L329 |
| `excludeAgent` | Exclude from specific agents | L77 |

These attributes are parsed but **filtering based on them (hiding from picker) happens in VS Code core**, not in the extension.

#### 4. Extension Prompt File Provider Command

The extension exposes a `vscode.extensionPromptFileProvider` command that VS Code core calls to get extension-contributed files. The `CustomInstructionsService` at [src/platform/customInstructions/common/customInstructionsService.ts:381](src/platform/customInstructions/common/customInstructionsService.ts#L381) caches these:

```typescript
const extensionPromptFiles = await this.runCommandExecutionService.executeCommand(
    'vscode.extensionPromptFileProvider'
) as IExtensionPromptFile[] | undefined;
```

Each `IExtensionPromptFile` has `{ uri: URI; type: PromptsType }` where `PromptsType` is one of `instructions | prompt | agent | skill` ([promptTypes.ts:11-15](src/platform/customInstructions/common/promptTypes.ts#L11)).

#### 5. Prompt File as Chat Variable

When a user selects a prompt file, it becomes a chat variable with ID prefix `vscode.prompt.file` ([chatVariablesCollection.ts:127](src/extension/prompt/common/chatVariablesCollection.ts#L127)). The `isPromptFile()` helper at [L123](src/extension/prompt/common/chatVariablesCollection.ts#L123) checks for this prefix. The `PromptFile` TSX component at [src/extension/prompts/node/panel/promptFile.tsx](src/extension/prompts/node/panel/promptFile.tsx) renders prompt file content into the prompt.

#### 6. Filtering & Visibility Logic

The `customInstructionsService` has matching logic that determines whether a URI is an "external instructions file":
- **Config-based locations**: Reads `chat.instructionsFilesLocations` setting, checks if URI path matches glob patterns ([customInstructionsService.ts:130-162](src/platform/customInstructions/common/customInstructionsService.ts#L130))
- **Extension-contributed locations**: Checks `contributes.chatInstructions` from extension manifests ([customInstructionsService.ts:165-188](src/platform/customInstructions/common/customInstructionsService.ts#L165))  
- **Skill locations**: Matches against `chat.agentSkillsLocations` setting and well-known paths (`.github/skills`, `.copilot/skills`) ([customInstructionsService.ts:190+](src/platform/customInstructions/common/customInstructionsService.ts#L190))

Copilot-ignored files are filtered via `IIgnoreService.isCopilotIgnored()` in the PromptFile TSX component ([promptFile.tsx:42](src/extension/prompts/node/panel/promptFile.tsx#L42)).

### Patterns

1. **Split Discovery Architecture**: VS Code core handles filesystem discovery of `.prompt.md` files via file watchers and glob patterns. The Copilot extension provides _additional_ resources through the proposed `ChatPromptFileProvider` API but does not register its own prompt file provider (only agent/instruction/skill providers).

2. **Three-Source Model**: Prompt files come from:
   - Workspace (`.github/prompts/*.prompt.md`, `.vscode/prompts/`)
   - User directory (`~/...User/prompts/`)
   - Extension providers (via `registerPromptFileProvider()`)

3. **Frontmatter-Driven Behavior**: The YAML frontmatter controls _how_ a prompt behaves when invoked (agent mode, tools, model), not _whether_ it appears in the picker. Discovery is purely file-extension based (`.prompt.md`).

4. **`user-invokable` and `target` are visibility hints**: While parsed, these attributes' filtering effect is implemented in VS Code core's prompt file resolution, not in the extension.

5. **No Extension-Side Filtering of Picker Items**: The extension does not filter which prompt files appear in the slash command picker. It only adds extra sources and handles rendering/ignoring at prompt-build time.

### Applicability

**HIGH** — This directly answers how prompt files flow from disk to the picker:
- Discovery: file extension matching by VS Code core
- Registration: via proposed API providers (extension adds org/extension sources)
- Frontmatter: parsed by `PromptFileParser`, affects behavior not discovery
- Filtering: `copilotIgnored` check at render time, `target`/`user-invokable` at core level

### Open Questions

1. **VS Code Core Implementation**: The actual file watcher and glob pattern logic for prompt file discovery lives in the `microsoft/vscode` repo (not in this extension). The exact glob patterns and watcher configuration would need to be traced there.

2. **`user-invokable: false` filtering**: Where exactly in VS Code core does the `user-invokable` attribute prevent a prompt from appearing in the picker? The extension parses it but doesn't act on it.

3. **`target` filtering**: How does the `target: github-copilot` attribute affect visibility in VS Code vs GitHub.com? The extension parses it but the filtering logic is in VS Code core.

4. **`excludeAgent` usage**: This attribute is defined in the parser but no usage was found in the extension codebase. It may be consumed by VS Code core to hide prompts from specific agent modes.

5. **User prompts directory**: The exact user-level prompts directory path and its configuration mechanism is managed by VS Code core settings, not the extension.
