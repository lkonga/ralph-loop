# Research 3: Auth Permission Upgrade Flow

## Findings

### Token Kinds: "permissive" vs "any"
The `IAuthenticationService.getGitHubSession()` accepts a `kind` parameter with two values:
- **`'any'`**: A basic session with minimal scopes (e.g. `user:email`) — enough for Copilot API access but NOT for reading private repo contents.
- **`'permissive'`**: A session with the `repo` scope — grants read/write access to private repositories on GitHub.

The extension treats these as two distinct cached sessions: `_anyGitHubSession` and `_permissiveGitHubSession` on `BaseAuthenticationService`.

### Minimal Mode Opt-Out
A user setting `AuthPermissionMode.Minimal` (config key `github.copilot.advanced.authPermissions`) permanently blocks all permissive token acquisition. When enabled:
- Interactive flows with `'permissive'` kind throw `MinimalModeError`
- Silent flows return `undefined`
- The upgrade service skips prompting (`shouldRequestPermissiveSessionUpgrade` returns false)

### Upgrade Detection: `shouldRequestPermissiveSessionUpgrade()`
Located in `AuthenticationChatUpgradeService`, this method runs a 5-step decision cascade:

1. **Already prompted this session?** → skip (in-memory flag `hasRequestedPermissiveSessionUpgrade`)
2. **Minimal mode enabled?** → skip
3. **Already have permissive session?** → skip (silent check via `getGitHubSession('permissive', { silent: true })`)
4. **Not signed in at all?** → skip
5. **Can access all workspace repos with current token?** → skip (calls `_canAccessAllRepositories()` which checks each git remote against `IGithubRepositoryService.isAvailable()`)

Only if ALL checks pass (user is signed in with a restrictive token AND cannot access at least one workspace repo) does it return `true`.

### Two Upgrade UI Paths

#### Path 1: Modal Dialog (startup proactive prompt)
Triggered by `AuthUpgradeAsk` in `authentication.contribution.ts`:
- Waits for chat to be enabled (copilot token available)
- Calls `shouldRequestPermissiveSessionUpgrade()`
- Guards against repeat prompting via `globalState` key `copilot.shownPermissiveTokenModal`
- Calls `showPermissiveSessionModal()` which uses `forceNewSession` with a localized detail message and a "Learn More" link (`https://aka.ms/copilotRepoScope`)
- If user cancels, falls back to a badge-style silent request (`getGitHubSession('permissive', {})`) so the Account menu shows a pending action

#### Path 2: In-Chat Confirmation
Triggered during chat conversations via `showPermissiveSessionUpgradeInChat()`:
- Renders a `stream.confirmation()` inline in the chat with three buttons:
  - **"Grant"** → acquires permissive session via `createIfNone`, fires `onDidGrantAuthUpgrade` event
  - **"Not Now"** → shows a friendly dismissal message, creates badge via silent request
  - **"Never Ask Again"** → sets `AuthPermissionMode.Minimal` in settings, permanently disabling future prompts
- After user responds, `handleConfirmationRequest()` replays the original user request that triggered the prompt (reconstructed from chat history)

### Re-trigger Logic
- `AuthUpgradeAsk` listens to `onDidAuthenticationChange` — if user signs out and back in, the `globalState` flag resets and `hasRequestedPermissiveSessionUpgrade` resets, allowing re-prompting
- Window focus awareness: if the auth change fires while the window is unfocused, the prompt waits for `onDidChangeWindowState` before showing
- A manual command `github.copilot.chat.triggerPermissiveSignIn` allows explicit re-triggering (bypasses repeat check)

## Patterns

1. **Cascading Guard Pattern**: `shouldRequestPermissiveSessionUpgrade` uses early-return guards with trace logging for each decision point — facilitates debugging without breakpoints
2. **Dual UI Surface**: Same upgrade flow exposed both as a modal (proactive) and as an inline chat confirmation (contextual) — different UX for different moments
3. **Graceful Degradation**: On user cancellation, the system falls back to a badge/Account menu notification rather than losing the opportunity entirely
4. **Session-level + Persistent Deduplication**: In-memory flag prevents repeat prompts within a session; `globalState` prevents across sessions; `AuthPermissionMode.Minimal` prevents permanently
5. **Request Replay**: After in-chat upgrade, the original user query is reconstructed from history and re-executed with the new permissions — seamless UX recovery
6. **Repository-Aware Detection**: Upgrade need is determined by actual repository accessibility, not just scope comparison — practical vs theoretical permission gaps

## Applicability

This upgrade flow is tightly integrated with the broader auth architecture:
- `IAuthenticationService` provides the two-tier session model (`any` vs `permissive`)
- `IAuthenticationChatUpgradeService` is a dedicated service for upgrade orchestration, cleanly separated from core auth
- The `onDidGrantAuthUpgrade` event allows other features (context resolution, workspace search) to re-fetch data with expanded permissions
- The `_canAccessAllRepositories` check bridges auth with git service and GitHub repository service, making the upgrade context-aware rather than scope-driven

## Open Questions

1. **Scope details**: What exact OAuth scopes constitute "permissive" vs "any"? The `repo` scope is implied but the actual scope list is likely defined in the VS Code GitHub auth provider, not in this extension.
2. **Badge behavior**: The fallback `getGitHubSession('permissive', {})` call on cancellation presumably creates an Account menu badge — how does the user interact with that badge to later grant permissions?
3. **GitHub Enterprise**: Does the upgrade flow work the same way for GHE tokens, or is it GitHub.com only?
4. **Rate of upgrade success**: No telemetry emission is visible in these files for tracking grant/decline rates — is it tracked elsewhere?
5. **Multi-repo edge cases**: If only one of N workspace repos is inaccessible, the upgrade triggers — but what if the inaccessible repo is irrelevant to the user's chat query?
