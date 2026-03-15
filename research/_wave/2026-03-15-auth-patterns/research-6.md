# Research 6: Static Auth & Shared Token Patterns

## Findings

### 1. StaticGitHubAuthenticationService — Deterministic Auth for Tests/CI

`StaticGitHubAuthenticationService` extends `BaseAuthenticationService` and replaces the interactive VS Code authentication flow with a **token-provider function** injected via constructor. It creates two synthetic `AuthenticationSession` objects at construction time:

- **`_anyGitHubSession`** — uses `GITHUB_SCOPE_USER_EMAIL` scopes, returns the provider's token as both `id` and `accessToken` via getter (lazy evaluation on every access).
- **`_permissiveGitHubSession`** — uses `GITHUB_SCOPE_ALIGNED` scopes, same lazy token pattern.

Key behaviors:
- `getGitHubSession()` returns the pre-built session objects directly — no VS Code authentication API calls.
- `getCopilotToken()` delegates to `super` (which uses the injected `ICopilotTokenManager`), keeping the token exchange pipeline intact.
- `setCopilotToken()` writes directly to `_tokenStore` and fires `onDidAuthenticationChange`, enabling test-driven token injection.
- ADO sessions always return `undefined` (not supported in this path).
- A standalone `setCopilotToken()` helper function enforces type-safety by asserting the service is a `StaticGitHubAuthenticationService` before calling the method.

### 2. SharedTokenWriter — Multi-Process Token Sharing (Fork Feature)

The `sharedTokenWriter.ts` is a **custom fork addition** (marked `FORK:TOKEN-SHARING`) that writes the Copilot API (CAPI) token to `~/.local/share/copilot-shared-token.json` for consumption by OpenCode (another AI coding tool).

**File format** (`SharedCopilotToken` interface):
- `token` — the CAPI token string (e.g., `tid=...`)
- `oauth_token` — optional OAuth token (`gho_...`) for fallback refresh
- `expires_at` — Unix timestamp (seconds) for expiry
- `source` — origin identifier (`vscode-insiders`, `vscode`, `opencode`)
- `source_version` — extension version string
- `updated_at` — write timestamp in milliseconds

**Atomic write pattern**: Writes to a `.tmp` file first, then renames to the target path. This prevents partial reads by the consumer process. Directory is created if missing.

**Best-effort semantics**: All errors are caught and logged as warnings — token sharing never crashes the extension. The function is async and fire-and-forget.

### 3. SimulationTestCopilotTokenManager — Singleton Test Token Manager

This manager solves the problem of **N simulation tests all needing a Copilot token without N separate GitHub API calls**. It uses a layered architecture:

- **`SimulationTestCopilotTokenManager`** — the public facade implementing `ICopilotTokenManager`. Delegates to a singleton.
- **`SingletonSimulationTestCopilotTokenManager`** — process-wide singleton (static `_instance`), lazily initialized. Selects strategy based on env vars:
  - `GITHUB_PAT` → `SimulationTestFixedCopilotTokenManager` (uses the PAT directly as the token, no exchange)
  - `GITHUB_OAUTH_TOKEN` → `SimulationTestCopilotTokenManagerFromGitHubToken` (performs real GitHub API exchange)
  - Neither set → throws error
- **`SimulationTestCopilotTokenManagerFromGitHubToken`** — performs a **real** `fetch()` to `https://api.github.com/copilot_internal/v2/token`, caches the result, and sets up a `setTimeout` for auto-refresh based on `refresh_in`. Uses a `fetchAlreadyGoing` flag to prevent duplicate concurrent fetches.
- **`SimulationTestFixedCopilotTokenManager`** — returns a fixed `CopilotToken` from a static string; no network calls.

### 4. Test Suites

**`authentication.spec.ts`**: Tests `StaticGitHubAuthenticationService` with `FixedCopilotTokenManager`:
- Verifies `getGitHubSession('any')` and `getGitHubSession('permissive')` return the injected token.
- Verifies `getCopilotToken()` returns the token via the manager.
- Tests `onDidAuthenticationChange` event fires when `setCopilotToken()` is called.
- Uses `createPlatformServices()` to build a full DI container for isolated testing.

**`copilotToken.spec.ts`**: Tests token exchange and validation:
- Uses `RefreshFakeCopilotTokenManager` (extends `BaseCopilotTokenManager`) and `StaticFetcherService` to simulate HTTP responses.
- Tests invalid GitHub tokens (access denied), network failures, JSON parse failures, rate limiting (403), and HTTP 401.
- Tests v1 vs v2 token parsing (`tid=...;dom=...;ol=...;exp=...` format).
- Tests `isTokenEnvelope`, `isErrorEnvelope`, `isStandardErrorEnvelope` validators.

## Patterns

| Pattern | Implementation | Purpose |
|---------|---------------|---------|
| **Test Double (Stub)** | `StaticGitHubAuthenticationService` | Replaces interactive auth with deterministic token provider |
| **Singleton** | `SingletonSimulationTestCopilotTokenManager` | Prevents N token fetches across N test instances |
| **Strategy** | PAT vs OAuth token manager selection | Runtime strategy based on environment variables |
| **Atomic File Write** | `sharedTokenWriter` temp+rename | Prevents partial reads in multi-process scenarios |
| **Best-Effort Fire-and-Forget** | `writeSharedToken` catch-all | Non-critical cross-process feature doesn't crash primary process |
| **Lazy Getter** | Session `accessToken` getter | Token provider invoked on access, not at construction |
| **Fake Service** | `StaticFetcherService`, `RefreshFakeCopilotTokenManager` | Controllable HTTP responses for deterministic tests |
| **DI Container Testing** | `createPlatformServices().createTestingAccessor()` | Full service graph with replaceable implementations |

## Applicability

These three components serve distinct layers of the auth architecture:

1. **StaticGitHubAuthenticationService** is the **standard test/CI auth path** — it plugs into the same `IAuthenticationService` interface used in production but bypasses VS Code's interactive authentication entirely. Any code that depends on `IAuthenticationService` works identically in tests.

2. **SharedTokenWriter** is a **cross-tool integration layer** — it extends the auth boundary beyond VS Code to external processes (OpenCode). The atomic write + defined JSON contract makes it a lightweight IPC mechanism without requiring sockets or shared memory.

3. **SimulationTestCopilotTokenManager** is the **simulation test infrastructure** — it ensures real API integration tests can run efficiently by sharing a single token across all test instances in a process.

Together they demonstrate that the auth system is designed for testability (static service), extensibility (shared writer), and efficiency (singleton manager).

## Open Questions

1. **SharedTokenWriter integration point** — Where in the production auth flow is `writeSharedToken()` called? Is it hooked into `CopilotTokenManagerFromGitHubToken.getCopilotToken()` or triggered by an event listener on token refresh?
2. **Token refresh coordination** — When OpenCode reads the shared token and it's near expiry, does OpenCode perform its own refresh using the `oauth_token`, or does it wait for VS Code to write a fresh one?
3. **`FixedCopilotTokenManager`** referenced in tests but defined in `src/platform/authentication/node/copilotTokenManager.ts` — how does it differ from `SimulationTestFixedCopilotTokenManager`? The test version is service-free while the production one likely participates in the full DI graph.
4. **Race condition in `fetchAlreadyGoing`** — The module-level boolean flag in the simulation manager could theoretically allow concurrent fetches if the first one errors and resets the flag before the second check. Is this an intentional simplification for tests?
