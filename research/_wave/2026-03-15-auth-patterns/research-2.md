# Research 2: Copilot Token Management

## Findings

### Token Lifecycle Overview

Copilot tokens are short-lived credentials minted from GitHub OAuth tokens (or device IDs for anonymous access). The lifecycle is: **GitHub auth session → fetch Copilot token from CAPI → cache in-memory → use until near-expiry → refresh**.

### Acquisition Flow

1. **VS Code auth session**: `VSCodeCopilotTokenManager._auth()` calls `getAnyAuthSession()` to obtain a GitHub OAuth session (or falls back to `env.devDeviceId` for anonymous/no-auth access).
2. **Token minting**: `BaseCopilotTokenManager.doAuthFromGitHubTokenOrDevDeviceId()` fires two parallel requests via `ICAPIClientService`:
   - `fetchCopilotTokenFromGitHubToken()` → hits the `/copilot_internal/v2/token` endpoint with `Authorization: token <githubToken>` header.
   - `fetchCopilotUserInfo()` → fetches supplementary user info (plan, quotas, org logins).
   - For anonymous access, only `fetchCopilotTokenFromDevDeviceId()` is called with an `Editor-Device-Id` header.
3. **Response validation**: `parseTokenResponse()` uses a **two-tier validation strategy**:
   - **Strict**: Validates the full `TokenEnvelope` schema (token, expires_at, refresh_in, sku, feature flags, etc.).
   - **Fallback**: If strict fails, validates only critical fields (`token`, `expires_at`, `refresh_in`), allowing the client to survive server schema drift. Telemetry tracks fallback usage.
4. **Clock skew adjustment**: The server-provided `expires_at` is overwritten with `nowSeconds() + refresh_in + 60` to handle users whose clocks are ahead of the server.
5. **Extended token info**: The `TokenEnvelope` is enriched into `ExtendedTokenInfo` with `copilot_plan`, `quota_snapshots`, `username`, `isVscodeTeamMember`, and `organization_login_list`.

### Refresh Logic

- **Expiration check**: `getCopilotToken(force?)` checks `expires_at - 300 < nowSeconds()` (5-minute pre-expiry buffer). If expired or `force=true`, a fresh token is fetched.
- **`RefreshableCopilotTokenManager`** (abstract base for test managers): Same 5-minute pre-expiry window, delegates to `authenticateAndGetToken()`.
- **No background refresh timer**: Refresh is lazy — tokens are only refreshed when `getCopilotToken()` is called and the current token is near expiry. There is no proactive background refresh loop.

### Caching Strategy

- **In-memory only**: Tokens are cached as `ExtendedTokenInfo` on the `BaseCopilotTokenManager.copilotToken` property. No disk persistence, no SecretStorage.
- **`TaskSingler`**: `VSCodeCopilotTokenManager` wraps the `_auth()` call in a `TaskSingler<TokenInfoOrError>` keyed by `'auth'`. This deduplicates concurrent token requests — if multiple callers request a token simultaneously, they share a single in-flight promise.
- **`CopilotTokenStore`**: A separate singleton service (`ICopilotTokenStore`) that holds a reference to the current `CopilotToken`. It exists to break cyclical dependency chains — networking and telemetry services read from the store without depending on `IAuthenticationService`. Fires `onDidStoreUpdate` when the token changes.
- **Event notification**: `BaseCopilotTokenManager` fires `onDidCopilotTokenRefresh` whenever `copilotToken` is set to a new value, used by downstream services (e.g., repo enablement cache invalidation).

### Token Reset

- `resetCopilotToken(httpError?)` clears the cached token and fires telemetry (`auth.reset_token_<code>`). Called when an HTTP error indicates the token is invalid.

### Token Structure (CopilotToken class)

The `CopilotToken` class wraps `ExtendedTokenInfo` and parses the raw token string (format: `key1=val1;key2=val2;...:mac`) into a `Map<string, string>`. Provides typed accessors for:
- Feature flags via token fields: `fcv1`, `sn`, `ccr`, `editor_preview_features`, `mcp`
- User attributes: `sku`, `copilotPlan`, `isIndividual`, `isFreeUser`, `isNoAuthUser`
- Org membership: `organizationList`, `organizationLoginList`, `enterpriseList`
- Internal user detection: `isInternal`, `isMicrosoftInternal`, `isGitHubInternal`, `isVscodeTeamMember`
- Quota: `isChatQuotaExceeded`, `isCompletionsQuotaExceeded`, `quotaInfo`

