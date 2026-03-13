import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
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
	ITaskExecutionStrategy,
	ExecutionOptions,
} from './types';
import { readPrdFile, readPrdSnapshot, pickNextTask, resolvePrdPath, resolveProgressPath, appendProgress } from './prd';
import { buildPrompt, buildFinalNudgePrompt, PromptCapabilities } from './copilot';
import { shouldRetryError, MAX_RETRIES_PER_TASK } from './decisions';
import { CopilotCommandStrategy, DirectApiStrategy } from './strategies';

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
	private readonly hooksEnabled: boolean;
	private readonly executionStrategy: ITaskExecutionStrategy;
	private currentSessionId: string | undefined;

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
		this.hooksEnabled = hookService !== undefined;
		this.executionStrategy = this.resolveStrategy();
	}

	private resolveStrategy(): ITaskExecutionStrategy {
		if (this.config.executionStrategy === 'api') {
			return new DirectApiStrategy(this.logger);
		}
		return new CopilotCommandStrategy(this.logger);
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

	setSessionId(sessionId: string | undefined): void {
		if (!this.config.useSessionTracking) { return; }
		const old = this.currentSessionId;
		if (old && sessionId && old !== sessionId && this.state === LoopState.Running) {
			this.logger.log(`Session changed: ${old} → ${sessionId} — pausing loop`);
			this.pauseRequested = true;
			this.onEvent({ kind: LoopEventKind.SessionChanged, oldSessionId: old, newSessionId: sessionId });
		}
		this.currentSessionId = sessionId;
	}

	getSessionId(): string | undefined {
		return this.currentSessionId;
	}

	private cleanup(): void {
		this.prdWatcher?.dispose();
		this.prdWatcher = undefined;
	}

	private get promptCapabilities(): PromptCapabilities {
		return {
			hooksEnabled: this.hooksEnabled,
			hookScript: this.config.hookScript,
			promptBlocks: this.config.promptBlocks,
		};
	}

	private get executionOptions(): ExecutionOptions {
		return {
			prdPath: resolvePrdPath(this.config.workspaceRoot, this.config.prdPath),
			workspaceRoot: this.config.workspaceRoot,
			inactivityTimeoutMs: this.config.inactivityTimeoutMs,
			useAutopilotMode: this.config.useAutopilotMode,
			shouldStop: () => this.stopRequested,
		};
	}

	private async *runLoop(): AsyncGenerator<LoopEvent> {
		const prdPath = resolvePrdPath(this.config.workspaceRoot, this.config.prdPath);
		const progressPath = resolveProgressPath(this.config.workspaceRoot, this.config.progressPath);
		let iteration = 0;
		let additionalContext = '';
		let iterationLimitExpanded = false;
		let effectiveMaxIterations = this.config.maxIterations;

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

			// Check iteration limit — auto-expand once if tasks remain
			if (effectiveMaxIterations > 0 && iteration >= effectiveMaxIterations) {
				if (!iterationLimitExpanded) {
					// Check if tasks remain before expanding
					const peekSnapshot = readPrdSnapshot(prdPath);
					const peekTask = pickNextTask(peekSnapshot);
					if (peekTask && !this.completedTasks.has(peekTask.id)) {
						const oldLimit = effectiveMaxIterations;
						const expanded = Math.ceil(effectiveMaxIterations * 1.5);
						effectiveMaxIterations = Math.min(expanded, this.config.hardMaxIterations);
						iterationLimitExpanded = true;
						this.logger.log(`Auto-expanded iteration limit: ${oldLimit} → ${effectiveMaxIterations}`);
						yield { kind: LoopEventKind.IterationLimitExpanded, oldLimit, newLimit: effectiveMaxIterations };
					} else {
						yield { kind: LoopEventKind.MaxIterations, limit: effectiveMaxIterations };
						return;
					}
				} else {
					yield { kind: LoopEventKind.MaxIterations, limit: effectiveMaxIterations };
					return;
				}
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
			const taskInvocationId = crypto.randomUUID();
			yield { kind: LoopEventKind.TaskStarted, task, iteration, taskInvocationId };

			const startTime = Date.now();
			try {
				appendProgress(progressPath, `[${taskInvocationId}] Task started: ${task.description}`);

				// Read context for prompt
				const prdContent = readPrdFile(prdPath);
				let progressContent = '';
				try {
					progressContent = fs.readFileSync(progressPath, 'utf-8');
				} catch {
					// progress file may not exist yet
				}

				// Build prompt and execute via strategy
				let prompt = buildPrompt(task.description, prdContent, progressContent, 20, this.config.promptBlocks, this.promptCapabilities);
				if (additionalContext) {
					prompt += '\n\n' + additionalContext;
					additionalContext = '';
				}
				const taskState: TaskState = { taskInvocationId, nudgeCount: 0, retryCount: 0, taskCompletedLatch: false };
				const execResult = await this.executionStrategy.execute(task, prompt, this.executionOptions);
				yield { kind: LoopEventKind.CopilotTriggered, method: execResult.method, taskInvocationId };
				yield { kind: LoopEventKind.WaitingForCompletion, task, taskInvocationId };
				let waitResult = { completed: execResult.completed, hadFileChanges: execResult.hadFileChanges };

				// Nudge loop: re-send prompt with continuation nudge if timed out
				while (!waitResult.completed && !this.stopRequested && taskState.nudgeCount < this.config.maxNudgesPerTask) {
					// Reset nudgeCount if productive file changes occurred during wait
					if (waitResult.hadFileChanges) {
						this.logger.log('Productive file changes detected — resetting nudge count');
						taskState.nudgeCount = 0;
					}

					taskState.nudgeCount++;
					yield { kind: LoopEventKind.TaskNudged, task, nudgeCount: taskState.nudgeCount, taskInvocationId };
					this.logger.log(`Nudging task (${taskState.nudgeCount}/${this.config.maxNudgesPerTask}): ${task.description}`);

					const finalNudge = buildFinalNudgePrompt(task.description, taskState.nudgeCount, this.config.maxNudgesPerTask);
					const continuationSuffix = finalNudge
						?? 'Continue with the current task. You have NOT marked the checkbox yet. Do NOT repeat previous work — pick up where you left off. If you encountered errors, resolve them. If you were planning, start implementing.';
					const nudgePrompt = buildPrompt(task.description, readPrdFile(prdPath), (() => { try { return fs.readFileSync(progressPath, 'utf-8'); } catch { return ''; } })(), 20, this.config.promptBlocks, this.promptCapabilities)
						+ '\n\n' + continuationSuffix;

					const nudgeResult = await this.executionStrategy.execute(task, nudgePrompt, this.executionOptions);
					waitResult = { completed: nudgeResult.completed, hadFileChanges: nudgeResult.hadFileChanges };
				}

				if (this.stopRequested) {
					yield { kind: LoopEventKind.Stopped };
					return;
				}

				const duration = Date.now() - startTime;

				if (waitResult.completed) {
					taskState.taskCompletedLatch = true;
					this.completedTasks.add(task.id);
					appendProgress(progressPath, `[${taskInvocationId}] Task completed: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration, taskInvocationId };

					// TaskComplete hook
					const completeHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'success', taskInvocationId });
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
					appendProgress(progressPath, `[${taskInvocationId}] Task timed out: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskTimedOut, task: { ...task, status: TaskStatus.TimedOut }, durationMs: duration, taskInvocationId };

					// TaskComplete hook (failure)
					const failHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'failure', taskInvocationId });
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
					yield { kind: LoopEventKind.TaskRetried, task, retryCount, taskInvocationId };
					this.logger.log(`Retrying task (${retryCount}/${MAX_RETRIES_PER_TASK}): ${task.description}`);
					await this.delay(2000);

					try {
						const prdContent = readPrdFile(prdPath);
						let progressContent = '';
						try { progressContent = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }

						const prompt = buildPrompt(task.description, prdContent, progressContent, 20, this.config.promptBlocks, this.promptCapabilities);
						const retryExecResult = await this.executionStrategy.execute(task, prompt, this.executionOptions);
						yield { kind: LoopEventKind.CopilotTriggered, method: retryExecResult.method, taskInvocationId };

						const retryResult = { completed: retryExecResult.completed, hadFileChanges: retryExecResult.hadFileChanges };

						if (retryResult.completed) {
							this.completedTasks.add(task.id);
							const duration = Date.now() - startTime;
							appendProgress(progressPath, `[${taskInvocationId}] Task completed (after ${retryCount} retries): ${task.description} (${Math.round(duration / 1000)}s)`);
							yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration, taskInvocationId };
						}
						handled = true;
						break;
					} catch (retryErr) {
						currentError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
					}
				}

				if (!handled) {
					const message = currentError.message;
					appendProgress(progressPath, `[${taskInvocationId}] Task error: ${task.description} — ${message}`);
					yield { kind: LoopEventKind.Error, message: `Task "${task.description}" failed: ${message}` };

					// TaskComplete hook (failure after retries exhausted)
					const errorHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'failure', taskInvocationId });
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
		hardMaxIterations: vsConfig.get<number>('hardMaxIterations', DEFAULT_CONFIG.hardMaxIterations),
		countdownSeconds: vsConfig.get<number>('countdownSeconds', DEFAULT_CONFIG.countdownSeconds),
		inactivityTimeoutMs: vsConfig.get<number>('inactivityTimeoutMs', DEFAULT_CONFIG.inactivityTimeoutMs),
		maxNudgesPerTask: vsConfig.get<number>('maxNudgesPerTask', DEFAULT_CONFIG.maxNudgesPerTask),
		hookScript: vsConfig.get<string | undefined>('hookScript', undefined),
		executionStrategy: vsConfig.get<'command' | 'api'>('executionStrategy', DEFAULT_CONFIG.executionStrategy),
		promptBlocks: vsConfig.get<string[]>('promptBlocks', DEFAULT_CONFIG.promptBlocks!),
		useHookBridge: vsConfig.get<boolean>('useHookBridge', DEFAULT_CONFIG.useHookBridge),
		useSessionTracking: vsConfig.get<boolean>('useSessionTracking', DEFAULT_CONFIG.useSessionTracking),
		useAutopilotMode: vsConfig.get<boolean>('useAutopilotMode', DEFAULT_CONFIG.useAutopilotMode),
		workspaceRoot,
	};
}
