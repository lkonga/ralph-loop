import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CircuitBreakerChain, createDefaultChain, ErrorHashTracker, type CircuitBreakerState } from './circuitBreaker';
import { showCooldownDialog, type CooldownDialogResult } from './cooldownDialog';
import { buildFinalNudgePrompt, buildPrompt, parseReviewVerdict, PromptCapabilities, sendReviewPrompt } from './copilot';
import { MAX_RETRIES_PER_TASK, shouldRetryError } from './decisions';
import { DiffValidator } from './diffValidator';
import { atomicCommit, getCurrentBranch, branchExists, createAndCheckoutBranch, checkoutBranch, getShortHash, hasDirtyWorkingTree, wipCommit } from './gitOps';
import { KnowledgeManager } from './knowledge';
import { addDependsAnnotation, analyzeMissingDependency, appendProgress, deriveBranchName, markTaskComplete, parsePrdTitle, pickNextTask, pickReadyTasks, readPrdFile, readPrdSnapshot, resolvePrdPath, resolveProgressPath, validatePrd, validatePrdEdit } from './prd';
import { SessionPersistence } from './sessionPersistence';
import { AutoDecomposer, StagnationDetector } from './stagnationDetector';
import { CopilotCommandStrategy, DirectApiStrategy } from './strategies';
import { StruggleDetector } from './struggleDetector';
import { VerificationCache } from './verificationCache';
import {
	BearingsConfig,
	BearingsResult,
	BearingsLevel,
	DEFAULT_AUTO_DECOMPOSE,
	DEFAULT_BEARINGS_CONFIG,
	DEFAULT_CONFIG,
	DEFAULT_CONTEXT_TRIMMING,
	DEFAULT_DIFF_VALIDATION,
	DEFAULT_FEATURES,
	DEFAULT_KNOWLEDGE_CONFIG,
	DEFAULT_PARALLEL_MONITOR,
	DEFAULT_PRE_COMPLETE_HOOKS,
	DEFAULT_REVIEW_AFTER_EXECUTE,
	DEFAULT_STAGNATION_DETECTION,
	DEFAULT_STRUGGLE_DETECTION,
	ExecutionOptions,
	HookResult,
	IConsistencyChecker,
	ILogger,
	IRalphHookService,
	ITaskExecutionStrategy,
	LoopEvent,
	LoopEventKind,
	LoopState,
	ParallelMonitorConfig,
	PreCompleteHookConfig,
	PreCompleteHookResult,
	PreCompleteInput,
	RalphConfig,
	TaskState,
	TaskStatus,
	VerifyCheck,
	VerifyResult
} from './types';
import { computeConfidenceScore, dualExitGateCheck, formatVerificationFeedback } from './verify';

const KNOWN_AGENTS = new Set(['executor', 'explore', 'research']);

export function resolveAgentMode(
	task: { agent?: string },
	defaultAgentMode: string,
	logger: ILogger,
): string {
	if (!task.agent) {
		return defaultAgentMode;
	}
	const modeId = `ralph-${task.agent}`;
	if (!KNOWN_AGENTS.has(task.agent)) {
		logger.warn(`Unknown agent "${task.agent}" — falling back to default "${defaultAgentMode}"`);
		return defaultAgentMode;
	}
	return modeId;
}

export type BearingsExecFn = (cmd: string, cwd: string, signal?: AbortSignal) => Promise<{ exitCode: number; output: string }>;

export class LinkedCancellationSource {
	private readonly controller = new AbortController();
	private readonly cleanups: (() => void)[] = [];

	constructor(...signals: AbortSignal[]) {
		for (const sig of signals) {
			if (sig.aborted) {
				this.controller.abort(sig.reason);
				return;
			}
			const handler = () => this.controller.abort(sig.reason);
			sig.addEventListener('abort', handler);
			this.cleanups.push(() => sig.removeEventListener('abort', handler));
		}
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	cancel(reason?: string): void {
		this.controller.abort(reason);
	}

	dispose(): void {
		for (const cleanup of this.cleanups) {
			cleanup();
		}
		this.cleanups.length = 0;
	}
}

export function defaultBearingsExec(cmd: string, cwd: string, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			return resolve({ exitCode: 1, output: 'Aborted before start' });
		}

		const child = spawn(cmd, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let settled = false;

		const onAbort = () => {
			if (!settled) {
				settled = true;
				child.kill('SIGTERM');
				resolve({ exitCode: 1, output: stdout + stderr + '\nAborted' });
			}
		};

		if (signal) {
			signal.addEventListener('abort', onAbort, { once: true });
		}

		child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
		child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

		child.on('error', (err: Error) => {
			if (!settled) {
				settled = true;
				if (signal) { signal.removeEventListener('abort', onAbort); }
				resolve({ exitCode: 1, output: err.message });
			}
		});

		child.on('close', (code: number | null) => {
			if (!settled) {
				settled = true;
				if (signal) { signal.removeEventListener('abort', onAbort); }
				resolve({ exitCode: code ?? 1, output: stdout + stderr });
			}
		});
	});
}

export type BearingsProgressFn = (stage: string, status: 'running' | 'done' | 'skipped') => void;

