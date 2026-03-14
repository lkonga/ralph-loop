import { PrdSnapshot, Task, TaskStatus, VerifyResult, VerifyCheck, ILogger } from './types';
import { readPrdSnapshot } from './prd';

// Binary pass/fail verification — deterministic, no LLM involvement
export function verifyTaskCompletion(prdPath: string, task: Task, logger: ILogger): VerifyCheck[] {
	const checks: VerifyCheck[] = [];

	// Check 1: PRD checkbox was ticked
	const snapshot = readPrdSnapshot(prdPath);
	const updatedTask = snapshot.tasks.find(t => t.description === task.description);
	const prdUpdated = updatedTask?.status === TaskStatus.Complete;
	checks.push({
		name: 'prd_checkbox',
		result: prdUpdated ? VerifyResult.Pass : VerifyResult.Fail,
		detail: prdUpdated ? 'Task marked complete in PRD.md' : 'Task NOT marked complete in PRD.md',
	});

	return checks;
}

export function allChecksPassed(checks: readonly VerifyCheck[]): boolean {
	return checks.every(c => c.result === VerifyResult.Pass || c.result === VerifyResult.Skip);
}

// Dual exit gate: checks if ALL tasks are done
export function isAllDone(prdPath: string): boolean {
	const snapshot = readPrdSnapshot(prdPath);
	return snapshot.remaining === 0 && snapshot.total > 0;
}

// Quick progress summary
export function progressSummary(prdPath: string): { total: number; completed: number; remaining: number } {
	const snapshot = readPrdSnapshot(prdPath);
	return { total: snapshot.total, completed: snapshot.completed, remaining: snapshot.remaining };
}
