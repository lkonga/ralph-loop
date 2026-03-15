# FINAL REPORT: Authentication Patterns in vscode-copilot-chat

## Executive Summary

The vscode-copilot-chat extension implements a sophisticated, multi-layered authentication architecture that serves as the gateway to all AI-powered features. At its core, the system operates two fully independent authentication pipelines: a **GitHub/CAPI pipeline** for standard Copilot models (GitHub OAuth → short-lived CopilotToken → Bearer auth) and a **BYOK pipeline** for user-provided API keys (SecretStorage → per-request header injection), with a clean discriminator (`isBYOKModel()`) that drives branching across telemetry, rate limiting, and error handling throughout the codebase.

The GitHub pipeline employs a three-layer token architecture — OAuth Session → CopilotToken → CopilotTokenStore — with each layer addressing distinct concerns: session acquisition uses a waterfall scope resolution strategy (aligned → user:email → read:user) for backward compatibility, token minting uses two-tier schema validation with clock skew compensation for resilience, and the dependency-breaking CopilotTokenStore prevents circular dependency chains between auth, networking, and telemetry services. A dedicated permission upgrade service orchestrates scope escalation through a 5-step cascading guard with dual UI surfaces (modal dialog and in-chat confirmation), using repository-aware detection rather than theoretical scope comparison.

The BYOK pipeline supports three auth types (GlobalApiKey, PerModelDeployment, None) across eight providers, with Azure being the most complex case supporting dual auth (API key OR Entra ID). Security hardening is thorough: a ~30-header reserved blocklist, pattern-based blocking, Unicode injection prevention, and RFC 7230 validation protect against header manipulation. All model requests converge on a single header construction path in `networkRequest()`, making it the architectural chokepoint for auth injection.

The system is designed for testability via interface-driven swappable implementations (`StaticGitHubAuthenticationService`, `SimulationTestCopilotTokenManager`), extensibility via the Strategy pattern at every boundary (`IChatEndpoint.getExtraHeaders()`, `BYOKAuthType` branching), and resilience via graceful degradation at every failure point (waterfall scopes, two-tier validation, badge fallback on upgrade cancellation, best-effort token sharing). A fork-specific SharedTokenWriter extends the auth boundary to external tools via atomic file-based IPC.

## Consolidated Findings

### 1. GitHub OAuth Session Management

The `IAuthenticationService` interface exposes a dual-tier session model with three scope levels:
- **`GITHUB_SCOPE_USER_EMAIL`** (`['user:email']`) — minimum for Copilot API access
- **`GITHUB_SCOPE_READ_USER`** (`['read:user']`) — legacy backward compat for Completions extension
- **`GITHUB_SCOPE_ALIGNED`** (`['read:user', 'user:email', 'repo', 'workflow']`) — full access matching GitHub PR extension scopes

Session acquisition uses a **waterfall strategy** in `getAnyAuthSession()`: try aligned scopes silently → try user:email → try read:user → fall through to interactive flow. The `BaseAuthenticationService` abstract class handles shared lifecycle logic with concrete implementations for Node.js (`AuthenticationService`) and presumably web environments. `TaskSingler` deduplicates concurrent silent session requests keyed by operation type, while interactive flows bypass deduplication to force fresh auth. The central event handler `_handleAuthChangeEvent()` snapshots state, refreshes all sessions in parallel via `Promise.allSettled`, detects state deltas, and fires targeted events (`onDidAuthenticationChange`, `onDidAccessTokenChange`, `onDidAdoAuthenticationChange`). Error state transitions also trigger events, enabling UI updates for subscription state changes.

### 2. Copilot Token Lifecycle

CopilotTokens are short-lived credentials minted from OAuth tokens by hitting the `/copilot_internal/v2/token` CAPI endpoint. The lifecycle:

