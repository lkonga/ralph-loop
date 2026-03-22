# Final Report: Status Bar Enhancements

## Executive Summary
- The wave converges on a simple conclusion: most desired status-bar improvements do **not** need new backend instrumentation; the data already exists in lifecycle, auth, rate, and result-formatting surfaces.
- The biggest false lead was the idea that the model name is missing during `Processing` because of a race; the research shows it is already set synchronously and usually disappears only when the Ralph-idle override chooses a simplified render branch.
- The safest first wins are presentation and composition fixes: clarify compact tags like `STD`, preserve the model alias during active requests, and expose already-tracked 429/error/session/limiter/model metadata in the tooltip.
- For security-sensitive observability, runtime UI should read from DI services, not the shared token file; any token hint should be the last 4 hex chars of a SHA-256 digest, never raw token bytes or raw suffixes.
- Agent/mode identity needs two paths: request lifecycle state for live/in-flight rendering and `formatResultDetails()` input for completed-turn footer rendering.
- Error and retry data already exist, but the UX is split across two counter models; a compact inline `E:n` tag is low risk, while semantic cleanup of the two stores is the larger follow-up.
- `interactionId.slice(-4)` is a viable short debug hint; `X-Initiator` is less trustworthy as user-visible truth because it is classification-derived and may be stripped by BYOK forwarding.
- The recommended implementation order is: tooltip/semantic clarity, processing-model preservation, compact error surfacing, agent/mode lifecycle plumbing, then secure identifier hints and counter-model cleanup.

## Consolidated Findings

