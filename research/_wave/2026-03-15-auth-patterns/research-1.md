# Research 1: GitHub Authentication Service

## Findings

### IAuthenticationService Interface

Defined in `src/platform/authentication/common/authentication.ts` via `createServiceIdentifier` (DI token). The interface exposes:

**Properties (synchronous cache reads):**
- `isMinimalMode: boolean` — derived observable from config; when true, permissive scopes are blocked.
- `anyGitHubSession: AuthenticationSession | undefined` — cached session with minimum scopes (`user:email`).
- `permissiveGitHubSession: AuthenticationSession | undefined` — cached session with full scopes (`read:user`, `user:email`, `repo`, `workflow`). Returns `undefined` in minimal mode.
- `copilotToken: Omit<CopilotToken, 'token'> | undefined` — cached Copilot token metadata (token string omitted to prevent accidental use of expired tokens).
- `speculativeDecodingEndpointToken: string | undefined` — public token for speculative decoding endpoint.

**Events:**
- `onDidAuthenticationChange: Event<void>` — fires on any auth state change (login, logout, token refresh, error change). Primary event consumers should react to.
- `onDidAccessTokenChange: Event<void>` — (deprecated) fires when OAuth access token changes.
- `onDidAdoAuthenticationChange: Event<void>` — fires when Azure DevOps auth state changes.

**Methods:**
- `getGitHubSession(kind, options)` — three overloads:
  1. `createIfNone` → always returns session (interactive flow).
  2. `forceNewSession` → forces re-auth, always returns session.
  3. Silent/optional → may return `undefined`.
  - `kind: 'permissive' | 'any'` controls scope level.
  - Throws `MinimalModeError` for permissive requests in minimal mode.
- `getCopilotToken(force?)` — returns valid CopilotToken, refreshing if expired. Stores in `ICopilotTokenStore`.
- `resetCopilotToken(httpError?)` — invalidates cached token (e.g., on HTTP 401/403).
- `getAdoAccessTokenBase64(options?)` — returns base64-encoded ADO PAT token.

### Scope Tiers

Three scope levels defined as constants:
1. **`GITHUB_SCOPE_USER_EMAIL`**: `['user:email']` — minimum for Copilot API access.
2. **`GITHUB_SCOPE_READ_USER`**: `['read:user']` — legacy/backwards compat (used by Completions extension).
3. **`GITHUB_SCOPE_ALIGNED`**: `['read:user', 'user:email', 'repo', 'workflow']` — matches GitHub PR extension scopes; needed for private repo access.

### Session Acquisition Flow (`session.ts`)

**`getAnyAuthSession()`** — waterfall strategy:
1. Try aligned scopes silently (if not minimal mode).
2. Try `user:email` silently.
3. Try `read:user` silently (backwards compat).
4. Fall through to `getAuthSession()` which handles `createIfNone`/`forceNewSession`.

**`getAlignedSession()`** — permissive-only:
- Blocks with `MinimalModeError` in minimal mode for interactive flows.
- Returns `undefined` silently in minimal mode.
- Otherwise attempts aligned scopes via `getAuthSession()`.

**`getAuthSession()`** (private helper):
- Checks existing accounts via `authentication.getAccounts()`.
- For `forceNewSession`: clears session preference, adds "learn more" link.
- For `createIfNone`: forces account picker for multi-account scenarios.
- Otherwise passes options directly to VS Code `authentication.getSession()`.

### BaseAuthenticationService (Abstract Base)

Implements shared lifecycle logic:
- **`_handleAuthChangeEvent()`** — central event handler:
  1. Snapshots current state (sessions + token + errors).
  2. Refreshes all three sessions in parallel (`Promise.allSettled`).
  3. If GitHub OAuth token changed → fires `onDidAccessTokenChange`, mints new CopilotToken.
  4. If ADO token changed → fires `onDidAdoAuthenticationChange`.
  5. If CopilotToken or its error changed → fires `onDidAuthenticationChange`.

