# Aggregation 2: External Auth & Alternative Patterns (Reports 4-6)

## Deduplicated Findings

### F1: Two Parallel Auth Pipelines
The extension maintains two fully independent authentication pipelines:

1. **GitHub/CAPI Pipeline** (standard Copilot models): GitHub OAuth token → CAPI token exchange → short-lived CopilotToken JWT → `Authorization: Bearer {copilotToken}` on every model request. Managed by `CopilotTokenManager` with auto-refresh via `RefreshableCopilotTokenManager`.

2. **BYOK Pipeline** (user-provided keys): API keys stored in VS Code `SecretStorage` (OS-keychain-backed) under `copilot-byok-{provider}[-{modelId}]-api-key`. Keys injected per-request via `OpenAIEndpoint.getExtraHeaders()` or passed directly to native SDK constructors (Anthropic, Gemini). Bypasses CAPI entirely via `secretKey ??= copilotToken.token` fallback (BYOK key takes precedence).

The `isBYOKModel()` discriminator (returns `1`=client BYOK, `2`=server BYOK, `-1`=standard) drives branching in telemetry, rate limiting, and error handling across the codebase.

### F2: Three BYOK Auth Types
`BYOKAuthType` enum governs key scoping:

| Auth Type | Providers | Storage Scope |
|---|---|---|
| `GlobalApiKey` | OpenAI, Anthropic, Gemini, xAI, OpenRouter | One key per provider |
| `PerModelDeployment` | Azure | Key + URL per model deployment |
| `None` | Ollama | No key stored |

Key retrieval uses a fallback chain: model-specific key → provider-level key. Empty/whitespace keys rejected via `.trim()` checks. Model metadata (URLs, capabilities) stored separately in `globalState` as plain JSON.

### F3: Unified Header Construction
All model requests share a single header construction path in `networkRequest()`:

- **Base headers** (always present): `Authorization: Bearer`, `X-Request-Id`, `OpenAI-Intent`, `X-GitHub-Api-Version: 2025-05-01`
- **Endpoint-specific headers** (via `IChatEndpoint.getExtraHeaders()`): Provider-specific headers like `anthropic-beta`, Azure's `api-key`, user-defined custom headers
- **Merge strategy**: Spread operator `{ ...baseHeaders, ...endpointHeaders }` — endpoint headers override base on collision

Azure is the most complex case with dual auth: API key (`api-key` header) OR Entra ID (`Authorization: Bearer {accessToken}` from `vscode.authentication.getSession()`).

### F4: Security Hardening — Reserved Header Protection
`OpenAIEndpoint` blocks user-defined custom headers from overriding security-critical headers:

- **Blocklist**: ~30 reserved headers (`authorization`, `api-key`, `cookie`, `host`, `origin`, `x-request-id`, etc.)
- **Pattern blocking**: `proxy-*`, `sec-*` prefixes rejected
- **Injection prevention**: CR/LF control characters, bidirectional Unicode overrides, zero-width characters all rejected
- **Limits**: Max 20 custom headers, 256-char names, 8192-char values; RFC 7230 compliant name validation

### F5: Provider Registration Lifecycle
`BYOKContrib` orchestrates one-time provider registration:
1. Listens for `onDidAuthenticationChange` events
2. Checks enablement via Copilot token feature flags (`isBYOKEnabled`)
3. Fetches model capabilities from CDN (`copilotChat.json` on `main.vscode-cdn.net`)
4. Instantiates 8 providers via `IInstantiationService.createInstance()`
5. Registers each with `lm.registerLanguageModelChatProvider()`
6. Guarded by `_byokProvidersRegistered` flag — never re-registers

Model capability resolution chain: user-specified → CDN-fetched → hardcoded defaults (128k context, 8k output).

### F6: Test & CI Authentication Infrastructure
Three specialized auth components for non-production environments:

- **`StaticGitHubAuthenticationService`**: Replaces interactive VS Code auth with a constructor-injected token provider function. Creates synthetic `AuthenticationSession` objects with lazy `accessToken` getters. Supports test-driven token injection via `setCopilotToken()` + event firing.

- **`SimulationTestCopilotTokenManager`**: Singleton-per-process manager preventing N test instances from making N token fetches. Strategy selection via env vars: `GITHUB_PAT` → static token (no network), `GITHUB_OAUTH_TOKEN` → real CAPI exchange with auto-refresh and `fetchAlreadyGoing` dedup.

- **`SharedTokenWriter`** (fork feature): Writes CAPI token to `~/.local/share/copilot-shared-token.json` for cross-tool consumption (OpenCode). Uses atomic temp+rename write pattern. Best-effort / fire-and-forget semantics — never crashes the extension.

### F7: Token Refresh & Error Recovery
- `CopilotToken.expiresAt` drives refresh timing in `RefreshableCopilotTokenManager`
- On HTTP 401/403 responses, `resetCopilotToken()` forces token re-acquisition from CAPI
- `chatMLFetcher.ts` checks response status and triggers reset on auth failures
- BYOK has no client-side refresh — invalid keys only surface as errors on first use (no pre-validation)

### F8: Broad Auth Consumer Surface
Beyond model requests, auth tokens are used across many services:

