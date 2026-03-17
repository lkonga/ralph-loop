# Research 3: VS Code Chat Response Part Types — Inline Feedback Inventory

**Question**: What are all the VS Code Chat response part types available for inline feedback, and how do they render in the chat pane?

---

## Findings

### A. Stable API Response Parts (vscode.d.ts)

The base `ChatResponsePart` union in the stable API defines six types:

| Part Class | Stream Helper | Rendering |
|---|---|---|
| `ChatResponseMarkdownPart` | `stream.markdown(value)` | Rendered as formatted Markdown inline in the chat body |
| `ChatResponseFileTreePart` | `stream.filetree(value, baseUri)` | Rendered as an expandable file tree widget |
| `ChatResponseAnchorPart` | `stream.anchor(value, title?)` | Rendered as a clickable inline link to a URI or Location |
| `ChatResponseProgressPart` | `stream.progress(value)` | Rendered as a transient spinner/status line (e.g., "Searching…") that updates in-place |
| `ChatResponseReferencePart` | `stream.reference(value, iconPath?)` | Rendered **separately from content** in a "Used references" list below the response |
| `ChatResponseCommandButtonPart` | `stream.button(command)` | Rendered as a clickable button that executes a VS Code `Command` |

### B. Proposed API Response Parts (chatParticipantAdditions)

These are proposed (not yet stable) additional part types registered in `ExtendedChatResponseParts`:

| Part Class | Stream Helper | Rendering |
|---|---|---|
| **`ChatResponseWarningPart`** | `stream.warning(msg)` | Rendered as a **yellow/orange warning banner** with icon inline in the chat body. Accepts `string \| MarkdownString`. |
| **`ChatResponseProgressPart2`** | `stream.progress(value, task)` | Extended progress: shows spinner + message, runs an async `task`, and during that task can emit sub-warnings and sub-references via the `progress` callback. On task completion, updates the message to the resolved string. |
| **`ChatResponseThinkingProgressPart`** | `stream.push(new ChatResponseThinkingProgressPart(...))` | Rendered as a collapsible "thinking" or "reasoning" section. Shows thinking/reasoning steps with an expandable disclosure triangle. Supports streaming via a `task` callback that emits `LanguageModelThinkingPart` deltas. Metadata key `vscodeReasoningDone: true` signals completion. |
| **`ChatResponseTextEditPart`** | `stream.textEdit(target, edits)` | Streams text edits to a file; rendered as an inline diff editor showing proposed changes |
| **`ChatResponseNotebookEditPart`** | `stream.notebookEdit(target, edits)` | Same as TextEdit but for notebook cells |
| **`ChatResponseWorkspaceEditPart`** | `stream.workspaceEdit(edits)` | File-level operations (create/delete/rename); rendered as file operation notifications |
| **`ChatResponseConfirmationPart`** | `stream.confirmation(title, message, data, buttons?)` | Rendered as an **inline confirmation dialog** with Accept/Reject (or custom buttons). Blocks user action until confirmed. Multiple confirmations may show "Accept All" / "Reject All". |
| **`ChatResponseQuestionCarouselPart`** | `stream.questionCarousel(questions, allowSkip?)` | Rendered as an **inline multi-question form** (carousel). Supports Text, SingleSelect (radio), MultiSelect (checkbox) question types. Returns answers as a `Record<string, unknown>`. |
| **`ChatResponseCodeCitationPart`** | `stream.codeCitation(value, license, snippet)` | Rendered as a code attribution notice linking to source URI with license info |
| **`ChatResponseReferencePart2`** | `stream.reference2(value, iconPath?, options?)` | Enhanced reference with status badge: `Complete`, `Partial`, `Omitted` (via `ChatResponseReferencePartStatusKind` enum). Rendered in the references section with status indicators. |
| **`ChatResponseMovePart`** | `stream.push(new ChatResponseMovePart(uri, range))` | Navigates the editor to a specific location — opens file at the given range |
| **`ChatResponseExtensionsPart`** | `stream.push(new ChatResponseExtensionsPart(extensions))` | Renders extension install recommendations (list of extension IDs) |
| **`ChatResponsePullRequestPart`** | `stream.push(new ChatResponsePullRequestPart(...))` | Rendered as a PR link card with title, description, author, and a clickable command link |
| **`ChatToolInvocationPart`** | `stream.beginToolInvocation(...)` / `stream.updateToolInvocation(...)` | Rendered as a collapsible **tool call entry** (e.g., "Running terminal command…"). Supports multiple `toolSpecificData` variants for different UI treatments. Has `presentation` property: `undefined` (visible), `'hidden'` (never shown), `'hiddenAfterComplete'` (shown during execution, hidden after). |
| **`ChatResponseMultiDiffPart`** | `stream.push(new ChatResponseMultiDiffPart(diffs, title))` | Rendered as a **multi-file diff editor** showing multiple file changes side by side. Has optional `readOnly` flag. |
| **`ChatResponseExternalEditPart`** | `stream.externalEdit(target, callback)` | Tracks edits made by external tools (e.g., MCP) to specified URIs during callback execution |
| **`ChatResponseMarkdownWithVulnerabilitiesPart`** | `stream.markdownWithVulnerabilities(value, vulns)` | Markdown with annotated vulnerability markers (title + description) |
| **`ChatResponseCodeblockUriPart`** | `stream.codeblockUri(uri, isEdit?)` | Associates a URI with a code block — enables "Open File" / "Apply Edit" actions on rendered code blocks |

