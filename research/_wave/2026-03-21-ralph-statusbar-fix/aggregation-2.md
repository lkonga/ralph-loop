## Aggregation Report 2

### Source Reports
- `research-4.md` finds that `ralph-loop.stop` does not update UI directly, `stop()` is fire-and-forget, `delay()` ignores abort, and terminal status updates can consume a stale `running` snapshot because `this.state` flips to `Idle` only in `start()`'s `finally`. [source: research-4.md#L9-L24] [source: research-4.md#L25-L43] [source: research-4.md#L67-L88] [source: research-4.md#L133-L171]
- `research-5.md` shows that `fireStateChangeNotification` pushes correct hardcoded terminal states, but the fork status bar has two uncoordinated writers (`RequestLifecycleModel` and Ralph-loop snapshot updates), so a later lifecycle `Processing` write can overwrite a correct Ralph `idle` push. [source: research-5.md#L9-L28] [source: research-5.md#L29-L46] [source: research-5.md#L111-L132]
- `research-6.md` confirms that `ralph-loop.status` simply returns live `this.state`, while `updateStatusBar` is driven by snapshots captured before `finally`, creating the visual-vs-command disconnect; it also notes missing idle refreshes on auto-resume and an unused `showStatusBarIdle()` helper. [source: research-6.md#L9-L25] [source: research-6.md#L26-L46] [source: research-6.md#L62-L120]

### Deduplicated Findings
1. The exact `"processing"` text mismatch is primarily a fork-layer bug: the fork status bar lets `RequestLifecycleModel` and Ralph-loop snapshot updates race, so a later lifecycle `Processing` write can replace a correct Ralph `idle` push and leave the UI saying `processing` while the command reports `idle`. [source: research-5.md#L111-L132] [source: research-5.md#L180-L194]
2. Ralph-loop has a separate stale-snapshot bug: terminal events call `updateStatusBar(orchestrator.getStateSnapshot())` before `start()`'s `finally` sets `this.state = Idle`, so Ralph's own status UI can freeze on `running`/spinner while `ralph-loop.status` later returns `idle`. [source: research-4.md#L133-L171] [source: research-6.md#L47-L102]
3. `fireStateChangeNotification` is not the broken part for terminal states; it sends hardcoded `Idle`/`Paused`/`Running` payloads directly, so the fork receives the correct idle push even when Ralph-loop's own snapshot is stale. [source: research-5.md#L9-L28] [source: research-5.md#L29-L82]
4. Stop propagation can be delayed, which increases perceived desync but does not fully explain the literal `"processing"` label: `stop()` emits no immediate event, `delay()` does not wake on abort, and `executionStrategy.execute()` may hold the loop until a long await completes. [source: research-4.md#L25-L43] [source: research-4.md#L67-L88] [source: research-4.md#L107-L132]
5. The reports are complementary, not contradictory: `research-5` explains the user-visible `"processing"` label in the fork, while `research-4` and `research-6` explain why Ralph's own status snapshot and `ralph-loop.status` command can diverge around terminal events. [source: research-5.md#L121-L132] [source: research-4.md#L133-L171] [source: research-6.md#L62-L102]
6. The most robust fix is layered: add fork-side precedence/merge logic so Ralph `idle` is authoritative over lifecycle `processing`, and fix Ralph-loop to transition to `Idle` before terminal snapshot reads or force a post-finally idle refresh; wire the same refresh through auto-resume and treat abort-aware waits as hardening. [source: research-5.md#L192-L194] [source: research-6.md#L129-L135] [source: research-4.md#L174-L201]

### Cross-Report Patterns
- **Terminal events expose stale state in Ralph-loop.** Multiple reports show that status consumers read or log `this.state` before `start()`'s `finally` flips it to `Idle`, which makes terminal snapshots and telemetry misleading during shutdown. [source: research-4.md#L133-L171] [source: research-5.md#L66-L82] [source: research-6.md#L62-L102]
- **The command/result split comes from different data paths.** `ralph-loop.status` reads live orchestrator state, while status bar rendering depends on pushed snapshots or UI event handlers that can lag, race, or be overwritten. [source: research-5.md#L111-L132] [source: research-6.md#L9-L46]
- **The fix direction converges on explicit idle signaling plus clear writer precedence.** Report 4 wants earlier idle state and abort-aware stop handling; report 5 wants fork-side merge/priority; report 6 wants early idle or a post-finally idle refresh with auto-resume parity. [source: research-4.md#L174-L201] [source: research-5.md#L192-L194] [source: research-6.md#L129-L135]

### Priority Matrix
| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Add fork-side precedence/merge logic so Ralph `idle` cannot be overwritten by lifecycle `processing` | High | Medium | [source: research-5.md#L111-L132] [source: research-5.md#L192-L194] |
| Set Ralph-loop state to `Idle` before yielding terminal events, so snapshot-based UI updates are truthful | High | Low | [source: research-4.md#L133-L171] [source: research-4.md#L174-L176] [source: research-6.md#L129-L135] |
| Force a post-finally idle refresh (`showStatusBarIdle()` / `updateStatusBar(...)`) after `await orchestrator.start()` and on auto-resume | Medium-High | Low | [source: research-6.md#L103-L120] [source: research-6.md#L133-L135] |
| Make waits abort-aware and review blocking execute paths to reduce stop-latency windows | Medium | Medium | [source: research-4.md#L67-L88] [source: research-4.md#L121-L132] [source: research-4.md#L191-L201] |
| Reintroduce a reconciliation or polling fallback only if push+merge still leaves edge-case drift | Medium | Medium | [source: research-5.md#L135-L145] [source: research-5.md#L186-L193] |

### Gaps
- None of the reports includes a live runtime trace with timestamps showing the exact ordering between Ralph's idle push and `RequestLifecycleModel` `Processing`; the fork race is well-supported by structure, but not yet instrumented.
- None verifies whether `executionStrategy.execute()` actually honors the abort signal, so stop-latency severity remains unmeasured.
- No report defines regression tests for fork precedence, terminal-state snapshot correctness, or auto-resume cleanup.

### Sources
- `research-4.md` (Does `ralph-loop.stop` Update the Status Bar?)
- `research-5.md` (`fireStateChangeNotification` Timing, Push/Poll Interaction, and Stuck `"Processing"` Bug)
- `research-6.md` (`ralph-loop.status` Command vs `updateStatusBar` — State Disconnect)
