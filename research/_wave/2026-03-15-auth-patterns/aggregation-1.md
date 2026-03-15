# Aggregation 1: Core Authentication Infrastructure (Reports 1-3)

## Deduplicated Findings

### Three-Layer Token Architecture

The authentication system operates as a pipeline: **OAuth Session → CopilotToken → CopilotTokenStore**.

1. **OAuth Sessions** are acquired via VS Code's `authentication.getSession()` API through the `IAuthenticationService` interface. Two session tiers exist:
   - **"any"** — minimal scopes (`user:email`) sufficient for Copilot API access.
   - **"permissive"** — full scopes (`read:user`, `user:email`, `repo`, `workflow`) required for private repo access.
   - A backwards-compat `read:user`-only tier is also silently attempted (legacy Completions extension support).

2. **CopilotToken** is minted from OAuth sessions by hitting the `/copilot_internal/v2/token` CAPI endpoint. The `BaseCopilotTokenManager` handles fetch logic, with `VSCodeCopilotTokenManager` as the production implementation. Tokens are short-lived, in-memory only (no disk persistence), and lazily refreshed with a 5-minute pre-expiry buffer. A two-tier schema validation (strict + fallback) survives server-side schema drift. Clock skew is compensated by overriding server `expires_at` with `nowSeconds() + refresh_in + 60`.

3. **CopilotTokenStore** is a dependency-breaking singleton that holds the current `CopilotToken`, allowing networking/telemetry services to read auth state without depending on `IAuthenticationService` directly.

### Session Acquisition: Waterfall Strategy

`getAnyAuthSession()` attempts scopes in descending order (aligned → user:email → read:user) silently before falling through to interactive flows. This maximizes backward compatibility and avoids unnecessary prompts.

### Minimal Mode

Config key `github.copilot.advanced.authPermissions` set to `Minimal` permanently blocks permissive scope acquisition — interactive flows throw `MinimalModeError`, silent flows return `undefined`, and the upgrade service skips prompting entirely.

### Permission Upgrade Flow

A dedicated `IAuthenticationChatUpgradeService` orchestrates scope upgrades via a 5-step cascading guard (`shouldRequestPermissiveSessionUpgrade`):
1. Already prompted this session? → skip
2. Minimal mode? → skip
3. Already have permissive session? → skip
4. Not signed in? → skip
5. Can access all workspace repos? → skip (checks actual repo accessibility, not just scopes)

Two UI surfaces: **modal dialog** (startup proactive) and **in-chat confirmation** (contextual). On cancellation, graceful degradation to Account menu badge. After in-chat upgrade, the original user query is replayed with expanded permissions.

### Event-Driven State Propagation

`BaseAuthenticationService._handleAuthChangeEvent()` is the central event handler: snapshots state → refreshes all sessions in parallel → detects changes → fires appropriate events (`onDidAuthenticationChange`, `onDidAccessTokenChange`, `onDidAdoAuthenticationChange`). Error state transitions also trigger events (e.g., "not signed in" → "no subscription").

### Error Classification

Token fetch failures map to typed error classes (`NotSignedUpError`, `SubscriptionExpiredError`, `InvalidTokenError`, `RateLimitedError`, `EnterpriseManagedError`, `GitHubLoginFailedError`, `ContactSupportError`), each with telemetry events and user-facing messages.

### Token Structure

`CopilotToken` wraps `ExtendedTokenInfo` and parses the raw token string (`key=val;...:mac`) into typed accessors for feature flags, SKU, plan type, org membership, internal user detection, and quota state.

### Concurrency Control

`TaskSingler` deduplicates concurrent async operations (session acquisition, token minting) keyed by operation type. Interactive flows intentionally bypass the singler to force fresh auth.

### Fork Addition: Token Sharing

On token store update, the fork writes a shared token file for OpenCode consumption via `writeSharedToken()`, including OAuth token for fallback exchange.

## Cross-Report Patterns

