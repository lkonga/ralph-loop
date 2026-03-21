## Findings

I searched the `vscode-copilot-chat` workspace for direct references to:

- `provideLanguageModelResponse(`
- `_provideLanguageModelResponse(`
- `_lmWrapper`
- LM API registration / request paths (`registerLanguageModelChatProvider`, `selectChatModels`, `sendRequest`)

### Direct callers found in the current branch (`bisect/v0.39-lean`)

#### A. Direct callers of `CopilotLanguageModelWrapper.provideLanguageModelResponse`

| Caller | File:line | Trigger / runtime path | `extensionId` value passed | Explicit user action required? |
|---|---|---|---|---|
| `LanguageModelAccess._provideLanguageModelChatResponse` | `src/extension/conversation/vscode-node/languageModelAccess.ts:336` | VS Code core invokes the registered `copilot` `LanguageModelChatProvider` (`provideLanguageModelChatResponse` is bound at `languageModelAccess.ts:163`, provider registered at `:166`). This is the provider path for Copilot models exposed through the VS Code LM API. | `options.requestInitiator` from core (`languageModelAccess.ts:339`) | **Built-in editor/chat usage:** yes, typically explicit. **External extension usage:** depends on the extension; could be passive in principle, but no in-repo passive caller was found. |
| `AbstractOpenAICompatibleLMProvider.provideLanguageModelChatResponse` | `src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts:96` | VS Code core invokes an openai-compatible BYOK provider response method, and that shared provider forwards into the wrapper. This covers the shared path for OpenAI-compatible BYOK vendors (OpenAI, OpenRouter, Ollama, xAI, Custom OAI, and Azure **when API key path delegates to `super`**). BYOK providers are registered in `src/extension/byok/vscode-node/byokContribution.ts:48-63`. | `options.requestInitiator` | Same as above: **usually explicit**, but other extensions could theoretically call programmatically after access is granted. |
| `AzureBYOKModelProvider.provideLanguageModelChatResponse` | `src/extension/byok/vscode-node/azureProvider.ts:129` | Azure-specific Entra ID path (no API key). If `model.configuration?.apiKey` exists, Azure takes the shared abstract-provider route (`azureProvider.ts:93`). Otherwise it acquires an Azure auth session and then forwards into the wrapper. | `options.requestInitiator` (`azureProvider.ts:133`) | **Usually explicit.** This path also calls `vscode.authentication.getSession(..., { createIfNone: true, silent: false })`, which strongly suggests an interactive/user-visible flow rather than background scroll/render. |
| Unit test invalid-path helper | `src/extension/conversation/vscode-node/test/languageModelAccess.test.ts:43` | Test-only direct invocation | `vscode.extensions.all[0].id` | Test only |
| Unit test valid-path helper | `src/extension/conversation/vscode-node/test/languageModelAccess.test.ts:71` | Test-only direct invocation | `vscode.extensions.all[0].id` | Test only |

#### B. Direct callers of `CopilotLanguageModelWrapper._provideLanguageModelResponse`

| Caller | File:line | Trigger / runtime path | `extensionId` value passed | Explicit user action required? |
|---|---|---|---|---|
| `CopilotLanguageModelWrapper.provideLanguageModelResponse` | `src/extension/conversation/vscode-node/languageModelAccess.ts:660` | The public wrapper method converts streaming deltas into VS Code LM response parts and then delegates to the private implementation. | Pass-through from the public wrapper method | Same as the public caller that entered the wrapper |

### No other direct callers were found

Repo-wide searches in `src/**/*.ts` found **no additional production call sites** for either wrapper method beyond the three production callers above and the two unit-test invocations.

### How VS Code core reaches the wrapper

This repo does not contain VS Code core’s internal implementation of LM-provider dispatch, but the public/proposed APIs in the workspace make the runtime path clear:

