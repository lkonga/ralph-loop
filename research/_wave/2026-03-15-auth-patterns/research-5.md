# Research 5: Auth in Outgoing API Requests

## Findings

### 1. Two-Tier Token Architecture

The codebase uses a **two-tier token system**:

1. **GitHub OAuth Token** → Used to *acquire* a Copilot Token from the CAPI (Copilot API) token endpoint
2. **Copilot Token** → Short-lived JWT-like token used as `Bearer` token in all AI model requests

**Token acquisition flow** (`src/platform/authentication/node/copilotTokenManager.ts`):
- `CopilotTokenManagerFromGitHubToken` takes a GitHub OAuth token and calls `fetchCopilotTokenFromGitHubToken()` which sends `Authorization: token ${githubToken}` to the CAPI token endpoint
- `CopilotTokenManagerFromDeviceId` uses a device ID header (`Editor-Device-Id`) for dev/CLI scenarios
- Both parse the response into a `CopilotToken` object (class in `src/platform/authentication/common/copilotToken.ts`) which stores the raw token string plus parsed metadata (sku, plan, quota info, orgs, expiry)

### 2. Primary Request Auth Pipeline (Copilot API / GitHub-hosted Models)

The main request path for GitHub Copilot models:

```
IAuthenticationService.getCopilotToken()
  → CopilotTokenManager.getCopilotToken()  (refreshes if expired)
    → CopilotToken.token (raw string)
      → secretKey parameter
        → Authorization: Bearer ${secretKey}  (in request headers)
```

**Key files in the pipeline**:

- **`src/extension/prompt/node/chatMLFetcher.ts`** (line ~248, ~973): The main chat fetcher. Calls `this._authenticationService.getCopilotToken()`, passes `copilotToken` to `_fetchAndStreamChat()`. Inside, `secretKey ??= copilotToken.token` — the CopilotToken's raw JWT becomes the Bearer secret.

- **`src/platform/networking/common/networking.ts`** (line ~377): The `networkRequest()` function constructs headers:
  ```
  Authorization: `Bearer ${secretKey}`
  X-Request-Id: requestId
  OpenAI-Intent: intent
  X-GitHub-Api-Version: '2025-05-01'
  + endpoint.getExtraHeaders()
  ```

- **`src/platform/nesFetch/node/completionsFetchServiceImpl.ts`** (line ~294): Similar pattern for inline completions: `Authorization: 'Bearer ' + secretKey`

### 3. Header Construction Pattern

Headers are built at **two levels** and merged:

1. **Base headers** (in `networkRequest()` or equivalent): Always includes `Authorization: Bearer`, `X-Request-Id`, `OpenAI-Intent`, `X-GitHub-Api-Version`
2. **Endpoint extra headers** (via `getExtraHeaders()` on `IChatEndpoint`): Model-specific headers like `anthropic-beta`, `X-Model-Provider-Preference`, request headers from model metadata (`modelMetadata.requestHeaders`)

The merge happens via spread: `{ ...baseHeaders, ...endpoint.getExtraHeaders(location) }` — endpoint headers override base headers.

### 4. BYOK (Bring Your Own Key) Auth Path

For user-provided API keys, a separate auth path exists:

- **`src/extension/byok/vscode-node/byokStorageService.ts`**: Stores API keys in VS Code's secret storage under keys like `copilot-byok-${providerName}-api-key`
- **`src/extension/byok/node/openAIEndpoint.ts`**: `OpenAIEndpoint.getExtraHeaders()` constructs auth headers based on provider type:
  - **Azure OpenAI**: Uses `api-key: ${apiKey}` header
  - **Standard OpenAI**: Uses `Authorization: Bearer ${apiKey}` header
  - **Custom headers**: User-defined headers are sanitized and appended
- **`src/extension/byok/node/azureOpenAIEndpoint.ts`**: Overrides to use `Authorization: Bearer ${apiKey}` (Entra ID auth) and explicitly deletes `api-key` header

For BYOK, `requestOptions.secretKey` is set by the caller, and the fallback `secretKey ??= copilotToken.token` in `chatMLFetcher.ts` is bypassed.

### 5. Additional Auth Patterns

