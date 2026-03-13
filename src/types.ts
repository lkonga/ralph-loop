import type * as vscode from 'vscode';

// --- Loop states ---
export const enum LoopState {
	Idle = 'idle',
	Running = 'running',
	Paused = 'paused',
}

// --- Task ---
export const enum TaskStatus {
	Pending = 'pending',
	InProgress = 'in_progress',
	Complete = 'complete',
	TimedOut = 'timed_out',
	Failed = 'failed',
	Skipped = 'skipped',
}

export interface Task {
	readonly id: number;
	readonly description: string;
	status: TaskStatus;
	readonly lineNumber: number;
}

export interface PrdSnapshot {
	readonly tasks: readonly Task[];
	readonly total: number;
	readonly completed: number;
	readonly remaining: number;
}

// --- Copilot result ---
export type CopilotMethod = 'agent' | 'chat' | 'clipboard';

// --- Loop events (async generator yields these) ---
export const enum LoopEventKind {
	TaskStarted = 'task_started',
	CopilotTriggered = 'copilot_triggered',
	WaitingForCompletion = 'waiting_for_completion',
	TaskCompleted = 'task_completed',
	TaskTimedOut = 'task_timed_out',
	TaskNudged = 'task_nudged',
	TaskRetried = 'task_retried',
	Countdown = 'countdown',
	AllDone = 'all_done',
	MaxIterations = 'max_iterations',
	IterationLimitExpanded = 'iteration_limit_expanded',
	YieldRequested = 'yield_requested',
	Stopped = 'stopped',
	Error = 'error',
}

export type LoopEvent =
	| { kind: LoopEventKind.TaskStarted; task: Task; iteration: number }
	| { kind: LoopEventKind.CopilotTriggered; method: CopilotMethod }
	| { kind: LoopEventKind.WaitingForCompletion; task: Task }
	| { kind: LoopEventKind.TaskCompleted; task: Task; durationMs: number }
	| { kind: LoopEventKind.TaskTimedOut; task: Task; durationMs: number }
	| { kind: LoopEventKind.TaskNudged; task: Task; nudgeCount: number }
	| { kind: LoopEventKind.TaskRetried; task: Task; retryCount: number }
	| { kind: LoopEventKind.Countdown; secondsLeft: number }
	| { kind: LoopEventKind.AllDone; total: number }
	| { kind: LoopEventKind.MaxIterations; limit: number }
	| { kind: LoopEventKind.IterationLimitExpanded; oldLimit: number; newLimit: number }
	| { kind: LoopEventKind.YieldRequested }
	| { kind: LoopEventKind.Stopped }
	| { kind: LoopEventKind.Error; message: string };

// --- Per-task tracking ---
export interface TaskState {
	nudgeCount: number;
	retryCount: number;
	taskCompletedLatch: boolean;
}

// --- Config ---
export interface RalphConfig {
	prdPath: string;
	progressPath: string;
	maxIterations: number;
	hardMaxIterations: number;
	countdownSeconds: number;
	inactivityTimeoutMs: number;
	maxNudgesPerTask: number;
	workspaceRoot: string;
}

export const DEFAULT_CONFIG: Omit<RalphConfig, 'workspaceRoot'> = {
	prdPath: 'PRD.md',
	progressPath: 'progress.txt',
	maxIterations: 50,
	hardMaxIterations: 50,
	countdownSeconds: 12,
	inactivityTimeoutMs: 300_000,
	maxNudgesPerTask: 3,
};

// --- Verification ---
export const enum VerifyResult {
	Pass = 'pass',
	Fail = 'fail',
	Skip = 'skip',
}

export interface VerifyCheck {
	readonly name: string;
	readonly result: VerifyResult;
	readonly detail?: string;
}

// --- Hook system ---
export type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'TaskComplete';

export interface SessionStartInput {
	prdPath: string;
}

export interface PreCompactInput {
	tokenCount: number;
	taskId: string;
}

export interface PostToolUseInput {
	toolName: string;
	taskId: string;
}

export interface TaskCompleteInput {
	taskId: string;
	result: 'success' | 'failure';
}

export interface HookResult {
	action: 'continue' | 'retry' | 'skip' | 'stop';
	reason?: string;
	additionalContext?: string;
}

export interface IRalphHookService {
	onSessionStart(input: SessionStartInput): Promise<HookResult>;
	onPreCompact(input: PreCompactInput): Promise<HookResult>;
	onPostToolUse(input: PostToolUseInput): Promise<HookResult>;
	onTaskComplete(input: TaskCompleteInput): Promise<HookResult>;
}

// --- Logger interface ---
export interface ILogger {
	log(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

// Minimal VS Code output channel logger
export function createOutputLogger(channel: vscode.OutputChannel): ILogger {
	return {
		log: (msg: string) => channel.appendLine(`[ralph-loop] ${msg}`),
		warn: (msg: string) => channel.appendLine(`[ralph-loop WARN] ${msg}`),
		error: (msg: string) => channel.appendLine(`[ralph-loop ERROR] ${msg}`),
	};
}

// Console logger for CLI
export function createConsoleLogger(): ILogger {
	return {
		log: (msg: string) => console.log(`[ralph] ${msg}`),
		warn: (msg: string) => console.warn(`[ralph] ${msg}`),
		error: (msg: string) => console.error(`[ralph] ${msg}`),
	};
}