1. `LanguageModelAccess` is instantiated as a contribution (`src/extension/extension/vscode-node/contributions.ts:83`).
2. It registers a `LanguageModelChatProvider` for vendor `copilot` (`src/extension/conversation/vscode-node/languageModelAccess.ts:160-166`).
3. The VS Code LM API says a `LanguageModelChatProvider` is used by the chat view **or** by extensions acquiring `LanguageModelChat` objects (`src/extension/vscode.d.ts:20831-20859`, `:20990-20996`).
4. `LanguageModelChat.sendRequest(...)` is the public API that causes core to invoke the provider, and the d.ts explicitly says it may show consent UI and therefore “must _only be called in response to a user action_” (`src/extension/vscode.d.ts:20424-20450`, especially `:20430`).
5. On the provider side, `ProvideLanguageModelChatResponseOptions.requestInitiator` is documented as “What extension initiated the request … or `undefined` if the request was initiated by other functionality in the editor” (`src/extension/vscode.proposed.chatProvider.d.ts:9-19`).
6. The wrapper normalizes `'core'` to `undefined` (`src/extension/conversation/vscode-node/languageModelAccess.ts:454-456`).

So the runtime call chain for Copilot models is:

- **VS Code core / LM API** → registered provider `provideLanguageModelChatResponse` → `LanguageModelAccess._provideLanguageModelChatResponse` (`languageModelAccess.ts:324-339`) → `CopilotLanguageModelWrapper.provideLanguageModelResponse` (`:622-660`) → `CopilotLanguageModelWrapper._provideLanguageModelResponse` (`:453-618` in this branch’s line layout)

And for OpenAI-compatible BYOK models:

- **VS Code core / LM API** → BYOK provider `provideLanguageModelChatResponse` → shared abstract forwarder (`abstractLanguageModelChatProvider.ts:94-96`) **or** Azure Entra path (`azureProvider.ts:85-129`) → wrapper public → wrapper private

### What `extensionId` / `requestInitiator` means in practice

The forwarding pattern is consistent:

- `LanguageModelAccess` passes `options.requestInitiator`
- `AbstractOpenAICompatibleLMProvider` passes `options.requestInitiator`
- `AzureBYOKModelProvider` passes `options.requestInitiator`

Inside the wrapper, that value drives:

- abusive-extension blocking (`languageModelAccess.ts:463-466`)
- `x-onbehalf-extension-id` header injection for non-core extension callers (`:520-527`)
- telemetry tagging (`:490-505`, `:539-552`)

So there are really two runtime initiator classes behind the production callers:

1. **Editor/core functionality** → `requestInitiator` is effectively `undefined` (or `'core'`, normalized to `undefined`)
2. **Another extension using the VS Code LM API** → `requestInitiator` is that extension’s ID

### Important negative evidence: many Copilot features do **not** go through this wrapper

Most internal Copilot Chat features in this repo use internal endpoints (`endpointProvider.getChatEndpoint(...).makeChatRequest(...)`) instead of the VS Code LM-provider wrapper path.

Examples:

- chat participant / panel flows use internal endpoint paths, not LM API provider dispatch
- inline chat / edits use internal endpoint paths
- summarization uses internal endpoints
- feedback/review generation uses internal endpoints

This matters for the scroll-burst question: many passive/editor-driven features in this repo are simply **not wrapper callers at all**.

Also, native BYOK implementations for Anthropic and Gemini **do not** call the wrapper:

- `src/extension/byok/vscode-node/anthropicProvider.ts:93`
- `src/extension/byok/vscode-node/geminiNativeProvider.ts:76`

So bursts from those providers would not show up as `copilotLanguageModelWrapper` wrapper traffic.

### In-repo LM API consumers that could indirectly cause core to call the `copilot` provider

These are not direct wrapper callers, but they are the main in-repo places where `vscode.lm` is used in ways that could result in core invoking the provider callback:

