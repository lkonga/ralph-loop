## Research Report 10: Ralph-Loop Hook Type Definitions

### Findings

**Source file**: `src/types.ts` (lines 459–507)

#### Hook Type Enum

```typescript
// Line 459
export type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'PreComplete' | 'TaskComplete';
```

Five hook types as a string-literal union (not a const enum).

#### Typed Input Interfaces

| Hook Type | Input Interface | Key Fields | Lines |
|-----------|----------------|------------|-------|
| `SessionStart` | `SessionStartInput` | `prdPath: string` | 461–463 |
| `PreCompact` | `PreCompactInput` | `tokenCount: number`, `taskId: string` | 465–468 |
| `PostToolUse` | `PostToolUseInput` | `toolName: string`, `taskId: string`, `taskInvocationId?: string` | 470–474 |
| `TaskComplete` | `TaskCompleteInput` | `taskId: string`, `result: 'success' \| 'failure'`, `taskInvocationId?: string` | 476–480 |
| `PreComplete` | `PreCompleteInput` | `taskId: string`, `taskInvocationId: string`, `checksRun: VerifyCheck[]`, `prdPath: string`, `previousResults?: PreCompleteHookResult[]` | 489–495 |

#### Shared Output Interface

```typescript
// Lines 482–487
export interface HookResult {
    action: 'continue' | 'retry' | 'skip' | 'stop';
    reason?: string;
    additionalContext?: string;
    blocked?: boolean;
}
```

All five hook methods return `Promise<HookResult>`. The `PreComplete` hook additionally uses `PreCompleteHookResult` (extends `HookResult` with `hookName: string`) for its `previousResults` chain (line 497–499).

#### Service Interface

```typescript
// Lines 501–507
export interface IRalphHookService {
    onSessionStart(input: SessionStartInput): Promise<HookResult>;
    onPreCompact(input: PreCompactInput): Promise<HookResult>;
    onPostToolUse(input: PostToolUseInput): Promise<HookResult>;
    onPreComplete(input: PreCompleteInput): Promise<HookResult>;
    onTaskComplete(input: TaskCompleteInput): Promise<HookResult>;
}
```

#### Known Implementations

| Class | File | Notes |
|-------|------|-------|
| `ShellHookProvider` | `src/shellHookProvider.ts:53` | Delegates to external shell scripts |
| `NoOpHookService` | `src/orchestrator.ts:135` | Default pass-through (returns `{ action: 'continue' }`) |

### Patterns

1. **Uniform return type**: Every hook returns `Promise<HookResult>` with a 4-value `action` discriminant (`continue | retry | skip | stop`). This enables a single control-flow handler in the orchestrator regardless of hook type.
2. **Progressive enrichment**: `PreCompleteInput` carries `previousResults` allowing chained pre-complete hooks to see earlier hook outcomes — a pipeline/chain-of-responsibility pattern.
3. **Strategy pattern**: `IRalphHookService` is a strategy interface with two implementations — `NoOpHookService` (null-object) and `ShellHookProvider` (bridge to external scripts). New hook providers just implement the interface.
4. **Invocation tracking**: `taskInvocationId` appears on `PostToolUseInput`, `TaskCompleteInput`, and `PreCompleteInput`, tying hook calls to a specific task attempt for tracing.

### Applicability

**High** — These interfaces are the primary extension points for injecting custom behavior into the ralph-loop lifecycle. Any handoff, gate, or side-effect mechanism (notifications, telemetry, approval gates) would plug in through `IRalphHookService`. The typed inputs provide all context needed for each lifecycle phase.

### Open Questions

1. Is there a registry or factory that selects which `IRalphHookService` implementation to use at runtime, or is it hard-wired in the orchestrator?
2. Could `RalphHookType` be leveraged as a discriminant to build a single `onHook(type, input)` dispatch method, or is the per-method interface intentional for type safety?
3. `PreComplete` is the only hook with a chaining/pipeline pattern (`previousResults`). Should other hooks support chaining too?
4. No `PreTaskStart` or `PostComplete` hooks exist — are these gaps or intentional omissions?