### Render composition and state ownership
- The enhancement surface is already concentrated in `forkStatusBar` composition plus a few narrow interface extensions; across the wave, the strongest pattern is to reuse current state rather than add new collectors or transport layers. [via: aggregation-3.md#L23-L72 ← research-7.md#L3-L5] [via: aggregation-4.md#L65-L82 ← research-10.md#L5-L18]
- The active-request model label is already available during `Processing`; when it appears empty, the likely cause is the Ralph-idle override branch suppressing `modelSuffix`, not a lifecycle race or missing request data. [via: aggregation-2.md#L9-L19 ← research-4.md#L44-L82] [via: aggregation-4.md#L23-L64 ← research-11.md#L124-L134]

### Tooltip clarity and compact semantics
- The tooltip already has a substantial baseline surface and is the safest place to resolve compact-token confusion without overcrowding the inline text: expand `STD/DEF/DLG`, explain requested vs resolved model identity, and add high-value metrics already present in existing services. [via: aggregation-2.md#L9-L19 ← research-5.md#L5-L23] [via: aggregation-2.md#L20-L26 ← research-6.md#L124-L137]
- `STD` means **Standard** billing behavior for the `'default'` mode; the confusion is linguistic, not computational, because the mapping is already consistent across the status bar and chat footer. [via: aggregation-2.md#L9-L19 ← research-6.md#L5-L24] [via: aggregation-2.md#L20-L26 ← research-6.md#L28-L60]
- The highest-leverage tooltip additions are zero- or low-plumbing signals already tracked today: 429 breakdowns, HTTP error counts, global limiter state, total session requests, provider/raw/resolved model identity, and premium-tier metadata. [via: aggregation-2.md#L9-L19 ← research-5.md#L26-L58] [via: aggregation-2.md#L27-L35 ← research-5.md#L147-L170]

### Secure runtime observability
- Live UI state should come from DI-managed runtime services (`IAuthenticationService`, `ICopilotTokenStore`, `IInteractionService`), while the shared token file should be treated as a persistence/exposure surface rather than the primary UI source of truth. [via: aggregation-1.md#L9-L20 ← research-1.md#L23-L39] [via: aggregation-1.md#L21-L25 ← research-2.md#L136-L172]
- If the UI shows a token hint, it should use `createSha256Hash(token).slice(-4)` for both OAuth and CAPI tokens; the reports explicitly reject raw-token suffixes as a display policy. [via: aggregation-1.md#L9-L20 ← research-1.md#L84-L165] [via: aggregation-4.md#L23-L64 ← research-12.md#L132-L192]
- `interactionId.slice(-4)` is a low-risk debugging hint that fits the existing render cycle, but `X-Initiator` should be treated only as a local classification clue because billing logic can modify it and BYOK endpoints may strip it before forwarding. [via: aggregation-1.md#L9-L20 ← research-3.md#L10-L56] [via: aggregation-1.md#L27-L36 ← research-3.md#L121-L164]

### Lifecycle identity and footer enrichment
- Agent or mode identity needs two complementary paths: request lifecycle state for in-flight status-bar rendering, and `ResultDetailsInput` for completed-turn footer rendering. Reading only completed result metadata cannot solve `Processing`-state visibility. [via: aggregation-3.md#L23-L72 ← research-7.md#L93-L186] [via: aggregation-3.md#L23-L72 ← research-8.md#L73-L137]
- `participantIdToModeName()` is the ready-made normalization layer for stable user-facing labels, while `formatResultDetails()` must remain zero-import, synchronous, and minimal even if it gains `agentName` and an optional timestamp. [via: aggregation-3.md#L23-L72 ← research-7.md#L133-L147] [via: aggregation-3.md#L23-L72 ← research-8.md#L47-L69]

### Error, retry, and counter semantics
- Retry visibility already exists inline via `⚠429`; the next compact inline improvement is a total-error tag such as `E:n`, with richer per-code or retry-detail diagnostics left in the dropdown/tooltip. [via: aggregation-4.md#L23-L64 ← research-10.md#L46-L72] [via: aggregation-4.md#L83-L91 ← research-10.md#L130-L156]
- The larger design issue is semantic drift between `HttpErrorCounter` and `RateTrackingService`: they count different events, reset differently, and can therefore diverge from user expectations unless the distinction is explained or the UI model is unified. [via: aggregation-3.md#L23-L72 ← research-9.md#L3-L80] [via: aggregation-3.md#L94-L103 ← research-9.md#L99-L180]

## Pattern Catalog

| Pattern | Implementation details | Sources |
|---|---|---|
| Preserve model alias during `Processing` | Narrow the Ralph-idle override or its precedence so active requests can continue to append `modelSuffix` while spinning. | [via: aggregation-4.md#L83-L91 ← research-11.md#L124-L134] [via: aggregation-2.md#L9-L19 ← research-4.md#L135-L145] |
| Clarify compact semantics in tooltip | Expand `STD/DEF/DLG`, explain requested vs resolved model, and pair friendly labels with provider/raw metadata where useful. | [via: aggregation-2.md#L27-L35 ← research-6.md#L124-L137] [via: aggregation-2.md#L27-L35 ← research-5.md#L147-L170] |
| Add compact error summary | Keep `⚠429:n`, add `E:n`, and consider moving verbose per-code error strings to tooltip-only if width becomes tight. | [via: aggregation-4.md#L83-L91 ← research-10.md#L130-L156] [via: aggregation-4.md#L92-L103 ← research-10.md#L130-L156] |
| Thread live agent/mode into lifecycle state | Extend `IRequestLifecycleModel.beginRequest()` with `agentName`/`agentId` and normalize display labels through `participantIdToModeName()`. | [via: aggregation-3.md#L94-L103 ← research-7.md#L93-L186] |
| Enrich completed-turn footer without breaking purity | Extend `ResultDetailsInput` only; keep `formatResultDetails()` zero-import, synchronous, and policy-light. Preformat timestamps upstream if determinism matters. | [via: aggregation-3.md#L94-L103 ← research-8.md#L47-L69] [via: aggregation-3.md#L23-L72 ← research-8.md#L87-L147] |
| Use secure token fingerprints | Read runtime token state from DI services and display only `createSha256Hash(token).slice(-4)`; never emit raw token material. | [via: aggregation-1.md#L27-L36 ← research-1.md#L84-L165] [via: aggregation-4.md#L83-L91 ← research-12.md#L132-L192] |
| Surface interaction suffix as a lightweight trace hint | Inject `IInteractionService` into the status-bar contribution and append `interactionId.slice(-4)` during existing render cycles. | [via: aggregation-1.md#L27-L36 ← research-3.md#L121-L164] |
| Reconcile counter mental models | Either explicitly label the difference between original HTTP errors and request-level error counts, or unify the user-facing store and reset behavior. | [via: aggregation-3.md#L94-L103 ← research-9.md#L99-L180] |

## Priority Matrix

| Item | Impact | Effort | Priority | Sources |
|---|---|---|---|---|
| Clarify tooltip semantics and abbreviations (`STD/DEF/DLG`, requested vs resolved model, override behavior) | High | Low | P1 | [via: aggregation-2.md#L27-L35 ← research-4.md#L98-L145] [via: aggregation-2.md#L27-L35 ← research-6.md#L124-L137] |
| Preserve model alias during active `Processing` by narrowing Ralph-idle override precedence | High | Low | P1 | [via: aggregation-4.md#L83-L91 ← research-11.md#L124-L134] |
| Expose zero-plumbing tooltip metrics and add compact inline `E:n` alongside `⚠429:n` | High | Low-Medium | P1 | [via: aggregation-2.md#L27-L35 ← research-5.md#L26-L58] [via: aggregation-4.md#L83-L91 ← research-10.md#L46-L72] |
| Thread `agentName`/`agentId` into request lifecycle state for live mode/agent display | High | Low-Medium | P1 | [via: aggregation-3.md#L94-L103 ← research-7.md#L93-L186] |
| Add secure token fingerprint and optional interaction suffix using runtime DI state | Medium-High | Low-Medium | P2 | [via: aggregation-1.md#L27-L36 ← research-1.md#L84-L165] [via: aggregation-1.md#L27-L36 ← research-3.md#L121-L164] [via: aggregation-4.md#L83-L91 ← research-12.md#L132-L192] |
| Clarify or unify `HttpErrorCounter` vs `RateTrackingService` semantics | High | Medium | P2 | [via: aggregation-3.md#L94-L103 ← research-9.md#L99-L180] |
| Extend chat footer result details with agent name and optional timestamp | Medium-High | Low | P3 | [via: aggregation-3.md#L94-L103 ← research-8.md#L73-L158] |

## Recommended Plan
1. **Define the display grammar first.** Lock tooltip copy and inline abbreviations for billing, model identity, and agent/mode labeling so later code changes target a stable UX contract. Depends on: none. [via: aggregation-2.md#L20-L35 ← research-6.md#L124-L137]
2. **Fix the misleading `Processing` experience.** Narrow the Ralph-idle override so active requests retain the model alias while spinning. Depends on: step 1 display grammar. [via: aggregation-4.md#L23-L64 ← research-11.md#L124-L134]
3. **Improve observability with existing counters.** Add inline `E:n`, keep `⚠429:n`, and expose the already-tracked 429/error/session/limiter/model metadata in the tooltip. Depends on: step 1 copy decisions. [via: aggregation-2.md#L9-L19 ← research-5.md#L26-L58] [via: aggregation-4.md#L23-L64 ← research-10.md#L46-L72]
4. **Thread live agent/mode identity through lifecycle state.** Extend `beginRequest()` inputs and render normalized mode/agent labels from the live lifecycle model. Depends on: step 1 label decisions. [via: aggregation-3.md#L23-L72 ← research-7.md#L93-L186]
5. **Align completed-turn details with live state.** Extend `ResultDetailsInput` with `agentName` and decide whether timestamps are locale-formatted at render time or preformatted upstream. Depends on: step 4 for consistent naming. [via: aggregation-3.md#L23-L72 ← research-8.md#L87-L147]
6. **Add secure identifier hints.** Surface hashed token fingerprints and optionally the last 4 chars of `interactionId`, sourced from DI services and guarded by an explicit display policy. Depends on: step 1 security/display decisions. [via: aggregation-1.md#L9-L20 ← research-1.md#L84-L165] [via: aggregation-4.md#L23-L64 ← research-12.md#L132-L192]
7. **Resolve counter-model drift.** Either document the two error stores clearly in the dropdown or converge them to a single user-facing mental model. Depends on: step 3 so the currently-hidden data is visible before semantics are changed. [via: aggregation-3.md#L23-L72 ← research-9.md#L99-L180]

## Gaps & Further Research
- No aggregation defines a final, width-tested status-bar grammar that combines model, billing, agent/mode, retry, error, and identifier hints across idle, processing, completed, error, and cancelled states. [via: aggregation-3.md#L104-L126 ← research-7.md#L116-L186] [via: aggregation-4.md#L92-L103 ← research-10.md#L130-L156]
- Token fingerprint hashing has not been benchmarked or memoized for frequent render cycles, and the reports do not settle whether secure-display/screen-share modes should suppress these identifiers. [via: aggregation-1.md#L37-L44 ← research-1.md#L84-L165] [via: aggregation-4.md#L92-L103 ← research-12.md#L132-L192]
- No end-to-end verification matrix covers sign-in/out, CAPI token rotation, BYOK vs GitHub forwarding, Ralph-idle processing overrides, tooltip rendering, and dropdown resets together. [via: aggregation-1.md#L37-L44 ← research-2.md#L164-L172] [via: aggregation-3.md#L104-L126 ← research-9.md#L99-L180] [via: aggregation-4.md#L92-L103 ← research-11.md#L124-L134]
- Timestamp policy is still unresolved: locale-sensitive formatting is easy, but determinism and test stability may require preformatted input. [via: aggregation-3.md#L104-L126 ← research-8.md#L87-L147]
- The wave does not decide whether verbose per-code error output should remain inline once a compact `E:n` tag exists, or move fully into tooltip/dropdown surfaces. [via: aggregation-4.md#L92-L103 ← research-10.md#L130-L156]

## Source Chain
- `aggregation-1.md` → `research-1.md`, `research-2.md`, `research-3.md` (token exposure/safe hashing, OAuth session flow, interaction/initiator tracing). [via: aggregation-1.md#L45-L48 ← research-1.md#L23-L39] [via: aggregation-1.md#L45-L48 ← research-2.md#L42-L97] [via: aggregation-1.md#L45-L48 ← research-3.md#L8-L56]
- `aggregation-2.md` → `research-4.md`, `research-5.md`, `research-6.md` (processing model rendering, tooltip data surfaces, billing-tag meaning). [via: aggregation-2.md#L43-L46 ← research-4.md#L44-L82] [via: aggregation-2.md#L43-L46 ← research-5.md#L26-L58] [via: aggregation-2.md#L43-L46 ← research-6.md#L5-L24]
- `aggregation-3.md` → `research-7.md`, `research-8.md`, `research-9.md` (agent lifecycle plumbing, footer purity contract, error/retry state models). [via: aggregation-3.md#L127-L130 ← research-7.md#L93-L186] [via: aggregation-3.md#L127-L130 ← research-8.md#L47-L69] [via: aggregation-3.md#L127-L130 ← research-9.md#L99-L180]
- `aggregation-4.md` → `research-10.md`, `research-11.md`, `research-12.md` (compact error segments, Ralph-idle model suppression, token flow/fingerprint safety). [via: aggregation-4.md#L104-L107 ← research-10.md#L130-L156] [via: aggregation-4.md#L104-L107 ← research-11.md#L124-L134] [via: aggregation-4.md#L104-L107 ← research-12.md#L132-L192]
