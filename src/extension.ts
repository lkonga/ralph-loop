import * as vscode from 'vscode';
import { HookBridgeDisposable, registerHookBridge, startChatSendWatcher } from './hookBridge';
import { LoopOrchestrator, loadConfig } from './orchestrator';
import { SessionPersistence } from './sessionPersistence';
import { ShellHookProvider } from './shellHookProvider';
import { disposeStatusBar, updateStatusBar } from './statusBar';
import { fireStateChangeNotification } from './stateNotification';
import { ChatSendRequest, IRalphHookService, LoopEventKind, LoopState, createOutputLogger } from './types';

let orchestrator: LoopOrchestrator | undefined;
let outputChannel: vscode.LogOutputChannel;
let hookBridgeDisposable: HookBridgeDisposable | undefined;
let sessionTrackingDisposable: vscode.Disposable | undefined;

async function resolveWorkspaceRoot(): Promise<string | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showErrorMessage('Ralph Loop: No workspace folder open');
		return undefined;
	}

	const prdFiles = await vscode.workspace.findFiles('**/PRD.md', '**/node_modules/**', 10);

	if (prdFiles.length === 0) {
		vscode.window.showErrorMessage('Ralph Loop: No PRD.md found in workspace');
		return undefined;
	}

	let prdUri: vscode.Uri;
	if (prdFiles.length === 1) {
		prdUri = prdFiles[0];
	} else {
		const picked = await vscode.window.showQuickPick(
			prdFiles.map(uri => ({
				label: vscode.workspace.asRelativePath(uri),
				uri,
			})),
			{ placeHolder: 'Multiple PRD.md files found — pick one' }
		);
		if (!picked) {
			return undefined;
		}
		prdUri = picked.uri;
	}

	const folder = vscode.workspace.getWorkspaceFolder(prdUri);
	if (folder) {
		return folder.uri.fsPath;
	}
	if (folders.length === 1) {
		return folders[0].uri.fsPath;
	}
	vscode.window.showErrorMessage('Ralph Loop: Could not determine workspace root for PRD.md');
	return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Ralph Loop', { log: true });
	const logger = createOutputLogger(outputChannel);

	// Always-active watcher for chatSend signal files (used by wave hooks, etc.)
	context.subscriptions.push(startChatSendWatcher(logger));

	context.subscriptions.push(
		vscode.commands.registerCommand('ralph-loop.start', async () => {
			if (orchestrator && orchestrator.getState() !== 'idle') {
				vscode.window.showWarningMessage('Ralph Loop: Already running');
				return;
			}

			const workspaceRoot = await resolveWorkspaceRoot();
			if (!workspaceRoot) {
				return;
			}

			const config = loadConfig(workspaceRoot);

			let hookService: IRalphHookService | undefined;
			if (config.hookScript) {
				logger.log(`Shell hook script configured: ${config.hookScript}`);
				hookService = new ShellHookProvider(config.hookScript, logger);
			}

			// Register hook bridge if enabled (requires vscode.proposed.chatHooks)
			if (config.features.useHookBridge) {
				try {
					hookBridgeDisposable = registerHookBridge(config, logger);
					logger.log('Hook bridge registered (chat.hooks Stop + PostToolUse)');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.warn(`Hook bridge registration failed (proposed API may be unavailable): ${msg}`);
				}
			}

			// Session tracking if enabled (requires vscode.proposed.chatParticipantPrivate)
			if (config.features.useSessionTracking) {
				try {
					const win = vscode.window as any;
					if (typeof win.activeChatPanelSessionResource !== 'undefined') {
						const uri = win.activeChatPanelSessionResource as vscode.Uri | undefined;
						const sessionId = uri?.toString();
						logger.log(`Initial chat session: ${sessionId ?? 'none'}`);
						// Will be set on orchestrator after construction below
						sessionTrackingDisposable?.dispose();
						// Watch for session changes via polling (proposed API has no change event)
						let lastSessionId = sessionId;
						const interval = setInterval(() => {
							const current = (win.activeChatPanelSessionResource as vscode.Uri | undefined)?.toString();
							if (current !== lastSessionId) {
								orchestrator?.setSessionId(current);
								lastSessionId = current;
							}
						}, 2000);
						sessionTrackingDisposable = new vscode.Disposable(() => clearInterval(interval));
					} else {
						logger.warn('Session tracking enabled but activeChatPanelSessionResource not available (proposed API missing)');
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.warn(`Session tracking setup failed: ${msg}`);
				}
			}

			orchestrator = new LoopOrchestrator(config, logger, event => {
				switch (event.kind) {
					case LoopEventKind.TaskStarted:
						logger.log(`▶ [iter ${event.iteration}] Starting: ${event.task.description}`);
						fireStateChangeNotification(LoopState.Running, event.task.taskId);
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.CopilotTriggered:
						logger.log(`⚡ Copilot triggered via ${event.method}`);
						break;
					case LoopEventKind.WaitingForCompletion:
						logger.log(`⏳ Waiting for completion: ${event.task.description}`);
						break;
					case LoopEventKind.TaskCompleted:
						logger.log(`✔ Completed in ${Math.round(event.durationMs / 1000)}s: ${event.task.description}`);
						fireStateChangeNotification(LoopState.Running, event.task.taskId);
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.TaskTimedOut:
						logger.warn(`⏰ Timed out after ${Math.round(event.durationMs / 1000)}s: ${event.task.description}`);
						vscode.window.showWarningMessage(`Ralph Loop: Task timed out — ${event.task.description}`);
						break;
					case LoopEventKind.TaskNudged:
						logger.log(`👉 Nudge #${event.nudgeCount}: ${event.task.description}`);
						break;
					case LoopEventKind.TaskRetried:
						logger.warn(`🔄 Retry #${event.retryCount}: ${event.task.description}`);
						break;
					case LoopEventKind.Countdown:
						vscode.window.setStatusBarMessage(`$(clock) Ralph: Next task in ${event.secondsLeft}s`, 1100);
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.AllDone:
						logger.log(`🏁 All ${event.total} tasks completed`);
						vscode.window.showInformationMessage(`Ralph Loop: All ${event.total} tasks completed!`);
						fireStateChangeNotification(LoopState.Idle, '');
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.MaxIterations:
						logger.warn(`🛑 Hit max iterations: ${event.limit}`);
						vscode.window.showWarningMessage(`Ralph Loop: Reached ${event.limit} iteration limit`);
						fireStateChangeNotification(LoopState.Idle, '');
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.IterationLimitExpanded:
						logger.log(`📈 Iteration limit expanded: ${event.oldLimit} → ${event.newLimit}`);
						break;
					case LoopEventKind.TasksParallelized:
						logger.log(`⚡ Running ${event.tasks.length} tasks in parallel: ${event.tasks.map(t => t.taskId).join(', ')}`);
						break;
					case LoopEventKind.YieldRequested:
						logger.log('⏸ Loop yielded gracefully');
						vscode.window.showInformationMessage('Ralph Loop: Yielded gracefully after task completion');
						fireStateChangeNotification(LoopState.Idle, '');
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.SessionChanged:
						logger.warn(`🔀 Chat session changed: ${event.oldSessionId} → ${event.newSessionId}`);
						vscode.window.showWarningMessage('Ralph Loop: Chat session changed — loop paused');
						fireStateChangeNotification(LoopState.Paused, '');
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.CircuitBreakerTripped:
						logger.warn(`⚠ Circuit breaker tripped: ${event.reason} (action: ${event.action})`);
						break;
					case LoopEventKind.DiffValidationFailed:
						logger.warn(`📋 Diff validation failed (attempt ${event.attempt}): ${event.nudge}`);
						break;
					case LoopEventKind.HumanCheckpointRequested:
						logger.warn(`🚧 Human checkpoint: ${event.reason}`);
						(async () => {
							const choice = await vscode.window.showWarningMessage(
								`Ralph Loop: ${event.reason}`,
								'Continue', 'Skip Task', 'Stop Loop', 'Provide Guidance',
							);
							if (choice === 'Continue') {
								orchestrator?.resume();
							} else if (choice === 'Skip Task') {
								orchestrator?.resume();
							} else if (choice === 'Stop Loop') {
								orchestrator?.stop();
							} else if (choice === 'Provide Guidance') {
								const guidance = await vscode.window.showInputBox({
									prompt: 'Provide guidance for the task',
									placeHolder: 'Enter instructions to help the agent...',
								});
								if (guidance) {
									orchestrator?.updateConfig({ promptBlocks: [...(config.promptBlocks ?? []), guidance] });
								}
								orchestrator?.resume();
							} else {
								orchestrator?.resume();
							}
						})();
						break;
					case LoopEventKind.TaskReviewed:
						logger.log(`📝 Review verdict for ${event.task.taskId}: ${event.verdict.outcome} — ${event.verdict.summary}`);
						break;
					case LoopEventKind.MonitorAlert:
						logger.warn(`🔔 Monitor alert [${event.taskId}]: ${event.alert}`);
						break;
					case LoopEventKind.TaskCommitted:
						logger.log(`📦 Committed ${event.task.taskId}: ${event.commitHash}`);
						break;
					case LoopEventKind.StagnationDetected:
						logger.warn(`🔄 Stagnation detected: ${event.staleIterations} stale iterations (${event.filesUnchanged.length} files unchanged)`);
						break;
					case LoopEventKind.TaskDecomposed:
						logger.log(`🔀 Task decomposed: ${event.originalTask.taskId} → ${event.subTasks.length} sub-tasks`);
						break;
					case LoopEventKind.ConsistencyCheckPassed:
						logger.log(`✔ Consistency check passed (${event.phase})`);
						break;
					case LoopEventKind.ConsistencyCheckFailed:
						logger.warn(`✘ Consistency check failed (${event.phase}): ${event.failureReason ?? 'unknown'}`);
						break;
					case LoopEventKind.ContextInjected:
						logger.log(`💉 Context injected: ${event.text.slice(0, 100)}${event.text.length > 100 ? '...' : ''}`);
						break;
					case LoopEventKind.StruggleDetected:
						logger.warn(`😵 Struggle detected [${event.taskId}]: ${event.signals.join(', ')}`);
						break;
					case LoopEventKind.CommandBlocked:
						logger.warn(`🚫 Command blocked [${event.taskId}]: ${event.command} — ${event.reason}`);
						break;
					case LoopEventKind.BearingsStarted:
						logger.log(`🧭 Bearings started (level: ${event.level})`);
						break;
					case LoopEventKind.BearingsProgress:
						logger.log(`🧭 Bearings ${event.stage}: ${event.status}`);
						break;
					case LoopEventKind.BearingsCompleted:
						if (event.healthy) {
							logger.log(`🧭 Bearings completed: healthy (${event.durationMs}ms)`);
						} else {
							logger.warn(`🧭 Bearings completed: unhealthy (${event.durationMs}ms) — ${event.issues.join(', ')}`);
						}
						break;
					case LoopEventKind.BearingsSkipped:
						logger.log(`🧭 Bearings skipped: ${event.reason}`);
						break;
					case LoopEventKind.BearingsChecked:
						if (event.healthy) {
							logger.log('🧭 Bearings check: healthy');
						} else {
							logger.warn(`🧭 Bearings check: unhealthy — ${event.issues.join(', ')}`);
						}
						break;
					case LoopEventKind.BearingsFailed:
						logger.error(`🧭 Bearings failed: ${event.issues.join(', ')}`);
						break;
					case LoopEventKind.PlanRegenerated:
						logger.log(`🔁 Plan regenerated for ${event.taskId} (#${event.regenerationCount})`);
						break;
					case LoopEventKind.ConfidenceScored: {
						const parts = Object.entries(event.breakdown).map(([k, v]) => `${k}=${v}`).join(' ');
						const status = event.score >= event.threshold ? '✔' : '✘';
						logger.log(`📊 Confidence ${status} ${event.score}/${event.threshold} [${event.taskId}]: ${parts}`);
						break;
					}
					case LoopEventKind.ContextHandoff:
						logger.warn(`📤 Context handoff: ${event.estimatedTokens}/${event.maxTokens} tokens (${event.pct}%)`);
						break;
					case LoopEventKind.StateNotified:
						logger.log(`📡 State notified: ${event.state} (task: ${event.taskId || 'none'})`);
						break;
					case LoopEventKind.Stopped:
						logger.log('⏹ Loop stopped');
						fireStateChangeNotification(LoopState.Idle, '');
						updateStatusBar(orchestrator!.getStateSnapshot());
						break;
					case LoopEventKind.PrdValidationFailed: {
						const msgs = event.errors.map(e => `  ${e.level}: ${e.message}`).join('\n');
						logger.error(`PRD validation failed:\n${msgs}`);
						vscode.window.showErrorMessage(`Ralph Loop: PRD validation failed — ${event.errors.length} error(s). Check output for details.`);
						break;
					}
					case LoopEventKind.BranchCreated:
						logger.log(`🌿 Branch created/checked out: ${event.branchName}`);
						vscode.window.showInformationMessage(`Ralph Loop: Switched to branch '${event.branchName}'`);
						break;
					case LoopEventKind.BranchValidated:
						logger.log(`🌿 Branch validated: ${event.branchName}`);
						break;
					case LoopEventKind.BranchEnforcementFailed:
						logger.error(`🌿 Branch enforcement failed: ${event.reason}`);
						vscode.window.showErrorMessage(`Ralph Loop: Branch enforcement failed — ${event.reason}`);
						break;
					case LoopEventKind.BranchSwitchedBack:
						logger.log(`🌿 Switched back to '${event.to}' from '${event.from}'`);
						vscode.window.showInformationMessage(`Ralph finished — switched back to ${event.to}. Review changes on ${event.from}.`);
						break;
					case LoopEventKind.Error:
						logger.error(`❌ ${event.message}`);
						vscode.window.showErrorMessage(`Ralph Loop: ${event.message}`);
						break;
				}
			}, hookService);

			logger.log(`Starting loop with config: ${JSON.stringify(config)}`);

			// Set initial session ID if tracking is active
			if (config.features.useSessionTracking) {
				try {
					const win = vscode.window as any;
					const uri = win.activeChatPanelSessionResource as vscode.Uri | undefined;
					orchestrator.setSessionId(uri?.toString());
				} catch { /* proposed API unavailable */ }
			}

			try {
				outputChannel.show(true);
				await orchestrator.start();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error(`Loop crashed: ${message}`);
				vscode.window.showErrorMessage(`Ralph Loop crashed: ${message}`);
			}
		}),

		vscode.commands.registerCommand('ralph-loop.stop', () => {
			if (!orchestrator || orchestrator.getState() === 'idle') {
				vscode.window.showWarningMessage('Ralph Loop: Not running');
				return;
			}
			orchestrator.stop();
		}),

		vscode.commands.registerCommand('ralph-loop.status', (silent?: boolean) => {
			const state = orchestrator?.getState() ?? 'idle';
			if (!silent) {
				vscode.window.showInformationMessage(`Ralph Loop: ${state}`);
			}
			return state;
		}),

		vscode.commands.registerCommand('ralph-loop.taskName', () => {
			return orchestrator?.getCurrentTaskId() ?? '';
		}),

		vscode.commands.registerCommand('ralph-loop.getStateSnapshot', () => {
			if (!orchestrator) {
				return { state: 'idle', taskId: '', taskDescription: '', iterationCount: 0, nudgeCount: 0 };
			}
			return orchestrator.getStateSnapshot();
		}),

		vscode.commands.registerCommand('ralph-loop.yield', () => {
			if (!orchestrator || orchestrator.getState() !== 'running') {
				vscode.window.showWarningMessage('Ralph Loop: Not running');
				return;
			}
			orchestrator.requestYield();
			vscode.window.showInformationMessage('Ralph Loop: Yield requested — will stop after current task completes');
		}),

		vscode.commands.registerCommand('ralph-loop.chatSend', async (request?: ChatSendRequest) => {
			if (!request?.mode && !request?.query) {
				logger.warn('ralph-loop.chatSend: missing mode or query');
				return;
			}

			try {
				const toggleArgs: Record<string, unknown> = { modeId: request.mode ?? 'agent' };
				if (request.sessionId) {
					toggleArgs.sessionResource = vscode.Uri.parse(request.sessionId);
				}
				await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', toggleArgs);
				logger.log(`chatSend: switched to ${request.mode ?? 'agent'}${request.sessionId ? ` (session: ${request.sessionId})` : ''}`);

				if (request.query) {
					await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
					await vscode.commands.executeCommand('type', { text: request.query });
					if (!request.isPartialQuery) {
						await vscode.commands.executeCommand('workbench.action.chat.submit');
					}
					logger.log(`chatSend: submitted query (partial=${!!request.isPartialQuery})`);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error(`chatSend failed: ${msg}`);
			}
		}),

		vscode.commands.registerCommand('ralph-loop.injectContext', async () => {
			if (!orchestrator || orchestrator.getState() !== 'running') {
				vscode.window.showWarningMessage('Ralph Loop: Not running');
				return;
			}
			const input = await vscode.window.showInputBox({
				prompt: 'Enter context to inject into the next iteration',
				placeHolder: 'e.g., The bug is in utils/parser.ts line 42',
			});
			if (input) {
				orchestrator.injectContext(input);
				vscode.window.showInformationMessage('Ralph Loop: Context injected — will be used in the next iteration');
			}
		}),

		outputChannel,
	);

	logger.log('Ralph Loop extension activated');

	// Check for incomplete session on activation
	const folders = vscode.workspace.workspaceFolders;
	if (folders?.length) {
		const wsRoot = folders[0].uri.fsPath;
		const persistence = new SessionPersistence();
		if (persistence.hasIncompleteSession(wsRoot)) {
			(async () => {
				const state = persistence.load(wsRoot);
				if (state) {
					const choice = await vscode.window.showInformationMessage(
						'Ralph Loop has an incomplete session. Resume?',
						'Resume', 'Discard',
					);
					if (choice === 'Resume') {
						const config = loadConfig(wsRoot);
						orchestrator = new LoopOrchestrator(config, logger, event => {
							logger.log(`[resumed] ${event.kind}`);
						});
						orchestrator.start();
					} else if (choice === 'Discard') {
						persistence.clear(wsRoot);
					}
				}
			})();
		}
	}
}

export function deactivate(): void {
	orchestrator?.stop();
	disposeStatusBar();
	hookBridgeDisposable?.dispose();
	hookBridgeDisposable = undefined;
	sessionTrackingDisposable?.dispose();
	sessionTrackingDisposable = undefined;
}
