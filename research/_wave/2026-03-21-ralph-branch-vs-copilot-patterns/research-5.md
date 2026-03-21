# Research 5: Copilot's Full PR Workflow Pattern

## Findings

### Two Distinct Paths: Cloud Agent vs Local Agent (Background Agent)

Copilot has **two completely different PR workflows** depending on whether the work is delegated to the cloud or run locally.

---

### Path A: Cloud Agent (CCA — Copilot Cloud Agent)

**Source**: `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts`, `copilotCloudGitOperationsManager.ts`

#### Branch Naming Convention (Cloud — for uncommitted changes)

When the user has uncommitted changes and chooses "Commit Changes", a temporary branch is created to push those changes:

```
copilot/vscode-{timestamp_base36}-{random_base36_4chars}
```

**Generation** (in `copilotCloudGitOperationsManager.ts`):
- Prefix: `copilot`
- Pattern: `copilot/vscode-{Date.now().toString(36)}-{Math.random().toString(36).slice(2, 6)}`
- Collision avoidance: Tries up to 5 times, checks `refs/heads/` for existing refs
- Fallback: `copilot/vscode-{Date.now().toString(36)}` (without random suffix)

**Important**: This branch is only for pushing uncommitted changes as a `head_ref`. The actual PR branch is created by the cloud agent itself — VS Code doesn't control the cloud-side branch name.

#### User Choice Flow (Confirmation Dialog)

The `buildConfirmation()` method constructs a modal dialog with buttons based on the current state. The decision matrix:

| State | Buttons Shown | Flow |
|-------|---------------|------|
| **Needs auth + uncommitted changes** | `Authorize and Commit Changes`, `Authorize`, `Cancel` | Auth first, then commit+push |
| **Needs auth + branch not on remote** | `Authorize and Push Branch`, `Authorize`, `Cancel` | Auth first, then push branch |
| **Needs auth only** | `Authorize`, `Cancel` | Get permissive GitHub token |
| **Uncommitted changes (already authed)** | `Commit Changes and Delegate`, `Delegate`, `Cancel` | Optionally commit, then delegate |
| **Branch not on remote** | `Push Branch and Delegate`, `Delegate`, `Cancel` | Optionally push local branch, then delegate |
| **Clean state, first time** | `Delegate`, `Cancel` | Show base info message with delegation button |
| **Clean state, returning user** | *(no dialog)* | Skip confirmation, delegate immediately |

#### What Each Button Does

1. **Cancel**: Aborts. No changes pushed.
2. **Authorize**: Gets a "permissive" GitHub session via `getGitHubSession('permissive', { createIfNone: true })`.
3. **Commit Changes**: Calls `commitAndPushChanges()`:
   - Creates a random branch (`copilot/vscode-...`)
   - Commits all changes with message: `"Checkpoint from VS Code for cloud agent session"`
   - Pushes the branch to remote
   - Switches back to the original base branch
   - Returns the branch name as `head_ref`
4. **Push Branch**: Calls `pushBaseRefToRemote()`:
   - Pushes the current branch to the remote (force-push with `set-upstream`)
5. **Delegate**: Proceeds directly to cloud delegation without any git operations.

#### Delegation to Cloud

The `delegate()` method (line 1413):

1. **Summarizes chat history** if there's meaningful conversation
2. **Extracts references** from the user's prompt (file attachments, etc.)
3. **Resolves the repository** — uses selected repo or falls back to first Git repo
4. **Calls `invokeRemoteAgent()`** which:
   - Extracts a title from the prompt
   - Truncates to fit within 30,000 char context window
   - Constructs a `RemoteAgentJobPayload` with:
     - `problem_statement` (the prompt + context)
     - `pull_request.title` (extracted from prompt)
     - `pull_request.body_placeholder` (formatted)
     - `pull_request.base_ref` (the base branch)
     - `pull_request.head_ref` (if user pushed uncommitted changes)
     - `pull_request.body_suffix`: "Created from VS Code"
     - Optional: `custom_agent`, `model_name`, `agent_id`
   - POSTs the job via `postCopilotAgentJob()` to GitHub's API
   - Waits for the job to create a PR via `waitForJobWithPullRequest()`
5. **Result**: A PR number + session ID are returned
6. **Untitled sessions**: The session item is "committed" (renamed from untitled to the PR number)
7. **Regular delegation**: Shows message "A cloud agent has begun working on your request"

**The cloud agent creates the PR automatically** — the user doesn't get to review before a PR is created. The PR is created by the remote service, not by VS Code.

#### Base Branch Resolution

The `checkBaseBranchPresentOnRemote()` method determines the `base_ref`:
- If the current local branch exists on the remote → use it as `base_ref`
- If the current branch is NOT on the remote → fall back to the repo's default branch (e.g., `main`)
- This is critical: if you're on a feature branch that hasn't been pushed, the cloud agent will target `main` unless you push first

#### Follow-Up Messages

For existing sessions (non-untitled), the `handleFollowUp()` method:
- Posts a comment to the existing PR
- Attaches to the new session kicked off by the comment
- Streams progress back to the user

---

### Path B: Local Agent (Background Agent / Copilot CLI)

**Source**: `src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts`, `src/extension/chatSessions/common/folderRepositoryManager.ts`

#### Branch Naming Convention (Local — Worktree Isolation)

```
{git.branchPrefix}copilot/{randomBranchName_without_prefix}
```