| Consumer | Auth Style |
|---|---|
| GitHub API calls | `Authorization: Bearer ${token}` |
| Remote agents | `Authorization: Bearer ${authToken}` |
| Proxy models | `Authorization: Bearer ${copilotToken.token}` |
| Router decisions | `Authorization: Bearer ${authToken}` |
| Automode service | `Authorization: Bearer ${authToken}` |
| Image service | `Authorization: Bearer ${token}` |
| Content exclusion | `Authorization: token ${ghToken}` (GitHub API style) |
| Xtab endpoint | `api-key: ${apiKey}` |
| Claude adapter | Reads `x-api-key` header |
| Maestro MCP | Reads `Authorization` or `x-api-key` from incoming request |

## Cross-Report Patterns

### P1: Strategy Pattern as Architectural Lingua Franca
All three reports independently surface the Strategy pattern:
- **R4**: `BYOKAuthType` enum drives storage/retrieval branching
- **R5**: `IChatEndpoint.getExtraHeaders()` — each endpoint type implements its own header strategy
- **R6**: PAT vs OAuth token manager selection based on environment variables

This is the dominant architectural pattern for auth extensibility — new auth mechanisms plug in via interface implementations, not conditional branches.

### P2: Interface-Driven Testability
The auth system is designed around swappable implementations behind stable interfaces:
- `IAuthenticationService` → `StaticGitHubAuthenticationService` (tests) or `GitHubAuthenticationService` (prod)
- `ICopilotTokenManager` → `SimulationTestCopilotTokenManager` / `FixedCopilotTokenManager` / `CopilotTokenManagerFromGitHubToken`
- `IChatEndpoint` → `ChatEndpoint` / `OpenAIEndpoint` / `AzureOpenAIEndpoint`

DI container (`IInstantiationService`) wires everything. Tests use `createPlatformServices().createTestingAccessor()` for full-graph testing with replaceable implementations.

### P3: Security at Every Boundary
Security enforcement is layered, not centralized:
- **Storage layer**: SecretStorage for keys, plain globalState for metadata only
- **Transport layer**: Reserved header blocklist, injection prevention, RFC 7230 validation
- **Token exchange layer**: Short-lived tokens with auto-refresh
- **Cross-process layer**: Atomic file writes prevent partial token reads

### P4: Graceful Degradation as Design Principle
Multiple components adopt best-effort semantics:
- BYOK model discovery returns empty lists on missing keys (silent mode) rather than erroring
- `SharedTokenWriter` catches all errors and logs warnings — never fails the primary flow
- BYOK errors only surface on first real request, not during registration
- Migration methods (`migrateExistingConfigs()`) are time-bounded with TODO markers

### P5: Two-Phase Secret Resolution
A recurring pattern: secrets are resolved in two phases with fallback:
- Request auth: `secretKey ??= copilotToken.token` (BYOK → Copilot fallback)
- BYOK key retrieval: model-specific → provider-level fallback
- Model capabilities: user-specified → CDN → hardcoded defaults
- Test token: `GITHUB_PAT` → `GITHUB_OAUTH_TOKEN` → error

## Priority Matrix

| Rank | Finding | Significance | Reports |
|------|---------|-------------|---------|
| 1 | **Two parallel auth pipelines** (F1) | Fundamental architecture — BYOK vs CAPI determines the entire request flow | R4, R5 |
| 2 | **Unified header construction** (F3) | Single chokepoint for auth injection — key integration point for any Ralph hook | R5 |
| 3 | **Strategy pattern everywhere** (P1) | Primary extensibility mechanism — new auth types plug in via interfaces | R4, R5, R6 |
| 4 | **Security hardening** (F4) | Critical for BYOK — prevents header injection, auth override, and Unicode attacks | R4, R5 |
| 5 | **Interface-driven testability** (P2) | Enables deterministic testing without network calls or VS Code UI | R6 |
| 6 | **Token refresh pipeline** (F7) | Understanding refresh triggers/timing is essential for reliable hook integration | R5, R6 |
| 7 | **SharedTokenWriter cross-tool IPC** (F6) | Fork-specific but demonstrates auth boundary extensibility pattern | R6 |
| 8 | **CDN-driven capability resolution** (F5) | Decouples capability updates from extension releases — relevant for model selection hooks | R4 |

## Gaps

1. **Server-side BYOK (type 2)**: `isBYOKModel()` returns `2` for `customModel` endpoints routed through CAPI — this path is completely uninvestigated. How does it differ from client-side BYOK auth?

2. **WebSocket auth divergence**: The `_doFetchViaWebSocket` path constructs `Authorization: Bearer` independently from the HTTP path — potential for header construction drift between the two transport modes.

3. **CopilotToken refresh timing**: The exact refresh schedule/buffer in `RefreshableCopilotTokenManager` was not fully traced. How far before expiry does refresh trigger? What happens during a refresh race?

4. **Extension-contributed model auth**: `endpoint.isExtensionContributed` allows third-party extensions to provide models — auth constraints, validation, and trust boundaries for these models are undocumented.

5. **BYOK key validation**: No pre-validation or "test connection" mechanism exists. Invalid keys only error on first use. No key rotation or expiration tracking.

6. **CAPI endpoint selection**: `ICAPIClientService.makeRequest()` abstracts domain/URL resolution — the primary/fallback CAPI endpoint selection logic was not investigated.

7. **SharedTokenWriter integration point**: Where exactly in the production token lifecycle is `writeSharedToken()` invoked? Event listener on refresh? Post-acquisition hook?

8. **Cross-process token refresh coordination**: When the shared token file nears expiry, which process (VS Code or OpenCode) is responsible for refresh? Is there a coordination protocol or is it first-come-first-served?
