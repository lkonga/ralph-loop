## Findings

- `src/extension/prompt/node/renderGuard.ts` is a fork-only utility whose entire purpose is to stop **passive transcript/render activity** from turning into backend/model traffic. It classifies a request as passive when `debugName` starts with one of:
  - `chatHistory.`
  - `scroll.`
  - `hover.`
  - `transcript.`
  - `passiveRender`
- The file comment is explicit: passive browsing of existing chat history (scrolling, hovering, restoring) must stay **render-only** and must never trigger backend/model requests.
- `src/extension/prompt/node/chatMLFetcher.ts` uses the guard at the **very top** of `fetchMany(...)`, before request body creation, auth-token acquisition, request logging, telemetry setup, quota processing, or any network call.
- When `isPassiveRenderSource(debugName)` is true, `chatMLFetcher.ts`:
  1. logs `"[FORK RENDER-GUARD] Blocked request from passive render source=..."`
  2. returns `ChatFetchResponseType.Canceled` with reason `"Passive render source blocked"`
  3. performs **zero** backend/model requests
- Because the guard returns early, passive requests do **not** reach `_fetchAndStreamChat`, `_fetchWithInstrumentation`, `postRequest`, or `onDidMakeChatMLRequest`. This is a real hard stop, not just a warning.
- `src/extension/prompt/node/test/renderGuard.spec.ts` and `src/extension/prompt/node/test/billingQuotaCheckpoint.spec.ts` verify that the named passive sources (`chatHistory.render`, `scroll.restore`, `hover.tooltip`, `transcript.hydrate`, `passiveRender`) return `Canceled` and leave `mockFetcherService.fetchCallCount === 0`.
- The same tests explicitly verify that `copilotLanguageModelWrapper` is **not** passive:
  - `expect(isPassiveRenderSource('copilotLanguageModelWrapper')).toBe(false)`
  - requests using that debug name are allowed and succeed
- Production call-site search matters here: the passive names (`chatHistory.render`, `scroll.restore`, `hover.tooltip`, `transcript.hydrate`, `passiveRender`) do **not** appear in non-test code in the current fork. They are only present in:
  - `renderGuard.ts`
  - `renderGuard.spec.ts`
  - `billingQuotaCheckpoint.spec.ts`
- By contrast, `src/extension/conversation/vscode-node/languageModelAccess.ts` hardcodes wrapper-originated requests as:
  - `endpoint.makeChatRequest('copilotLanguageModelWrapper', ...)`
- Therefore, if a passive UI path still reaches `chatMLFetcher` through `CopilotLanguageModelWrapper`, the fetch-layer guard would **not** block it, because `copilotLanguageModelWrapper` is classified as active.
- Task 16 / BQ2 did not rely only on the fetch-layer guard. The stronger fix was in `src/extension/chatSessionContext/vscode-node/chatSessionContextProvider.ts`, which now keeps summary generation pure: it just concatenates recent user messages and explicitly states that passive browsing paths must avoid model requests.
- The fork also added `src/extension/chatSessionContext/vscode-node/test/chatSessionContextProvider.spec.ts`, which asserts the provider source contains neither `selectChatModels(` nor `.sendRequest(`.
- Upstream `main` still had the old behavior in `chatSessionContextProvider.ts`: GitHub source excerpts from `microsoft/vscode-copilot-chat` show `generateSummary(...)` doing both:
  - `vscode.lm.selectChatModels({ family: 'gpt-4o-mini', vendor: 'copilot' })`
  - `model.sendRequest(...)`
  That upstream path is exactly the kind of passive render-triggered LM request BQ2 was written to eliminate.
- Upstream comparison for the guard itself: the configured upstream remote is `https://github.com/microsoft/vscode-copilot-chat/`, and GitHub source search found no upstream `renderGuard.ts` / `isPassiveRenderSource` equivalent. Upstream `chatMLFetcher.ts` excerpts also show no `renderGuard` import and no early passive-cancel branch. So the render guard is a **fork-only** addition.
- `progress.txt` records Task 16 as changing exactly:
  - `src/extension/chatSessionContext/vscode-node/chatSessionContextProvider.ts`
  - `src/extension/prompt/node/chatMLFetcher.ts`
  and committing them in `2853e28da35a2382121ecd8a949853942d9a867c`.

## Patterns

- The fork uses a **two-layer defense** for BQ2:
  1. **remove passive LM work at the source** (`chatSessionContextProvider.ts`)
  2. **add a fetch-layer failsafe** (`renderGuard.ts` + `chatMLFetcher.ts`)
- The fetch-layer guard is driven **only by `debugName` string prefixes**. It does not inspect call stack, UI event type, extension ID, chat location, or a structured request-kind enum.
- That means the guard is only effective when callers cooperate and choose a passive `debugName`.
- `copilotLanguageModelWrapper` is intentionally treated as an active source because it is the normal request path for many valid `vscode.lm` / extension-contributed / BYOK flows.
- The Task 16 source-side change is the more robust part of the fix: it removes the passive path that upstream had, instead of depending on every passive caller to be labeled correctly.

## Applicability

- **Does the guard block passive render sources like scroll/restore?**
  - **At the fetch layer: yes**, if the request enters `chatMLFetcher.fetchMany(...)` with a passive debug name such as `scroll.restore` or `chatHistory.render`.
  - The tests prove this path returns `Canceled` and performs zero fetches.
- **Does that mean all passive render-triggered requests are guaranteed blocked in practice?**
  - **Not by the guard alone.** In the current fork, there are no real production call sites using those passive debug names.
  - The practical BQ2 fix is mostly that the previously passive provider (`chatSessionContextProvider.ts`) no longer makes LM calls at all.
- **Would the guard catch a passive request that still comes through `copilotLanguageModelWrapper`?**
  - **No.** `copilotLanguageModelWrapper` is explicitly classified as active, and its requests are allowed through.
- So the correct interpretation is:
  - the guard is a valid **failsafe/backstop** for explicitly labeled passive sources
  - the actual regression fix was to **remove the passive LM path upstream had**, so passive browsing no longer needs to rely on wrapper classification

## Open Questions

- There are no current production call sites using the passive debug-name prefixes. If a future passive render path is introduced and it uses an active debug name instead, the current guard will miss it.
- A stronger long-term design would be to classify requests with structured metadata (for example, explicit request kind / passive vs active origin) instead of relying on string prefixes.
- I could not run literal `git show main:src/extension/prompt/node/renderGuard.ts` locally with the available tools. The upstream comparison above is based on:
  - the repo’s configured `upstream` remote (`microsoft/vscode-copilot-chat`)
  - GitHub source excerpts from that upstream repo
  - local fork source and tests