1. **Acquisition**: `VSCodeCopilotTokenManager._auth()` obtains a GitHub OAuth session, then `BaseCopilotTokenManager.doAuthFromGitHubTokenOrDevDeviceId()` fires parallel requests for token + user info.
2. **Validation**: `parseTokenResponse()` uses strict schema validation with graceful fallback to critical-only fields (`token`, `expires_at`, `refresh_in`). Telemetry tracks fallback usage to detect server-side schema drift.
3. **Clock skew compensation**: Server `expires_at` is overwritten with `nowSeconds() + refresh_in + 60` to handle misaligned clocks.
4. **Caching**: In-memory only (no disk persistence — deliberate security choice). `CopilotTokenStore` holds the active token as a dependency-breaking singleton.
5. **Refresh**: Lazy — triggered when `getCopilotToken()` detects `expires_at - 300 < nowSeconds()` (5-minute pre-expiry buffer). No proactive background refresh loop.
6. **Reset**: On HTTP 401/403, `resetCopilotToken()` clears the cached token and fires telemetry.
7. **Structure**: `CopilotToken` class parses raw token string (`key=val;...:mac`) into typed accessors for feature flags, SKU, plan, orgs, quota, and internal user detection.

### 3. Auth Permission Upgrade Flow

The `IAuthenticationChatUpgradeService` orchestrates scope escalation via a 5-step cascading guard:

1. Already prompted this session? → skip
2. Minimal mode enabled? → skip
3. Already have permissive session? → skip
4. Not signed in? → skip
5. Can access all workspace repos? → skip (checks actual repo accessibility via `IGithubRepositoryService.isAvailable()`)

**Two UI surfaces**:
- **Modal dialog** (startup): Proactive prompt guarded by `globalState` key. On cancel, falls back to Account menu badge.
- **In-chat confirmation**: Three-button inline confirmation (Grant / Not Now / Never Ask Again). After grant, the original user query is reconstructed from history and replayed with expanded permissions.

**Deduplication**: Three layers — in-memory flag (per session), `globalState` (cross-session), `AuthPermissionMode.Minimal` in settings (permanent opt-out).

### 4. BYOK Authentication

A fully independent auth pipeline supporting 8 providers across 3 auth types:

| Auth Type | Providers | Key Storage |
|---|---|---|
| `GlobalApiKey` | OpenAI, Anthropic, Gemini, xAI, OpenRouter | `copilot-byok-{provider}-api-key` |
| `PerModelDeployment` | Azure | `copilot-byok-{provider}-{modelId}-api-key` |
| `None` | Ollama | N/A |

