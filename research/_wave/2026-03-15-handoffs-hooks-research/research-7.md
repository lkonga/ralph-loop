## Research Report 7: Hook Result Processing and Decision Fields

### Findings

#### Core Processor: `processHookResults()` — [hookResultProcessor.ts](../../../vscode-copilot-chat/src/extension/intents/node/hookResultProcessor.ts)

The processor is a single synchronous function that iterates over an array of `HookResult` objects and dispatches based on two axes: the presence of `stopReason` (checked first), and the `resultKind` enum.

**`HookResult` interface** ([hookResultProcessor.ts#L35-L40](../../../vscode-copilot-chat/src/extension/intents/node/hookResultProcessor.ts)):

```ts
export interface HookResult {
    stopReason?: string;
    resultKind: 'success' | 'error' | 'warning';
    warningMessage?: string;
    output: unknown;
}
```

**`ChatHookResultKind` type** (VS Code proposed API, [vscode.proposed.chatHooks.d.ts#L55](../../../vscode-copilot-chat/src/extension/vscode.proposed.chatHooks.d.ts)):

```ts
export type ChatHookResultKind = 'success' | 'error' | 'warning';
```

Maps to shell exit codes:
- Exit code 0 → `resultKind: 'success'` — stdout passed to model via `onSuccess(output)`
- Exit code 2 → `resultKind: 'error'` — blocking error, throws `HookAbortError` or calls `onError`
- Other exit codes → `resultKind: 'warning'` — non-blocking, `warningMessage` shown to user

#### Processing Priority (per result, in order)

1. **`stopReason` check** (line 84): If `result.stopReason !== undefined` (empty string is valid — represents `continue: false`):
   - If `ignoreErrors` is `true` → silently skip (log trace, `continue`)
   - Otherwise → call `outputStream.hookProgress()` with formatted error → throw `HookAbortError`
   - **`stopReason` always takes priority** — even if `resultKind` is `'success'`, the result is blocked

2. **`resultKind: 'warning'`** (line 95): Collect `warningMessage` into `warnings[]` array

3. **`resultKind: 'success'`** (line 101): Call `onSuccess(result.output)`. Also collect `warningMessage` if present

4. **`resultKind: 'error'`** (line 109):
   - If `onError` callback provided → call `onError(errorMessage)`, continue processing
   - If `ignoreErrors` is `true` → silently skip
   - Otherwise → call `hookProgress()` → throw `HookAbortError`

5. **Warning aggregation** (line 126): After loop, if any warnings accumulated, push them via `hookProgress()` as `systemMessage` (single warning directly; multiple warnings numbered as `"1. ...\n2. ..."`)

#### `HookAbortError` class (line 15-23)

Custom error carrying `hookType` and `stopReason`. Has a type guard `isHookAbortError()` for catch blocks.

#### `ProcessHookResultsOptions` interface (line 44-65)

| Field | Type | Purpose |
|-------|------|---------|
| `hookType` | `ChatHookType` | Which hook is being processed |
| `results` | `readonly HookResult[]` | Array of results from hook execution |
| `outputStream` | `ChatResponseStream \| undefined` | For `hookProgress()` calls |
| `logService` | `ILogService` | Logging |
| `onSuccess` | `(output: unknown) => void` | Called for each success result |
| `ignoreErrors?` | `boolean` | When true, errors and stopReason silently ignored |
| `onError?` | `(errorMessage: string) => void` | When provided, errors go here instead of throwing |

#### Hook-Specific Output Fields (from [chatHookService.ts](../../../vscode-copilot-chat/src/platform/chat/common/chatHookService.ts))

**Stop/SubagentStop hooks** use `decision` + `reason`:
```ts
interface StopHookOutput {
    decision?: 'block';        // Set to "block" to prevent stopping
    reason?: string;           // Required when decision is "block"
}
interface SubagentStopHookOutput {
    decision?: 'block';
    reason?: string;
}
```

**SessionStart/SubagentStart hooks** use `hookSpecificOutput.additionalContext`:
```ts
interface SessionStartHookOutput {
    hookSpecificOutput?: {
        hookEventName?: string;
        additionalContext?: string;    // Concatenated from all hooks
    };
}
interface SubagentStartHookOutput {
    hookSpecificOutput?: {
        hookEventName?: string;
        additionalContext?: string;
    };
}
```

**UserPromptSubmit hook** uses both `decision` and `hookSpecificOutput.additionalContext`:
```ts
interface UserPromptSubmitHookOutput {
    decision?: 'block';
    reason?: string;
    hookSpecificOutput?: {
        hookEventName?: string;
        additionalContext?: string;
    };
}
```

**PreToolUse hooks** (collapsed result, processed in chatHookService, not hookResultProcessor):
```ts
interface IPreToolUseHookResult {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: object;
    additionalContext?: string[];
}
```

**PostToolUse hooks** (collapsed result):
```ts
interface IPostToolUseHookResult {
    decision?: 'block';
    reason?: string;
    additionalContext?: string[];
}
```

#### How Callers Wire Options ([toolCallingLoop.ts](../../../vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts))

| Hook Type | `ignoreErrors` | `onError` | `onSuccess` extracts |
|-----------|---------------|-----------|---------------------|
| Stop | — | Yes (collects blocking reasons) | `decision === 'block'` + `reason` |
| SessionStart | `true` | — | `hookSpecificOutput.additionalContext` |
| SubagentStart | `true` | — | `hookSpecificOutput.additionalContext` |
| SubagentStop | — | Yes (collects blocking reasons) | `decision === 'block'` + `reason` |

UserPromptSubmit hooks are processed at a different call site (not in these four methods).

#### ChatHookType Full Enum

From the proposed API ([vscode.proposed.chatHooks.d.ts#L13](../../../vscode-copilot-chat/src/extension/vscode.proposed.chatHooks.d.ts)):
```ts
type ChatHookType = 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'ErrorOccurred';
```

Note: `hookResultProcessor.ts` only handles 5 of these (`UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`). PreToolUse/PostToolUse have their own processing in `chatHookService.ts`. SessionEnd, PreCompact, ErrorOccurred are not tested in the hookResultProcessor spec.

#### Test Coverage ([hookResultProcessor.spec.ts](../../../vscode-copilot-chat/src/extension/intents/test/node/hookResultProcessor.spec.ts))

- 770+ lines, comprehensive coverage
- Tests all 5 hook types for `stopReason` handling (parametric)
- Tests per-hook type: success, error, warning, and `ignoreErrors` behavior
- Tests `onError` callback for Stop/SubagentStop
- Tests aggregation of multiple warnings
- Tests edge cases: empty results, undefined outputStream, non-string error output, multiple sequential results
- Tests that `stopReason` short-circuits (remaining results not processed)
- Tests empty string `stopReason` (from `continue: false`)

### Patterns

1. **Two-axis dispatch**: `stopReason` checked first (flow control), then `resultKind` (semantic classification). This ensures abort signals always win regardless of result kind.

2. **Strategy via options**: The same `processHookResults` function handles all hook types. Behavioral differences are injected via `ignoreErrors` and `onError` callbacks rather than branching on hook type.

3. **Warning aggregation**: Warnings are collected across all results and displayed in a single `hookProgress` call after all processing, preventing message spam.

4. **Hook-specific output typing is external**: `hookResultProcessor.ts` treats `output` as `unknown`. The caller (toolCallingLoop.ts) casts to the appropriate typed interface (`StopHookOutput`, `SessionStartHookOutput`, etc.).

5. **Exit code mapping convention**: Shell exit codes map to `resultKind` values (0→success, 2→error, other→warning), establishing a simple contract for hook script authors.

6. **Decision field convention**: Stop-like hooks use `{ decision: 'block', reason: '...' }` pattern. Start-like hooks use `{ hookSpecificOutput: { additionalContext: '...' } }` pattern. PreToolUse uses the more granular `{ permissionDecision: 'allow' | 'deny' | 'ask' }`.

### Applicability

**High** — This is the central mechanism for hook result processing in the extension. Any feature that adds new hook types or modifies hook behavior must go through `processHookResults`. The patterns (strategy via options, two-axis dispatch, warning aggregation) are directly reusable for new hook types.

### Open Questions

1. **PreToolUse/PostToolUse processing path**: These hooks have their own `executePreToolUseHook`/`executePostToolUseHook` methods in `chatHookService.ts` that collapse multiple results with priority rules (`deny > ask > allow`). They do NOT go through `processHookResults`. Is there a plan to unify?

2. **SessionEnd, PreCompact, ErrorOccurred**: These `ChatHookType` values exist in the proposed API but have no corresponding `processHookResults` call sites or test coverage in `hookResultProcessor.spec.ts`. Are they processed elsewhere or planned for future implementation?

3. **`output` typing**: The `HookResult.output` field is `unknown`. Callers cast to typed interfaces, but there's no runtime validation. A malformed hook response could silently produce incorrect behavior (e.g., missing `decision` field treated as "allow").

4. **Warning from success**: A success result can also carry `warningMessage`, which gets displayed alongside regular warnings. This dual behavior is tested but may be surprising to hook authors.
