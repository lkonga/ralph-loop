# Research: Checkpoint Approach Code Changes Analysis

**Wave ID**: 2026-03-17-ralph-checkpoint-patterns
**Report**: research-12
**Date**: 2026-03-17
**Question**: What changes to types.ts, orchestrator.ts, prd.ts, verify.ts would be needed for each checkpoint approach?

---

## Findings

### Current State Summary

The codebase already has foundational checkpoint infrastructure:

- **`LoopEventKind.HumanCheckpointRequested`** exists in `types.ts` (line ~68) and is yielded by orchestrator in two places: stagnation tier-3 escalation (orchestrator.ts ~740) and diff-validation exhaustion (orchestrator.ts ~860).
- **`extension.ts`** handles `HumanCheckpointRequested` with a 4-option dialog: Continue, Skip Task, Stop Loop, Provide Guidance (lines 163–189).
- **`VerifierRegistry`** in `verify.ts` supports pluggable verifier types (`checkbox`, `fileExists`, `fileContains`, `commandExitCode`, `tsc`, `vitest`, `custom`).
- **`parsePrd()`** in `prd.ts` parses checkbox lines and `[DECOMPOSED]` annotations but no other DSL markers.
- **`RalphConfig.verifiers`** accepts `VerifierConfig[]` so new verifier types can be added without config schema changes.

---

### Approach A: Sentinel Verifier

**Concept**: A custom verifier that checks for the existence of a human-created approval file (e.g., `.ralph-approved-Task-003`). The loop blocks (via existing pause mechanism) until the file appears.

#### Files Changed

| File | Change | Lines Added/Modified |
|------|--------|---------------------|
| `src/verify.ts` | Register new `'sentinel'` verifier in `createBuiltinRegistry()` | ~15 lines added |

#### Specific Changes

**`src/verify.ts`** — Add to `createBuiltinRegistry()`:

```typescript
registry.register('sentinel', async (task, workspaceRoot, args) => {
    const approvalFile = args?.path ?? `.ralph-approved-${task.taskId}`;
    const fullPath = path.join(workspaceRoot, approvalFile);
    const exists = fs.existsSync(fullPath);
    return {
        name: 'sentinel',
        result: exists ? VerifyResult.Pass : VerifyResult.Fail,
        detail: exists ? `Approval file found: ${approvalFile}` : `Awaiting approval file: ${approvalFile}`,
    };
});
```

**No changes needed to types.ts, orchestrator.ts, or prd.ts.** The sentinel verifier plugs into the existing `VerifierConfig` system. Users configure it in their `ralph-loop` settings:

```json
{
    "ralph-loop.verifiers": [
        { "type": "checkbox" },
        { "type": "sentinel", "args": { "path": ".ralph-approved" } },
        { "type": "tsc" }
    ]
}
```

When the sentinel fails, the existing dual-exit-gate rejects completion → confidence score drops → task retries → eventually stagnation detection triggers `HumanCheckpointRequested` → loop pauses for human.

#### Estimates

- **Lines of code**: ~15 new lines in verify.ts
- **Complexity**: Very low — single function registration
- **Risk**: Minimal — additive change with no modifications to existing logic
- **Limitation**: Blocking is indirect (via stagnation → pause). No immediate pause on sentinel failure. The loop wastes iterations before pausing.

---

### Approach B: DSL Checkpoint Annotation

**Concept**: A new `[CHECKPOINT]` marker in PRD tasks (e.g., `- [ ] **Deploy** Deploy to staging [CHECKPOINT]`) that tells the orchestrator to pause and wait for human approval before proceeding to the next task.

#### Files Changed

| File | Change | Lines Added/Modified |
|------|--------|---------------------|
| `src/types.ts` | Add `checkpoint` field to `Task` interface | ~2 lines |
| `src/prd.ts` | Parse `[CHECKPOINT]` annotation in `parsePrd()` | ~8 lines |
| `src/orchestrator.ts` | Yield `HumanCheckpointRequested` after completing a checkpoint-annotated task | ~12 lines |

#### Specific Changes

**`src/types.ts`** — Extend `Task` interface:

```typescript
export interface Task {
    readonly id: number;
    readonly taskId: string;
    readonly description: string;
    status: TaskStatus;
    readonly lineNumber: number;
    readonly dependsOn?: string[];
    readonly checkpoint?: boolean;  // NEW: pause after this task completes
}
```

**`src/prd.ts`** — Parse `[CHECKPOINT]` in `parsePrd()`:

```typescript
const CHECKPOINT_ANNOTATION = /\[CHECKPOINT\]/i;

// Inside the for-loop where tasks are created, after setting description:
const isCheckpoint = CHECKPOINT_ANNOTATION.test(line);
// Strip the annotation from the description for clean display:
const cleanDescription = description.replace(CHECKPOINT_ANNOTATION, '').trim();

// Add to task construction:
taskEntries.push({
    task: {
        id: id++,
        taskId: '',
        description: cleanDescription,
        status: TaskStatus.Pending,
        lineNumber: i + 1,
        dependsOn,
        checkpoint: isCheckpoint,
    },
    indent,
    rawDescription: cleanDescription,
});
```

