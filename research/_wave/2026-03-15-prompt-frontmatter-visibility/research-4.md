## Research Report 4: Prompt-to-Prompt Invocation

### Findings

**1. No direct prompt-to-prompt `${prompt:other}` variable syntax exists.**
The `PromptFileParser` ([promptFileParser.ts](src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts)) parses frontmatter and body but has no `${prompt:...}` variable type. The body parser (L400-446) recognizes only:
- `#file:<filePath>` — inline file reference syntax (L423)
- `#tool:<toolName>` — inline tool reference syntax (L423)
- `[text](link)` — markdown links treated as file references (L411-418)

There is no `#prompt:`, `#include:`, or `${prompt:...}` syntax for referencing other `.prompt.md` files.

**2. File references CAN point to other `.prompt.md` files (implicit chaining).**
`PromptBody.fileReferences` (L389) collects all `#file:` and markdown link paths from the body. The `resolveFilePath` method (L455-467) resolves relative paths against the prompt file's own directory. If a `#file:path/to/other.prompt.md` appears in a prompt body, it would be collected as a file reference. However, the runtime consumer (`PromptFile` component in [promptFile.tsx](src/extension/prompts/node/panel/promptFile.tsx) L59-80) reads the entire file content as text and strips the YAML header — it does **not** recursively resolve nested file references within that content. This means `#file:` references inside included prompts are NOT further resolved.

**3. Handoffs provide agent-level prompt delegation (not nesting).**
The `handoffs` frontmatter attribute ([promptFileParser.ts](src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts) L235-279) enables `.agent.md` files to delegate to other agents with a prompt string:
```yaml
handoffs:
  - agent: coder
    label: "Start Implementation"
    prompt: "Implement the plan"
    send: true
```
Interface `IHandOff` (L342-349) has `agent`, `label`, `prompt`, `send`, `showContinueOn`, `model` fields. This is used by `planAgentProvider.ts` (L205-237) to create handoff buttons between agents (Plan → Coder). This is **agent-level delegation**, not prompt file inclusion/nesting.

**4. Custom instructions resolve file content but don't chain.**
`customInstructions.tsx` (L80-105) iterates instruction files via `createElementFromURI`, which reads file content. It deduplicates by URI and content hash but does not recursively parse referenced files within those instructions.

**5. The `agents` frontmatter field lists agent names, not prompt references.**
`PromptHeaderAttributes.agents` (L84) lists agent identifiers for routing, not for invoking other prompt files.

### Patterns

| Pattern | Supported? | Mechanism |
|---------|-----------|-----------|
| `${prompt:other}` variable | **No** | Does not exist |
| `#file:other.prompt.md` in body | **Partial** | Parsed as file reference but content is NOT recursively expanded |
| `#include` / `#import` directive | **No** | Does not exist |
| YAML `handoffs` to delegate to agents | **Yes** | Agent-level delegation with prompt string |
| Recursive/nested prompt resolution | **No** | `PromptFile.getBodyContent()` reads flat text, strips header, no recursion |

**How "chaining" works in practice:**
- There is no true prompt-to-prompt invocation or subroutine mechanism
- `handoffs` allow one agent to transition to another agent with a prompt, but this is UI-level delegation (buttons), not prompt file inclusion
- `.instructions.md` files are gathered and concatenated into the prompt, but they don't reference each other
- `#file:` references in prompt bodies are parsed for IDE features (completions, navigation) but the runtime prompt rendering reads the file as flat text without recursion

### Applicability
**Medium** — The `#file:` syntax exists and is parsed, meaning a prompt file body *could* reference another `.prompt.md` via `#file:path.prompt.md` or `[label](path.prompt.md)`. However, the runtime does not recursively resolve these nested references — the content would be included as flat text without further `#file:` expansion. The `handoffs` mechanism provides agent-level delegation but operates at a completely different level than prompt file inclusion.

### Open Questions
1. Could the VS Code core (not the extension) do recursive resolution of `#file:` references in prompt bodies? The parser is copied from `microsoft/vscode` — need to check if the core chat system handles recursive file reference expansion.
2. If `#file:other.prompt.md` is used in a prompt body, does the chat system's variable resolution pass expand it before the extension's `PromptFile` component processes it? The `resolveVariablesInPrompt` call in `remoteAgents.ts:301` could potentially handle this.
3. Is there a planned `${prompt:name}` syntax? The existing `ChatPromptReference` proposed API types suggest this namespace might be extensible.
