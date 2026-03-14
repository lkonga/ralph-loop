import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
	LoopState,
	LoopEvent,
	LoopEventKind,
	RalphConfig,
	DEFAULT_CONFIG,
	DEFAULT_FEATURES,
	DEFAULT_PRE_COMPLETE_HOOKS,
	DEFAULT_DIFF_VALIDATION,
	DEFAULT_REVIEW_AFTER_EXECUTE,
	DEFAULT_PARALLEL_MONITOR,
	DEFAULT_PRE_COMPACT_BEHAVIOR,
	DEFAULT_STAGNATION_DETECTION,
	DEFAULT_KNOWLEDGE_CONFIG,
	ILogger,
	TaskStatus,
	TaskState,
	DiffValidationConfig,
	ParallelMonitorConfig,
	IRalphHookService,
	HookResult,
	ITaskExecutionStrategy,
	ExecutionOptions,
	PreCompleteInput,
	PreCompleteHookResult,
	PreCompleteHookConfig,
	VerifyCheck,
	ReviewVerdict,
	ReviewAfterExecuteConfig,
	IConsistencyChecker,
} from './types';
import { readPrdFile, readPrdSnapshot, pickNextTask, pickReadyTasks, resolvePrdPath, resolveProgressPath, appendProgress } from './prd';
import { buildPrompt, buildFinalNudgePrompt, PromptCapabilities, sendReviewPrompt } from './copilot';
import { shouldRetryError, MAX_RETRIES_PER_TASK } from './decisions';
import { CopilotCommandStrategy, DirectApiStrategy } from './strategies';
import { createDefaultChain, CircuitBreakerChain, type CircuitBreakerState } from './circuitBreaker';
import { DiffValidator } from './diffValidator';
import { atomicCommit } from './gitOps';
import { StagnationDetector } from './stagnationDetector';
import { KnowledgeManager } from './knowledge';

const NO_OP_HOOK_RESULT: HookResult = { action: 'continue' };

export class NoOpHookService implements IRalphHookService {
	async onSessionStart() { return NO_OP_HOOK_RESULT; }
	async onPreCompact() { return NO_OP_HOOK_RESULT; }
	async onPostToolUse() { return NO_OP_HOOK_RESULT; }
	async onPreComplete() { return NO_OP_HOOK_RESULT; }
	async onTaskComplete() { return NO_OP_HOOK_RESULT; }
}

export async function runPreCompleteChain(
	hooks: PreCompleteHookConfig[],
	hookService: IRalphHookService,
	baseInput: Omit<PreCompleteInput, 'previousResults'>,
): Promise<{ action: 'continue' | 'retry' | 'stop'; results: PreCompleteHookResult[] }> {
	const results: PreCompleteHookResult[] = [];
	for (const hook of hooks) {
		if (!hook.enabled) { continue; }
		const input: PreCompleteInput = { ...baseInput, previousResults: [...results] };
		const result = await hookService.onPreComplete(input);
		results.push({ ...result, hookName: hook.name });
		if (result.action === 'retry') { return { action: 'retry', results }; }
		if (result.action === 'stop') { return { action: 'stop', results }; }
	}
	return { action: 'continue', results };
}

export function parseReviewVerdict(output: string): ReviewVerdict {
	const lower = output.toLowerCase();
	const needsRetry = lower.includes('needs-retry');
	return {
		outcome: needsRetry ? 'needs-retry' : 'approved',
		summary: output,
	};
}

export interface MonitorSignals {
	getPrdMtime: () => number;
	getProgressMtime: () => number;
	getProgressSize: () => number;
	getCheckboxCount: () => number;
}