**`src/orchestrator.ts`** — After the task-completed block (after atomic commit, around line ~960), before the countdown:

```typescript
// DSL checkpoint gate: pause after completing a checkpoint-annotated task
if (task.checkpoint) {
    yield {
        kind: LoopEventKind.HumanCheckpointRequested,
        task,
        reason: `Checkpoint reached after completing: ${task.description}`,
        failCount: 0,
        taskInvocationId,
    };
    this.pauseRequested = true;
    while (this.pauseRequested) {
        this.state = LoopState.Paused;
        await this.delay(1000);
        if (this.stopRequested) {
            yield { kind: LoopEventKind.Stopped };
            return;
        }
    }
}
```

#### Estimates

- **Lines of code**: ~22 lines across 3 files
- **Complexity**: Low — the PRD parser already handles annotations (`[DECOMPOSED]`), and the orchestrator already yields `HumanCheckpointRequested` in similar patterns
- **Risk**: Low — additive change. The `checkpoint` field is optional so existing PRDs work identically. The `[DECOMPOSED]` pattern provides precedent for annotation parsing.
- **Advantage**: Deterministic — checkpoint positions are declared in the PRD, visible to the user, and require no runtime heuristics.

---

### Approach C: Agent-Initiated Escalation

**Concept**: The agent (Copilot) itself recognizes when it's stuck or unsure and requests human clarification. Ralph detects this signal in the execution result or progress output and pauses the loop.

#### Files Changed

| File | Change | Lines Added/Modified |
|------|--------|---------------------|
| `src/types.ts` | Add `escalationRequested` to `ExecutionResult`, new `LoopEventKind.EscalationRequested` | ~5 lines |
| `src/orchestrator.ts` | Check `execResult.escalationRequested` after execution, yield escalation event and pause | ~15 lines |

#### Specific Changes

**`src/types.ts`** — Extend `ExecutionResult`:

```typescript
export interface ExecutionResult {
    completed: boolean;
    method: CopilotMethod;
    hadFileChanges: boolean;
    escalationRequested?: boolean;  // NEW: agent asked for human help
    escalationReason?: string;      // NEW: why the agent is escalating
}
```

Add new event variant:

```typescript
// In LoopEventKind enum:
EscalationRequested = 'escalation_requested',

// In LoopEvent union:
| { kind: LoopEventKind.EscalationRequested; task: Task; reason: string; taskInvocationId: string }
```

**`src/orchestrator.ts`** — After `execResult` is obtained, before the nudge loop (around line ~720):

```typescript
// Agent-initiated escalation: if the execution strategy detects an escalation
// signal from the model (e.g., "I need human input" in output), surface it
if (execResult.escalationRequested) {
    const reason = execResult.escalationReason ?? 'Agent requested human clarification';
    appendProgress(progressPath, `[${taskInvocationId}] Escalation requested: ${reason}`);
    yield {
        kind: LoopEventKind.EscalationRequested,
        task,
        reason,
        taskInvocationId,
    };
    this.pauseRequested = true;
    while (this.pauseRequested) {
        this.state = LoopState.Paused;
        await this.delay(1000);
        if (this.stopRequested) {
            yield { kind: LoopEventKind.Stopped };
            return;
        }
    }
    // After human resumes, re-run the task with any injected context
    continue;
}
```

**Note**: The execution strategy (`CopilotCommandStrategy` or `DirectApiStrategy`) would also need changes to detect the escalation signal in Copilot's output. This adds ~10–20 lines in `src/strategies.ts` to scan for escalation markers (e.g., `[NEEDS_HUMAN]` or a specific output pattern).

#### Estimates

- **Lines of code**: ~20 lines in types.ts + orchestrator.ts, plus ~15 in strategies.ts
- **Complexity**: Medium — requires defining what constitutes an escalation signal from the model. The signal detection is inherently fuzzy (parsing natural language output).
- **Risk**: Medium — false positives could pause the loop unnecessarily; false negatives miss genuine stuck situations. Depends on model reliability for signal quality.
- **Advantage**: Most flexible — the agent can escalate at any point, not just at predefined checkpoints. Works with any PRD without annotations.

---

### Approach D: Split PRD (Operational Pattern)

**Concept**: No code changes. User manually splits work into multiple PRD files (e.g., `PRD-phase1.md`, `PRD-phase2.md`). Ralph runs phase 1 to completion, the user reviews, then reconfigures Ralph to use the next PRD.

#### Files Changed

| File | Change | Lines Added/Modified |
|------|--------|---------------------|
| (none) | No code changes | 0 |

#### Workflow

1. User creates `PRD-phase1.md` with tasks up to the decision point.
2. Configure: `"ralph-loop.prdPath": "PRD-phase1.md"`.
3. Run Ralph → it completes all phase-1 tasks → emits `AllDone`.
4. User reviews work, makes decisions.
5. User creates `PRD-phase2.md` (or modifies the config to point to `PRD-phase2.md`).
6. Run Ralph again.

