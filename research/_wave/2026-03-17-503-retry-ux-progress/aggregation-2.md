## Aggregation Report 2

### Source Reports

**research-4.md** — ChatResponseStreamImpl internals: `progress()` and `warning()` method implementations, `_push` callback injection pattern, part type hierarchy, and decorator factories (spy/filter/map).
- Key finding: `progress()` branches on task presence → `ChatResponseProgressPart` (simple) vs `ChatResponseProgressPart2` (task-based) [source: research-4.md#L18-L28]
- Key finding: `_push` is a constructor-injected callback, not a method — all behavior is externally controlled [source: research-4.md#L10-L16]
- Key finding: `warning()` accepts `string | MarkdownString`, appropriate for retry exhaustion messages [source: research-4.md#L42-L48]

**research-5.md** — Comprehensive inventory of 27+ `stream.progress()` call sites across the codebase, categorized into 5 usage patterns with applicability analysis for retry UX.
- Key finding: 5 distinct patterns identified — fire-and-forget, task-based transition, ChatResponseProgressPart2 via progress.report(), delayed/conditional, and polling heartbeat [source: research-5.md#L50-L100]
- Key finding: No existing retry-count progress messages anywhere in the codebase; inline chat's "Looking not yet good, trying again..." is closest [source: research-5.md#L105-L107]
- Key finding: Pattern 2 (task-based) recommended as best fit for retry UX with attempt counts [source: research-5.md#L109-L111]

**research-6.md** — Deep dive into `ChatResponseProgressPart2` API shape, all 3 usage sites, task callback lifecycle, dual-await pattern, and sub-progress reporting capability.
- Key finding: Task callback return semantics — `string` replaces spinner with done message, `void` silently dismisses [source: research-6.md#L12-L16]
- Key finding: Dual-await pattern decouples UI lifecycle from business logic; `progress.report()` is non-blocking [source: research-6.md#L85-L97]
- Key finding: Task callback receives `Progress<ChatResponseWarningPart | ChatResponseReferencePart>` sub-reporter, but zero current usage leverages it [source: research-6.md#L107-L108]

### Deduplicated Findings

#### 1. Two-Tier Progress API

The extension provides two progress mechanisms through a single `stream.progress()` method: [source: research-4.md#L18-L28]
- **`ChatResponseProgressPart`** (simple): Static string message, transient spinner, no completion callback. Part of the stable VS Code API.
- **`ChatResponseProgressPart2`** (task-based): Proposed API extension with an async task callback. Shows spinner during execution, transitions to a resolved string or silently dismisses on void return. [source: research-6.md#L5-L16]

Both paths funnel through the `_push` callback — a constructor-injected function that decouples the stream from consumption logic. [source: research-4.md#L10-L16]

#### 2. Five Usage Patterns (Consolidated from 27+ Call Sites)

| Pattern | Frequency | Mechanism | Example | Best For |
|---------|-----------|-----------|---------|----------|
| **Fire-and-forget** | ~70% of sites | `ChatResponseProgressPart` | `stream.progress('Compacting...')` | Quick sequential status updates [source: research-5.md#L50-L55] |
| **Task-based transition** | ~15% | `ChatResponseProgressPart2` via stream | `stream.progress('Searching...', async () => { await task; return 'Done'; })` | Long-running ops needing completion msg [source: research-5.md#L57-L65] |
| **Part2 via progress.report()** | ~10% | `ChatResponseProgressPart2` pushed to `Progress` object | `progress.report(new ChatResponseProgressPart2(...))` | Prompt-rendering pipeline (no stream access) [source: research-5.md#L67-L78] |
| **Delayed/conditional** | 2 sites | Wrapped in `setTimeout` (1s) | Show only if operation exceeds threshold | Preventing flicker for fast ops [source: research-5.md#L80-L88] |
| **Polling heartbeat** | 1 site | Boolean-gated simple progress | `stream.progress('Working...')` | Keep-alive during polling intervals [source: research-5.md#L90-L95] |

#### 3. ChatResponseProgressPart2 Task Lifecycle

- Task callback is invoked by **VS Code core**, not the extension [source: research-6.md#L115-L116]
- `progress.report()` is **non-blocking** — returns immediately [source: research-6.md#L93]
- **Dual-await pattern**: Same promise awaited inside task (for UI) and outside (for control flow), decoupling UI from business logic [source: research-6.md#L85-L97]
- Error handling in task callbacks uses empty `catch {}` blocks — errors handled by outer control flow [source: research-6.md#L99-L101]
- Task callback sub-progress reporter (`Progress<ChatResponseWarningPart | ChatResponseReferencePart>`) exists but is **unused in the entire codebase** [source: research-6.md#L107-L108]

#### 4. Warning API for Terminal States

`stream.warning(value)` creates `ChatResponseWarningPart` for user-visible warnings. Accepts `string | MarkdownString` with automatic coercion. [source: research-4.md#L42-L48]
- Current uses: trust violations, worktree failures, agent errors, max-turns reached [source: research-4.md#L44-L47]
- Appropriate for retry exhaustion or degraded-response notifications [source: research-4.md#L66-L67]

#### 5. No Existing Retry Precedent

Zero retry-count progress messages exist in the codebase. The closest patterns are: [source: research-5.md#L105-L107]
- Inline chat: `'Looking not yet good, trying again...'` (no count) [source: research-5.md#L35]
- Claude agent: `'Maximum turns reached ({n})'` (numeric parameter, but for limits not retries) [source: research-5.md#L46]
- All progress strings use `l10n.t()` for localization with `{0}` interpolation [source: research-5.md#L103]

#### 6. Stream Composition (Decorator Pattern)

Three static factories enable intercepting part flow: [source: research-4.md#L56-L62]
- `spy(stream, callback)` — observe without modifying
- `filter(stream, callback)` — conditionally forward
- `map(stream, callback)` — transform parts

These could intercept retry progress parts for logging/telemetry without altering user-facing behavior.

### Cross-Report Patterns

**HIGH CONFIDENCE — Confirmed across all 3 reports:**

1. **`ChatResponseProgressPart2` with task callback is the recommended API for retry UX**: Research-4 identifies it as the correct API for transient retry status [source: research-4.md#L64-L65], Research-5 explicitly recommends Pattern 2 (task-based) as best fit [source: research-5.md#L109-L111], and Research-6 provides the implementation details and lifecycle semantics [source: research-6.md#L103-L108].

2. **`stream.progress()` is the primary entry point; `progress.report()` is the fallback**: Research-4 documents the method [source: research-4.md#L18-L28], Research-5 shows ~85% of sites use `stream.progress()` [source: research-5.md#L50-L65], Research-6 shows `progress.report()` only used when stream is unavailable (prompt-rendering pipeline) [source: research-6.md#L40-L42].

3. **Non-blocking push model with no deduplication**: Research-4 notes `_push` forwards every part without coalescing [source: research-4.md#L70-L71], Research-5 confirms each `stream.progress()` call replaces the previous indicator [source: research-5.md#L117], Research-6 confirms `progress.report()` returns immediately [source: research-6.md#L93]. This means sequential retry progress calls will each appear independently.

4. **Localization is mandatory**: All three reports confirm `l10n.t()` usage for user-facing messages, with `{0}` for parameter interpolation [source: research-5.md#L103] [source: research-4.md#L34-L39].

### Priority Matrix

| Pattern | Impact | Effort | Sources |
|---------|--------|--------|---------|
| Use `stream.progress()` with task callback for retry spinner → done transition | **High** — core retry UX visibility | **Low** — single API call per retry | [research-4.md#L64-L65](research-4.md#L64-L65), [research-5.md#L109-L111](research-5.md#L109-L111), [research-6.md#L103-L108](research-6.md#L103-L108) |
| Add delayed display (1s threshold) to prevent flicker on fast retries | **Medium** — polish UX | **Low** — wrap in setTimeout, existing pattern | [research-5.md#L80-L88](research-5.md#L80-L88), [research-5.md#L113-L114](research-5.md#L113-L114) |
| Use `stream.warning()` for retry exhaustion / degraded state | **Medium** — informs user of failure | **Low** — one-liner API | [research-4.md#L42-L48](research-4.md#L42-L48), [research-4.md#L66-L67](research-4.md#L66-L67) |
| Leverage task sub-progress reporter for per-retry warnings/references | **Low** — unexplored capability, unclear UX | **Medium** — no existing usage to model from | [research-6.md#L107-L108](research-6.md#L107-L108), [research-6.md#L121-L122](research-6.md#L121-L122) |
| Use stream decorators (spy/filter) for retry telemetry/logging | **Low** — observability, not user-facing | **Low** — existing pattern | [research-4.md#L56-L62](research-4.md#L56-L62) |

### Gaps

1. **Retry loop location not identified**: All three reports note the need to determine which layer handles 503 retries (endpoint vs intent handler) and whether `stream` is accessible there. [source: research-5.md#L120-L121] [source: research-4.md#L74-L75] — This is critical for implementation and was not covered by these reports.

2. **VS Code core rendering behavior unknown**: How does VS Code render rapid successive `ChatResponseProgressPart` instances? Does it replace, stack, or throttle them? [source: research-4.md#L74-L75] [source: research-6.md#L115-L116] — This affects whether retry count updates flicker.

3. **Cancellation interaction with task callbacks**: No existing task callback checks the cancellation token. If a retry is cancelled mid-task, cleanup behavior is undefined. [source: research-6.md#L125-L126]

4. **Warning positioning during streaming**: Where `warning()` renders relative to active streaming content is undocumented. [source: research-4.md#L78-L79]

5. **Retry message UX design**: Should messages include HTTP status codes (`'Server busy (503)'`), attempt counts (`'Attempt 2/3'`), or be user-friendly (`'Retrying request...'`)? No existing pattern provides guidance. [source: research-5.md#L128-L129]

### Sources
- research-4.md — ChatResponseStreamImpl: progress(), warning(), _push() callback injection, part types, decorator factories
- research-5.md — stream.progress() usage patterns inventory (27+ sites, 5 patterns), retry UX applicability analysis
- research-6.md — ChatResponseProgressPart2 deep dive: API shape, 3 usage sites, task lifecycle, dual-await pattern, sub-progress capability
