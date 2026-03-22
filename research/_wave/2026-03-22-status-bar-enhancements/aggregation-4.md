## Aggregation Report 4

### Source Reports
- `research-10.md` finds that `_mergeAndRender()` already composes the status
  bar from precomputed segments, with retry data already exposed via
  `IRateTrackingService` and error counts available via `httpErrorCounter`; the
  least invasive enhancement is to add a compact total-error tag alongside the
  existing `⚠429` signal. [source: research-10.md#L5-L18]
  [source: research-10.md#L20-L42] [source: research-10.md#L46-L72]
  [source: research-10.md#L130-L156]
- `research-11.md` shows the active model label is set synchronously from
  `request.model.name` during `beginRequest()` and remains available throughout
  `Processing`; the likely reason it disappears is the Ralph-idle override
  branch omitting the model suffix on purpose. [source: research-11.md#L9-L10]
  [source: research-11.md#L13-L23] [source: research-11.md#L25-L70]
  [source: research-11.md#L98-L110] [source: research-11.md#L124-L134]
- `research-12.md` traces the auth flow from OAuth session to CAPI token to
  shared-token file and concludes that a status-bar token indicator is safe if
  it displays only the last 4 hex chars of a SHA-256 hash of the CAPI token,
  never raw token bytes or raw-token suffixes. [source: research-12.md#L19-L89]
  [source: research-12.md#L132-L192]

### Deduplicated Findings
1. The enhancement surface is already concentrated in `forkStatusBar` render
   composition. New inline status-bar data should be added by computing compact
   display segments in `_mergeAndRender()` and adjusting branch composition,
   rather than by adding new lifecycle or auth transport plumbing.
   [source: research-10.md#L5-L18] [source: research-10.md#L20-L42]
   [source: research-11.md#L72-L85] [source: research-12.md#L154-L180]
2. Retry visibility mostly exists today: `segment429` already exposes the 429
   count from `IRateTrackingService.get429Stats()`. The missing compact signal
   is total error volume, which can be derived from
   `httpErrorCounter.getCounts()`/`hasErrors()` and rendered as something like
   `E:<count>`. [source: research-10.md#L22-L29]
   [source: research-10.md#L46-L72] [source: research-10.md#L130-L156]
3. The active-request model name is not absent because of a race. During
   `Processing`, `beginRequest()` synchronously stores `request.model.name`,
   `activeModelLabel` returns that stored label, and `forkStatusBar` will render
   it whenever the active branch uses `modelSuffix`.
   [source: research-11.md#L9-L10] [source: research-11.md#L25-L70]
   [source: research-11.md#L72-L85] [source: research-11.md#L98-L122]
4. The most likely root cause of “empty model while spinning” is a deliberate
   render-policy branch: the Ralph-idle override suppresses the model label even
   while lifecycle status remains `Processing`. That means the fix target is the
   override branch or its precedence, not `RequestLifecycleModel`.
   [source: research-11.md#L124-L134]
   [source: research-10.md#L37-L42]
5. The auth/token pipeline is already well-defined and reactive: OAuth session
   acquisition leads to CAPI minting, the resulting token is stored in
   `CopilotTokenStore`, and the shared file is written atomically on update. A
   token indicator should reuse that path instead of creating a new storage or
   logging surface. [source: research-12.md#L19-L89]
6. Displaying the last 4 hex characters of `SHA-256(token.token)` is a safe way
   to expose a stable token fingerprint in the status bar. The reports strongly
   favor hash-then-truncate over any raw-token display and recommend
   `createSha256Hash(...).slice(-4)` as the implementation pattern.
   [source: research-12.md#L132-L192]
7. The reports are complementary, not contradictory: research 10 and 12 show
   the counters and token fingerprint can be derived from existing state, while
   research 11 overturns the initial suspicion of a missing model label and
   localizes the issue to a specific status-bar branch choice.
   [source: research-10.md#L130-L156]
   [source: research-11.md#L124-L134] [source: research-12.md#L154-L192]

### Cross-Report Patterns
- **Existing state is already available; visibility problems are mostly render
  decisions.** Counters, model labels, and token fingerprints can all be built
  from current services and state transitions, so enhancement work should stay
  close to the status-bar composition layer. [source: research-10.md#L5-L18]
  [source: research-11.md#L25-L85] [source: research-12.md#L19-L89]
- **Compact derived identifiers are the safe UX direction.** The reports favor
  short aliases and summaries (`E:n`, existing `⚠429:n`, short model alias,
  last-4 of SHA-256) over verbose or sensitive raw values in the status bar.
  [source: research-10.md#L120-L156] [source: research-11.md#L74-L96]
  [source: research-12.md#L154-L192]
- **Reactivity already exists, so most implementation risk is in branch
  selection and test coverage, not event wiring.** Counter updates already
  re-render, model labels are set before `Processing` events fire, and token
  persistence already updates through the current store/file flow.
  [source: research-10.md#L173-L179] [source: research-11.md#L100-L110]
  [source: research-12.md#L59-L89]

### Priority Matrix
| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Adjust the Ralph-idle `Processing` branch so active requests can still show the model alias, or otherwise narrow that override's precedence | High | Low | [source: research-11.md#L124-L134] [source: research-11.md#L72-L85] [source: research-10.md#L37-L42] |
| Add a compact total-error tag (for example `E:n`) into `rateSuffix` while keeping the existing `⚠429:n` retry signal | High | Low | [source: research-10.md#L46-L72] [source: research-10.md#L120-L156] |
| Add a token fingerprint derived from `createSha256Hash(token.token).slice(-4)` and never expose any raw token material | High | Low-Medium | [source: research-12.md#L132-L192] |
| Reuse the existing token store/shared-file path instead of inventing a second token distribution channel for the UI | Medium-High | Low | [source: research-12.md#L59-L89] |
| Keep status-bar changes localized to `_mergeAndRender()`/segment composition so enhancements remain small and reversible | Medium-High | Low | [source: research-10.md#L5-L18] [source: research-10.md#L20-L42] [source: research-11.md#L72-L85] |

### Gaps
- None of the reports measures real status-bar width or truncation behavior once
  model alias, billing/effort tags, counters, and a token fingerprint all appear
  together.
- No report defines regression tests for the Ralph-idle override case, compact
  error/retry formatting, or token-fingerprint refresh behavior after token
  rotation.
- The reports do not decide whether the verbose per-code `errorSegment` should
  move to tooltip-only display once a compact `E:n` segment is added inline.
- No report evaluates whether token hashing should be cached or memoized to
  avoid repeated async work during frequent renders.

### Sources
- `research-10.md` (Adding Error & Retry Counter Segments to Status Bar)
  - `/home/lkonga/codes/vscode-copilot-chat/research/_wave/2026-03-22-status-bar-enhancements/research-10.md`
- `research-11.md` (Why Model Name Shows Empty During Active Requests)
  - `/home/lkonga/codes/vscode-copilot-chat/research/_wave/2026-03-22-status-bar-enhancements/research-11.md`
- `research-12.md` (Authentication Token Flow & Security of Partial Hash Display)
  - `/home/lkonga/codes/vscode-copilot-chat/research/_wave/2026-03-22-status-bar-enhancements/research-12.md`