- **`getCopilotToken()`** — delegates to `ICopilotTokenManager`, stores result in `ICopilotTokenStore`. Detects error message changes and fires auth change events even when both attempts fail (e.g., "not signed in" → "no subscription").

### Token Lifecycle

1. **OAuth Session** → acquired via VS Code `authentication.getSession()` API.
2. **CopilotToken** → minted from OAuth session by `ICopilotTokenManager.getCopilotToken()`.
3. **Storage** → `ICopilotTokenStore` holds the active CopilotToken, fires `onDidStoreUpdate`.
4. **Refresh** → `ICopilotTokenManager` fires `onDidCopilotTokenRefresh`, triggering `_handleAuthChangeEvent`.
5. **Reset** → on HTTP errors (401/403), `resetCopilotToken()` clears store and manager state.
6. **Sharing** → FORK addition: on token store update, writes shared token file for OpenCode consumption via `writeSharedToken()`, including OAuth token for fallback exchange.

### AuthenticationService (Node Implementation)

In `vscode-node/authenticationService.ts`:
- Extends `BaseAuthenticationService`.
- Uses `TaskSingler` to deduplicate concurrent silent session requests (keyed by `'permissive'`, `'any'`, `'ado'`). Interactive flows bypass the singler.
- Listens to `authentication.onDidChangeSessions` for GitHub/Microsoft provider changes.
- Listens to `domainService.onDidChangeDomains` for dotcom URL changes.
- Also supports ADO sessions via Microsoft auth provider with scope `499b84ac-.../.default`.

## Patterns

1. **Service Identifier DI**: `createServiceIdentifier<T>('name')` creates both the type and the DI token — standard VS Code pattern.
2. **Abstract Base + Concrete Implementations**: `BaseAuthenticationService` handles shared logic; `AuthenticationService` (node) and presumably a web variant implement platform-specific session acquisition.
3. **Event-Driven State Management**: Three event emitters for different auth domains; consumers react to events rather than polling.
4. **Observable Derived State**: `isMinimalMode` uses `derived()` from observable infrastructure to reactively track config changes.
5. **TaskSingler Pattern**: Deduplicates concurrent async operations for the same key, preventing redundant network calls. Interactive flows intentionally bypass this.
6. **Three-Layer Token Architecture**: OAuth Session → CopilotToken → CopilotTokenStore, each with distinct lifecycle and concerns.
7. **Waterfall Scope Resolution**: `getAnyAuthSession` tries progressively narrower scopes to maximize backward compatibility.
8. **Error State Tracking**: Auth change events fire on error transitions, not just token changes, enabling UI updates for subscription state changes.

## Applicability

- The auth service is a foundational platform service — virtually every feature that calls GitHub or Copilot APIs depends on it.
- The dual-mode design (minimal vs permissive) directly affects which features are available (e.g., workspace search needs `repo` scope).
- The token sharing mechanism (`writeSharedToken`) is a custom fork addition for multi-tool interop.
- `ICopilotTokenStore` exists as a separate service specifically to break circular dependencies with networking/telemetry services.

## Open Questions

1. **Web implementation**: Where is the web-specific `AuthenticationService`? Likely in a `vscode-web/` sibling directory.
2. **Token refresh internals**: `ICopilotTokenManager.getCopilotToken()` handles refresh logic — the actual HTTP call to mint a CopilotToken from an OAuth session is inside that manager, not examined here.
3. **Multi-account handling**: The code has `TODO`-style comments about GitHub becoming a "true multi-account provider" — current workarounds use `clearSessionPreference` and `forceNewSession`.
4. **`authProviderId` switching**: Supports GitHub vs GitHub Enterprise via config, but the Enterprise flow's differences aren't covered here.
5. **Speculative decoding token**: Set externally via ChatMLFetcher, reset on 403 — lifecycle details are outside auth service scope.
