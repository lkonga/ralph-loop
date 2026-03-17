# Checkpoint Retry Pattern

## Problem

Multi-phase pipelines (like `--ralph-prd`) run several subagent phases in sequence with human checkpoints between them. When a user wants to "go back" and retry a phase with different feedback, the pipeline needs to:

1. Know what inputs were used for each phase
2. Restore the pipeline to that phase's starting state
3. Append user feedback and re-run

Without persistent phase state, going back requires re-running the entire pipeline from scratch.

## Solution

Each phase writes a `phase-{N}-state.json` file capturing its inputs, outputs, user steering, and timestamp. Going back loads the target phase's state, clears all subsequent phases, and re-runs with appended user feedback.

### State File Location

```
research/_wave/{WAVE_ID}/phase-{N}-state.json
```

Where `WAVE_ID` follows the format `{date}-{topic-slug}` (e.g., `2026-03-15-auth-patterns`).

### State Schema

```typescript
interface PhaseState {
  waveId: string;
  phase: number;
  inputs: Record<string, unknown>;   // what the subagent received
  outputs: Record<string, unknown>;  // what the subagent produced
  userSteering: string | null;       // feedback from go-back, null on first run
  timestamp: number;                 // epoch ms
}
```

### Operations

| Operation | Description |
|-----------|-------------|
| `savePhase(waveId, phase, state)` | Write phase state after subagent completes |
| `loadPhase(waveId, phase)` | Read a specific phase's state |
| `listPhases(waveId)` | List all saved phase numbers (sorted) |
| `goBack(waveId, phase, feedback)` | Load phase N, clear phases > N, set userSteering |
| `clearWave(waveId)` | Remove all state for a wave |

### Go-Back Flow

```
User at Checkpoint 2 chooses [Back] → "Focus more on OAuth2"
  ↓
goBack(waveId, 1, "Focus more on OAuth2")
  ↓
1. Load phase-1-state.json (original inputs + outputs)
2. Delete phase-2-state.json, phase-3-state.json, etc.
3. Update phase-1-state.json with userSteering = "Focus more on OAuth2"
4. Return the updated state
  ↓
Pipeline re-runs Phase 1 subagent with:
  - Same inputs as before
  - userSteering appended to the prompt
```

## Usage in Wave Orchestrator

The `--ralph-prd` mode writes state at each phase transition:

```
Phase 0: Context Grounding  → savePhase(waveId, 0, { inputs: {workspace}, outputs: {contextBriefPath} })
Phase 1: Research Wave       → savePhase(waveId, 1, { inputs: {topic, n}, outputs: {finalReportPath} })
Checkpoint 1: [Back] triggers goBack(waveId, 0, feedback)
Phase 2: Spec Generation     → savePhase(waveId, 2, { inputs: {reportPath}, outputs: {specPath} })
Checkpoint 2: [Back] triggers goBack(waveId, 1, feedback)
Phase 3: Seal Spec           → savePhase(waveId, 3, ...)
Phase 4: PRD Generation      → savePhase(waveId, 4, ...)
Checkpoint 3: [Back] triggers goBack(waveId, 2, feedback)
Phase 5: Finalize            → savePhase(waveId, 5, ...)
```

## Relationship to SessionPersistence

This pattern generalizes `sessionPersistence.ts` from the ralph-loop orchestrator:

| Aspect | SessionPersistence | CheckpointStore |
|--------|-------------------|-----------------|
| Scope | Single session state | Per-phase state across a pipeline |
| Location | `.ralph/session.json` | `research/_wave/{WAVE_ID}/phase-{N}-state.json` |
| Granularity | One file for entire loop | One file per phase |
| Go-back | Resume from last state | Rewind to any phase |
| Atomic writes | Yes (tmp + rename) | Yes (tmp + rename) |

Both use the same atomic-write pattern (write to `.tmp`, then `rename`) to prevent corruption from interrupted writes.

## Implementation

Source: `src/checkpointRetry.ts`  
Tests: `test/checkpointRetry.test.ts`

The `CheckpointStore` class takes a workspace root path and manages all phase state files under `research/_wave/`.
