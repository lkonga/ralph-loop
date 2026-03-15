## Research Report 3: Visibility/Hidden Controls

### Findings

#### 1. `hiddenFromUser` on slash commands/intents
- **Type definition**: [src/extension/prompt/node/intents.ts](src/extension/prompt/node/intents.ts#L29) — `IIntentSlashCommandInfo.hiddenFromUser?: boolean`
- **Filtering**: [src/extension/commands/node/commandService.ts](src/extension/commands/node/commandService.ts#L30) — `.filter(candidate => !candidate.commandInfo || !candidate.commandInfo.hiddenFromUser)` excludes hidden intents from the user-visible command list.
- **Used by**: `generateCodeIntent.ts` (L23) and `unknownIntent.ts` (L24) — both set `hiddenFromUser: true` to hide internal-only slash commands.

#### 2. `user-invokable` / `userInvocable` frontmatter for prompts/agents
- **Parser attribute**: [src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts](src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser.ts#L84) — `PromptHeaderAttributes.userInvokable = 'user-invokable'`
- **Getter**: Same file L325-326 — `PromptHeader.userInvokable: boolean | undefined` reads the frontmatter boolean.
- **AgentConfig type**: [src/extension/agents/vscode-node/agentTypes.ts](src/extension/agents/vscode-node/agentTypes.ts#L30) — `readonly userInvocable?: boolean`
- **Markdown generation**: Same file L79 — `if (config.userInvocable === false) { lines.push('user-invocable: false'); }` — only emitted when explicitly false.
- **Explore agent**: [src/extension/agents/vscode-node/exploreAgentProvider.ts](src/extension/agents/vscode-node/exploreAgentProvider.ts#L35) — `userInvocable: false` — the Explore subagent is hidden from users; it's only callable by other agents.
- **GitHub org agents**: [src/extension/agents/vscode-node/githubOrgCustomAgentProvider.ts](src/extension/agents/vscode-node/githubOrgCustomAgentProvider.ts#L142-143) — reads `agent.user_invocable` from API and writes `user-invocable` frontmatter.

#### 3. `disable-model-invocation` frontmatter
- **Parser attribute**: promptFileParser.ts L85 — `PromptHeaderAttributes.disableModelInvocation = 'disable-model-invocation'`
- **Getter**: L329-330 — `PromptHeader.disableModelInvocation: boolean | undefined`
- **Used by built-in agents**: Plan agent (`planAgentProvider.ts` L24), Ask agent (`askAgentProvider.ts` L25), Edit mode agent (`editModeAgentProvider.ts` L19) — all set `disableModelInvocation: true` to prevent the model from invoking them autonomously.

#### 4. `isListedCapability` on intents
- **Type**: [src/extension/prompt/node/intents.ts](src/extension/prompt/node/intents.ts#L79) — `IIntent.isListedCapability?: boolean` — "Whether this intent is listed as a capability in the prompt."
- **Filtering**: [src/extension/prompts/node/base/capabilities.tsx](src/extension/prompts/node/base/capabilities.tsx#L33) — `!intent || intent.isListedCapability === false ? undefined : intent.description` — hides the intent from the capabilities list shown to the model.
- **Used by**: `setupTests.ts` L22 — `isListedCapability = false`.

#### 5. `excludeAgent` frontmatter attribute
- **Parser**: promptFileParser.ts L77 — `PromptHeaderAttributes.excludeAgent = 'excludeAgent'` — allows prompts to exclude specific agents.

#### 6. No generic "hidden" or "visibility" field on prompt files
- There is **no** `hidden`, `visibility`, `isInternal`, or `isPrivate` field in the `PromptHeaderAttributes` namespace.
- The only visibility controls are `user-invokable` (controls user visibility) and `disable-model-invocation` (controls model invocability).
- Traditional prompt `.prompt.md` files have no mechanism to hide from users — `user-invokable` is the closest equivalent and it works on agent definitions.

### Patterns

1. **Two-axis visibility model**: User visibility (`user-invokable`) and model invocability (`disable-model-invocation`) are independent axes. An agent can be visible to users but not auto-invocable by the model, or invisible to users but callable by other agents.

2. **Slash command hiding**: `hiddenFromUser` is a separate, older mechanism specifically for VS Code slash commands/intents. It works via filtering in `commandService.ts`.

3. **Capability listing**: `isListedCapability` controls whether an intent appears in the system prompt's capabilities section — it doesn't hide the command from the UI, just from the model's awareness.

4. **Default behavior**: All fields default to "visible/enabled" — you must explicitly set `false` to hide. The absence of a field means visible.

5. **Frontmatter vs TypeScript**: `.prompt.md` files use YAML frontmatter (`user-invokable`), while built-in intents use TypeScript interfaces (`hiddenFromUser`, `isListedCapability`).

### Applicability
**HIGH** — The `user-invokable: false` frontmatter field is directly usable in `.prompt.md` or `.agent.md` files to hide prompts from users. The pattern is well-established (Explore agent uses it). For ralph-loop, this means wave prompts could use `user-invokable: false` to hide internal/orchestration prompts from the user's slash command list while keeping them callable by agents.

### Open Questions

1. Does VS Code core (not the extension) also filter on `user-invokable` in its prompt file discovery UI, or is it only the Copilot Chat extension that respects it?
2. Is `user-invokable` the same as `user-invocable` (typo in agentTypes.ts)? The frontmatter parser uses `user-invokable` but the TypeScript config uses `userInvocable` — this inconsistency may cause bugs.
3. Can `user-invokable: false` be set on regular `.prompt.md` files (not agents), and will it hide them from the prompt picker?