export function startMonitor(
	taskId: string,
	taskInvocationId: string,
	config: ParallelMonitorConfig,
	signals: MonitorSignals,
	onEvent: (event: LoopEvent) => void,
	logger: ILogger,
): { stop: () => void } {
	if (!config.enabled) {
		return { stop: () => { } };
	}

	let staleIntervalCount = 0;
	let prevPrdMtime = signals.getPrdMtime();
	let prevProgressMtime = signals.getProgressMtime();
	let prevProgressSize = signals.getProgressSize();
	let prevCheckboxCount = signals.getCheckboxCount();

	const interval = setInterval(() => {
		const curPrdMtime = signals.getPrdMtime();
		const curProgressMtime = signals.getProgressMtime();
		const curProgressSize = signals.getProgressSize();
		const curCheckboxCount = signals.getCheckboxCount();

		const changed =
			curPrdMtime !== prevPrdMtime ||
			curProgressMtime !== prevProgressMtime ||
			curProgressSize !== prevProgressSize ||
			curCheckboxCount !== prevCheckboxCount;

		prevPrdMtime = curPrdMtime;
		prevProgressMtime = curProgressMtime;
		prevProgressSize = curProgressSize;
		prevCheckboxCount = curCheckboxCount;

		if (changed) {
			staleIntervalCount = 0;
		} else {
			staleIntervalCount++;
		}

		if (staleIntervalCount >= config.stuckThreshold) {
			logger.warn(`Monitor: task ${taskId} appears stuck (${staleIntervalCount} stale intervals)`);
			onEvent({
				kind: LoopEventKind.MonitorAlert,
				alert: `Task ${taskId} appears stuck — no progress signals for ${staleIntervalCount} intervals`,
				taskId,
			});
			staleIntervalCount = 0;
		}
	}, config.intervalMs);

	return {
		stop: () => clearInterval(interval),
	};
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
	private readonly circuitBreakerChain: CircuitBreakerChain;
	private readonly consistencyChecker?: IConsistencyChecker;

	constructor(
		config: RalphConfig,
		logger: ILogger,
		onEvent: (event: LoopEvent) => void,
		hookService?: IRalphHookService,
		consistencyChecker?: IConsistencyChecker,
	) {
		this.config = config;
		this.logger = logger;
		this.onEvent = onEvent;
		this.hookService = hookService ?? new NoOpHookService();
		this.hooksEnabled = hookService !== undefined;
		this.executionStrategy = this.resolveStrategy();
		this.circuitBreakerChain = createDefaultChain(this.config.circuitBreakers);
		this.consistencyChecker = consistencyChecker;
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
		if (!this.config.features.useSessionTracking) { return; }
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
			modelHint: this.config.modelHint,
		};
	}

	private get executionOptions(): ExecutionOptions {
		return {
			prdPath: resolvePrdPath(this.config.workspaceRoot, this.config.prdPath),
			workspaceRoot: this.config.workspaceRoot,
			inactivityTimeoutMs: this.config.inactivityTimeoutMs,
			useAutopilotMode: this.config.features.useAutopilotMode,
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
		const loopStartTime = Date.now();

		// Stagnation detection
		const stagnationConfig = this.config.stagnationDetection ?? DEFAULT_STAGNATION_DETECTION;
		const stagnationDetector = stagnationConfig.enabled
			? new StagnationDetector(stagnationConfig.hashFiles, stagnationConfig.maxStaleIterations)
			: undefined;

		// Knowledge manager
		const knowledgeConfig = this.config.knowledge ?? DEFAULT_KNOWLEDGE_CONFIG;
		const knowledgeManager = knowledgeConfig.enabled
			? new KnowledgeManager(knowledgeConfig.path, knowledgeConfig.maxInjectLines)
			: undefined;

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
			// Circuit breaker check before next iteration
			{
				const cbState: CircuitBreakerState = {
					nudgeCount: 0,
					retryCount: 0,
					elapsedMs: Date.now() - loopStartTime,
					fileChanges: 0,
					errorHistory: [],
					consecutiveNudgesWithoutFileChanges: 0,
				};
				const cbResult = this.circuitBreakerChain.check(cbState);
				if (cbResult.tripped) {
					this.logger.log(`Circuit breaker tripped before next iteration: ${cbResult.reason}`);
					yield { kind: LoopEventKind.CircuitBreakerTripped, breakerName: '', reason: cbResult.reason ?? 'unknown', action: cbResult.action, taskInvocationId: '' };
					if (cbResult.action === 'stop') { yield { kind: LoopEventKind.Stopped }; return; }
					if (cbResult.action === 'skip') { /* skip to next task */ }
				}
			}

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

			// Parse PRD, pick next task(s)
			const snapshot = readPrdSnapshot(prdPath);

			// Use DAG-aware parallel task selection when useParallelTasks is enabled and maxParallelTasks > 1
			if (this.config.features.useParallelTasks && this.config.maxParallelTasks > 1) {
				const concurrencyCap = this.config.maxConcurrencyPerStage > 1
					? this.config.maxConcurrencyPerStage
					: this.config.maxParallelTasks;
				const readyTasks = pickReadyTasks(snapshot, concurrencyCap)
					.filter(t => !this.completedTasks.has(t.id));

				if (readyTasks.length === 0) {
					const fallbackTask = pickNextTask(snapshot);
					if (!fallbackTask || this.completedTasks.has(fallbackTask.id)) {
						yield { kind: LoopEventKind.AllDone, total: snapshot.total };
						return;
					}
					// Fall through to single-task execution below
				} else if (readyTasks.length > 1) {
					yield { kind: LoopEventKind.TasksParallelized, tasks: readyTasks };
					iteration++;

					const parallelResults = await Promise.all(
						readyTasks.map(async (task) => {
							const invId = crypto.randomUUID();
							task.status = TaskStatus.InProgress;
							this.onEvent({ kind: LoopEventKind.TaskStarted, task, iteration, taskInvocationId: invId });
							const start = Date.now();

							try {
								appendProgress(progressPath, `[${invId}] Task started (parallel): ${task.description}`);
								const prdContent = readPrdFile(prdPath);
								let progContent = '';
								try { progContent = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }
								const prompt = buildPrompt(task.description, prdContent, progContent, 20, this.config.promptBlocks, this.promptCapabilities);
								const execResult = await this.executionStrategy.execute(task, prompt, this.executionOptions);
								const duration = Date.now() - start;

								if (execResult.completed) {
									this.completedTasks.add(task.id);
									appendProgress(progressPath, `[${invId}] Task completed (parallel): ${task.description} (${Math.round(duration / 1000)}s)`);
									this.onEvent({ kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration, taskInvocationId: invId });

									// Atomic git commit per task (parallel path)
									const pCommitResult = await atomicCommit(this.config.workspaceRoot, task, invId);
									if (pCommitResult.success) {
										appendProgress(progressPath, `[${invId}] Committed: ${pCommitResult.commitHash}`);
										this.onEvent({ kind: LoopEventKind.TaskCommitted, task, commitHash: pCommitResult.commitHash!, taskInvocationId: invId });
									} else {
										this.logger.warn(`Atomic commit failed for parallel task ${task.id}: ${pCommitResult.error}`);
										this.onEvent({ kind: LoopEventKind.Error, message: `Atomic commit failed: ${pCommitResult.error}` });
									}
								} else {
									appendProgress(progressPath, `[${invId}] Task timed out (parallel): ${task.description} (${Math.round(duration / 1000)}s)`);
									this.onEvent({ kind: LoopEventKind.TaskTimedOut, task: { ...task, status: TaskStatus.TimedOut }, durationMs: duration, taskInvocationId: invId });
								}
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								appendProgress(progressPath, `[${invId}] Task error (parallel): ${task.description} — ${msg}`);
								this.onEvent({ kind: LoopEventKind.Error, message: `Task "${task.description}" failed: ${msg}` });
							}
						}),
					);

					if (this.yieldRequested) {
						this.logger.log('Yield honoured after parallel tasks');
						yield { kind: LoopEventKind.YieldRequested };
						return;
					}

					// Countdown between parallel batches
					for (let s = this.config.countdownSeconds; s > 0; s--) {
						if (this.stopRequested) {
							yield { kind: LoopEventKind.Stopped };
							return;
						}
						yield { kind: LoopEventKind.Countdown, secondsLeft: s };
						await this.delay(1000);
					}
					continue; // back to while(true) for next batch
				}
				// If only 1 ready task, fall through to single-task path
			}

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
				// Stagnation snapshot before prompt
				stagnationDetector?.snapshot(this.config.workspaceRoot);

				const prdContent = readPrdFile(prdPath);
				let progressContent = '';
				try {
					progressContent = fs.readFileSync(progressPath, 'utf-8');
				} catch {
					// progress file may not exist yet
				}

				// Build prompt and execute via strategy
				const relevantLearnings = knowledgeManager
					? knowledgeManager.getRelevantLearnings(this.config.workspaceRoot, task.description)
					: [];
				let prompt = buildPrompt(task.description, prdContent, progressContent, 20, this.config.promptBlocks, this.promptCapabilities, relevantLearnings);
				if (additionalContext) {
					prompt += '\n\n' + additionalContext;
					additionalContext = '';
				}
				const taskState: TaskState = { taskInvocationId, nudgeCount: 0, retryCount: 0, taskCompletedLatch: false };
				let consecutiveNudgesWithoutFileChanges = 0;
				const errorHistory: boolean[] = [];

				// Start monitor before execute
				const monitorConfig = this.config.parallelMonitor ?? DEFAULT_PARALLEL_MONITOR;
				const monitorSignals: MonitorSignals = {
					getPrdMtime: () => { try { return fs.statSync(prdPath).mtimeMs; } catch { return 0; } },
					getProgressMtime: () => { try { return fs.statSync(progressPath).mtimeMs; } catch { return 0; } },
					getProgressSize: () => { try { return fs.statSync(progressPath).size; } catch { return 0; } },
					getCheckboxCount: () => { try { const content = fs.readFileSync(prdPath, 'utf-8'); return (content.match(/- \[x\]/gi) ?? []).length; } catch { return 0; } },
				};
				const monitor = startMonitor(String(task.id), taskInvocationId, monitorConfig, monitorSignals, this.onEvent, this.logger);

				let execResult;
				try {
					execResult = await this.executionStrategy.execute(task, prompt, this.executionOptions);
				} catch (execErr) {
					monitor.stop();
					throw execErr;
				}
				monitor.stop();
				yield { kind: LoopEventKind.CopilotTriggered, method: execResult.method, taskInvocationId };
				yield { kind: LoopEventKind.WaitingForCompletion, task, taskInvocationId };
				let waitResult = { completed: execResult.completed, hadFileChanges: execResult.hadFileChanges };

				// Nudge loop: re-send prompt with continuation nudge if timed out
				while (!waitResult.completed && !this.stopRequested && taskState.nudgeCount < this.config.maxNudgesPerTask) {
					// Circuit breaker check before nudge
					const cbState: CircuitBreakerState = {
						nudgeCount: taskState.nudgeCount,
						retryCount: taskState.retryCount,
						elapsedMs: Date.now() - startTime,
						fileChanges: waitResult.hadFileChanges ? 1 : 0,
						errorHistory,
						consecutiveNudgesWithoutFileChanges,
					};
					const cbResult = this.circuitBreakerChain.check(cbState);
					if (cbResult.tripped) {
						this.logger.log(`Circuit breaker tripped before nudge: ${cbResult.reason}`);
						yield { kind: LoopEventKind.CircuitBreakerTripped, breakerName: '', reason: cbResult.reason ?? 'unknown', action: cbResult.action, taskInvocationId };
						if (cbResult.action === 'stop') { yield { kind: LoopEventKind.Stopped }; return; }
						if (cbResult.action === 'skip') { break; }
					}

					// Reset nudgeCount if productive file changes occurred during wait
					if (waitResult.hadFileChanges) {
						this.logger.log('Productive file changes detected — resetting nudge count');
						taskState.nudgeCount = 0;
						consecutiveNudgesWithoutFileChanges = 0;
					} else {
						consecutiveNudgesWithoutFileChanges++;
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

				// Stagnation evaluation after task attempt
				if (stagnationDetector) {
					const stagnation = stagnationDetector.evaluate();
					if (stagnation.staleIterations > 0) {
						yield { kind: LoopEventKind.StagnationDetected, task, staleIterations: stagnation.staleIterations, filesUnchanged: stagnation.filesUnchanged };
					}
					const stagnationThreshold = stagnationConfig.maxStaleIterations;
					if (stagnation.staleIterations >= stagnationThreshold + 2) {
						// Tier 3: yield HumanCheckpointRequested and break
						yield { kind: LoopEventKind.HumanCheckpointRequested, task, reason: 'Stagnation detected — no progress after multiple attempts', failCount: stagnation.staleIterations, taskInvocationId };
						this.pauseRequested = true;
						while (this.pauseRequested) {
							this.state = LoopState.Paused;
							await this.delay(1000);
							if (this.stopRequested) {
								yield { kind: LoopEventKind.Stopped };
								return;
							}
						}
					} else if (stagnation.staleIterations >= stagnationThreshold + 1) {
						// Tier 2: trigger circuit breaker
						yield { kind: LoopEventKind.CircuitBreakerTripped, breakerName: 'stagnation', reason: 'Stagnation detected — progress files unchanged', action: 'skip', taskInvocationId };
					} else if (stagnation.stagnating) {
						// Tier 1: inject enhanced stagnation nudge
						additionalContext = 'You appear to be stuck. Progress file has not changed. Try a different approach.';
					}
				}

				if (waitResult.completed) {
					taskState.taskCompletedLatch = true;
					this.completedTasks.add(task.id);
					appendProgress(progressPath, `[${taskInvocationId}] Task completed: ${task.description} (${Math.round(duration / 1000)}s)`);
					yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration, taskInvocationId };

					// Knowledge extraction after task completion
					if (knowledgeManager) {
						let capturedOutput = '';
						try { capturedOutput = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }
						const learnings = knowledgeManager.extractLearnings(capturedOutput);
						const gaps = knowledgeManager.extractGaps(capturedOutput);
						if (learnings.length > 0 || gaps.length > 0) {
							knowledgeManager.persist(this.config.workspaceRoot, learnings, gaps);
						}
					}

					// Consistency check after task execution
					if (this.consistencyChecker) {
						const ccInput = {
							prdPath,
							progressPath,
							workspaceRoot: this.config.workspaceRoot,
							expectedPhase: 'in_progress',
							taskDescription: task.description,
						};
						const ccResult = await this.consistencyChecker.runDeterministic(ccInput);
						if (ccResult.passed) {
							this.onEvent({ kind: LoopEventKind.ConsistencyCheckPassed, phase: 'post_task', checks: ccResult.checks });
						} else {
							this.onEvent({ kind: LoopEventKind.ConsistencyCheckFailed, phase: 'post_task', checks: ccResult.checks, failureReason: ccResult.failureReason });
							this.logger.warn(`Consistency check failed: ${ccResult.failureReason}`);
						}
					}

					// Diff validation after TaskCompleted
					const diffConfig = this.config.diffValidation ?? DEFAULT_DIFF_VALIDATION;
					if (diffConfig.enabled) {
						const diffValidator = new DiffValidator(diffConfig);
						let diffAttempt = 0;
						let diffPassed = false;

						while (diffAttempt < this.config.maxDiffValidationRetries) {
							const diffResult = await diffValidator.validateDiff(this.config.workspaceRoot, taskInvocationId);

							if (diffResult.hasDiff) {
								// Diff present — generate summary if configured
								if (diffConfig.generateSummary) {
									await diffValidator.appendStateToProgress(progressPath, task.id, diffResult);
								}
								diffPassed = true;
								break;
							}

							// No diff — escalate
							diffAttempt++;
							const nudge = diffResult.nudge ?? 'No code changes detected. Review the task requirements and make the necessary code modifications.';
							yield { kind: LoopEventKind.DiffValidationFailed, task, nudge, attempt: diffAttempt, taskInvocationId };

							if (diffAttempt >= this.config.maxDiffValidationRetries) {
								// Max retries exhausted — request human checkpoint
								yield {
									kind: LoopEventKind.HumanCheckpointRequested,
									task,
									reason: `Diff validation failed after ${diffAttempt} attempts — no code changes detected`,
									failCount: diffAttempt,
									taskInvocationId,
								};
								// Pause the loop for human intervention
								this.pauseRequested = true;
								break;
							}

							// Inject nudge and re-enter task (autopilot pattern)
							this.logger.log(`Diff validation failed (attempt ${diffAttempt}/${this.config.maxDiffValidationRetries}): re-entering task with nudge`);
							this.completedTasks.delete(task.id);

							const prdContentRetry = readPrdFile(prdPath);
							let progressContentRetry = '';
							try { progressContentRetry = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }
							let retryPrompt = buildPrompt(task.description, prdContentRetry, progressContentRetry, 20, this.config.promptBlocks, this.promptCapabilities);
							retryPrompt += '\n\n' + nudge;
							const retryExec = await this.executionStrategy.execute(task, retryPrompt, this.executionOptions);
							waitResult = { completed: retryExec.completed, hadFileChanges: retryExec.hadFileChanges };
						}

						if (!diffPassed && this.pauseRequested) {
							// Wait for human to unpause
							while (this.pauseRequested) {
								this.state = LoopState.Paused;
								await this.delay(1000);
								if (this.stopRequested) {
									yield { kind: LoopEventKind.Stopped };
									return;
								}
							}
						}
					}

					// PreComplete hook chain — runs after verifiers pass, before TaskComplete hook
					const preCompleteHooks = this.config.preCompleteHooks ?? DEFAULT_PRE_COMPLETE_HOOKS;
					const preCompleteResult = await runPreCompleteChain(
						preCompleteHooks,
						this.hookService,
						{ taskId: String(task.id), taskInvocationId, checksRun: [], prdPath },
					);
					if (preCompleteResult.action === 'retry') {
						this.completedTasks.delete(task.id);
						continue;
					}
					if (preCompleteResult.action === 'stop') {
						yield { kind: LoopEventKind.Stopped };
						return;
					}

					// TaskComplete hook
					const completeHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'success', taskInvocationId });
					if (completeHook.additionalContext) { additionalContext = completeHook.additionalContext; }
					if (completeHook.action === 'stop') {
						yield { kind: LoopEventKind.Stopped };
						return;
					}

					// Review-after-execute
					const reviewConfig = this.config.reviewAfterExecute ?? DEFAULT_REVIEW_AFTER_EXECUTE;
					if (reviewConfig.enabled) {
						const reviewPrompt = await sendReviewPrompt(
							task.description,
							reviewConfig.mode,
							reviewConfig.reviewPromptTemplate,
							this.logger,
						);
						const verdict = parseReviewVerdict(reviewPrompt);
						appendProgress(progressPath, `[${taskInvocationId}] Review verdict: ${verdict.outcome} — ${verdict.summary}`);
						yield { kind: LoopEventKind.TaskReviewed, task, verdict, taskInvocationId };
						if (verdict.outcome === 'needs-retry') {
							this.completedTasks.delete(task.id);
							continue;
						}
					}

					// Atomic git commit per task
					const commitResult = await atomicCommit(this.config.workspaceRoot, task, taskInvocationId);
					if (commitResult.success) {
						appendProgress(progressPath, `[${taskInvocationId}] Committed: ${commitResult.commitHash}`);
						yield { kind: LoopEventKind.TaskCommitted, task, commitHash: commitResult.commitHash!, taskInvocationId };
					} else {
						this.logger.warn(`Atomic commit failed for task ${task.id}: ${commitResult.error}`);
						yield { kind: LoopEventKind.Error, message: `Atomic commit failed: ${commitResult.error}` };
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
					// Circuit breaker check before retry
					const cbState: CircuitBreakerState = {
						nudgeCount: 0,
						retryCount,
						elapsedMs: Date.now() - startTime,
						fileChanges: 0,
						errorHistory: [true],
						consecutiveNudgesWithoutFileChanges: 0,
					};
					const cbResult = this.circuitBreakerChain.check(cbState);
					if (cbResult.tripped) {
						this.logger.log(`Circuit breaker tripped before retry: ${cbResult.reason}`);
						yield { kind: LoopEventKind.CircuitBreakerTripped, breakerName: '', reason: cbResult.reason ?? 'unknown', action: cbResult.action, taskInvocationId };
						if (cbResult.action === 'stop') { yield { kind: LoopEventKind.Stopped }; return; }
						if (cbResult.action === 'skip') { break; }
					}

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
	const featConfig = vscode.workspace.getConfiguration('ralph-loop.features');

	const features = {
		useHookBridge: featConfig.get<boolean>('useHookBridge', DEFAULT_FEATURES.useHookBridge),
		useSessionTracking: featConfig.get<boolean>('useSessionTracking', DEFAULT_FEATURES.useSessionTracking),
		useAutopilotMode: featConfig.get<boolean>('useAutopilotMode', DEFAULT_FEATURES.useAutopilotMode),
		useParallelTasks: featConfig.get<boolean>('useParallelTasks', DEFAULT_FEATURES.useParallelTasks),
		useLlmConsistencyCheck: featConfig.get<boolean>('useLlmConsistencyCheck', DEFAULT_FEATURES.useLlmConsistencyCheck),
	};

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
		modelHint: vsConfig.get<string | undefined>('modelHint', undefined),
		features,
		useHookBridge: features.useHookBridge,
		useSessionTracking: features.useSessionTracking,
		useAutopilotMode: features.useAutopilotMode,
		maxParallelTasks: vsConfig.get<number>('maxParallelTasks', DEFAULT_CONFIG.maxParallelTasks),
		workspaceRoot,
		diffValidation: vsConfig.get('diffValidation', DEFAULT_CONFIG.diffValidation),
		maxDiffValidationRetries: vsConfig.get<number>('maxDiffValidationRetries', DEFAULT_CONFIG.maxDiffValidationRetries),
		reviewAfterExecute: vsConfig.get('reviewAfterExecute', DEFAULT_CONFIG.reviewAfterExecute),
		maxConcurrencyPerStage: vsConfig.get<number>('maxConcurrencyPerStage', DEFAULT_CONFIG.maxConcurrencyPerStage),
		parallelMonitor: vsConfig.get('parallelMonitor', DEFAULT_CONFIG.parallelMonitor),
		preCompactBehavior: vsConfig.get('preCompactBehavior', DEFAULT_CONFIG.preCompactBehavior),
		stagnationDetection: vsConfig.get('stagnationDetection', DEFAULT_CONFIG.stagnationDetection),
		knowledge: vsConfig.get('knowledge', DEFAULT_CONFIG.knowledge),
	};
}