### P1: Layered Architecture (common → node → vscode-node)
All three reports reveal the same layering: types/interfaces in `common/`, Node.js logic in `node/`, VS Code integration in `vscode-node/`. This enables web vs Node.js environment separation — the auth service, token manager, and upgrade service all follow this pattern.

### P2: Dependency-Breaking via Intermediary Services
`CopilotTokenStore` breaks circular dependencies between auth ↔ networking ↔ telemetry. Similarly, `IAuthenticationChatUpgradeService` is cleanly separated from core `IAuthenticationService`, bridging auth with git/repo services without coupling them.

### P3: Multi-Layered Deduplication
Deduplication appears at every level: `TaskSingler` for concurrent requests (R1, R2), in-memory flags for per-session prompt suppression (R3), `globalState` for cross-session persistence (R3), and config-level permanent opt-out (R3).

### P4: Graceful Degradation Throughout
The system never hard-fails on auth issues: waterfall scope resolution (R1), two-tier schema validation (R2), badge fallback on upgrade cancellation (R3), silent returns vs throws based on context. Every boundary has a fallback path.

### P5: Observable/Event-Driven State
Auth state changes propagate via events rather than polling. `onDidAuthenticationChange` is the primary event; `onDidGrantAuthUpgrade` enables features to re-fetch with expanded permissions. `isMinimalMode` uses `derived()` observables.

### P6: Repository-Aware Decision Making
The upgrade flow (R3) bridges auth with git services by checking actual repository accessibility (`_canAccessAllRepositories`) rather than comparing scope lists — practical detection over theoretical.

## Priority Matrix

| Rank | Finding | Significance | Reports |
|------|---------|-------------|---------|
| 1 | Three-layer token pipeline (OAuth → CopilotToken → Store) | Foundation of all API access; every feature depends on this | R1, R2 |
| 2 | Waterfall scope resolution + dual session tiers | Controls feature availability; backward compat strategy | R1, R3 |
| 3 | Dependency-breaking store pattern | Architectural pattern preventing circular deps across services | R1, R2 |
| 4 | Permission upgrade orchestration (5-step guard + dual UI) | User-facing auth UX; controls private repo access | R3 |
| 5 | TaskSingler concurrency control | Prevents thundering herd across all auth operations | R1, R2 |
| 6 | Two-tier token validation with telemetry | Resilience against server schema drift | R2 |
| 7 | Lazy refresh with clock skew compensation | Token freshness without background timers | R2 |
| 8 | Typed error classification hierarchy | Precise error handling and user messaging | R2 |
| 9 | Request replay after in-chat upgrade | Seamless UX recovery after permission grant | R3 |
| 10 | Fork token sharing (`writeSharedToken`) | Multi-tool interop pattern | R1 |

## Gaps

1. **Web implementation**: No report examines the web-specific `AuthenticationService` — only the Node.js path was covered. The web variant likely differs in session acquisition.
2. **Token minting internals**: The actual HTTP call inside `ICopilotTokenManager` to mint a CopilotToken from an OAuth session was not traced. The CAPI endpoint contract is inferred, not verified.
3. **GitHub Enterprise flow**: All three reports focus on github.com auth. GHE differences (custom `authProviderId`, different scope requirements) are unexamined.
4. **Rate limiting recovery**: `RateLimitedError` is classified but no retry-after/backoff mechanism is visible in the token layer.
5. **Proactive refresh absence**: No background refresh loop exists — potential latency spikes at the 5-minute boundary under burst workloads are unanalyzed.
6. **Telemetry coverage for upgrade flow**: Grant/decline rates for the permission upgrade are not visibly tracked in the examined files.
7. **Multi-account handling**: `TODO`-style code comments reference GitHub becoming a "true multi-account provider" — current workarounds need deeper examination.
8. **ADO authentication**: Azure DevOps auth via Microsoft provider is mentioned but not deeply covered in any report.