| Consumer | Header Pattern | Source |
|----------|---------------|--------|
| GitHub API calls | `Authorization: Bearer ${token}` | `githubAPI.ts`, `octoKitServiceImpl.ts` |
| Remote agents | `Authorization: Bearer ${authToken}` | `remoteAgents.ts` |
| Proxy models | `Authorization: Bearer ${copilotToken.token}` | `proxyModelsService.ts` |
| Router decisions | `Authorization: Bearer ${authToken}` | `routerDecisionFetcher.ts` |
| Automode service | `Authorization: Bearer ${authToken}` | `automodeService.ts` |
| Image service | `Authorization: Bearer ${token}` | `imageServiceImpl.ts` |
| Content exclusion | `Authorization: token ${ghToken}` (GitHub API style) | `remoteContentExclusion.ts` |
| Xtab endpoint | `api-key: ${apiKey}` | `xtabEndpoint.ts` |
| Claude adapter | Reads from `x-api-key` header | `anthropicAdapter.ts` |
| Maestro MCP | Reads `Authorization` or `x-api-key` from incoming request | `maestroMcpServer.ts` |

### 6. Security Headers and Sanitization

`OpenAIEndpoint` (BYOK) maintains a **reserved headers set** (~30 headers) that cannot be overridden by user-defined custom headers. This includes forbidden request headers per MDN spec (`Cookie`, `Host`, `Origin`, etc.), auth headers (`Authorization`, `api-key`), and internal tracking headers (`X-Request-Id`, `OpenAI-Intent`).

Header values are sanitized by `_sanitizeHeaderValue()` which rejects:
- Control characters (CR/LF injection prevention)
- Bidirectional override / zero-width Unicode characters
- Values exceeding max length

### 7. Token Refresh and Error Recovery

- `IAuthenticationService.resetCopilotToken(httpError?)`: Called on 401/403 responses to force token refresh
- `chatMLFetcher.ts` (line ~1232, ~1490): Checks `response.status` and calls `resetCopilotToken()` on auth failures
- `CopilotTokenManager` handles automatic token refresh via `RefreshableCopilotTokenManager` base class

## Patterns

1. **Lazy Token Resolution**: `secretKey ??= copilotToken.token` — BYOK key takes precedence, CopilotToken is the fallback
2. **Strategy Pattern for Endpoints**: `IChatEndpoint.getExtraHeaders()` — each endpoint type (ChatEndpoint, OpenAIEndpoint, AzureOpenAIEndpoint) implements its own header strategy
3. **Two-Phase Token Exchange**: GitHub OAuth → Copilot Token exchange at a CAPI endpoint, then Copilot Token → Bearer auth on model requests
4. **Header Merging via Spread**: Base headers + endpoint-specific headers merged with spread operator; endpoint headers win on collision
5. **Reserved Header Protection**: BYOK endpoints maintain a deny-list of security-critical headers that user config cannot override

## Applicability

This auth architecture supports Ralph Loop's understanding of the Copilot extension's request lifecycle:

- **Token acquisition** is decoupled from **token usage** — the `IAuthenticationService` abstracts the GitHub OAuth flow, and consumers only see `getCopilotToken()` → `CopilotToken.token`
- **BYOK is a parallel auth path** — it bypasses CopilotToken entirely, injecting user-provided API keys via `getExtraHeaders()`
- **All model requests share the same header construction** in `networkRequest()` — this is the single chokepoint for auth header injection
- The `IChatEndpoint` interface with `getExtraHeaders()` and `interceptBody()` is the extension point for custom endpoint behavior

## Open Questions

1. **WebSocket auth**: The WebSocket path (`_doFetchViaWebSocket`) constructs its own `Authorization: Bearer` header independently — is there a risk of header divergence between HTTP and WebSocket paths?
2. **Token caching**: How long are CopilotTokens cached before refresh? The `expiresAt` field exists but the refresh timing logic in `RefreshableCopilotTokenManager` wasn't fully traced.
3. **CAPI client service**: `ICAPIClientService.makeRequest()` abstracts the actual CAPI domain/URL resolution — how does it select between primary and fallback CAPI endpoints?
4. **Extension-contributed models**: `endpoint.isExtensionContributed` allows third-party extensions to provide models — what auth constraints apply to them?
