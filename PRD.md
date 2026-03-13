# Ralph Loop V2 — Phase 1 Self-Fix PRD

> Being executed BY ralph-loop ON itself.
> Run `npx tsc --noEmit` after each change. Run `npx vitest run` if test files change.

## Tasks

- [ ] In `src/prompt.ts`: Add a new section to the prompt output. After the "YOUR TASK TO IMPLEMENT" banner and task description, before the "MANDATORY" section, insert a block titled "ROLE & BEHAVIOR" containing: "You are an autonomous coding agent. Complete the task below by editing files directly. If you encounter errors, debug and fix them — do not stop. If tests fail, fix the tests or the code. When done, mark the checkbox in PRD.md and append what you did to progress.txt. Do not ask questions — act." Run `npx tsc --noEmit` and `npx vitest run` to verify — update test expectations in `test/copilot.test.ts` if they fail due to changed output format. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

- [ ] In `src/prompt.ts`: Modify the `buildPrompt` function to accept a 4th optional parameter `maxProgressLines: number = 20`. When progressContent has more lines than maxProgressLines, keep only the LAST maxProgressLines lines and prepend a summary line like `[...N earlier entries omitted]`. This prevents the prompt from growing unboundedly as progress.txt grows. Run `npx tsc --noEmit` and `npx vitest run` — add a new test in `test/copilot.test.ts` that verifies truncation with 30 lines of progress. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

- [ ] In `src/prompt.ts`: Change how PRD content is shown in the prompt. Instead of including the FULL PRD file content, filter it to show only unchecked task lines (lines matching `- [ ]`) plus a summary header like `Progress: N/M tasks completed`. Keep the markdown code fence wrapper. This reduces context waste since completed tasks aren't relevant. Run `npx tsc --noEmit` and `npx vitest run` — update tests in `test/copilot.test.ts` that check for PRD content format. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.

- [ ] Add a file `src/prompt.test.ts` (or use the existing `test/copilot.test.ts`) to add a test that verifies `buildPrompt` includes the "ROLE & BEHAVIOR" section in its output. Also add a test that when given 30 lines of progress content, the output contains `[...10 earlier entries omitted]` (since default maxProgressLines is 20). Also add a test that checked PRD lines (`- [x]`) are NOT included in the output but unchecked ones are. Run `npx vitest run` to verify all tests pass. Mark this checkbox [x] in PRD.md and append to progress.txt what you did.
