import * as vscode from 'vscode';
import { LoopEventKind, createOutputLogger, IRalphHookService } from './types';
import { LoopOrchestrator, loadConfig } from './orchestrator';
import { ShellHookProvider } from './shellHookProvider';
import { registerHookBridge, HookBridgeDisposable } from './hookBridge';

let orchestrator: LoopOrchestrator | undefined;
let outputChannel: vscode.OutputChannel;
let hookBridgeDisposable: HookBridgeDisposable | undefined;

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
			if (config.useHookBridge) {
				try {
					hookBridgeDisposable = registerHookBridge(config, logger);
					logger.log('Hook bridge registered (chat.hooks Stop + PostToolUse)');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.warn(`Hook bridge registration failed (proposed API may be unavailable): ${msg}`);
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

		outputChannel,
	);

	logger.log('Ralph Loop extension activated');
}

export function deactivate(): void {
	orchestrator?.stop();
	hookBridgeDisposable?.dispose();
	hookBridgeDisposable = undefined;
}
