/**
 * Deterministic checkpoint questions for ralph-loop.
 * These are used with vscode.lm.invokeTool('askQuestions', ...) at specific orchestrator events.
 */

export interface CheckpointQuestion {
	header: string;
	question: string;
	options: { label: string; description?: string; recommended?: boolean }[];
}

export type StagnationAction = 'retry' | 'decompose' | 'skip' | 'debug' | 'change-strategy';
export type CheckpointAction = 'continue' | 'pause' | 'stop' | 'rollback';
export type SessionEndAction = 'new-session' | 'review' | 'report' | 'done';

export function buildStagnationQuestions(taskId: string, failCount: number): CheckpointQuestion[] {
	return [{
		header: 'stagnation-recovery',
		question: `Task ${taskId} has failed ${failCount} times. How should Ralph proceed?`,
		options: [
			{ label: 'Retry with different approach', description: 'Agent tries again with fresh strategy', recommended: true },
			{ label: 'Decompose into sub-tasks', description: 'Break task into smaller steps' },
			{ label: 'Skip this task', description: 'Move to the next task' },
			{ label: 'Debug interactively', description: 'Pause for manual debugging' },
			{ label: 'Change strategy', description: 'Switch agent or approach entirely' },
		],
	}];
}

export function buildCheckpointQuestions(taskId: string, description: string): CheckpointQuestion[] {
	return [{
		header: 'checkpoint-decision',
		question: `Checkpoint reached: ${taskId} — ${description}. What next?`,
		options: [
			{ label: 'Continue', description: 'Resume the loop', recommended: true },
			{ label: 'Pause for review', description: 'Review changes before continuing' },
			{ label: 'Stop loop', description: 'End the ralph loop session' },
			{ label: 'Rollback last task', description: 'Undo and retry the last task' },
		],
	}];
}

export function buildSessionEndQuestions(completedCount: number, totalCount: number): CheckpointQuestion[] {
	return [{
		header: 'session-end-action',
		question: `Session complete: ${completedCount}/${totalCount} tasks done. What next?`,
		options: [
			{ label: 'Start new session', description: 'Continue with remaining tasks', recommended: completedCount < totalCount },
			{ label: 'Review changes', description: 'Inspect what was done this session' },
			{ label: 'Generate report', description: 'Create a summary of this session' },
			{ label: 'Done', description: 'Close ralph loop', recommended: completedCount >= totalCount },
		],
	}];
}

export function parseStagnationAnswer(answer: string): StagnationAction {
	const lower = answer.toLowerCase();
	if (lower.includes('decompose')) return 'decompose';
	if (lower.includes('skip')) return 'skip';
	if (lower.includes('debug')) return 'debug';
	if (lower.includes('change') || lower.includes('strategy')) return 'change-strategy';
	return 'retry';
}

export function parseCheckpointAnswer(answer: string): CheckpointAction {
	const lower = answer.toLowerCase();
	if (lower.includes('pause') || lower.includes('review')) return 'pause';
	if (lower.includes('stop')) return 'stop';
	if (lower.includes('rollback')) return 'rollback';
	return 'continue';
}

export function parseSessionEndAnswer(answer: string): SessionEndAction {
	const lower = answer.toLowerCase();
	if (lower.includes('review')) return 'review';
	if (lower.includes('report')) return 'report';
	if (lower.includes('done') || lower.includes('close')) return 'done';
	return 'new-session';
}