Where:
- `branchPrefix` comes from VS Code's `git.branchPrefix` setting (default: `""`)
- `randomBranchName` is generated by `gitService.generateRandomBranchName()`
- Fallback: `{branchPrefix}copilot/worktree-{ISO_timestamp}`

Example: `copilot/amusing-platypus`, `myprefix-copilot/worktree-2026-03-21T10-30-00`

#### Isolation Modes

Two modes defined in `IsolationMode`:
- **`worktree`**: Creates an isolated git worktree for the session (default for Background Agent)
- **`workspace`**: Works directly in the workspace directory without isolation

#### Worktree Properties Tracked

```typescript
{
  branchName: string;           // e.g., "copilot/amusing-platypus"
  baseCommit: string;           // SHA of the commit the worktree branched from
  baseBranchName: string;       // e.g., "main"
  repositoryPath: string;       // path to main repo
  worktreePath: string;         // path to the isolated worktree
  version: 2;                   // v2 format
}
```

#### Applying/Merging Changes

Three approaches available in `ChatSessionWorktreeService`:

1. **`applyWorktreeChanges()`**: Generates a patch from `git diff` between `baseCommit` and the worktree branch, applies it to the main repo. For in-progress sessions with uncommitted files, it uses `migrateChanges()` (stash-based).

2. **`mergeWorktreeChanges()`**: Checks out the base branch in the main repo, then runs `git merge` with the worktree branch.

3. **`updateWorktreeBranch()`**: Updates the worktree to incorporate new changes from the base branch.

#### Rollback

- For cloud delegation: If `commitAndPushChanges()` fails mid-way, the `rollbackToOriginalBranch()` method checks out the original `baseRef`.
- For worktrees: Since changes are isolated in a worktree, the user can simply discard the worktree. Changes are never applied to the main workspace until the user explicitly triggers apply/merge.

---

### Interactive Commit Handling

When auto-commit fails (e.g., due to hooks or complex staging), the `handleInteractiveCommit()` method:
1. Opens a terminal named "GitHub Copilot Cloud Agent"
2. Shows a bold message asking the user to commit
3. Watches for a new commit (HEAD changes)
4. Times out after 5 minutes
5. User can close the terminal to cancel

---

### UX Philosophy

1. **Confirmation before action**: Cloud delegation always shows a confirmation dialog (except for returning users with a clean state)
2. **No silent pushes**: The user sees exactly what will be pushed and chooses
3. **Async-first for cloud**: The cloud agent works asynchronously — the user gets a PR link and can follow progress
4. **Isolation-first for local**: Background agent uses worktrees to avoid polluting the user's workspace
5. **Graceful degradation**: If worktree creation fails, falls back to workspace mode. If auto-commit fails, falls back to interactive terminal.

## Patterns

1. **Branch naming**: Always prefixed with `copilot/` — this is a consistent convention across both cloud and local paths
2. **Random branch generation**: Both paths use randomized branch names to avoid collisions, with retry logic
3. **Base branch detection**: Checks remote for current branch existence, uses repo default branch as fallback
4. **Explicit user consent**: No git operations happen without user clicking a button in the confirmation UI
5. **State machine approach**: The confirmation dialog is state-driven — it inspects auth status, uncommitted changes, and remote branch state to build the right set of options
6. **Separation of concerns**: Git operations (`CopilotCloudGitOperationsManager`), session content (`ChatSessionContentBuilder`), and delegation (`CopilotCloudSessionsProvider`) are cleanly separated
7. **Two-phase for uncommitted changes**: Creates a temporary branch → pushes it → switches back to original branch. The cloud agent then uses the pushed branch as `head_ref` for the PR.

## Applicability

For ralph-loop's feature branch E2E workflow:

1. **Branch naming**: Ralph could adopt a similar `prefix/random` convention (e.g., `ralph/feature-{timestamp}`) but should use more descriptive names since Ralph branches are developer-facing, not ephemeral
2. **User choice flow**: The confirmation dialog pattern (state-driven button generation) is a good model for any workflow that needs conditional user input before proceeding
3. **Worktree isolation**: If Ralph needs to run changes in isolation, the worktree pattern with tracked properties (`baseCommit`, `baseBranchName`, etc.) is well-proven
4. **Cloud delegation is opaque**: Note that Copilot's cloud agent handles the actual PR creation server-side — VS Code only submits the job and polls for results. Ralph's local-only model doesn't need this pattern
5. **Rollback strategy**: The "switch to temp branch → push → switch back" approach is safe but complex. For local-only workflows, worktree isolation provides cleaner rollback semantics

## Open Questions

1. **How does the cloud agent name its PR branch?** VS Code only controls the `base_ref` and `head_ref` (for uncommitted changes). The actual working branch created by the cloud agent is opaque — it's created server-side by GitHub's SWE agent service.
2. **What happens to the temporary `copilot/vscode-*` branch after PR merge?** There's no cleanup code in VS Code for these branches — presumably GitHub's service handles it.
3. **Does the local Background Agent ever create PRs?** The worktree service has `applyWorktreeChanges()` and `mergeWorktreeChanges()` but no PR creation. The local agent seems designed for local iteration, with cloud delegation as the PR path.
4. **How does multi-repo support work?** The `sessionRepositoryMap` tracks per-session repository selections, but the interaction between multiple repos and a single cloud agent job is unclear.
5. **What's the trust model for empty workspaces?** The `IFolderRepositoryManager` has MRU (Most Recently Used) folder tracking and trust prompting for agent sessions in empty windows.
