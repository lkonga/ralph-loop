import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	LoopState,
	LoopEvent,
	LoopEventKind,
	RalphConfig,
	DEFAULT_CONFIG,
	ILogger,
	TaskStatus,
} from './types';
import { readPrdFile, readPrdSnapshot, pickNextTask, resolvePrdPath, resolveProgressPath, appendProgress } from './prd';
import { startFreshChatSession, openCopilotWithPrompt, buildPrompt } from './copilot';
import { verifyTaskCompletion, allChecksPassed, isAllDone } from './verify';

export class LoopOrchestrator {
	private state: LoopState = LoopState.Idle;
	private stopRequested = false;
	private pauseRequested = false;
	private prdWatcher: vscode.FileSystemWatcher | undefined;
	private config: RalphConfig;
	private readonly logger: ILogger;
	private readonly onEvent: (event: LoopEvent) => void;

	constructor(
		config: RalphConfig,
		logger: ILogger,
		onEvent: (event: LoopEvent) => void,
	) {
		this.config = config;
		this.logger = logger;
		this.onEvent = onEvent;
	}

	getState(): LoopState {
		return this.state;
	}

	updateConfig(config: Partial<RalphConfig>): void {
		this.config = { ...this.config, ...config };
	}

	async start(): Promise<void> {
		if (this.state === LoopState.Running) {
			this.logger.warn('Loop already running');
			return;
		}

		this.state = LoopState.Running;
		this.stopRequested = false;
		this.pauseRequested = false;
		this.logger.log('Loop started');

		try {
			for await (const event of this.runLoop()) {
				this.onEvent(event);
				if (event.kind === LoopEventKind.Stopped ||
					event.kind === LoopEventKind.AllDone ||
					event.kind === LoopEventKind.MaxIterations) {
					break;
				}
			}
		} finally {
			this.cleanup();
			this.state = LoopState.Idle;
		}
	}

	stop(): void {
		this.stopRequested = true;
		this.logger.log('Stop requested');
	}

	pause(): void {
		this.pauseRequested = true;
		this.logger.log('Pause requested');
	}

	resume(): void {
		this.pauseRequested = false;
		this.state = LoopState.Running;
		this.logger.log('Resumed');
	}

	private cleanup(): void {
		this.prdWatcher?.dispose();
		this.prdWatcher = undefined;
	}

	private async *runLoop(): AsyncGenerator<LoopEvent> {
		const prdPath = resolvePrdPath(this.config.workspaceRoot, this.config.prdPath);
		const progressPath = resolveProgressPath(this.config.workspaceRoot, this.config.progressPath);
		let iteration = 0;

		while (true) {
			// Check stop
			if (this.stopRequested) {
				yield { kind: LoopEventKind.Stopped };
				return;
			}

			// Handle pause
			while (this.pauseRequested) {
				this.state = LoopState.Paused;
				await this.delay(1000);
				if (this.stopRequested) {
					yield { kind: LoopEventKind.Stopped };
					return;
				}
			}

			// Check iteration limit
			if (this.config.maxIterations > 0 && iteration >= this.config.maxIterations) {
				yield { kind: LoopEventKind.MaxIterations, limit: this.config.maxIterations };
				return;
			}

			// Parse PRD, pick next task
			const snapshot = readPrdSnapshot(prdPath);
			const task = pickNextTask(snapshot);

			if (!task) {
				yield { kind: LoopEventKind.AllDone, total: snapshot.total };
				return;
			}

			iteration++;
			task.status = TaskStatus.InProgress;
			yield { kind: LoopEventKind.TaskStarted, task, iteration };

			try {
				appendProgress(progressPath, `Task started: ${task.description}`);

				// Read context for prompt
				const prdContent = readPrdFile(prdPath);
				let progressContent = '';
				try {
					progressContent = fs.readFileSync(progressPath, 'utf-8');
				} catch {
					// progress file may not exist yet
				}

				// Start fresh session + trigger Copilot
				await startFreshChatSession(this.logger);
				const prompt = buildPrompt(task.description, prdContent, progressContent);
				const method = await openCopilotWithPrompt(prompt, this.logger);
				yield { kind: LoopEventKind.CopilotTriggered, method };

				// Wait for completion: watch PRD for checkbox change
				yield { kind: LoopEventKind.WaitingForCompletion, task };
				const startTime = Date.now();
				const completed = await this.waitForTaskCompletion(prdPath, task);

				if (this.stopRequested) {
					yield { kind: LoopEventKind.Stopped };
					return;
				}

				const duration = Date.now() - startTime;

				if (completed) {
					appendProgress(progressPath, `Task completed: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration };
				} else {
					appendProgress(progressPath, `Task timed out: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskTimedOut, task: { ...task, status: TaskStatus.TimedOut }, durationMs: duration };
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				appendProgress(progressPath, `Task error: ${task.description} — ${message}`);
				yield { kind: LoopEventKind.Error, message: `Task "${task.description}" failed: ${message}` };
				// Continue to next task instead of crashing
			}

			// Countdown between tasks
			for (let s = this.config.countdownSeconds; s > 0; s--) {
				if (this.stopRequested) {
					yield { kind: LoopEventKind.Stopped };
					return;
				}
				yield { kind: LoopEventKind.Countdown, secondsLeft: s };
				await this.delay(1000);
			}
		}
	}

	private waitForTaskCompletion(prdPath: string, task: { readonly description: string }): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const prdUri = vscode.Uri.file(prdPath);
			const pattern = new vscode.RelativePattern(
				path.dirname(prdPath),
				path.basename(prdPath),
			);

			let settled = false;
			let poll: ReturnType<typeof setInterval>;

			const settle = (result: boolean) => {
				if (!settled) {
					settled = true;
					watcher.dispose();
					clearTimeout(timeout);
					clearInterval(poll);
					resolve(result);
				}
			};

			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			const checkCompletion = () => {
				const checks = verifyTaskCompletion(prdPath, task as any, this.logger);
				if (allChecksPassed(checks)) {
					settle(true);
				}
			};
			watcher.onDidChange(checkCompletion);
			watcher.onDidCreate(checkCompletion);

			const timeout = setTimeout(() => settle(false), this.config.inactivityTimeoutMs);

			poll = setInterval(() => {
				if (this.stopRequested) {
					settle(false);
					return;
				}
				checkCompletion();
			}, 5000);
		});
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

// Load config from VS Code settings
export function loadConfig(workspaceRoot: string): RalphConfig {
	const vsConfig = vscode.workspace.getConfiguration('ralph-loop');
	return {
		prdPath: vsConfig.get<string>('prdPath', DEFAULT_CONFIG.prdPath),
		progressPath: vsConfig.get<string>('progressPath', DEFAULT_CONFIG.progressPath),
		maxIterations: vsConfig.get<number>('maxIterations', DEFAULT_CONFIG.maxIterations),
		countdownSeconds: vsConfig.get<number>('countdownSeconds', DEFAULT_CONFIG.countdownSeconds),
		inactivityTimeoutMs: vsConfig.get<number>('inactivityTimeoutMs', DEFAULT_CONFIG.inactivityTimeoutMs),
		workspaceRoot,
	};
}