**Alternatively**, use `updateConfig()` programmatically or via the VS Code settings UI between phases. The `AllDone` event in `extension.ts` already shows an information message — the user naturally gets notified.

#### Estimates

- **Lines of code**: 0
- **Complexity**: Zero (no engineering effort)
- **Risk**: Zero (no codebase changes)
- **Limitation**: Manual workflow friction. User must pre-plan split points. No in-loop checkpointing — if the user wants to checkpoint mid-phase, they must stop the loop manually.

---

## Patterns

### Existing Infrastructure Reuse

All four approaches leverage existing infrastructure differently:

| Infrastructure | Approach A | Approach B | Approach C | Approach D |
|---------------|:----------:|:----------:|:----------:|:----------:|
| `VerifierRegistry` | ✅ Primary | ❌ | ❌ | ❌ |
| `HumanCheckpointRequested` event | ✅ Indirect | ✅ Direct | ❌ (new event) | ❌ |
| `parsePrd()` annotation parsing | ❌ | ✅ Primary | ❌ | ❌ |
| `pauseRequested` mechanism | ✅ | ✅ | ✅ | ❌ |
| `extension.ts` checkpoint dialog | ✅ | ✅ | Needs new handler | ❌ |
| Dual exit gate | ✅ | ❌ | ❌ | ❌ |
| Stagnation detection | ✅ Relied upon | ❌ | ❌ | ❌ |

### Design Pattern: `[DECOMPOSED]` as Precedent

The `[DECOMPOSED]` annotation in `prd.ts` (line 26: `if (line.includes('[DECOMPOSED]')) { continue; }`) establishes the pattern for Approach B. It shows:
- PRD-inline annotations are already parsed
- They modify task handling without changing the checkbox syntax
- The pattern is simple string matching followed by behavioral modification

### Composability

Approaches A, B, and C are **not mutually exclusive**. A reasonable implementation path:
1. Start with **Approach B** (DSL checkpoint) for predictable, planned checkpoints.
2. Add **Approach A** (sentinel verifier) for external-system gating (e.g., CI/CD approval).
3. Add **Approach C** (agent escalation) for adaptive, runtime checkpointing.

Each layer addresses a different trigger source: user-declared (B), external-system (A), agent-detected (C).

---

## Applicability

### Recommendation Matrix

| Criterion | A: Sentinel | B: DSL | C: Escalation | D: Split PRD |
|-----------|:-----------:|:------:|:--------------:|:------------:|
| Implementation effort | Very Low | Low | Medium | Zero |
| Determinism | Medium | High | Low | High |
| User visibility | Low | High | Medium | High |
| Flexibility | Low | Medium | High | Low |
| Iteration waste | High (stagnation delay) | None | None | None |
| Composable with others | Yes | Yes | Yes | N/A |
| Requires model cooperation | No | No | Yes | No |

### Best Fit by Use Case

- **"I want checkpoints at specific PRD milestones"** → **Approach B** (DSL)
- **"I want external CI/CD gating"** → **Approach A** (sentinel)
- **"I want the agent to self-report when confused"** → **Approach C** (escalation)
- **"I just want to review between phases, no code changes"** → **Approach D** (split PRD)

### Ralph's Current Gap

The biggest gap is the **iteration waste** in the current `HumanCheckpointRequested` path. Today, checkpoints are only triggered reactively (after stagnation or diff failures exhaust retries). There is no proactive, user-declared checkpoint mechanism. **Approach B fills this gap most cleanly.**

---

## Open Questions

1. **Should `[CHECKPOINT]` pause _before_ or _after_ the annotated task completes?** Current design assumes after. An alternative: `[CHECKPOINT:pre]` could pause before execution, letting the user review the plan before the agent starts.

2. **Should Approach B strip `[CHECKPOINT]` from the description passed to the prompt?** If the annotation leaks into the Copilot prompt, the agent might interpret it as an instruction. The current analysis assumes stripping.

3. **For Approach C, what output pattern constitutes an escalation signal?** Options:
   - Structured marker: `[NEEDS_HUMAN: reason]`
   - Progress file entry: agent writes `ESCALATION: ...` to progress.txt
   - Exit code convention: strategy returns a special status
   
   All require changes to `strategies.ts` in addition to orchestrator/types.

4. **Should `Task.checkpoint` support values beyond boolean?** E.g., `checkpoint: 'review' | 'approve' | 'gate'` to differentiate checkpoint behaviors in the UI dialog.

5. **For Approach A, should sentinel verifier actively poll or only check at verification time?** Currently it would only check during the verification chain (after task execution). An active-poll variant would need orchestrator changes similar to Approach C.

6. **Can Approaches B + C be unified under a single `CheckpointConfig` type?** E.g., `{ source: 'prd' | 'agent' | 'sentinel', behavior: 'pause' | 'dialog' | 'gate' }` — this would simplify the event handling in extension.ts.