export async function runBearings(
	workspaceRoot: string,
	logger: ILogger,
	config: BearingsConfig = DEFAULT_BEARINGS_CONFIG,
	execFn: BearingsExecFn = defaultBearingsExec,
	level?: BearingsLevel,
	onProgress?: BearingsProgressFn,
): Promise<BearingsResult> {
	const effectiveLevel = level ?? 'full';
	if (effectiveLevel === 'none') {
		return { healthy: true, issues: [] };
	}

	const issues: string[] = [];

	const shouldRunTsc = config.runTsc && (effectiveLevel === 'tsc' || effectiveLevel === 'full');
	const shouldRunTests = config.runTests && effectiveLevel === 'full';

	if (shouldRunTsc) {
		const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
		if (fs.existsSync(tsconfigPath)) {
			onProgress?.('tsc', 'running');
			logger.log('Bearings: running tsc --noEmit...');
			const tscResult = await execFn('npx tsc --noEmit', workspaceRoot);
			if (tscResult.exitCode !== 0) {
				issues.push(`TypeScript errors: ${tscResult.output.slice(0, 500)}`);
			}
			onProgress?.('tsc', 'done');
		} else {
			onProgress?.('tsc', 'skipped');
			logger.log('Bearings: skipping tsc (no tsconfig.json)');
		}
	}

	if (shouldRunTests) {
		const hasVitest = fs.existsSync(path.join(workspaceRoot, 'vite.config.ts'))
			|| fs.existsSync(path.join(workspaceRoot, 'vitest.config.ts'))
			|| fs.existsSync(path.join(workspaceRoot, 'vitest.config.js'));
		if (hasVitest) {
			onProgress?.('vitest', 'running');
			logger.log('Bearings: running vitest...');
			const testResult = await execFn('npx vitest run', workspaceRoot);
			if (testResult.exitCode !== 0) {
				issues.push(`Test failures: ${testResult.output.slice(0, 500)}`);
			}
			onProgress?.('vitest', 'done');
		} else {
			onProgress?.('vitest', 'skipped');
			logger.log('Bearings: skipping tests (no vitest config)');
		}
	}

	if (issues.length === 0) {
		return { healthy: true, issues: [] };
	}

	const details = issues.join('; ');
	return {
		healthy: false,
		issues,
		fixTask: `Fix baseline: ${details}`,
	};
}

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
	private stopController = new AbortController();
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
	private readonly errorHashTracker: ErrorHashTracker;
	private readonly consistencyChecker?: IConsistencyChecker;
	private pendingContext?: string;
	private linkedSignal?: LinkedCancellationSource;
	private readonly sessionPersistence?: SessionPersistence;
	private activeBranch?: string;
	private originalBranch?: string;
	private _currentTaskId = '';
	private _currentTaskDescription = '';
	private _currentIteration = 0;
	private _currentNudgeCount = 0;
	bearingsExecFn?: BearingsExecFn;
	showCooldownDialogFn: (nextTask: string, timeoutMs: number) => Promise<CooldownDialogResult>;

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
		this.errorHashTracker = new ErrorHashTracker();
		this.circuitBreakerChain = createDefaultChain(this.config.circuitBreakers, this.errorHashTracker);
		this.consistencyChecker = consistencyChecker;
		const spConfig = this.config.sessionPersistence ?? { enabled: true, expireAfterMs: 86400000 };
		if (spConfig.enabled) {
			this.sessionPersistence = new SessionPersistence(spConfig.expireAfterMs);
		}
		this.showCooldownDialogFn = showCooldownDialog;
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

	getCurrentTaskId(): string {
		return this._currentTaskId;
	}

	getStateSnapshot(): import('./types').StateSnapshot {
		return {
			state: this.state,
			taskId: this._currentTaskId,
			taskDescription: this._currentTaskDescription,
			iterationCount: this._currentIteration,
			nudgeCount: this._currentNudgeCount,
			branch: this.activeBranch,
			originalBranch: this.originalBranch,
		};
	}

	updateConfig(config: Partial<RalphConfig>): void {
		this.config = { ...this.config, ...config };
	}

	private static readonly STATE_CHANGE_EVENTS = new Set<LoopEventKind>([
		LoopEventKind.TaskStarted,
		LoopEventKind.TaskCompleted,
		LoopEventKind.Stopped,
		LoopEventKind.AllDone,
		LoopEventKind.MaxIterations,
		LoopEventKind.YieldRequested,
		LoopEventKind.SessionChanged,
	]);

	private static readonly TERMINAL_EVENTS = new Set<LoopEventKind>([
		LoopEventKind.Stopped,
		LoopEventKind.AllDone,
		LoopEventKind.MaxIterations,
		LoopEventKind.YieldRequested,
	]);

	async start(): Promise<void> {
		if (this.state === LoopState.Running) {
			this.logger.warn('Loop already running');
			return;
		}

		this.state = LoopState.Running;
		this.stopRequested = false;
		this.stopController = new AbortController();
		this.pauseRequested = false;
		this.yieldRequested = false;
		this.logger.log('Loop started');

		try {
			for await (const event of this.runLoop()) {
				this.onEvent(event);

				if (LoopOrchestrator.STATE_CHANGE_EVENTS.has(event.kind)) {
					if (LoopOrchestrator.TERMINAL_EVENTS.has(event.kind)) {
						this.state = LoopState.Idle;
						this._currentTaskId = '';
						this._currentTaskDescription = '';
					}
					const stateStr = this.state as string;
					const taskId = this._currentTaskId;
					this.onEvent({ kind: LoopEventKind.StateNotified, state: stateStr, taskId });
				}

				if (event.kind === LoopEventKind.Stopped ||
					event.kind === LoopEventKind.AllDone ||
					event.kind === LoopEventKind.MaxIterations ||
					event.kind === LoopEventKind.YieldRequested ||
					event.kind === LoopEventKind.BranchEnforcementFailed) {
					this.sessionPersistence?.clear(this.config.workspaceRoot);
					break;
				}
			}

			// Switch back to original branch after loop completion
			if (this.originalBranch && this.activeBranch) {
				try {
					const result = await checkoutBranch(this.config.workspaceRoot, this.originalBranch);
					if (result.success) {
						this.onEvent({ kind: LoopEventKind.BranchSwitchedBack, from: this.activeBranch, to: this.originalBranch });
					} else {
						this.logger.warn(`Failed to switch back to '${this.originalBranch}': ${result.error ?? 'unknown error'}. Work remains on '${this.activeBranch}'.`);
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.warn(`Failed to switch back to '${this.originalBranch}': ${msg}. Work remains on '${this.activeBranch}'.`);
				}
			}
		} finally {
			this.cleanup();
			this.state = LoopState.Idle;
		}
	}

	stop(): void {
		this.stopRequested = true;
		this.stopController.abort('stop requested');
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

	injectContext(text: string): void {
		this.pendingContext = text;
		this.logger.log('Context injected for next iteration');
	}

	private consumePendingContext(): string | undefined {
		const ctx = this.pendingContext;
		this.pendingContext = undefined;
		return ctx;
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
		this.linkedSignal?.dispose();
		this.linkedSignal = undefined;
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
		return this.executionOptionsForTask();
	}

	private executionOptionsForTask(task?: { agent?: string }): ExecutionOptions {
		const agentMode = task
			? resolveAgentMode(task, this.config.agentMode ?? 'ralph-executor', this.logger)
			: this.config.agentMode;
		this.logger.log(`Agent mode resolved: ${agentMode} (config: ${this.config.agentMode}, task.agent: ${task?.agent ?? 'none'})`);
		return {
			prdPath: resolvePrdPath(this.config.workspaceRoot, this.config.prdPath),
			workspaceRoot: this.config.workspaceRoot,
			inactivityTimeoutMs: this.config.inactivityTimeoutMs,
			useAutopilotMode: this.config.features.useAutopilotMode,
			shouldStop: () => this.stopRequested,
			signal: this.linkedSignal?.signal,
			agentMode,
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

		// Linked cancellation: combines manual stop signal + timeout
		const timeoutSignal = AbortSignal.timeout(this.config.inactivityTimeoutMs * effectiveMaxIterations);
		this.linkedSignal = new LinkedCancellationSource(this.stopController.signal, timeoutSignal);
		try {

			// Stagnation detection
			const stagnationConfig = this.config.stagnationDetection ?? DEFAULT_STAGNATION_DETECTION;
			const stagnationDetector = stagnationConfig.enabled
				? new StagnationDetector(stagnationConfig.hashFiles, stagnationConfig.maxStaleIterations)
				: undefined;

			// Auto-decomposition
			const autoDecomposeConfig = this.config.autoDecompose ?? DEFAULT_AUTO_DECOMPOSE;
			const autoDecomposer = autoDecomposeConfig.enabled ? new AutoDecomposer() : undefined;
			const taskFailCounts = new Map<number, number>();

			// Bearings phase state
			const bearingsConfig = this.config.bearings ?? DEFAULT_BEARINGS_CONFIG;
			let bearingsFixAttempted = false;
			let skipBearingsOnce = false;
			let startupBearingsDone = false;
			const verificationCache = new VerificationCache();

			// Knowledge manager
			const knowledgeConfig = this.config.knowledge ?? DEFAULT_KNOWLEDGE_CONFIG;
			const knowledgeManager = knowledgeConfig.enabled
				? new KnowledgeManager(knowledgeConfig.path, knowledgeConfig.maxInjectLines)
				: undefined;

			// Struggle detector
			const struggleConfig = this.config.struggleDetection ?? DEFAULT_STRUGGLE_DETECTION;
			const struggleDetector = struggleConfig.enabled
				? new StruggleDetector({
					noProgressThreshold: struggleConfig.noProgressThreshold,
					shortIterationThreshold: struggleConfig.shortIterationThreshold,
					shortIterationMs: struggleConfig.shortIterationMs,
				}, {
					regionRepetitionThreshold: struggleConfig.thrashingThreshold,
					windowSize: struggleConfig.thrashingWindowSize,
				})
				: undefined;

			// SessionStart hook
			const sessionHook = await this.hookService.onSessionStart({ prdPath });
			this.logger.log(`SessionStart hook: action=${sessionHook.action}`);
			if (sessionHook.additionalContext) { additionalContext = sessionHook.additionalContext; }
			if (sessionHook.blocked) {
				additionalContext = `Shell command blocked: ${sessionHook.reason}. Provide a safe alternative that does not use shell metacharacters or chaining.`;
				yield { kind: LoopEventKind.CommandBlocked, command: this.config.hookScript ?? 'unknown', reason: sessionHook.reason ?? 'unknown', taskId: '' };
			} else if (sessionHook.action === 'stop') {
				yield { kind: LoopEventKind.Stopped };
				return;
			}

			// Pre-flight PRD validation
			{
				const preflight = readPrdSnapshot(prdPath);
				const validation = validatePrd(preflight);
				if (!validation.valid) {
					yield { kind: LoopEventKind.PrdValidationFailed, errors: validation.errors };
					return;
				}
				if (validation.errors.length > 0) {
					for (const w of validation.errors) {
						this.logger.warn(`PRD warning: ${w.message}`);
					}
				}
			}

			// Branch enforcement gate (linear flow — always create new branch)
			const featureBranchConfig = this.config.featureBranch;
			if (featureBranchConfig?.enabled) {
				try {
					const currentBranch = await getCurrentBranch(this.config.workspaceRoot);
					this.originalBranch = currentBranch;

					const prdContent = readPrdFile(prdPath);
					const prdTitle = parsePrdTitle(prdContent);
					const shortHash = await getShortHash(this.config.workspaceRoot);
					const derivedName = deriveBranchName(prdTitle ?? '', shortHash);

					const createResult = await createAndCheckoutBranch(this.config.workspaceRoot, derivedName);
					if (!createResult.success) {
						yield { kind: LoopEventKind.BranchEnforcementFailed, reason: createResult.error ?? 'branch creation failed' };
						return;
					}

					if (await hasDirtyWorkingTree(this.config.workspaceRoot)) {
						await wipCommit(this.config.workspaceRoot);
						this.logger.log('Branch gate: committed dirty working tree as WIP');
					}

					this.activeBranch = derivedName;
					this.logger.log(`Branch gate: created branch '${derivedName}' from '${currentBranch}'`);
					yield { kind: LoopEventKind.BranchCreated, branchName: derivedName };
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.warn(`Branch gate: git operations failed — ${msg}`);
					yield { kind: LoopEventKind.BranchEnforcementFailed, reason: msg };
					return;
				}
			}

			while (true) {
				// Check stop
				if (this.linkedSignal?.signal.aborted || this.stopRequested) {
					yield { kind: LoopEventKind.Stopped };
					return;
				}

				// Handle pause
				while (this.pauseRequested) {
					this.state = LoopState.Paused;
					await this.delay(1000);
					if (this.linkedSignal?.signal.aborted || this.stopRequested) {
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
							if (snapshot.total === 0) {
								this.logger.warn('PRD re-read returned 0 tasks — possible file corruption, retrying');
								await this.delay(500);
								continue;
							}
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
									const prdContentBeforeParallel = readPrdFile(prdPath);
									const prdContent = prdContentBeforeParallel;
									let progContent = '';
									try { progContent = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }
									const prompt = buildPrompt(task.description, prdContent, progContent, 20, this.config.promptBlocks, this.promptCapabilities, undefined, iteration, this.config.contextTrimming ?? DEFAULT_CONTEXT_TRIMMING, undefined, task.taskId, undefined, this.config.workspaceRoot);
									const execResult = await this.executionStrategy.execute(task, prompt, this.executionOptionsForTask(task));
									const duration = Date.now() - start;

									if (execResult.completed) {
										this.completedTasks.add(task.id);
										appendProgress(progressPath, `[${invId}] Task completed (parallel): ${task.description} (${Math.round(duration / 1000)}s)`);
										this.onEvent({ kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: duration, taskInvocationId: invId });

										// PRD write protection (parallel path)
										const prdAfterParallel = readPrdFile(prdPath);
										const pEditValidation = validatePrdEdit(prdContentBeforeParallel, prdAfterParallel);
										if (!pEditValidation.allowed) {
											this.logger.warn(`PRD write protection (parallel): ${pEditValidation.reason}`);
											fs.writeFileSync(prdPath, prdContentBeforeParallel, 'utf-8');
											this.onEvent({ kind: LoopEventKind.Error, message: `PRD write protection: ${pEditValidation.reason}` });
										}

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
					if (snapshot.total === 0) {
						this.logger.warn('PRD re-read returned 0 tasks — possible file corruption, retrying');
						await this.delay(500);
						continue;
					}
					yield { kind: LoopEventKind.AllDone, total: snapshot.total };
					return;
				}

				// Skip tasks whose completion latch is already set
				if (this.completedTasks.has(task.id)) {
					continue;
				}

				// DSL checkpoint gate: run checkpoint-level bearings then pause for human review
				if (task.checkpoint) {
					const checkpointInvocationId = crypto.randomUUID();
					// Run bearings at checkpoint level before pausing
					if (bearingsConfig.enabled) {
						const checkpointLevel = bearingsConfig.checkpoint ?? 'full';
						if (checkpointLevel !== 'none') {
							const branch = VerificationCache.getGitBranch(this.config.workspaceRoot);
							const treeHash = VerificationCache.getGitTreeHash(this.config.workspaceRoot);
							const fileHashes = VerificationCache.computeFileHashes(this.config.workspaceRoot);
							const cacheHit = verificationCache.isValid(this.config.workspaceRoot, branch, treeHash, checkpointLevel, fileHashes);
							if (cacheHit) {
								this.logger.log('Bearings (checkpoint): cache hit — skipping verification');
								yield { kind: LoopEventKind.BearingsSkipped, reason: 'checkpoint cache hit' };
								yield { kind: LoopEventKind.BearingsChecked, healthy: true, issues: [] };
							} else {
								yield { kind: LoopEventKind.BearingsStarted, level: checkpointLevel };
								const cpStart = Date.now();
								const cbResult = await runBearings(this.config.workspaceRoot, this.logger, bearingsConfig, this.bearingsExecFn, checkpointLevel, (stage, status) => {
									this.onEvent({ kind: LoopEventKind.BearingsProgress, stage, status });
								});
								const cpDuration = Date.now() - cpStart;
								yield { kind: LoopEventKind.BearingsCompleted, healthy: cbResult.healthy, durationMs: cpDuration, issues: cbResult.issues };
								yield { kind: LoopEventKind.BearingsChecked, healthy: cbResult.healthy, issues: cbResult.issues };
								if (cbResult.healthy) {
									verificationCache.save(this.config.workspaceRoot, {
										timestamp: Date.now(),
										branch,
										treeHash,
										level: checkpointLevel,
										healthy: true,
										fileHashes,
									});
								}
								if (!cbResult.healthy) {
									verificationCache.clear(this.config.workspaceRoot);
									yield { kind: LoopEventKind.BearingsFailed, issues: cbResult.issues };
									this.pauseRequested = true;
									continue;
								}
							}
						}
						if (!startupBearingsDone) {
							startupBearingsDone = true;
						}
					}
					yield {
						kind: LoopEventKind.HumanCheckpointRequested,
						task,
						reason: `Checkpoint: ${task.description}`,
						failCount: 0,
						taskInvocationId: checkpointInvocationId,
					};
					this.pauseRequested = true;
					while (this.pauseRequested) {
						this.state = LoopState.Paused;
						await this.delay(1000);
						if (this.stopRequested) {
							yield { kind: LoopEventKind.Stopped };
							return;
						}
					}
					this.state = LoopState.Running;
					this.completedTasks.add(task.id);
					markTaskComplete(prdPath, task);
					appendProgress(progressPath, `[${checkpointInvocationId}] [${task.taskId}] Checkpoint cleared: ${task.description}`);
					yield { kind: LoopEventKind.TaskCompleted, task: { ...task, status: TaskStatus.Complete }, durationMs: 0, taskInvocationId: checkpointInvocationId };
					continue;
				}

				// Bearings phase: stage-aware pre-flight health check
				if (bearingsConfig.enabled && !skipBearingsOnce) {
					const bearingsLevel = !startupBearingsDone
						? (bearingsConfig.startup ?? 'tsc')
						: (bearingsConfig.perTask ?? 'none');
					if (bearingsLevel !== 'none') {
						const branch = VerificationCache.getGitBranch(this.config.workspaceRoot);
						const treeHash = VerificationCache.getGitTreeHash(this.config.workspaceRoot);
						const fileHashes = VerificationCache.computeFileHashes(this.config.workspaceRoot);
						const cacheHit = verificationCache.isValid(this.config.workspaceRoot, branch, treeHash, bearingsLevel, fileHashes);
						if (cacheHit) {
							this.logger.log('Bearings: cache hit — skipping verification (no relevant changes)');
							yield { kind: LoopEventKind.BearingsSkipped, reason: 'cache hit — no relevant changes' };
							yield { kind: LoopEventKind.BearingsChecked, healthy: true, issues: [] };
						} else {
							yield { kind: LoopEventKind.BearingsStarted, level: bearingsLevel };
							const bearingsStart = Date.now();
							const bearingsResult = await runBearings(this.config.workspaceRoot, this.logger, bearingsConfig, this.bearingsExecFn, bearingsLevel, (stage, status) => {
								this.onEvent({ kind: LoopEventKind.BearingsProgress, stage, status });
							});
							const bearingsDuration = Date.now() - bearingsStart;
							yield { kind: LoopEventKind.BearingsCompleted, healthy: bearingsResult.healthy, durationMs: bearingsDuration, issues: bearingsResult.issues };
							yield { kind: LoopEventKind.BearingsChecked, healthy: bearingsResult.healthy, issues: bearingsResult.issues };
							if (bearingsResult.healthy) {
								verificationCache.save(this.config.workspaceRoot, {
									timestamp: Date.now(),
									branch,
									treeHash,
									level: bearingsLevel,
									healthy: true,
									fileHashes,
								});
							}
							if (!bearingsResult.healthy) {
								verificationCache.clear(this.config.workspaceRoot);
								if (bearingsFixAttempted) {
									bearingsFixAttempted = false;
									yield { kind: LoopEventKind.BearingsFailed, issues: bearingsResult.issues };
									this.pauseRequested = true;
									continue;
								}
								bearingsFixAttempted = true;
								skipBearingsOnce = true;
								const fixLine = '- [ ] Fix baseline: resolve TypeScript errors and failing tests before continuing';
								const fixLineChecked = '- [x] Fix baseline: resolve TypeScript errors and failing tests before continuing';
								const currentPrd = fs.readFileSync(prdPath, 'utf-8');
								if (!currentPrd.includes(fixLine) && !currentPrd.includes(fixLineChecked)) {
									fs.writeFileSync(prdPath, fixLine + '\n' + currentPrd, 'utf-8');
								}
								continue;
							}
						}
						bearingsFixAttempted = false;
					} else {
						yield { kind: LoopEventKind.BearingsSkipped, reason: `level is 'none' for ${!startupBearingsDone ? 'startup' : 'per-task'}` };
					}
					if (!startupBearingsDone) {
						startupBearingsDone = true;
					}
				} else if (skipBearingsOnce) {
					skipBearingsOnce = false;
				} else if (!bearingsConfig.enabled) {
					yield { kind: LoopEventKind.BearingsSkipped, reason: 'bearings disabled' };
				}

				iteration++;
				task.status = TaskStatus.InProgress;
				this._currentTaskId = task.taskId;
				this._currentTaskDescription = task.description;
				this._currentIteration = iteration;
				this._currentNudgeCount = 0;
				const taskInvocationId = crypto.randomUUID();
				yield { kind: LoopEventKind.TaskStarted, task, iteration, taskInvocationId };

				const startTime = Date.now();
				try {
					appendProgress(progressPath, `[${taskInvocationId}] [${task.taskId}] Task started: ${task.description}`);

					// Read context for prompt
					// Stagnation snapshot before prompt
					stagnationDetector?.snapshot(this.config.workspaceRoot);

					const prdContentBeforeTask = readPrdFile(prdPath);
					const prdContent = prdContentBeforeTask;
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
					const ctConfig = this.config.contextTrimming ?? DEFAULT_CONTEXT_TRIMMING;
					const operatorContext = this.consumePendingContext();
					if (operatorContext) {
						this.onEvent({ kind: LoopEventKind.ContextInjected, text: operatorContext });
					}
					let prompt = buildPrompt(task.description, prdContent, progressContent, 20, this.config.promptBlocks, this.promptCapabilities, relevantLearnings, iteration, ctConfig, operatorContext, task.taskId, undefined, this.config.workspaceRoot);
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
						execResult = await this.executionStrategy.execute(task, prompt, this.executionOptionsForTask(task));
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
						if (waitResult.hadFileChanges || task.noDiff) {
							if (waitResult.hadFileChanges) {
								this.logger.log('Productive file changes detected — resetting nudge count');
							}
							taskState.nudgeCount = 0;
							consecutiveNudgesWithoutFileChanges = 0;
						} else {
							consecutiveNudgesWithoutFileChanges++;
						}

						taskState.nudgeCount++;
						this._currentNudgeCount = taskState.nudgeCount;
						yield { kind: LoopEventKind.TaskNudged, task, nudgeCount: taskState.nudgeCount, taskInvocationId };
						this.logger.log(`Nudging task (${taskState.nudgeCount}/${this.config.maxNudgesPerTask}): ${task.description}`);

						const finalNudge = buildFinalNudgePrompt(task.description, taskState.nudgeCount, this.config.maxNudgesPerTask);
						const continuationSuffix = finalNudge
							?? 'Continue with the current task. You have NOT marked the checkbox yet. Do NOT repeat previous work — pick up where you left off. If you encountered errors, resolve them. If you were planning, start implementing.';
						const nudgePrompt = buildPrompt(task.description, readPrdFile(prdPath), (() => { try { return fs.readFileSync(progressPath, 'utf-8'); } catch { return ''; } })(), 20, this.config.promptBlocks, this.promptCapabilities, undefined, iteration, this.config.contextTrimming ?? DEFAULT_CONTEXT_TRIMMING, undefined, task.taskId, undefined, this.config.workspaceRoot)
							+ '\n\n' + continuationSuffix;

						const nudgeResult = await this.executionStrategy.execute(task, nudgePrompt, this.executionOptionsForTask(task));
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
							// Tier 2.5: dynamic dependency discovery before circuit breaker
							let progressContent = '';
							try { progressContent = fs.readFileSync(progressPath, 'utf-8'); } catch { /* may not exist */ }
							const depTaskId = await analyzeMissingDependency(task, progressContent, prdPath);
							if (depTaskId) {
								addDependsAnnotation(prdPath, task, depTaskId);
								additionalContext = `Dependency discovered: ${task.taskId} depends on ${depTaskId}. Switching to dependency task.`;
								break;
							}
							// Inject prompt for next iteration so agent can report MISSING_DEP
							additionalContext = `Analyze WHY this task keeps failing. Identify if there is a prerequisite task that should have been completed first. If so, respond with MISSING_DEP: <taskId>.`;
							// Tier 2: trigger circuit breaker
							yield { kind: LoopEventKind.CircuitBreakerTripped, breakerName: 'stagnation', reason: 'Stagnation detected — progress files unchanged', action: 'skip', taskInvocationId };
						} else if (stagnation.stagnating) {
							// Tier 1: inject enhanced stagnation nudge
							additionalContext = 'You appear to be stuck. Progress file has not changed. Try a different approach.';
						}
					}

					// Struggle detection after task attempt
					if (struggleDetector) {
						const filesChanged = waitResult.hadFileChanges ? 1 : 0;
						struggleDetector.recordIteration(duration, filesChanged, []);
						const struggle = struggleDetector.isStruggling();
						if (struggle.struggling) {
							additionalContext = `Struggle detected: ${struggle.signals.join(', ')}. Try a completely different approach. If tests keep failing, check your assumptions.`;
							yield { kind: LoopEventKind.StruggleDetected, signals: struggle.signals, taskId: task.taskId };
						}
					}

					// Dual exit gate: require BOTH model signal AND machine verification
					const dualGateChecks: VerifyCheck[] = [];
					{
						const snapshot = readPrdSnapshot(prdPath);
						const foundTask = snapshot.tasks.find(t => t.description === task.description);
						dualGateChecks.push({ name: 'checkbox', result: foundTask?.status === TaskStatus.Complete ? VerifyResult.Pass : VerifyResult.Fail });
					}
					// noDiff tasks (documentation, meta) skip the diff requirement
					if (task.noDiff) {
						dualGateChecks.push({ name: 'diff', result: VerifyResult.Skip, detail: 'Skipped (noDiff task)' });
					} else {
						dualGateChecks.push({ name: 'diff', result: waitResult.hadFileChanges ? VerifyResult.Pass : VerifyResult.Fail, detail: waitResult.hadFileChanges ? 'Files changed' : 'No file changes detected' });
					}

					const gateResult = dualExitGateCheck(waitResult.completed, dualGateChecks);

					if (gateResult.canComplete) {
						taskState.taskCompletedLatch = true;
						this.completedTasks.add(task.id);
						appendProgress(progressPath, `[${taskInvocationId}] [${task.taskId}] Task completed: ${task.description} (${Math.round(duration / 1000)}s)`);
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
						if (diffConfig.enabled && !task.noDiff) {
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
								let retryPrompt = buildPrompt(task.description, prdContentRetry, progressContentRetry, 20, this.config.promptBlocks, this.promptCapabilities, undefined, iteration, this.config.contextTrimming ?? DEFAULT_CONTEXT_TRIMMING, undefined, task.taskId, undefined, this.config.workspaceRoot);
								retryPrompt += '\n\n' + nudge;
								const retryExec = await this.executionStrategy.execute(task, retryPrompt, this.executionOptionsForTask(task));
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

						// Confidence-based completion scoring
						const confidenceThreshold = this.config.confidenceThreshold ?? 100;
						const confidenceChecks: VerifyCheck[] = [];
						{
							const snapshot = readPrdSnapshot(prdPath);
							const foundTask = snapshot.tasks.find(t => t.description === task.description);
							confidenceChecks.push({ name: 'checkbox', result: foundTask?.status === TaskStatus.Complete ? VerifyResult.Pass : VerifyResult.Fail });
						}
						confidenceChecks.push({ name: 'vitest', result: VerifyResult.Pass });
						confidenceChecks.push({ name: 'tsc', result: VerifyResult.Pass });
						confidenceChecks.push({ name: 'no_errors', result: VerifyResult.Pass });
						{
							let progressUpdated = false;
							try { const stat = fs.statSync(progressPath); progressUpdated = (Date.now() - stat.mtimeMs) < 60000; } catch { /* ignore */ }
							confidenceChecks.push({ name: 'progress_updated', result: progressUpdated ? VerifyResult.Pass : VerifyResult.Fail });
						}
						const diffForConfidence: import('./types').DiffValidationResult | undefined = waitResult.hadFileChanges
							? { filesChanged: [], linesAdded: 0, linesRemoved: 0, hasDiff: true, summary: '' }
							: undefined;
						const confidence = computeConfidenceScore(confidenceChecks, diffForConfidence);
						yield { kind: LoopEventKind.ConfidenceScored, score: confidence.score, threshold: confidenceThreshold, breakdown: confidence.breakdown, taskId: task.taskId };

						if (confidence.score < confidenceThreshold) {
							const failing = Object.entries(confidence.breakdown).filter(([, v]) => v === 0).map(([k]) => k).join(', ');
							const feedback = formatVerificationFeedback(confidenceChecks);
							additionalContext = `Verification confidence: ${confidence.score}/180. Missing: ${failing}. Complete the remaining items.`;
							if (feedback) {
								additionalContext += '\n\n' + feedback;
							}
							this.completedTasks.delete(task.id);
							continue;
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
						if (completeHook.blocked) {
							additionalContext = `Shell command blocked: ${completeHook.reason}. Provide a safe alternative that does not use shell metacharacters or chaining.`;
							yield { kind: LoopEventKind.CommandBlocked, command: this.config.hookScript ?? 'unknown', reason: completeHook.reason ?? 'unknown', taskId: task.taskId };
						} else if (completeHook.action === 'stop') {
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

						// PRD write protection: validate edits before commit
						const prdContentAfterTask = readPrdFile(prdPath);
						const prdEditValidation = validatePrdEdit(prdContentBeforeTask, prdContentAfterTask);
						if (!prdEditValidation.allowed) {
							this.logger.warn(`PRD write protection: ${prdEditValidation.reason}`);
							fs.writeFileSync(prdPath, prdContentBeforeTask, 'utf-8');
							additionalContext = `PRD write protection rejected your edit: ${prdEditValidation.reason}. Only checkbox toggles, DECOMPOSED prefixes, and depends annotations are allowed.`;
							yield { kind: LoopEventKind.Error, message: `PRD write protection: ${prdEditValidation.reason}` };
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
					} else if (waitResult.completed && !gateResult.canComplete) {
						// Model signaled complete but dual gate rejected — nudge to fix
						this.logger.warn(`Dual exit gate rejected: ${gateResult.reason}`);
						const feedback = formatVerificationFeedback(dualGateChecks);
						additionalContext = gateResult.reason ?? 'Dual exit gate check failed';
						if (feedback) {
							additionalContext += '\n\n' + feedback;
						}
						this.completedTasks.delete(task.id);
						continue;
					} else {
						appendProgress(progressPath, `[${taskInvocationId}] [${task.taskId}] Task timed out: ${task.description} (${Math.round(duration / 1000)}s)`);
						yield { kind: LoopEventKind.TaskTimedOut, task: { ...task, status: TaskStatus.TimedOut }, durationMs: duration, taskInvocationId };

						// Track consecutive failures for auto-decomposition
						if (autoDecomposer) {
							const count = (taskFailCounts.get(task.id) ?? 0) + 1;
							taskFailCounts.set(task.id, count);
							if (autoDecomposer.shouldDecompose(String(task.id), count, autoDecomposeConfig.failThreshold)) {
								const currentPrdContent = readPrdFile(prdPath);
								const updatedPrd = autoDecomposer.decomposeTask(task, currentPrdContent);
								fs.writeFileSync(prdPath, updatedPrd, 'utf-8');
								const subTaskLines = updatedPrd.split('\n')
									.filter(l => l.includes('Sub-task:') && /^\s*- \[ \]/.test(l))
									.map(l => l.trim());
								yield { kind: LoopEventKind.TaskDecomposed, originalTask: task, subTasks: subTaskLines };
								taskFailCounts.delete(task.id);
								continue;
							}
						}

						// TaskComplete hook (failure)
						const failHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'failure', taskInvocationId });
						if (failHook.additionalContext) { additionalContext = failHook.additionalContext; }
						if (failHook.blocked) {
							additionalContext = `Shell command blocked: ${failHook.reason}. Provide a safe alternative that does not use shell metacharacters or chaining.`;
							yield { kind: LoopEventKind.CommandBlocked, command: this.config.hookScript ?? 'unknown', reason: failHook.reason ?? 'unknown', taskId: task.taskId };
							continue;
						} else if (failHook.action === 'retry') {
							continue; // re-enter the task
						} else if (failHook.action === 'stop') {
							yield { kind: LoopEventKind.Stopped };
							return;
						}
						// 'continue' and 'skip' both move to next task
					}
				} catch (err) {
					let currentError = err instanceof Error ? err : new Error(String(err));
					this.errorHashTracker.record(currentError.message);
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

							const prompt = buildPrompt(task.description, prdContent, progressContent, 20, this.config.promptBlocks, this.promptCapabilities, undefined, iteration, this.config.contextTrimming ?? DEFAULT_CONTEXT_TRIMMING, undefined, task.taskId, undefined, this.config.workspaceRoot);
							const retryExecResult = await this.executionStrategy.execute(task, prompt, this.executionOptionsForTask(task));
							yield { kind: LoopEventKind.CopilotTriggered, method: retryExecResult.method, taskInvocationId };

							const retryResult = { completed: retryExecResult.completed, hadFileChanges: retryExecResult.hadFileChanges };

							if (retryResult.completed) {
								this.completedTasks.add(task.id);
								const duration = Date.now() - startTime;
								appendProgress(progressPath, `[${taskInvocationId}] [${task.taskId}] Task completed (after ${retryCount} retries): ${task.description} (${Math.round(duration / 1000)}s)`);
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
						appendProgress(progressPath, `[${taskInvocationId}] [${task.taskId}] Task error: ${task.description} — ${message}`);
						yield { kind: LoopEventKind.Error, message: `Task "${task.description}" failed: ${message}` };

						// TaskComplete hook (failure after retries exhausted)
						const errorHook = await this.hookService.onTaskComplete({ taskId: String(task.id), result: 'failure', taskInvocationId });
						if (errorHook.additionalContext) { additionalContext = errorHook.additionalContext; }
						if (errorHook.blocked) {
							additionalContext = `Shell command blocked: ${errorHook.reason}. Provide a safe alternative that does not use shell metacharacters or chaining.`;
							yield { kind: LoopEventKind.CommandBlocked, command: this.config.hookScript ?? 'unknown', reason: errorHook.reason ?? 'unknown', taskId: task.taskId };
						} else if (errorHook.action === 'stop') {
							yield { kind: LoopEventKind.Stopped };
							return;
						}
					}
				}

				// Countdown between tasks with optional cooldown dialog
				if (this.config.cooldownShowDialog !== false) {
					const nextTask = snapshot.tasks.find(t => t.status === 'pending');
					const dialogResult = await this.showCooldownDialogFn(
						nextTask?.description ?? 'next task',
						this.config.countdownSeconds * 1000,
					);
					if (dialogResult === 'pause') {
						yield { kind: LoopEventKind.YieldRequested };
						return;
					}
					if (dialogResult === 'stop') {
						yield { kind: LoopEventKind.Stopped };
						return;
					}
					if (dialogResult === 'edit') {
						const userInput = await vscode.window.showInputBox({ prompt: 'Provide context for the next task' });
						if (userInput) {
							this.injectContext(userInput);
							yield { kind: LoopEventKind.ContextInjected, text: userInput };
						}
					}
				} else {
					for (let s = this.config.countdownSeconds; s > 0; s--) {
						if (this.stopRequested) {
							this.sessionPersistence?.clear(this.config.workspaceRoot);
							yield { kind: LoopEventKind.Stopped };
							return;
						}
						yield { kind: LoopEventKind.Countdown, secondsLeft: s };
						await this.delay(1000);
					}
				}

				// Save session state after each iteration
				const currentBranch = await getCurrentBranch(this.config.workspaceRoot);
				this.sessionPersistence?.save(this.config.workspaceRoot, {
					currentTaskIndex: task.id,
					iterationCount: iteration,
					nudgeCount: 0,
					retryCount: 0,
					circuitBreakerState: 'active',
					timestamp: Date.now(),
					version: 1,
					branchName: currentBranch,
					originalBranch: this.originalBranch,
				});
			}
		} finally {
			this._currentTaskId = '';
			this.linkedSignal?.dispose();
			this.linkedSignal = undefined;
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
		autoDecompose: vsConfig.get('autoDecompose', DEFAULT_CONFIG.autoDecompose),
		knowledge: vsConfig.get('knowledge', DEFAULT_CONFIG.knowledge),
		contextTrimming: vsConfig.get('contextTrimming', DEFAULT_CONFIG.contextTrimming),
		bearings: vsConfig.get('bearings', DEFAULT_CONFIG.bearings),
		cooldownShowDialog: vsConfig.get<boolean>('cooldownShowDialog', DEFAULT_CONFIG.cooldownShowDialog ?? true),
		agentMode: vsConfig.get<string>('agentMode', DEFAULT_CONFIG.agentMode ?? 'ralph-executor'),
	};
}
