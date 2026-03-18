# Phase 15 — Annotation Strictness Spec

## Problem

In `src/prd.ts` lines 56-57, the parser uses naive `line.includes('[DECOMPOSED]')` and `line.includes('[CHECKPOINT]')` to detect annotation tags. This matches the tag **anywhere** in the line — including inside task description text that merely references the tag. Result: any task that discusses `[DECOMPOSED]` in its description gets silently skipped by the parser.

## Root Cause

Annotations like `[DECOMPOSED]` and `[CHECKPOINT]` must only be recognized when they appear in the **annotation position** — immediately after the checkbox markup (`- [ ] ` or `- [x] `), before the task body. The current `includes()` check has no positional awareness.

## Task 104 — Fix naive annotation substring matching

1. In `src/prd.ts` line 56, replace:
   ```ts
   if (line.includes('[DECOMPOSED]')) { continue; }
   ```
   with a regex anchored to annotation position:
   ```ts
   if (/^-\s*\[[ x]\]\s*\[DECOMPOSED\]/i.test(line)) { continue; }
   ```

2. In `src/prd.ts` line 57, replace:
   ```ts
   const isCheckpoint = line.includes('[CHECKPOINT]');
   ```
   with:
   ```ts
   const isCheckpoint = /^-\s*\[[ x]\]\s*(?:\[DECOMPOSED\]\s*)?\[CHECKPOINT\]/i.test(line);
   ```
   (CHECKPOINT may appear after DECOMPOSED in theory, but the DECOMPOSED line is skipped first, so simpler regex is fine:)
   ```ts
   const isCheckpoint = /^-\s*\[[ x]\]\s*\[CHECKPOINT\]/i.test(line);
   ```

3. Add tests in `test/prd.test.ts`:
   - `- [ ] [DECOMPOSED] Original task` → skipped (not in parsed output)
   - `- [x] [DECOMPOSED] Original task` → skipped
   - `- [ ] **Task N — Fix the [DECOMPOSED] detection**:` → NOT skipped, parsed normally
   - `- [ ] [CHECKPOINT] Gate task` → checkpoint=true
   - `- [ ] **Task N — Fix the [CHECKPOINT] detection**:` → checkpoint=false, parsed normally

4. Run `npx tsc --noEmit && npx vitest run` — all tests must pass.

## Task 105 — Extract annotation parser helper

After Task 104, extract annotation detection into a helper:

```ts
function parseLineAnnotations(line: string): { decomposed: boolean; checkpoint: boolean } {
    const decomposed = /^-\s*\[[ x]\]\s*\[DECOMPOSED\]/i.test(line);
    const checkpoint = /^-\s*\[[ x]\]\s*\[CHECKPOINT\]/i.test(line);
    return { decomposed, checkpoint };
}
```

- Use this helper in the main parsing loop
- Unit test the helper directly with edge cases
- Run `npx tsc --noEmit && npx vitest run`

## Task 106 — End-to-end verification

After Tasks 104-105 are done, add a regression test that parses a PRD containing a task whose description text mentions `[DECOMPOSED]` and `[CHECKPOINT]` — verify it appears in the parsed output and is not skipped or incorrectly flagged.
