## Aggregation Report 3

### Source Reports

- `research-7.md` concludes that `agentName` and `agentId` already exist in
  `IChatAgentArgs`, flow into `ChatParticipantRequestHandler`, and should be
  added to `IRequestLifecycleModel.beginRequest()` so `forkStatusBar` can render
  agent or mode information during processing instead of waiting for result
  metadata. [source: research-7.md#L3-L5; research-7.md#L9-L58;
  research-7.md#L93-L113; research-7.md#L149-L186]
- `research-8.md` shows that `formatResultDetails()` is a zero-import,
  synchronous, pure formatter protected by CI; agent name and timestamp can be
  added only by extending `ResultDetailsInput` and passing already-available
  handler state into the single `result.details = formatResultDetails(...)`
  assignment. [source: research-8.md#L3-L44; research-8.md#L47-L69;
  research-8.md#L73-L137]
- `research-9.md` maps three existing telemetry or state surfaces —
  `HttpErrorCounter`, `RateTrackingService`, and `GlobalRateLimiterService` —
  and finds that the dropdown currently exposes only a subset of tracked error,
  retry, rate-limit, and queue data; it also flags split error-counting
  semantics. [source: research-9.md#L3-L95; research-9.md#L99-L180]

### Deduplicated Findings

1. The status-bar enhancement work is mostly a state-plumbing task, not a new
   data-collection task: agent identity already exists in request handling,
   footer input already receives completed-turn data, and retry or rate or
   error counters already exist in singleton or service state.
   [source: research-7.md#L3-L5; research-7.md#L9-L58;
   research-8.md#L9-L44; research-9.md#L3-L95]
2. Agent identity needs two complementary paths: `IRequestLifecycleModel` for
   live or in-flight status bar and tooltip rendering, and `ResultDetailsInput`
   for the post-response chat footer. Reading agent info only from completed
   result metadata is insufficient for `Processing` state.
   [source: research-7.md#L93-L130; research-7.md#L149-L186;
   research-8.md#L31-L44; research-8.md#L73-L85]
3. `participantIdToModeName()` gives a ready-made normalization step for
   turning participant IDs into stable user-facing mode labels (`ask`, `agent`,
   `edit`, `inline`) instead of surfacing raw IDs in the status bar.
   [source: research-7.md#L133-L147]
4. The chat footer has a hard purity contract: `formatResultDetails.ts` must
   stay zero-import, synchronous, and limited to the existing two exports,
   while `chatParticipantRequestHandler.ts` must keep a single direct
   `result.details = formatResultDetails(...)` assignment with no fetch,
   model, or title work in that region.
   [source: research-8.md#L47-L69]
5. Adding timestamp output is technically safe within that purity contract, but
   it introduces a policy choice: `toLocaleTimeString()` keeps the
   implementation minimal and pure, while a preformatted timestamp input is
   safer if deterministic tests or locale consistency matter.
   [source: research-8.md#L87-L107; research-8.md#L139-L147]
6. Error and retry UX currently spans two separate counter models:
   `HttpErrorCounter` tracks original 499 or 503 error events used by the live
   status bar and reset action, while `RateTrackingService` tracks all
   request-level 4xx or 5xx errors plus 429 breakdown and persistence. Because
   the two reset actions clear different stores, the dropdown can drift from
   user expectations unless the distinction is made explicit or the stores are
   unified.
   [source: research-9.md#L3-L28; research-9.md#L32-L80;
   research-9.md#L99-L120; research-9.md#L179-L180]
7. The highest-leverage dropdown enhancements are already backed by data:
   session request count, last 429 occurrence or retry-after or key, queue
   depth or throttle state, completed-turn billing or model details, Ralph task
   snapshot data, and possibly 503 retry attempts or circuit-breaker state with
   minor plumbing.
   [source: research-9.md#L124-L180]
8. There are no hard contradictions across the reports; the only meaningful
   design fork is timestamp formatting. Lifecycle plumbing and footer
   formatting solve different phases of the same request lifecycle and should be
   implemented together if the goal is consistent agent-aware UI.
   [source: research-7.md#L149-L186; research-8.md#L73-L147]

### Cross-Report Patterns

- **Surface already-available state before adding new instrumentation.** All
  three reports find existing state that can be reused directly: agent identity
  in request args, footer inputs in the request handler, and error or rate
  telemetry in existing services. This is high confidence because it appears
  across every report. [source: research-7.md#L3-L5; research-7.md#L149-L186;
  research-8.md#L31-L44; research-8.md#L73-L137;
  research-9.md#L3-L95; research-9.md#L124-L180]
- **Preserve current boundaries and contracts.** The recommended changes are
  small interface or input extensions rather than broad rewrites: extend
  `beginRequest()`, extend `ResultDetailsInput`, and expose more read-only
  service state in the dropdown. [source: research-7.md#L149-L196;
  research-8.md#L73-L158; research-9.md#L164-L180]
- **Different UI surfaces map to different lifecycle moments.** In-flight
  status bar text should bind to request lifecycle or service state, while
  completed chat footer text should bind to the immutable result-details
  formatter; the dropdown is the richer inspection surface for counters and
  context. [source: research-7.md#L116-L186; research-8.md#L9-L44;
  research-9.md#L99-L180]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
|---|---|---|---|
| Thread `agentName` and `agentId` into `IRequestLifecycleModel` and render a normalized mode or agent label in `forkStatusBar` | High | Low-Medium | [source: research-7.md#L93-L186] |
| Extend `formatResultDetails()` with `agentName` and optionally a timestamp while preserving the SR4 purity contract | Medium-High | Low | [source: research-8.md#L47-L158] |
| Expand the dropdown using already-tracked 429, queue, session-count, Ralph snapshot, and completed-turn data before adding new counters | High | Low-Medium | [source: research-9.md#L124-L180] |
| Clarify or unify `HttpErrorCounter` versus `RateTrackingService._errorCounts` so reset actions and displayed counts follow one user mental model | High | Medium | [source: research-9.md#L3-L80; research-9.md#L99-L180] |
| Expose retry-attempt and circuit-breaker state only after the existing counters are surfaced clearly | Medium | Medium | [source: research-9.md#L146-L180] |

### Gaps

- None of the reports defines a final combined status-bar grammar that shows
  agent or mode, model, billing, retry, and error information together across
  idle, processing, completed, error, and cancelled states; they identify
  plumbing points but stop short of a canonical text or tooltip spec.
  [source: research-7.md#L116-L186; research-8.md#L111-L137;
  research-9.md#L99-L180]
- Timestamp handling is not fully closed: the research identifies safe
  implementation options and test risks, but it does not settle localization,
  determinism, or whether no-auth users should also see agent or timestamp
  footer data. [source: research-8.md#L87-L147]
- The reports do not validate how the proposed lifecycle or footer or dropdown
  changes interact in tests end-to-end; they name likely test files or surfaces,
  but there is no combined verification matrix for chat footer, status bar
  text, tooltip, and dropdown behavior.
  [source: research-7.md#L188-L196; research-8.md#L150-L158;
  research-9.md#L99-L180]
- Retry semantics remain partially underspecified: `HttpErrorCounter` tracks
  original errors, while retry attempts and 499 circuit-breaker state need
  additional plumbing if they should be shown distinctly to users.
  [source: research-9.md#L21-L28; research-9.md#L146-L180]

### Sources

- `research-7.md` (Agent Name Tracking Through Request Lifecycle)
- `research-8.md` (`formatResultDetails()` Chat Pane Footer & SR4 Purity Contract)
- `research-9.md` (Error & Retry Counters — Data Model and Dropdown Expansion Opportunities)
