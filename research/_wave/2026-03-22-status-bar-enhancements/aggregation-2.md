## Aggregation Report 2

### Source Reports

- `research-4.md` — The current implementation already carries and renders the requested model label during `Processing`; after completion it prefers the resolved endpoint label, and the only documented case that suppresses the model during processing is Ralph's intentional idle override. [source: research-4.md#L9-L9] [source: research-4.md#L44-L82] [source: research-4.md#L98-L145]
- `research-5.md` — `_buildTooltip()` already shows 13 data points, and the codebase already exposes additional high-value signals such as 429 stats, error counts, global rate-limiter state, session request counts, and raw/premium/provider model metadata with little or no new plumbing. [source: research-5.md#L5-L23] [source: research-5.md#L26-L58] [source: research-5.md#L147-L170]
- `research-6.md` — `STD` means "Standard" for the `'default'` billing mode, not "default setting value"; the same `STD`/`DEF`/`DLG` mapping is already implemented in both the status bar and the chat footer, and the tooltip/docs are the recommended place to explain the abbreviations. [source: research-6.md#L5-L24] [source: research-6.md#L28-L60] [source: research-6.md#L124-L137]

### Deduplicated Findings

1. The strongest correction is that the "missing model during `Processing`" premise is not true in the current code path: `activeModelLabel` returns the requested model label while processing, and the status bar render path consumes that label. [source: research-4.md#L9-L9] [source: research-4.md#L44-L82] [source: research-4.md#L137-L145]
2. If the model is absent while a request is processing, the documented explanation is a separate UI ownership rule, not a lifecycle-data gap: Ralph's idle override intentionally renders a simplified surface without the model name. [source: research-4.md#L135-L145]
3. The tooltip already has a substantial baseline surface area with 13 fields, so enhancement work should focus on selecting the next most useful signals rather than redesigning `_buildTooltip()` from scratch. [source: research-5.md#L5-L23]
4. The highest-leverage tooltip additions are already available in existing services: 429 breakdowns, HTTP error counts, total session requests, global limiter state, premium-tier status, raw model name, provider family, and related diagnostics. [source: research-5.md#L26-L58] [source: research-5.md#L147-L170]
5. Lower-tier tooltip additions exist too, but they read as secondary diagnostics rather than primary UX wins: config values such as thinking budget or compaction threshold are medium value, while request IDs and last retry-after details are mostly forensic/debug data. [source: research-5.md#L147-L170]
6. `STD` should be interpreted as "Standard" billing behavior for the `'default'` mode, chosen specifically to avoid confusion with `'force-agent'`, which is the actual default value of the billing-mode setting. [source: research-6.md#L5-L24]
7. Billing-tag semantics are already consistent across the two current display surfaces because both `computeBillingCodes()` and `getBillingTag()` produce the same `STD`/`DEF`/`DLG` mapping. [source: research-6.md#L28-L60]
8. The reports converge on a presentation fix more than a backend fix: clarifying abbreviations in the tooltip, and optionally pairing friendly display labels with raw or resolved model metadata, would address confusion without needing new lifecycle plumbing. [source: research-5.md#L26-L58] [source: research-6.md#L124-L137]

### Cross-Report Patterns

- **Presentation and explanation are the main gap, not data collection.** Report 4 shows the processing model label already exists in lifecycle state, report 5 shows many unused tooltip-ready data points already exist, and report 6 shows billing tags are already computed consistently and mainly need clearer explanation. [source: research-4.md#L44-L82] [source: research-5.md#L147-L170] [source: research-6.md#L28-L60]
- **The tooltip is the safest place to add clarity without overcrowding the status bar text.** Report 5 identifies many candidate fields for `_buildTooltip()`, while report 6 explicitly recommends expanding `STD`/`DEF`/`DLG` in the tooltip. [source: research-5.md#L5-L23] [source: research-5.md#L147-L170] [source: research-6.md#L124-L137]
- **Model identity has multiple layers that the UI can choose to expose deliberately.** Report 4 distinguishes requested vs resolved model labels across lifecycle states, and report 5 shows raw model name plus provider-family data are also available for tooltip use. [source: research-4.md#L98-L145] [source: research-5.md#L26-L58]
- **Confusion comes from compact tokens and state-specific overrides.** Report 4 documents the Ralph idle override as a special rendering rule, while report 6 documents `STD` as a compressed token whose meaning is not obvious without explanation. [source: research-4.md#L135-L145] [source: research-6.md#L5-L24] [source: research-6.md#L124-L137]

### Priority Matrix

| Pattern | Impact | Effort | Sources (with line refs) |
| --- | --- | --- | --- |
| Clarify status semantics in tooltip/docs (`STD`, requested vs resolved model, override behavior) | High | Low | [source: research-4.md#L98-L145], [source: research-6.md#L124-L137] |
| Add zero-plumbing tooltip metrics (429s, errors, limiter, session counts, premium/model metadata) | High | Low-Medium | [source: research-5.md#L26-L58], [source: research-5.md#L147-L170] |
| Preserve current processing-model flow and treat missing labels as an override/UI-ownership issue first | Medium-High | Low | [source: research-4.md#L44-L82], [source: research-4.md#L135-L145] |
| Expose raw/resolved/provider model identity alongside the friendly label for debugging and trust | Medium | Low-Medium | [source: research-4.md#L98-L145], [source: research-5.md#L26-L58] |

### Gaps

- The three reports do not rank the proposed tooltip additions by user frequency, telemetry, or space constraints.
- They do not test the live UX of the processing model label under Ralph-owned states beyond the documented idle override.
- They do not propose exact copy for tooltip strings, localization, or accessibility wording.
- They stop short of a concrete implementation sequence or test plan for the final enhancement bundle.

### Sources

- `research-4.md` (Model Name in Status Bar During Processing State)
- `research-5.md` (Additional Data Points for `_buildTooltip()` and Available Services)
- `research-6.md` (`"STD"` Billing Tag — Derivation, Meaning, and Documentation)
