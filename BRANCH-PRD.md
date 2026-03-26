# BRANCH PRD — Hybrid Checkpoint Lock

> Branch: `feat/hybrid-checkpoint-lock`
> Purpose: isolate and refine the minimal hybrid verification lock hotfix before anything lands on `master`.
> Status: the core lock-gate hotfix is implemented on this branch; the remaining tasks below are branch-local refinement and validation work.

## Goal

When `hybridVerification.enabled` is on, Ralph must:

1. complete a task,
2. commit the task,
3. create a verification lock file,
4. stop and wait,
5. continue only after an external verifier or human removes that lock file.

This branch intentionally covers only the **minimal usable lock-file gate**. It does **not** attempt full built-in multi-agent orchestration yet.

## Tasks

- [x] **Task 1 — Minimal hybrid verification gate hotfix**: Add branch-local support for `hybridVerification.enabled`, `hybridVerification.lockFilePath`, and `hybridVerification.pollIntervalMs`. After successful task commit, create a lock file and wait until it is removed before continuing. Persist enough state to re-enter the wait on resume. Conservatively disable parallel batching while this mode is enabled.

- [ ] **Task 2 — Real workflow canary on a non-trivial PRD**: Run Ralph on a realistic multi-task PRD with `hybridVerification.enabled=true`. Verify the loop stops after commit, creates the lock file in `.ralph/`, resumes only after external deletion, and does not accidentally advance on restart, yield, or stop.

- [ ] **Task 3 — Operator UX and docs pass**: Add a short branch-local workflow note covering: where the lock file appears, who removes it, what the expected waiting state looks like, and how to recover from stale locks. Keep this focused on immediate usability rather than long-term architecture.

- [ ] **Task 4 — Decide branch fate after canary**: After the canary, decide whether to: (a) keep this branch as a longer-lived refinement lane, (b) split follow-up work into smaller branches, or (c) promote the hotfix to a cleaner PR after additional testing.