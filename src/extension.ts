import * as vscode from 'vscode';
import { LoopEventKind, createOutputLogger, IRalphHookService } from './types';
import { LoopOrchestrator, loadConfig } from './orchestrator';
import { ShellHookProvider } from './shellHookProvider';
import { registerHookBridge, HookBridgeDisposable } from './hookBridge';
import { SessionPersistence } from './sessionPersistence';

let orchestrator: LoopOrchestrator | undefined;
let outputChannel: vscode.OutputChannel;
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
	outputChannel = vscode.window.createOutputChannel('Ralph Loop');
	const logger = createOutputLogger(outputChannel);

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
						logger.log(`[${event.iteration}] Starting: ${event.task.description}`);
						vscode.window.setStatusBarMessage(`$(sync~spin) Ralph: ${event.task.description}`, 5000);
						break;
					case LoopEventKind.CopilotTriggered:
						logger.log(`Copilot triggered via ${event.method}`);
						break;
					case LoopEventKind.WaitingForCompletion:
						logger.log(`Waiting for completion: ${event.task.description}`);
						break;
					case LoopEventKind.TaskCompleted:
						logger.log(`Completed in ${Math.round(event.durationMs / 1000)}s: ${event.task.description}`);
						break;
					case LoopEventKind.TaskTimedOut:
						logger.warn(`Timed out after ${Math.round(event.durationMs / 1000)}s: ${event.task.description}`);
						vscode.window.showWarningMessage(`Ralph Loop: Task timed out — ${event.task.description}`);
						break;
					case LoopEventKind.Countdown:
						vscode.window.setStatusBarMessage(`$(clock) Ralph: Next task in ${event.secondsLeft}s`, 1100);
						break;
					case LoopEventKind.AllDone:
						vscode.window.showInformationMessage(`Ralph Loop: All ${event.total} tasks completed!`);
						logger.log(`All ${event.total} tasks done`);
						break;
					case LoopEventKind.MaxIterations:
						vscode.window.showWarningMessage(`Ralph Loop: Reached ${event.limit} iteration limit`);
						logger.warn(`Hit max iterations: ${event.limit}`);
						break;
					case LoopEventKind.YieldRequested:
						logger.log('Loop yielded gracefully');
						vscode.window.showInformationMessage('Ralph Loop: Yielded gracefully after task completion');
						break;
					case LoopEventKind.SessionChanged:
						logger.log(`Chat session changed: ${event.oldSessionId} → ${event.newSessionId}`);
						vscode.window.showWarningMessage('Ralph Loop: Chat session changed — loop paused');
						break;
					case LoopEventKind.DiffValidationFailed:
						logger.warn(`Diff validation failed (attempt ${event.attempt}): ${event.nudge}`);
						break;
					case LoopEventKind.HumanCheckpointRequested:
						logger.warn(`Human checkpoint requested: ${event.reason}`);
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
								// Dismissed — resume
								orchestrator?.resume();
							}
						})();
						break;
					case LoopEventKind.Stopped:
						logger.log('Loop stopped');
						break;
					case LoopEventKind.Error:
						logger.error(event.message);
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

		vscode.commands.registerCommand('ralph-loop.status', () => {
			const state = orchestrator?.getState() ?? 'idle';
			vscode.window.showInformationMessage(`Ralph Loop: ${state}`);
		}),

		vscode.commands.registerCommand('ralph-loop.yield', () => {
			if (!orchestrator || orchestrator.getState() !== 'running') {
				vscode.window.showWarningMessage('Ralph Loop: Not running');
				return;
			}
			orchestrator.requestYield();
			vscode.window.showInformationMessage('Ralph Loop: Yield requested — will stop after current task completes');
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
			vscode.window.showInformationMessage(
				'Ralph Loop has an incomplete session. Resume?',
				'Resume', 'Discard',
			).then(choice => {
				if (choice === 'Resume') {
					const state = persistence.load(wsRoot);
					if (state) {
						const config = loadConfig(wsRoot);
						orchestrator = new LoopOrchestrator(config, logger, event => {
							logger.log(`[resumed] ${event.kind}`);
						});
						orchestrator.start();
					}
				} else if (choice === 'Discard') {
					persistence.clear(wsRoot);
				}
			});
		}
	}
}

export function deactivate(): void {
	orchestrator?.stop();
	hookBridgeDisposable?.dispose();
	hookBridgeDisposable = undefined;
	sessionTrackingDisposable?.dispose();
	sessionTrackingDisposable = undefined;
}
