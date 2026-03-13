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
	Countdown = 'countdown',
	AllDone = 'all_done',
	MaxIterations = 'max_iterations',
	Stopped = 'stopped',
	Error = 'error',
}

export type LoopEvent =
	| { kind: LoopEventKind.TaskStarted; task: Task; iteration: number }
	| { kind: LoopEventKind.CopilotTriggered; method: CopilotMethod }
	| { kind: LoopEventKind.WaitingForCompletion; task: Task }
	| { kind: LoopEventKind.TaskCompleted; task: Task; durationMs: number }
	| { kind: LoopEventKind.TaskTimedOut; task: Task; durationMs: number }
	| { kind: LoopEventKind.Countdown; secondsLeft: number }
	| { kind: LoopEventKind.AllDone; total: number }
	| { kind: LoopEventKind.MaxIterations; limit: number }
	| { kind: LoopEventKind.Stopped }
	| { kind: LoopEventKind.Error; message: string };

// --- Config ---
export interface RalphConfig {
	prdPath: string;
	progressPath: string;
	maxIterations: number;
	countdownSeconds: number;
	inactivityTimeoutMs: number;
	workspaceRoot: string;
}

export const DEFAULT_CONFIG: Omit<RalphConfig, 'workspaceRoot'> = {
	prdPath: 'PRD.md',
	progressPath: 'progress.txt',
	maxIterations: 50,
	countdownSeconds: 12,
	inactivityTimeoutMs: 300_000,
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