| LM API use | File:line | Notes on trigger | Passive? |
|---|---|---|---|
| `models[0].sendRequest(...)` | `src/extension/chatSessions/claude/vscode-node/slashCommands/agentsCommand.ts:545` | Explicit `/agents` command flow generating Claude agent config. Models are selected just above at `:531-534`. | **No** — explicit user slash-command action |
| `languageModel.sendRequest(...)` | `src/platform/endpoint/vscode-node/extChatEndpoint.ts:204` | Generic adapter from an internal `IChatEndpoint` abstraction to a `vscode.LanguageModelChat`. This is not itself a wrapper caller; it’s a generic LM API consumer. In repo usage, it is mainly for extension-contributed models; scenario automation explicitly looks for non-`copilot` models (`src/extension/prompt/vscode-node/scenarioAutomationEndpointProviderImpl.ts:19-30`). | No passive evidence found |
| `selectChatModels(...)` only | `src/extension/log/vscode-node/extensionStateCommand.ts:79` | Debug command checks registration only. No request sent. | No |
| `selectChatModels(...)` only | `src/extension/conversation/vscode-node/chatParticipants.ts:244` | Model switching helper; no request sent. | No |
| `selectChatModels(...)` only | `src/extension/prompt/vscode-node/scenarioAutomationEndpointProviderImpl.ts:19` | Model selection only; no request sent here. | No |
| `selectChatModels(...)` only (model stuffed into tool loop request object) | `src/extension/mcp/vscode-node/commands.ts:255` | This is backgrounded after an explicit MCP setup command; the selected model may later be used by the tool loop, but the line itself does not send a request. | Not passive in the code path shown |

### Passive/render/scroll/visibility evidence in this branch

This branch contains a **render guard** specifically for passive UI activity:

- Passive debug-name prefixes are defined in `src/extension/prompt/node/renderGuard.ts:6-17`
  - `chatHistory.`
  - `scroll.`
  - `hover.`
  - `transcript.`
  - `passiveRender`
- Requests from those sources are canceled before backend fetch in `src/extension/prompt/node/chatMLFetcher.ts:145-148`

Crucially:

- `copilotLanguageModelWrapper` is **explicitly classified as NOT passive** in tests:
  - `src/extension/prompt/node/test/renderGuard.spec.ts:192-196`
  - `src/extension/prompt/node/test/billingQuotaCheckpoint.spec.ts:235-241`
- The fetcher tests explicitly allow `copilotLanguageModelWrapper` requests:
  - `src/extension/prompt/node/test/renderGuard.spec.ts:265-272`
  - `src/extension/prompt/node/test/billingQuotaCheckpoint.spec.ts:302-309`

The wrapper itself uses the debug name `'copilotLanguageModelWrapper'` when it eventually calls into the endpoint fetch path (`src/extension/conversation/vscode-node/languageModelAccess.ts:569`).

That means:

- the fetch layer **does not** consider wrapper traffic to be passive-render traffic
- passive sources have **different** debug names and are explicitly blocked
- I found **no in-repo call path** from scroll/hover/visibility/focus handlers into the wrapper methods

### Fork (`bisect/v0.39-lean`) vs upstream `main`

I compared the local branch against `microsoft/vscode-copilot-chat` on GitHub `main` using repository search snippets.

#### Caller-pattern comparison

The direct caller graph appears the **same** on `main`:

- `LanguageModelAccess` forwarding into `_lmWrapper.provideLanguageModelResponse(...)`
  - upstream snippet: `languageModelAccess.ts:368-385`
- `AbstractOpenAICompatibleLMProvider` forwarding into `_lmWrapper.provideLanguageModelResponse(...)`
  - upstream snippet: `abstractLanguageModelChatProvider.ts:93-102`
- Azure Entra path forwarding into `_lmWrapper.provideLanguageModelResponse(...)`
  - upstream snippet: `azureProvider.ts:119-136`
- public wrapper forwarding into private `_provideLanguageModelResponse(...)`
  - upstream snippet: `languageModelAccess.ts:700-715`

