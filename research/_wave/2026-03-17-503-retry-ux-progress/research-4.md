# Research 4: ChatResponseStreamImpl — progress(), warning(), and _push()

## Findings

### Class Overview

`ChatResponseStreamImpl` ([src/util/common/chatResponseStreamImpl.ts](../../../vscode-copilot-chat/src/util/common/chatResponseStreamImpl.ts)) is the central adapter that implements `FinalizableChatResponseStream` (extending VS Code's `ChatResponseStream`). It unifies every chat response method into a single `_push` callback pattern.

### `_push` — the core mechanism

`_push` is a **constructor-injected callback** of type `(part: ExtendedChatResponsePart) => void`. It is **not** a concrete method but a private readonly function parameter:

```ts
constructor(
    private readonly _push: (part: ExtendedChatResponsePart) => void,
    private readonly _clearToPreviousToolInvocation: ...,
    private readonly _finalize?: ...,
    ...
) { }
```

Every public method (`markdown()`, `progress()`, `warning()`, `anchor()`, `button()`, `textEdit()`, `push()`, etc.) wraps its arguments into a typed part class and delegates to `this._push(part)`. The class itself has **zero logic for how parts are consumed** — all behavior is injected at construction time.

### `progress()` implementation

```ts
progress(value: string, task?: (progress: Progress<ChatResponseWarningPart | ChatResponseReferencePart>) => Thenable<string | void>): void {
    if (typeof task === 'undefined') {
        this._push(new ChatResponseProgressPart(value));
    } else {
        this._push(new ChatResponseProgressPart2(value, task));
    }
}
```

Two code paths based on whether a `task` callback is provided:

1. **Simple progress** (`task` is undefined): Creates a `ChatResponseProgressPart` containing just a string message. Renders as a transient status indicator (e.g., "Working...", "Generating edits...").

2. **Task-based progress** (`task` provided): Creates a `ChatResponseProgressPart2` (extends `ChatResponseProgressPart`), which carries both the message and a task function. The task receives a `Progress<ChatResponseWarningPart | ChatResponseReferencePart>` reporter, enabling sub-progress emissions (warnings and references) while the long-running task executes. The task can return a replacement string or void.

**Real usage examples:**
- Simple: `stream.progress('Working...')`, `stream.progress(l10n.t('Generating edits...'))`
- Task-based: `stream.progress(l10n.t('Searching Bing for "{0}"...', data.query), async (progress) => reportProgress(progress, ...))`
- Task-based with sub-progress: `stream.progress(l10n.t('Creating isolated worktree...'), async progress => { ... })`

### `warning()` implementation

```ts
warning(value: string | MarkdownString): void {
    this._push(new ChatResponseWarningPart(value));
}
```

Simple one-liner. Creates a `ChatResponseWarningPart` which wraps the value into a `MarkdownString` (if plain string). Used for user-visible warning messages:
- Error conditions: `stream.warning(l10n.t('The selected folder is not trusted.'))`
- Failures: `stream.warning(l10n.t('Failed to create worktree. Proceeding without isolation.'))`
- Agent errors: `stream.warning(error.message)`

### Part Type Definitions

| Part | Source | Constructor |
|------|--------|-------------|
| `ChatResponseProgressPart` | vscode core API (`vscode.d.ts`) | `(value: string)` |
| `ChatResponseProgressPart2` | proposed API (`chatParticipantAdditions.d.ts`) | `(value: string, task?: ...)` — extends `ChatResponseProgressPart` |
| `ChatResponseWarningPart` | proposed API (`chatParticipantAdditions.d.ts`) | `(value: string \| MarkdownString)` |

### Static Factory Methods

Three decorator-pattern factories wrap existing streams:

1. **`spy(stream, callback)`**: Calls `callback(part)` then forwards to `stream.push(part)` — observation without modification.
2. **`filter(stream, callback)`**: Only forwards to `stream.push(part)` if `callback(part)` returns `true`.
3. **`map(stream, callback)`**: Transforms each part via `callback(part)` before forwarding; drops the part if callback returns `undefined`.

### Test Infrastructure

`SpyChatResponseStream` extends `ChatResponseStreamImpl` with `_push` set to `(part) => this.items.push(part)`, accumulating all parts into an `items[]` array for assertions. This confirms that `_push` is purely an output channel.

## Patterns

1. **Callback Injection / Strategy Pattern**: `_push` is not a virtual method — it's a constructor-injected function. This avoids inheritance for behavior customization and enables composable wrapping (spy/filter/map).

2. **Part Object Pattern**: Every stream method creates a typed part object (discriminated by class) and delegates to a single collection point. This is a variant of the Command pattern where each method produces a reified action object.

3. **Decorator Composition**: The static factories (`spy`, `filter`, `map`) wrap an existing `ChatResponseStream` and intercept/transform the part flow. Multiple decorators can be stacked.

4. **Two-tier progress**: Simple `ChatResponseProgressPart` for status text, `ChatResponseProgressPart2` for long-running tasks that report sub-progress. The task callback pattern enables VS Code to show an expandable progress item with intermediate updates.

5. **MarkdownString coercion**: `ChatResponseWarningPart` accepts `string | MarkdownString` and normalizes to `MarkdownString` internally, keeping the API ergonomic while the renderer always gets rich text.

## Applicability

For the 503-retry UX research context:

- **Progress indicator during retries**: `stream.progress()` is the correct API for showing transient status like "Retrying request..." or "Server temporarily unavailable, retrying in 5s...". Simple string form suffices for short retries; task-based form (`ChatResponseProgressPart2`) could wrap the entire retry loop to show sub-progress.

- **Warning on degraded state**: `stream.warning()` is appropriate for notifying users of retry exhaustion or degraded responses. Examples: "Request succeeded after 3 retries", "Some results may be incomplete due to server issues".

- **Part flow is synchronous and push-based**: Callers don't await `progress()` or `warning()` — parts are pushed immediately. For retry scenarios, multiple progress parts can be pushed sequentially to update the status.

- **No deduplication**: `_push` forwards every part without coalescing. Rapid progress updates (e.g., per-retry) will each appear as separate UI elements unless the consumer deduplicates.

## Open Questions

1. **How does VS Code core render `ChatResponseProgressPart` vs `ChatResponseProgressPart2`?** The proposed API defines the types but rendering logic is in the VS Code side (not in this extension). Does `ChatResponseProgressPart` replace the previous one or accumulate?

2. **Can `ChatResponseProgressPart2`'s task callback be used for retry loops?** The task receives a `Progress<ChatResponseWarningPart | ChatResponseReferencePart>` reporter — could intermediate retry status be pushed through this sub-channel?

3. **Warning visibility during streaming**: When `warning()` is called mid-stream (between markdown parts), how does the UI position it? Is it inline or rendered in a separate warning banner?

4. **Rate limiting on progress**: Is there any throttling on the VS Code side for rapid `progress()` calls (e.g., per-retry updates every few seconds)?
