import * as vscode from 'vscode';
import * as path from 'path';
import {
	Task,
	ExecutionOptions,
	ExecutionResult,
	ITaskExecutionStrategy,
	ILogger,
} from './types';
import { startFreshChatSession, openCopilotWithPrompt, CopilotRequestOptions } from './copilot';
import { verifyTaskCompletion, allChecksPassed } from './verify';

export class CopilotCommandStrategy implements ITaskExecutionStrategy {
	constructor(private readonly logger: ILogger) {}

	async execute(task: Task, prompt: string, options: ExecutionOptions): Promise<ExecutionResult> {
		await startFreshChatSession(this.logger);

		const requestOptions: CopilotRequestOptions = {
			useAutopilotMode: options.useAutopilotMode,
		};
		const method = await openCopilotWithPrompt(prompt, this.logger, requestOptions);

		const waitResult = await this.waitForCompletion(task, options);

		return {
			completed: waitResult.completed,
			method,
			hadFileChanges: waitResult.hadFileChanges,
		};
	}

	private waitForCompletion(
		task: Task,
		options: ExecutionOptions,
	): Promise<{ completed: boolean; hadFileChanges: boolean }> {
		return new Promise(resolve => {
			const pattern = new vscode.RelativePattern(
				path.dirname(options.prdPath),
				path.basename(options.prdPath),
			);

			let settled = false;
			let hadFileChanges = false;
			let poll: ReturnType<typeof setInterval>;
			let timeout: ReturnType<typeof setTimeout>;

			const settle = (result: boolean) => {
				if (!settled) {
					settled = true;
					prdWatcher.dispose();
					activityWatcher.dispose();
					clearTimeout(timeout);
					clearInterval(poll);
					resolve({ completed: result, hadFileChanges });
				}
			};

			const resetInactivityTimer = () => {
				clearTimeout(timeout);
				timeout = setTimeout(() => settle(false), options.inactivityTimeoutMs);
			};

			const prdWatcher = vscode.workspace.createFileSystemWatcher(pattern);
			const checkCompletion = () => {
				const checks = verifyTaskCompletion(options.prdPath, task, this.logger);
				if (allChecksPassed(checks)) {
					settle(true);
				}
			};
			prdWatcher.onDidChange(checkCompletion);
			prdWatcher.onDidCreate(checkCompletion);

			const workspacePattern = new vscode.RelativePattern(options.workspaceRoot, '**/*');
			const activityWatcher = vscode.workspace.createFileSystemWatcher(workspacePattern);
			const onFileActivity = () => {
				hadFileChanges = true;
				resetInactivityTimer();
			};
			activityWatcher.onDidChange(onFileActivity);
			activityWatcher.onDidCreate(onFileActivity);
			activityWatcher.onDidDelete(onFileActivity);

			timeout = setTimeout(() => settle(false), options.inactivityTimeoutMs);

			poll = setInterval(() => {
				if (options.shouldStop()) {
					settle(false);
					return;
				}
				checkCompletion();
			}, 5000);
		});
	}
}

// chatProvider proposed API is not yet available
export class DirectApiStrategy implements ITaskExecutionStrategy {
	constructor(private readonly logger: ILogger) {}

	async execute(_task: Task, _prompt: string, _options: ExecutionOptions): Promise<ExecutionResult> {
		this.logger.warn('DirectApiStrategy: chatProvider API not yet available');
		throw new Error(
			'DirectApiStrategy is not yet implemented. The chatProvider API is not available. Use executionStrategy: "command" instead.',
		);
	}
}