### C. Hook-Specific Part (chatHooks proposal)

| Part Class | Stream Helper | Rendering |
|---|---|---|
| **`ChatResponseHookPart`** | `stream.hookProgress(hookType, stopReason?, systemMessage?)` | Rendered as a **hook execution result**. If `stopReason` is set, shows a blocking message indicating the hook denied the operation. `systemMessage` shows a warning/info message from the hook. |

### D. ChatToolInvocationPart — toolSpecificData Variants

The `ChatToolInvocationPart` renders differently depending on its `toolSpecificData`:

| Data Type | UI Rendering |
|---|---|
| `ChatTerminalToolInvocationData` | Shows terminal command line, language, output text (with ANSI support), exit code, and duration |
| `ChatMcpToolInvocationData` | Shows MCP tool input/output with content data (supports various MIME types) |
| `ChatTodoToolInvocationData` | Shows a **todo/checklist** with items and statuses: `NotStarted`, `InProgress`, `Completed` |
| `ChatSimpleToolResultData` | Displays collapsible input/output sections (generic tool result) |
| `ChatToolResourcesInvocationData` | Displays a collapsible list of file URIs / locations |
| `ChatSubagentToolInvocationData` | Shows subagent details: agent name, description, prompt, and result text |

### E. ChatResponseReferencePartStatusKind

```typescript
enum ChatResponseReferencePartStatusKind {
    Complete = 1,   // Green checkmark — file fully processed
    Partial = 2,    // Yellow indicator — file partially read/used
    Omitted = 3     // Grey/red — file was omitted from context
}
```

---

## Patterns

1. **Two-tier API**: Stable parts (6 types) vs. proposed parts (~18+ types). Production-facing code uses stable; the Copilot Chat extension itself uses proposed via `enabledApiProposals`.

2. **Inline Feedback Pattern**: `ChatResponseWarningPart`, `ChatResponseProgressPart`, and `ChatResponseProgressPart2` are the primary inline feedback mechanisms. Warning renders as a persistent banner; progress renders as a transient spinner that auto-updates.

3. **Task-based Progress**: `ChatResponseProgressPart2` and `ChatResponseThinkingProgressPart` both support an async `task` callback that allows emitting sub-parts (warnings, references, thinking deltas) during execution — the UI shows a spinner while the task runs.

4. **Stream Helper vs. Push**: Most parts have a dedicated `stream.*()` helper method. For parts without helpers, `stream.push(new Part())` is used directly.

5. **Confirmation/Question Pattern**: `ChatResponseConfirmationPart` and `ChatResponseQuestionCarouselPart` provide interactive inline UX for gathering user input, used by agent mode for tool approval flows.

6. **Tool Invocation as UI Container**: `ChatToolInvocationPart` is a polymorphic container — its visual rendering is driven by `toolSpecificData` type, making it the most versatile part for agent mode.

---

## Applicability

For **503 retry UX** specifically, the most relevant parts are:

- **`stream.progress(msg)`** — Show transient retry status ("Retrying request (attempt 2/3)…")
- **`stream.progress(msg, task)`** (`ChatResponseProgressPart2`) — Show retry status with an async task that resolves when the retry completes, allowing sub-warnings
- **`stream.warning(msg)`** — Show persistent warning about degraded service or rate limiting
- **`ChatResponseThinkingProgressPart`** — Could show retry reasoning if the model is thinking through alternatives
- **`ChatToolInvocationPart`** with `ChatSimpleToolResultData` — Could wrap a retry as a "tool call" with visible input (request params) and output (retry result)

The simplest and most idiomatic approach for retry UX: use `stream.progress()` for transient "retrying…" messages and `stream.warning()` for persistent notices like "Service temporarily unavailable, retrying" or "Request succeeded after 2 retries".

---

## Open Questions

1. **Warning persistence**: Does `ChatResponseWarningPart` persist in the response after streaming completes, or is it transient like `ChatResponseProgressPart`? Evidence suggests it persists (it's a response part, not just progress).

2. **Progress replacement**: When multiple `stream.progress()` calls are made, does each new call replace the previous one or stack? VS Code core behavior typically replaces/updates the single progress line.

3. **Error-specific part**: There is no `ChatResponseErrorPart` — errors are communicated either via `ChatResponseWarningPart`, via `ChatResult.errorDetails`, or via `ChatToolInvocationPart.isError`. Which is most appropriate for retry-after-failure UX?

4. **ProgressPart2 task cancellation**: If a retry task in `ChatResponseProgressPart2` is cancelled (e.g., user stops generation), how does the UI update? The task returns `Thenable<string | void>` — does returning void leave the original message?

5. **Proposed API stability**: Several of these parts are in proposed APIs. If Ralph uses them, it will need `enabledApiProposals: ["chatParticipantAdditions"]` — is that acceptable for the target environment?