Keys stored in VS Code `SecretStorage` (OS-keychain-backed); metadata (URLs, capabilities) in `globalState` as plain JSON. Key retrieval uses fallback chain: model-specific → provider-level. OpenAI-compatible providers inject auth via `OpenAIEndpoint.getExtraHeaders()` (`Authorization: Bearer` or Azure's `api-key`). Native SDK providers (Anthropic, Gemini) pass keys directly to vendor SDK constructors. Azure supports dual auth: API key OR Entra ID via `vscode.authentication.getSession()`. No key pre-validation or rotation mechanism exists. Model capabilities resolved via CDN-hosted `copilotChat.json`, decoupling updates from extension releases.

### 5. Request Authentication Pipeline

All model requests converge on a single header construction path:

```
IAuthenticationService.getCopilotToken()
  → CopilotToken.token (raw string)
    → secretKey parameter
      → Authorization: Bearer ${secretKey}  (in networkRequest())
```

**BYOK override**: `secretKey ??= copilotToken.token` — BYOK key takes precedence when set.

**Header merge**: Base headers (`Authorization`, `X-Request-Id`, `OpenAI-Intent`, `X-GitHub-Api-Version`) + endpoint-specific headers (`IChatEndpoint.getExtraHeaders()`) merged via spread. Endpoint headers win on collision. This path serves all consumers: chat, completions, GitHub API, remote agents, proxy models, router decisions, automode, image service, content exclusion, xtab, Claude adapter, and Maestro MCP.

Security hardening on custom headers: ~30-header reserved blocklist, `proxy-*`/`sec-*` prefix blocking, CR/LF injection prevention, bidirectional Unicode rejection, zero-width character blocking, limits (20 headers, 256-char names, 8192-char values), RFC 7230 validation.

### 6. Static Auth & Test Infrastructure

- **`StaticGitHubAuthenticationService`**: Replaces interactive VS Code auth with a constructor-injected token provider function. Creates synthetic `AuthenticationSession` objects with lazy `accessToken` getters. Supports `setCopilotToken()` for test-driven token injection.
- **`SimulationTestCopilotTokenManager`**: Process-wide singleton preventing N tests from making N token fetches. Strategy selection via env vars: `GITHUB_PAT` → static token, `GITHUB_OAUTH_TOKEN` → real CAPI exchange with auto-refresh.
- **`SharedTokenWriter`** (fork feature): Writes CAPI token to `~/.local/share/copilot-shared-token.json` for cross-tool consumption. Atomic temp+rename write pattern. Best-effort / fire-and-forget semantics. Includes OAuth token for fallback refresh.

## Pattern Catalog

| # | Pattern | Description | Where It Appears | Why It Matters |
|---|---------|-------------|------------------|----------------|
| 1 | **Three-Layer Token Pipeline** | OAuth Session → CopilotToken → CopilotTokenStore | `IAuthenticationService`, `CopilotTokenManager`, `CopilotTokenStore` | Foundation of all API access; separates concerns of acquisition, exchange, and consumption |
| 2 | **Waterfall Scope Resolution** | Try progressively narrower OAuth scopes silently before interactive prompts | `getAnyAuthSession()` in `session.ts` | Maximizes backward compatibility without user friction |
| 3 | **Dependency-Breaking Store** | Singleton cache (`CopilotTokenStore`) breaks circular deps between auth ↔ networking ↔ telemetry | `copilotTokenStore.ts` | Classic mediator pattern preventing DI cycles |
| 4 | **TaskSingler Deduplication** | Map-based promise deduplication keyed by operation type | Auth sessions, token minting | Prevents thundering herd on concurrent requests |
| 5 | **Two-Tier Schema Validation** | Strict validation with fallback to critical-only fields + telemetry tracking | `parseTokenResponse()` in `copilotToken.ts` | Survives server-side schema drift without breaking clients |
| 6 | **Clock Skew Compensation** | Override server `expires_at` with local time + `refresh_in` + buffer | Token minting in `BaseCopilotTokenManager` | Handles users whose clocks diverge from server |
| 7 | **Cascading Guard Pattern** | Multi-step early-return guards with trace logging at each decision point | `shouldRequestPermissiveSessionUpgrade()` | Debuggable decision trees without breakpoints |
| 8 | **Dual UI Surface** | Same auth upgrade flow exposed as modal (proactive) and in-chat confirmation (contextual) | `AuthUpgradeAsk`, `AuthenticationChatUpgradeService` | Different UX for different interaction moments |
| 9 | **Request Replay** | After in-chat permission upgrade, reconstruct and re-execute original user query | `handleConfirmationRequest()` | Seamless UX recovery after permission grant |
| 10 | **Strategy Pattern for Auth** | `BYOKAuthType` enum, `IChatEndpoint.getExtraHeaders()`, env-var token manager selection | BYOK, endpoints, test infrastructure | Primary extensibility mechanism — new auth types plug in via interfaces |
| 11 | **Lazy Token Resolution** | `secretKey ??= copilotToken.token` — BYOK key takes precedence, CopilotToken is fallback | `chatMLFetcher.ts` | Clean parallel pipeline merging without conditionals |
| 12 | **Reserved Header Protection** | Blocklist + pattern blocking + injection prevention for user-defined headers | `OpenAIEndpoint` in BYOK | Prevents auth override and injection attacks |
| 13 | **Atomic File Write** | Temp file + rename for cross-process token sharing | `sharedTokenWriter.ts` | Prevents partial reads in multi-process scenarios |
| 14 | **Interface-Driven Testability** | Swappable auth implementations behind stable interfaces, wired via DI | `Static*Service`, `SimulationTest*Manager` | Deterministic testing without network or VS Code UI |
| 15 | **Eager Error Classification** | Raw HTTP errors immediately mapped to typed error classes with notification IDs | Token fetch error handling | Precise user messaging and telemetry per error category |
| 16 | **Observable Derived State** | `isMinimalMode` uses `derived()` from observable infrastructure | `BaseAuthenticationService` | Reactive config tracking without polling |
| 17 | **Event-Driven State Propagation** | Auth state changes propagate via events; consumers react, don't poll | `onDidAuthenticationChange`, `onDidGrantAuthUpgrade` | Decoupled state management across features |

## Architecture Diagram (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER INTERACTION                                │
│   [Sign In] [Permission Upgrade Modal] [In-Chat Upgrade] [BYOK Setup]  │
└──────┬──────────────┬─────────────────────┬───────────────────┬─────────┘
       │              │                     │                   │
       ▼              ▼                     │                   ▼
┌──────────────┐ ┌────────────────────┐     │      ┌───────────────────┐
│  VS Code     │ │ AuthChatUpgrade    │     │      │ BYOKStorage       │
│  Auth API    │ │ Service            │     │      │ Service           │
│              │ │ (5-step guard,     │     │      │ (SecretStorage)   │
│ getSession() │ │  dual UI surface)  │     │      │                   │
└──────┬───────┘ └────────┬───────────┘     │      └────────┬──────────┘
       │                  │                 │               │
       ▼                  ▼                 │               │
┌─────────────────────────────────────┐     │     ┌─────────▼──────────┐
│     IAuthenticationService          │     │     │ BYOK Providers     │
│  ┌───────────┐  ┌───────────────┐   │     │     │ (OpenAI, Anthropic │
│  │ "any"     │  │ "permissive"  │   │     │     │  Gemini, Azure,    │
│  │ session   │  │ session       │   │     │     │  Ollama, xAI,      │
│  │ (email)   │  │ (repo+wf)    │   │     │     │  OpenRouter,Custom) │
│  └─────┬─────┘  └──────┬───────┘   │     │     └─────────┬──────────┘
│        │               │           │     │               │
│        └───────┬───────┘           │     │               │
│                ▼                   │     │               │
│  ┌─────────────────────────┐       │     │               │
│  │ CopilotTokenManager     │       │     │               │
│  │ (CAPI /v2/token)        │       │     │               │
│  │ [TaskSingler dedup]     │       │     │               │
│  │ [2-tier validation]     │       │     │               │
│  │ [clock skew comp]       │       │     │               │
│  └───────────┬─────────────┘       │     │               │
│              ▼                     │     │               │
│  ┌─────────────────────────┐       │     │               │
│  │ CopilotTokenStore       │       │     │               │
│  │ (dependency-breaking    │       │     │               │
│  │  singleton cache)       │       │     │               │
│  └───────────┬─────────────┘       │     │               │
└──────────────┼─────────────────────┘     │               │
               │                           │               │
               │    ┌──────────────────┐   │               │
               │    │ SharedTokenWriter│   │               │
               ├───►│ (fork: atomic    │   │               │
               │    │  file IPC)       │   │               │
               │    └──────────────────┘   │               │
               │                           │               │
               ▼                           │               ▼
┌──────────────────────────────────────────┴───────────────────────────┐
│                    networkRequest()                                   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ secretKey ??= copilotToken.token    ◄── BYOK key precedence   │  │
│  │                                                                │  │
│  │ Headers:                                                       │  │
│  │   Authorization: Bearer ${secretKey}                           │  │
│  │   X-Request-Id: ${requestId}                                   │  │
│  │   OpenAI-Intent: ${intent}                                     │  │
│  │   X-GitHub-Api-Version: 2025-05-01                             │  │
│  │   + endpoint.getExtraHeaders()  ◄── Strategy pattern           │  │
│  │   + [reserved header protection]                               │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │   AI Model Endpoints    │
              │  (GitHub Copilot, BYOK  │
              │   vendors, Azure, etc.) │
              └─────────────────────────┘
```

## Priority Matrix

| Pattern | Significance | Complexity | Key Files |
|---------|-------------|-----------|-----------|
| Three-Layer Token Pipeline (OAuth→CopilotToken→Store) | **Critical** — foundation of all API access | High | `authentication.ts`, `copilotTokenManager.ts`, `copilotTokenStore.ts` |
| Dual Auth Pipelines (CAPI vs BYOK) | **Critical** — determines entire request flow | High | `chatMLFetcher.ts`, `byokStorageService.ts`, `openAIEndpoint.ts` |
| Unified Header Construction (`networkRequest()`) | **Critical** — single chokepoint for auth injection | Medium | `networking.ts`, `chatMLFetcher.ts` |
| Waterfall Scope Resolution | **High** — controls feature availability | Medium | `session.ts` |
| Permission Upgrade Orchestration | **High** — user-facing auth UX | High | `authenticationChatUpgrade*.ts`, `authentication.contribution.ts` |
| Strategy Pattern (endpoints, auth types) | **High** — primary extensibility mechanism | Medium | `IChatEndpoint`, `BYOKAuthType`, `AbstractLMProvider` |
| Reserved Header Protection | **High** — security-critical for BYOK | Medium | `openAIEndpoint.ts` |
| TaskSingler Concurrency Control | **Medium** — prevents thundering herd | Low | `authenticationService.ts`, `copilotTokenManager.ts` |
| Two-Tier Token Validation | **Medium** — resilience against schema drift | Low | `copilotToken.ts` |
| Dependency-Breaking Store | **Medium** — architectural pattern | Low | `copilotTokenStore.ts` |
| Interface-Driven Testability | **Medium** — enables CI/simulation testing | Medium | `StaticGitHubAuthenticationService`, `SimulationTestCopilotTokenManager` |
| Request Replay After Upgrade | **Medium** — seamless UX recovery | Medium | `authenticationChatUpgradeService.ts` |
| SharedTokenWriter (fork IPC) | **Low** (fork-specific) — cross-tool interop | Low | `sharedTokenWriter.ts` |
| Eager Error Classification | **Medium** — precise user messaging | Low | `copilotTokenManager.ts` |
| Clock Skew Compensation | **Low** — edge case resilience | Low | `copilotTokenManager.ts` |

## Recommended Investigation Plan

1. **`networkRequest()` internals** — Trace the complete header construction and request lifecycle in `src/platform/networking/common/networking.ts`. This is the single chokepoint for any Ralph auth hook integration.

2. **`ICAPIClientService` endpoint selection** — Understand primary/fallback CAPI endpoint resolution. Critical for token exchange reliability and potential hook points.

3. **Server-side BYOK (type 2)** — `isBYOKModel()` returns `2` for `customModel` endpoints routed through CAPI. This undocumented path differs from client-side BYOK and may affect auth interception.

4. **WebSocket auth path** — `_doFetchViaWebSocket` constructs `Authorization: Bearer` independently from HTTP. Verify consistency or document divergence.

5. **Web environment auth** — The web-specific `AuthenticationService` (likely in a `vscode-web/` directory) was not examined. May differ significantly from the Node.js path.

6. **Extension-contributed model auth** — `endpoint.isExtensionContributed` allows third-party extensions to provide models. Trust boundaries and auth constraints are undocumented.

7. **`RefreshableCopilotTokenManager` refresh timing** — Trace the exact refresh buffer, race condition handling, and behavior under burst workloads at the 5-minute boundary.

8. **GitHub Enterprise differences** — GHE uses custom `authProviderId` and potentially different scope requirements. The entire GHE auth flow is unexamined.

## Gaps & Open Questions

### Architecture Gaps
- **Web implementation**: No report covers the web-specific `AuthenticationService`. The web variant likely differs in session acquisition and may not support all features.
- **Server-side BYOK (type 2)**: The `customModel` CAPI-routed BYOK path is completely uninvestigated.
- **WebSocket vs HTTP auth divergence**: Two independent `Authorization: Bearer` construction paths may drift.
- **CAPI endpoint selection logic**: Primary/fallback endpoint resolution in `ICAPIClientService` is a black box.

### Security Gaps
- **BYOK key validation**: No pre-validation or "test connection" mechanism. Invalid keys only error on first use.
- **BYOK key rotation/expiration**: No explicit mechanism. Keys persist in SecretStorage indefinitely until manually deleted.
- **Extension-contributed model trust boundaries**: Third-party model providers via `isExtensionContributed` have undocumented auth constraints.

### Operational Gaps
- **No proactive token refresh**: Lazy refresh could cause latency spikes at the 5-minute boundary under burst workloads.
- **Rate limiting recovery**: `RateLimitedError` is classified but no retry-after/backoff mechanism exists in the token layer.
- **Multi-account handling**: `TODO` comments reference GitHub becoming a "true multi-account provider" — current workarounds use `clearSessionPreference`.

### Telemetry Gaps
- **Permission upgrade grant/decline rates**: No visible telemetry emission for tracking user responses to the upgrade prompt.
- **Token refresh latency**: Refresh timing and failure rates are not tracked in the examined files.

### Integration Gaps
- **SharedTokenWriter invocation point**: Exact production callsite for `writeSharedToken()` was not definitively traced (likely an event listener on token store update).
- **Cross-process refresh coordination**: When the shared token nears expiry, the coordination protocol between VS Code and OpenCode is unclear.
- **ADO authentication**: Azure DevOps auth via Microsoft provider is mentioned but not deeply covered.

---

*Generated: 2026-03-15 | Sources: 6 research reports + 2 aggregation reports | Scope: vscode-copilot-chat authentication architecture*
