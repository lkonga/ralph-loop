## Aggregation Report 1

### Source Reports
- `research-1.md` — Maps the timing bug: the only transition to `Idle` happens in `LoopOrchestrator.start()`'s `finally`, after terminal events have already triggered `updateStatusBar(getStateSnapshot())`; also notes `statusBar.ts` only hides on an idle snapshot and highlights the unused `showStatusBarIdle()` helper. [source: research-1.md#L8-L26] [source: research-1.md#L27-L43] [source: research-1.md#L44-L78] [source: research-1.md#L90-L115]
- `research-2.md` — Confirms the dual-path inconsistency: terminal handlers call `fireStateChangeNotification(Idle, ...)` but also call `updateStatusBar(orchestrator.getStateSnapshot())` while the live internal state is still `Running`; compares three fix options. [source: research-2.md#L16-L32] [source: research-2.md#L33-L49] [source: research-2.md#L50-L113] [source: research-2.md#L126-L138]
- `research-3.md` — Expands the analysis to abnormal and uncovered exits: `BranchEnforcementFailed`, `PrdValidationFailed`, uncaught exceptions, and the resumed-session path can all miss a final Ralph status bar refresh; recommends a guaranteed post-`start()` idle update plus targeted handler backfills. [source: research-3.md#L9-L32] [source: research-3.md#L46-L97] [source: research-3.md#L109-L149] [source: research-3.md#L180-L197] [source: research-3.md#L213-L252]

### Deduplicated Findings
1. The root cause is a timing mismatch: `LoopState.Idle` is assigned only in `LoopOrchestrator.start()`'s `finally`, after terminal events have already been handed to the extension callback, so `updateStatusBar(orchestrator.getStateSnapshot())` renders stale `running/processing` state even though later status reads return `idle`. [source: research-1.md#L8-L26] [source: research-1.md#L44-L78] [source: research-2.md#L33-L49] [source: research-2.md#L50-L113] [source: research-3.md#L180-L197]
2. The observed discrepancy exists because the system has two state channels: `fireStateChangeNotification` hardcodes `Idle` for terminal events, while the Ralph status bar reads the live orchestrator snapshot. That split lets the status command and any idle notification consumers report `idle` while the Ralph status bar remains stuck on `processing`. [source: research-2.md#L16-L32] [source: research-2.md#L91-L125] [source: research-1.md#L27-L43]
3. The normal terminal handlers are insufficient even when they do update the bar: `AllDone`, `MaxIterations`, `YieldRequested`, and `Stopped` call `updateStatusBar`, but they do so before the idle transition, so each can still publish a stale `running` snapshot. [source: research-1.md#L27-L43] [source: research-1.md#L44-L78] [source: research-2.md#L16-L32] [source: research-2.md#L50-L90]
4. Some exit paths skip a Ralph status bar refresh entirely. `BranchEnforcementFailed` and `PrdValidationFailed` do not drive a final Ralph status bar update, and an uncaught exception in `runLoop()` also falls through to `start()`'s `finally` without any UI notification, leaving the stale bar visible indefinitely. [source: research-1.md#L79-L89] [source: research-3.md#L46-L97] [source: research-3.md#L109-L149] [source: research-3.md#L180-L197]
5. `statusBar.ts` can only hide when it receives an idle snapshot with no task id, so a missed final idle refresh guarantees persistent stale UI instead of a self-healing bar. [source: research-1.md#L90-L102]
6. Contradiction resolved on the fix strategy: `research-1` prefers emitting a final orchestrator event, `research-2` prefers surgical idle overrides in terminal handlers, and `research-3` prefers a guaranteed idle refresh after `await orchestrator.start()` settles. The most comprehensive fix is the caller-side guaranteed idle refresh because it covers normal completion, early returns, and crashes; missing-handler updates or terminal idle overrides should be added as defense-in-depth, not as the only fix. [source: research-1.md#L139-L151] [source: research-2.md#L126-L138] [source: research-3.md#L213-L240]
7. The resumed-session path is a separate parity risk: its event callback only logs resumed events and never updates the Ralph status bar, so resume flows should be audited alongside the primary fix. [source: research-3.md#L241-L252]

### Cross-Report Patterns
- **High confidence:** The final `Idle` transition happens after event-driven UI updates, so terminal-event snapshots are stale by construction. This appears in all three reports and is the clearest shared root-cause statement. [source: research-1.md#L44-L78] [source: research-2.md#L50-L113] [source: research-3.md#L180-L197]
- **High confidence:** The bug is caused by split state propagation: idle notifications and Ralph status bar rendering do not use the same source of truth. This pattern is explicit in `research-2` and implied by the event tables in `research-1`. [source: research-2.md#L91-L125] [source: research-1.md#L27-L43]
- **High confidence:** A guaranteed post-`start()` idle refresh is the highest-coverage mitigation because it also catches abnormal exits and crashes; multiple reports propose this directly or as the fastest safe path. [source: research-1.md#L139-L143] [source: research-2.md#L126-L138] [source: research-3.md#L213-L232]
- **Medium confidence:** Handler coverage is incomplete beyond the main happy-path terminal events, especially for `BranchEnforcementFailed`, `PrdValidationFailed`, crash paths, and resume flows. [source: research-1.md#L79-L89] [source: research-3.md#L46-L97] [source: research-3.md#L109-L149] [source: research-3.md#L241-L252]

### Priority Matrix
| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Add a guaranteed idle refresh after `await orchestrator.start()` settles in `extension.ts` | High | Low | [source: research-1.md#L139-L143], [source: research-2.md#L126-L138], [source: research-3.md#L213-L232] |
| Backfill missing Ralph status bar updates for `BranchEnforcementFailed`, `PrdValidationFailed`, and crash handling | High | Low-Medium | [source: research-1.md#L79-L89], [source: research-3.md#L46-L97], [source: research-3.md#L109-L149], [source: research-3.md#L233-L240] |
| Unify final idle notification at the orchestrator layer (emit a final event after state reset) | Medium-High | Medium | [source: research-1.md#L145-L151], [source: research-2.md#L126-L137] |
| Audit and align resumed-session status bar updates | Medium | Low | [source: research-3.md#L241-L252] |
| Optional: override terminal-event snapshots to `idle` for cosmetic immediacy | Medium | Low | [source: research-2.md#L126-L138] |

### Gaps
- Only `research-3` examined the resumed-session callback, so resume-path behavior is still under-investigated relative to the main bug report and should be validated after the primary fix lands. [source: research-3.md#L241-L252]
- The report set recommends fixes but does not define regression tests for normal completion, abnormal early-return paths, or crash recovery, so validation criteria still need to be written. [source: research-1.md#L139-L151] [source: research-2.md#L126-L138] [source: research-3.md#L213-L252]
- The reports explain why `ralph-loop.status` can read `idle`, but they do not fully trace repeated-run behavior after the orchestrator completes, so implementation should verify command/bar consistency across consecutive runs. [source: research-1.md#L66-L78] [source: research-2.md#L99-L113]

### Sources
- `research-1.md` — *State→Idle Transition vs `updateStatusBar` Timing*
- `research-2.md` — *Terminal Event Timing — `updateStatusBar` vs State Reset*
- `research-3.md` — *Exit Paths Missing Status Bar Updates*
