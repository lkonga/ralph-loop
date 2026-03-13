export const MAX_RETRIES_PER_TASK = 3;

export interface LoopDecisionState {
	readonly stopRequested: boolean;
	readonly tasksRemaining: number;
	readonly iteration: number;
	readonly maxIterations: number;
}

export interface NudgeDecisionState {
	readonly taskCompleted: boolean;
	readonly nudgeCount: number;
	readonly maxNudgesPerTask: number;
}

export function shouldContinueLoop(state: LoopDecisionState): boolean {
	if (state.stopRequested) { return false; }
	if (state.tasksRemaining <= 0) { return false; }
	if (state.maxIterations > 0 && state.iteration >= state.maxIterations) { return false; }
	return true;
}

export function shouldNudge(state: NudgeDecisionState): string | undefined {
	if (state.taskCompleted) { return undefined; }
	if (state.nudgeCount >= state.maxNudgesPerTask) { return undefined; }
	return 'Continue with the current task. You have NOT marked the checkbox yet. Do NOT repeat previous work — pick up where you left off. If you encountered errors, resolve them. If you were planning, start implementing.';
}

export function shouldRetryError(error: Error, retryCount: number, stopRequested: boolean = false): boolean {
	if (retryCount >= MAX_RETRIES_PER_TASK) { return false; }
	if (stopRequested) { return false; }
	const msg = error.message.toLowerCase();
	const transientPatterns = ['network', 'timeout', 'econnreset', 'econnrefused', 'etimedout', 'socket hang up', 'fetch failed', 'abort'];
	return transientPatterns.some(p => msg.includes(p));
}
