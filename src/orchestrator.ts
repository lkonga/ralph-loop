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
	TaskState,
	IRalphHookService,
	HookResult,
} from './types';
import { readPrdFile, readPrdSnapshot, pickNextTask, resolvePrdPath, resolveProgressPath, appendProgress } from './prd';
import { startFreshChatSession, openCopilotWithPrompt, buildPrompt } from './copilot';
import { verifyTaskCompletion, allChecksPassed, isAllDone } from './verify';
import { shouldRetryError, MAX_RETRIES_PER_TASK } from './decisions';

const NO_OP_HOOK_RESULT: HookResult = { action: 'continue' };

export class NoOpHookService implements IRalphHookService {
	async onSessionStart() { return NO_OP_HOOK_RESULT; }
	async onPreCompact() { return NO_OP_HOOK_RESULT; }
	async onPostToolUse() { return NO_OP_HOOK_RESULT; }
	async onTaskComplete() { return NO_OP_HOOK_RESULT; }
}

export class LoopOrchestrator {
	private state: LoopState = LoopState.Idle;
	private stopRequested = false;
	private pauseRequested = false;
	private yieldRequested = false;
	private prdWatcher: vscode.FileSystemWatcher | undefined;
	private config: RalphConfig;
	private readonly logger: ILogger;
	private readonly onEvent: (event: LoopEvent) => void;
	private readonly completedTasks = new Set<number>();
	private readonly hookService: IRalphHookService;

	constructor(
		config: RalphConfig,
		logger: ILogger,
		onEvent: (event: LoopEvent) => void,
		hookService?: IRalphHookService,
	) {
		this.config = config;
		this.logger = logger;
		this.onEvent = onEvent;
		this.hookService = hookService ?? new NoOpHookService();
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
		this.yieldRequested = false;
		this.logger.log('Loop started');

		try {
			for await (const event of this.runLoop()) {
				this.onEvent(event);
				if (event.kind === LoopEventKind.Stopped ||
					event.kind === LoopEventKind.AllDone ||
					event.kind === LoopEventKind.MaxIterations ||
					event.kind === LoopEventKind.YieldRequested) {
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

	requestYield(): void {
		this.yieldRequested = true;
		this.logger.log('Yield requested');
	}

	private cleanup(): void {
		this.prdWatcher?.dispose();
		this.prdWatcher = undefined;
	}

	private async *runLoop(): AsyncGenerator<LoopEvent> {
		const prdPath = resolvePrdPath(this.config.workspaceRoot, this.config.prdPath);
		const progressPath = resolveProgressPath(this.config.workspaceRoot, this.config.progressPath);
		let iteration = 0;
		let additionalContext = '';

		// SessionStart hook
		const sessionHook = await this.hookService.onSessionStart({ prdPath });
		this.logger.log(`SessionStart hook: action=${sessionHook.action}`);
		if (sessionHook.additionalContext) { additionalContext = sessionHook.additionalContext; }
		if (sessionHook.action === 'stop') {
			yield { kind: LoopEventKind.Stopped };
			return;
		}

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

			// Skip tasks whose completion latch is already set
			if (this.completedTasks.has(task.id)) {
				continue;
			}

			iteration++;
			task.status = TaskStatus.InProgress;
			yield { kind: LoopEventKind.TaskStarted, task, iteration };

			const startTime = Date.now();
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
				let prompt = buildPrompt(task.description, prdContent, progressContent);
				if (additionalContext) {
					prompt += '\n\n' + additionalContext;
					additionalContext = '';
				}
				const method = await openCopilotWithPrompt(prompt, this.logger);
				yield { kind: LoopEventKind.CopilotTriggered, method };

				// Wait for completion: watch PRD for checkbox change
				yield { kind: LoopEventKind.WaitingForCompletion, task };
				const taskState: TaskState = { nudgeCount: 0, retryCount: 0, taskCompletedLatch: false };
				let waitResult = await this.waitForTaskCompletion(prdPath, task);

				// Nudge loop: re-send prompt with continuation nudge if timed out
				while (!waitResult.completed && !this.stopRequested && taskState.nudgeCount < this.config.maxNudgesPerTask) {
					// Reset nudgeCount if productive file changes occurred during wait
					if (waitResult.hadFileChanges) {
						this.logger.log('Productive file changes detected — resetting nudge count');
						taskState.nudgeCount = 0;
					}

					taskState.nudgeCount++;
					yield { kind: LoopEventKind.TaskNudged, task, nudgeCount: taskState.nudgeCount };
					this.logger.log(`Nudging task (${taskState.nudgeCount}/${this.config.maxNudgesPerTask}): ${task.description}`);

					const nudgePrompt = buildPrompt(task.description, readPrdFile(prdPath), (() => { try { return fs.readFileSync(progressPath, 'utf-8'); } catch { return ''; } })())
						+ '\n\nContinue with the current task. You have NOT marked the checkbox yet. Do NOT repeat previous work — pick up where you left off. If you encountered errors, resolve them. If you were planning, start implementing.';

					await startFreshChatSession(this.logger);
					await openCopilotWithPrompt(nudgePrompt, this.logger);
					waitResult = await this.waitForTaskCompletion(prdPath, task);
				}

				if (this.stopRequested) {
					yield { kind: LoopEventKind.Stopped };
					return;
				}

				const duration = Date.now() - startTime;

				if (waitResult.completed) {
					taskState.taskCompletedLatch = true;
					this.completedTasks.add(task.id);
					appendProgress(progressPath, `Task completed: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration };

					// TaskComplete hook
					const completeHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'success' });
					if (completeHook.additionalContext) { additionalContext = completeHook.additionalContext; }
					if (completeHook.action === 'stop') {
						yield { kind: LoopEventKind.Stopped };
						return;
					}

					// Graceful yield: deferred until task completion (autopilot pattern)
					if (this.yieldRequested) {
						this.logger.log('Yield honoured after task completion');
						yield { kind: LoopEventKind.YieldRequested };
						return;
					}
				} else {
					appendProgress(progressPath, `Task timed out: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskTimedOut, task: { ...task, status: TaskStatus.TimedOut }, durationMs: duration };

					// TaskComplete hook (failure)
					const failHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'failure' });
					if (failHook.additionalContext) { additionalContext = failHook.additionalContext; }
					if (failHook.action === 'retry') {
						continue; // re-enter the task
					} else if (failHook.action === 'stop') {
						yield { kind: LoopEventKind.Stopped };
						return;
					}
					// 'continue' and 'skip' both move to next task
				}
			} catch (err) {
				let currentError = err instanceof Error ? err : new Error(String(err));
				let retryCount = 0;
				let handled = false;

				while (this.shouldRetry(currentError, retryCount)) {
					retryCount++;
					yield { kind: LoopEventKind.TaskRetried, task, retryCount };
					this.logger.log(`Retrying task (${retryCount}/${MAX_RETRIES_PER_TASK}): ${task.description}`);
					await this.delay(2000);

					try {
						const prdContent = readPrdFile(prdPath);
						let progressContent = '';
						try { progressContent = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }

						await startFreshChatSession(this.logger);
						const prompt = buildPrompt(task.description, prdContent, progressContent);
						const method = await openCopilotWithPrompt(prompt, this.logger);
						yield { kind: LoopEventKind.CopilotTriggered, method };

						yield { kind: LoopEventKind.WaitingForCompletion, task };
						const retryResult = await this.waitForTaskCompletion(prdPath, task);

						if (retryResult.completed) {
							this.completedTasks.add(task.id);
							const duration = Date.now() - startTime;
							appendProgress(progressPath, `Task completed (after ${retryCount} retries): ${task.description} (${Math.round(duration / 1000)}s)`);
							yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration };
						}
						handled = true;
						break;
					} catch (retryErr) {
						currentError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
					}
				}

				if (!handled) {
					const message = currentError.message;
					appendProgress(progressPath, `Task error: ${task.description} — ${message}`);
					yield { kind: LoopEventKind.Error, message: `Task "${task.description}" failed: ${message}` };

					// TaskComplete hook (failure after retries exhausted)
					const errorHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'failure' });
					if (errorHook.additionalContext) { additionalContext = errorHook.additionalContext; }
					if (errorHook.action === 'stop') {
						yield { kind: LoopEventKind.Stopped };
						return;
					}
				}
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

