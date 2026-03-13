import * as vscode from 'vscode';
import { LoopEventKind, createOutputLogger } from './types';
import { LoopOrchestrator, loadConfig } from './orchestrator';

let orchestrator: LoopOrchestrator | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Ralph Loop');
	const logger = createOutputLogger(outputChannel);

	context.subscriptions.push(
		vscode.commands.registerCommand('ralph-loop.start', async () => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders?.length) {
				vscode.window.showErrorMessage('Ralph Loop: No workspace folder open');
				return;
			}

			if (orchestrator?.getState() !== 'idle') {
				vscode.window.showWarningMessage('Ralph Loop: Already running');
				return;
			}

			const workspaceRoot = folders[0].uri.fsPath;
			const config = loadConfig(workspaceRoot);

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
					case LoopEventKind.Stopped:
						logger.log('Loop stopped');
						break;
					case LoopEventKind.Error:
						logger.error(event.message);
						vscode.window.showErrorMessage(`Ralph Loop: ${event.message}`);
						break;
				}
			});

			logger.log(`Starting loop with config: ${JSON.stringify(config)}`);
			await orchestrator.start();
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

		outputChannel,
	);

	logger.log('Ralph Loop extension activated');
}

export function deactivate(): void {
	orchestrator?.stop();
}