### Layer Architecture

| Layer | File | Responsibility |
|-------|------|---------------|
| **common** | `copilotToken.ts` | Token types, validation, `CopilotToken` class, `TokenEnvelope` schema |
| **common** | `copilotTokenManager.ts` | `ICopilotTokenManager` interface, `nowSeconds()` helper |
| **common** | `copilotTokenStore.ts` | `CopilotTokenStore` — dependency-breaking cache singleton |
| **node** | `copilotTokenManager.ts` | `BaseCopilotTokenManager` with fetch logic, plus test variants (`FixedCopilotTokenManager`, `StaticExtendedTokenInfoCopilotTokenManager`, `RefreshableCopilotTokenManager`, `CopilotTokenManagerFromGitHubToken`, `CopilotTokenManagerFromDeviceId`) |
| **vscode-node** | `copilotTokenManager.ts` | `VSCodeCopilotTokenManager` — production implementation using VS Code auth sessions |
| **vscode-node** | `session.ts` | `getAnyAuthSession()` — obtains GitHub OAuth sessions from VS Code |

### Error Handling

Token fetch failures are categorized into typed error classes:
- `NotSignedUpError`, `SubscriptionExpiredError` — user doesn't have Copilot access
- `InvalidTokenError` — HTTP 401, prompts user to re-authenticate
- `RateLimitedError` — GitHub API rate limit exceeded
- `EnterpriseManagedError` — EMU account restrictions
- `GitHubLoginFailedError` — no auth session available
- `ContactSupportError` — server-side issues (feature flag blocked, spammy user, etc.)

Each error category has corresponding telemetry events and user-facing warning messages.

## Patterns

1. **Layered Architecture (common → node → vscode-node)**: Types and interfaces in `common/`, Node.js implementation in `node/`, VS Code-specific integration in `vscode-node/`. Enables web vs Node.js environment separation.

2. **Dependency-Breaking Store**: `CopilotTokenStore` exists solely to break circular dependency chains between auth, networking, and telemetry services. A classic "mediator" pattern.

3. **TaskSingler (Request Deduplication)**: Prevents thundering herd on concurrent token requests. Map-based with automatic cleanup on promise settlement.

4. **Two-Tier Validation with Telemetry**: Strict schema validation with graceful fallback to critical-only fields. Tracks drift via telemetry to detect server-side schema changes without breaking clients.

5. **Clock Skew Compensation**: Overrides server `expires_at` with local time + `refresh_in` + buffer to handle clock misalignment.

6. **Template Method for Test Variants**: `BaseCopilotTokenManager` is abstract; `RefreshableCopilotTokenManager` adds caching; concrete classes provide `authenticateAndGetToken()`. `FixedCopilotTokenManager` and `StaticExtendedTokenInfoCopilotTokenManager` exist for test scenarios.

7. **Eager Error Classification**: Raw HTTP/JSON errors are immediately classified into typed error enums with notification IDs, enabling precise user messaging.

## Applicability

- **Token management is the gateway to all Copilot API access**: Every chat request, completion, and tool invocation flows through `getCopilotToken()`. Understanding this flow is essential for the auth architecture.
- **The `CopilotTokenStore` pattern** is reusable for any scenario where cross-cutting services need access to shared state without creating circular dependencies.
- **The two-tier validation** pattern is a robust approach for evolving API contracts — validates strictly for correctness but falls back gracefully, tracking drift via telemetry.
- **No disk persistence**: Tokens are ephemeral (in-memory only), re-fetched from GitHub on each VS Code session. This is a deliberate security choice — no token leakage via disk.

## Open Questions

1. **No proactive refresh**: Tokens are only refreshed lazily on next `getCopilotToken()` call. Could this cause latency spikes at the 5-minute boundary for burst workloads?
2. **`CopilotTokenStore` vs `ICopilotTokenManager`**: The store and manager hold parallel references to the token. How/where is the store updated when the manager refreshes? (Likely in `IAuthenticationService` which bridges both.)
3. **FORK:TOKEN-SHARING annotation**: The `expiresAt` getter has a `FORK:TOKEN-SHARING` comment suggesting token sharing across processes or extensions — what is this fork pattern?
4. **`refresh_in` vs `expires_at`**: The server provides both, but `expires_at` is overwritten. Is `refresh_in` always strictly less than the actual TTL? What's the typical `refresh_in` value?
5. **Rate limiting recovery**: `RateLimitedError` is thrown but there's no retry-after backoff mechanism visible in the token manager layer.