	private waitForTaskCompletion(prdPath: string, task: { readonly description: string }): Promise<{ completed: boolean; hadFileChanges: boolean }> {
		return new Promise<{ completed: boolean; hadFileChanges: boolean }>(resolve => {
			const pattern = new vscode.RelativePattern(
				path.dirname(prdPath),
				path.basename(prdPath),
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
				timeout = setTimeout(() => settle(false), this.config.inactivityTimeoutMs);
			};

			const prdWatcher = vscode.workspace.createFileSystemWatcher(pattern);
			const checkCompletion = () => {
				const checks = verifyTaskCompletion(prdPath, task as any, this.logger);
				if (allChecksPassed(checks)) {
					settle(true);
				}
			};
			prdWatcher.onDidChange(checkCompletion);
			prdWatcher.onDidCreate(checkCompletion);

			// Watch all files in the workspace to reset inactivity timer on any edit
			const workspacePattern = new vscode.RelativePattern(this.config.workspaceRoot, '**/*');
			const activityWatcher = vscode.workspace.createFileSystemWatcher(workspacePattern);
			const onFileActivity = () => {
				hadFileChanges = true;
				resetInactivityTimer();
			};
			activityWatcher.onDidChange(onFileActivity);
			activityWatcher.onDidCreate(onFileActivity);
			activityWatcher.onDidDelete(onFileActivity);

			timeout = setTimeout(() => settle(false), this.config.inactivityTimeoutMs);

			poll = setInterval(() => {
				if (this.stopRequested) {
					settle(false);
					return;
				}
				checkCompletion();
			}, 5000);
		});
	}

	private shouldRetry(error: Error, retryCount: number): boolean {
		return shouldRetryError(error, retryCount, this.stopRequested);
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
		maxNudgesPerTask: vsConfig.get<number>('maxNudgesPerTask', DEFAULT_CONFIG.maxNudgesPerTask),
		workspaceRoot,
	};
}
