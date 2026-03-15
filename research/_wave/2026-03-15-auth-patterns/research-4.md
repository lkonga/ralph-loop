# Research 4: BYOK Authentication Patterns

## Findings

### Key Storage Mechanism

BYOK uses VS Code's **SecretStorage API** (`extensionContext.secrets`) for all API key persistence. Keys are stored under deterministic namespaced keys following the pattern:

- **Provider-level**: `copilot-byok-{providerName}-api-key` (for `GlobalApiKey` auth type)
- **Model-level**: `copilot-byok-{providerName}-{modelId}-api-key` (for `PerModelDeployment` auth type)

Model metadata (deployment URLs, capabilities, registration status) is stored separately in **globalState** under `copilot-byok-{providerName}-models-config` as plain JSON — only secrets use SecretStorage.

Key retrieval implements a **fallback chain**: model-specific key → provider-level key. Empty/whitespace-only keys are rejected at both store and retrieve time via `.trim()` checks.

### Three Auth Types (BYOKAuthType enum)

| Auth Type | Example Providers | Key Scope | Storage Pattern |
|---|---|---|---|
| `GlobalApiKey` | OpenAI, Anthropic, Gemini, xAI, OpenRouter | One key per provider | `copilot-byok-{provider}-api-key` |
| `PerModelDeployment` | Azure | Key + URL per model | `copilot-byok-{provider}-{modelId}-api-key` |
| `None` | Ollama | No key stored | N/A |

### Per-Request Auth Injection

The key injection path differs by provider category:

**OpenAI-compatible providers** (OpenAI, Ollama, OpenRouter, xAI, Azure, Custom):
1. `provideLanguageModelChatInformation()` retrieves key from storage (or from `configuration.apiKey` passed by VS Code LM API)
2. Key flows into `createOpenAIEndPoint()` which instantiates `OpenAIEndpoint(modelInfo, apiKey, url)`
3. `OpenAIEndpoint.getExtraHeaders()` injects auth:
   - Standard: `Authorization: Bearer {apiKey}`
   - Azure OpenAI: `api-key: {apiKey}` header
   - AzureOpenAIEndpoint subclass: Always uses `Authorization: Bearer {token}`, deletes `api-key`

**Azure special case**: When no API key is present, Azure falls back to **Microsoft Entra ID (AAD)** authentication via `vscode.authentication.getSession()` with scope `https://cognitiveservices.azure.com/.default`, passing the session's `accessToken` as the bearer token.

**Native SDK providers** (Anthropic, Gemini):
1. Key retrieved the same way from storage
2. Passed directly to vendor SDK constructors: `new Anthropic({ apiKey })`, `new GoogleGenAI({ apiKey })`
3. SDKs handle their own HTTP auth headers internally

### Provider Registration Pattern

`BYOKContrib` orchestrates registration:
1. Listens for authentication changes (`onDidAuthenticationChange`)
2. Checks if BYOK is enabled via Copilot token + feature flags (`isBYOKEnabled`)
3. Fetches known model capabilities from CDN (`https://main.vscode-cdn.net/extensions/copilotChat.json`)
4. Instantiates all 8 providers via DI (`IInstantiationService.createInstance`)
5. Registers each with `lm.registerLanguageModelChatProvider(providerName, provider)`

Providers are registered once and never re-registered (guarded by `_byokProvidersRegistered` flag).

### Model Discovery & Validation

Each provider discovers available models differently:
- **OpenAI/xAI/OpenRouter**: `GET /v1/models` with `Authorization: Bearer` header
- **Anthropic**: `new Anthropic({ apiKey }).models.list()` (SDK method)
- **Gemini**: `new GoogleGenAI({ apiKey }).models.list()` (SDK method)
- **Ollama**: `GET /v1/models` (no auth required)
- **Azure**: No model discovery; models configured per-deployment by user

If silent mode is active and no key exists, all providers return empty model lists — this is the implicit "validation" (invalid keys trigger errors on first real request, not during discovery).

### Security Hardening

`OpenAIEndpoint` implements extensive header sanitization for custom model-defined headers:
- **Reserved headers blocklist**: `authorization`, `api-key`, `cookie`, `host`, etc. cannot be overridden
- **Pattern-based blocking**: `proxy-*`, `sec-*` prefixes rejected
- **Injection prevention**: Control characters (CR/LF), bidirectional Unicode overrides, zero-width characters all rejected
- **Limits**: Max 20 custom headers, 256-char names, 8192-char values
- RFC 7230 compliant header name validation

## Patterns

1. **Abstract Factory + Template Method**: `AbstractLanguageModelChatProvider` defines the lifecycle; subclasses override `getAllModels()`, `getModelsBaseUrl()`, response handling. Two parallel hierarchies:
   - OpenAI-compatible: `AbstractOpenAICompatibleLMProvider` → `OpenAIEndpoint` for HTTP
   - Native SDK: Direct `AbstractLanguageModelChatProvider` → vendor SDK calls

2. **Strategy Pattern for Auth**: `BYOKAuthType` enum drives branching in storage, retrieval, and deletion — the storage service adapts key scoping based on the enum value.

3. **Secure Secret Storage**: Separation of concerns — secrets in SecretStorage (encrypted by OS keychain), metadata in globalState (plain JSON). Keys never logged or serialized to disk outside SecretStorage.

4. **Capability Resolution Chain**: Model capabilities resolved in priority order: user-specified `modelCapabilities` → CDN-fetched `knownModels` → hardcoded defaults (128k context, 8k output).

5. **Migration Pattern**: Multiple providers include `migrateExistingConfigs()` methods that move keys from deprecated config locations (e.g., old Azure config keys, old Ollama endpoint settings) into the new unified storage. These are time-bounded TODOs.

## Applicability

- The BYOK auth system is **completely independent** from Copilot's GitHub-authenticated endpoint system. BYOK keys bypass CAPI (Copilot API) entirely — requests go direct to vendor APIs.
- The `isBYOKModel()` function returns `1` for client-side BYOK (all providers here), `2` for server-side BYOK (custom models via CAPI), `-1` for standard Copilot models — this distinction drives different telemetry, rate limiting, and error handling paths throughout the codebase.
- Azure's dual auth (API key OR Entra ID) is the most complex path and the only one that uses VS Code's built-in authentication providers.
- The CDN-hosted known models list (`copilotChat.json`) enables capability updates without extension releases.

## Open Questions

1. **Key rotation**: No explicit key rotation or expiration mechanism exists. Keys persist in SecretStorage until manually deleted.
2. **Validation timing**: API keys are never pre-validated — invalid keys only surface as errors on first model list fetch or chat request. No dedicated "test connection" flow in the provider layer.
3. **Rate limit handling**: `hydrateBYOKErrorMessages()` reformats rate limit errors but there's no client-side rate limiting or retry logic specific to BYOK providers.
4. **Server-side BYOK (type 2)**: The `isBYOKModel()` function references a server-side BYOK mode (`customModel` flag on endpoints) that routes through CAPI — this path was not investigated here.
5. **`configureDefaultGroupWithApiKeyOnly` migration**: Marked with "TODO: Remove after 6 months" — migrates old provider-level keys to the new VS Code LM provider group system. Current status of deprecation timeline unclear.