I did **not** find evidence of extra production callers on `main`.

#### Non-caller differences that do exist

The meaningful branch/main differences I saw are internal to the wrapper path, not caller topology:

- upstream `main` has added LM model configuration/schema plumbing in `languageModelAccess.ts`
- upstream `main` uses `makeChatRequest2(...)` and threads `modelConfiguration.reasoningEffort` through the wrapper
- line numbers shift accordingly, but the direct caller set remains unchanged

So for **caller patterns**, there is no meaningful fork-vs-main delta surfaced by the searches.

## Patterns

1. **Single private-entry pattern**
   - `_provideLanguageModelResponse` has exactly **one** caller: the wrapper’s public `provideLanguageModelResponse`.

2. **Three production direct-entry points**
   - one for vendor `copilot`
   - one shared path for OpenAI-compatible BYOK providers
   - one Azure-specific Entra-ID path

3. **All production direct callers forward `options.requestInitiator` unchanged**
   - The wrapper is designed to preserve who initiated the LM request, which is why it can apply extension blocking and `x-onbehalf-extension-id`.

4. **Wrapper path is LM-API/provider-specific, not the general Copilot Chat request path**
   - Most Copilot Chat features in this repo bypass the wrapper entirely and use internal endpoints.

5. **Passive render sources are explicitly named and separated from wrapper traffic**
   - The render guard blocks `chatHistory.*`, `scroll.*`, `hover.*`, `transcript.*`, and `passiveRender`.
   - `copilotLanguageModelWrapper` is intentionally treated as an active request source.

## Applicability

For the “mini burst on scroll / passive render” question, the codebase evidence points strongly to:

- **No direct in-repo scroll/render/visibility/focus caller reaches `CopilotLanguageModelWrapper.provideLanguageModelResponse` or `_provideLanguageModelResponse`.**
- The branch has a dedicated passive-render guard, and passive sources use **different debug names** than the wrapper path.
- Therefore, if runtime bursts are labeled/attributed as `copilotLanguageModelWrapper`, they are **not explained by the known passive transcript/render sources in this repo**.

What **could** still produce wrapper traffic without an obvious user click?

1. **Another extension** using `vscode.lm.selectChatModels(...).sendRequest(...)`
   - That would arrive with a non-undefined `requestInitiator` / extension ID.
   - After permissions are already granted, such an extension could theoretically trigger LM requests from timers, focus handlers, visibility changes, etc. The d.ts says callers *should* only call in response to user action, but this repo does not show whether core hard-enforces that after consent.

2. **VS Code core/editor functionality**
   - This would typically arrive with `requestInitiator` `undefined` (or `'core'`, normalized away).
   - I found no code in this repo showing core initiating wrapper traffic on scroll/render/visibility, but the actual core implementation is outside this repository.

So the practical narrowing is:

- **Inside this repo:** no passive scroll/render/visibility caller found
- **Outside this repo:** external extension misuse or a VS Code core-side issue remain possible

## Open Questions

1. **Does VS Code core enforce the “user action only” rule after consent, or is it advisory?**
   - The d.ts documents it, but core implementation is not in this repo.

2. **Which `requestInitiator` values are present in the problematic runtime bursts?**
   - If they are non-empty extension IDs, another extension is the prime suspect.
   - If they are `undefined`, built-in editor/core functionality is more likely.

3. **Is the observed burst labeled with the wrapper debug name (`copilotLanguageModelWrapper`) or with a passive-render debug name (`scroll.restore`, `chatHistory.render`, etc.)?**
   - That distinction is decisive in this branch because passive sources are explicitly blocked.

4. **If the bursts happen only on this fork and not on upstream binaries, is there runtime behavior (not caller topology) changed by the fork’s fetch/billing/render-guard modifications?**
   - I did not find a caller-graph delta, so any fork-specific difference is more likely in request classification or fetch-path behavior than in who calls the wrapper.
