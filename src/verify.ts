import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PrdSnapshot, Task, TaskStatus, VerifyResult, VerifyCheck, VerifierFn, VerifierConfig, VerificationTemplate, RalphConfig, ILogger, DiffValidationResult } from './types';
import { readPrdSnapshot } from './prd';

export class VerifierRegistry {
	private registry = new Map<string, VerifierFn>();

	register(type: string, fn: VerifierFn): void {
		this.registry.set(type, fn);
	}

	get(type: string): VerifierFn {
		const fn = this.registry.get(type);
		if (!fn) { throw new Error(`Unknown verifier type: ${type}`); }
		return fn;
	}
}

export function createBuiltinRegistry(): VerifierRegistry {
	const registry = new VerifierRegistry();

	registry.register('checkbox', async (task, workspaceRoot, args) => {
		const prdPath = args?.prdPath ?? path.join(workspaceRoot, 'PRD.md');
		const snapshot = readPrdSnapshot(prdPath);
		const found = snapshot.tasks.find(t => t.description === task.description);
		const passed = found?.status === TaskStatus.Complete;
		return { name: 'checkbox', result: passed ? VerifyResult.Pass : VerifyResult.Fail, detail: passed ? 'Checkbox marked' : 'Checkbox not marked' };
	});

	registry.register('fileExists', async (task, workspaceRoot, args) => {
		const filePath = path.join(workspaceRoot, args?.path ?? '');
		const exists = fs.existsSync(filePath);
		return { name: 'fileExists', result: exists ? VerifyResult.Pass : VerifyResult.Fail, detail: exists ? `File exists: ${args?.path}` : `File missing: ${args?.path}` };
	});

	registry.register('fileContains', async (task, workspaceRoot, args) => {
		const filePath = path.join(workspaceRoot, args?.path ?? '');
		if (!fs.existsSync(filePath)) {
			return { name: 'fileContains', result: VerifyResult.Fail, detail: `File missing: ${args?.path}` };
		}
		const content = fs.readFileSync(filePath, 'utf-8');
		const has = content.includes(args?.content ?? '');
		return { name: 'fileContains', result: has ? VerifyResult.Pass : VerifyResult.Fail, detail: has ? 'Content found' : 'Content not found' };
	});

	registry.register('commandExitCode', async (task, workspaceRoot, args) => {
		try {
			execSync(args?.command ?? 'true', { cwd: workspaceRoot, stdio: 'pipe' });
			return { name: 'commandExitCode', result: VerifyResult.Pass, detail: 'Command exited 0' };
		} catch {
			return { name: 'commandExitCode', result: VerifyResult.Fail, detail: 'Command exited non-zero' };
		}
	});

	registry.register('tsc', async (task, workspaceRoot) => {
		try {
			execSync('npx tsc --noEmit', { cwd: workspaceRoot, stdio: 'pipe' });
			return { name: 'tsc', result: VerifyResult.Pass, detail: 'TypeScript clean' };
		} catch {
			return { name: 'tsc', result: VerifyResult.Fail, detail: 'TypeScript errors' };
		}
	});

	registry.register('vitest', async (task, workspaceRoot) => {
		try {
			execSync('npx vitest run', { cwd: workspaceRoot, stdio: 'pipe' });
			return { name: 'vitest', result: VerifyResult.Pass, detail: 'Tests pass' };
		} catch {
			return { name: 'vitest', result: VerifyResult.Fail, detail: 'Tests failed' };
		}
	});

	registry.register('custom', async (task, workspaceRoot, args) => {
		try {
			execSync(args?.command ?? 'true', { cwd: workspaceRoot, stdio: 'pipe', shell: '/bin/sh' });
			return { name: 'custom', result: VerifyResult.Pass, detail: 'Custom command passed' };
		} catch {
			return { name: 'custom', result: VerifyResult.Fail, detail: 'Custom command failed' };
		}
	});

	return registry;
}

export async function runVerifierChain(task: Task, workspaceRoot: string, configs: VerifierConfig[], registry: VerifierRegistry, logger: ILogger): Promise<VerifyCheck[]> {
	const results: VerifyCheck[] = [];
	for (const config of configs) {
		const fn = registry.get(config.type);
		results.push(await fn(task, workspaceRoot, config.args));
	}
	return results;
}

export function resolveVerifiers(task: Task, config: RalphConfig, registry: VerifierRegistry): VerifierConfig[] {
	if (config.verifiers && config.verifiers.length > 0) {
		return config.verifiers;
	}

	if (config.verificationTemplates) {
		const descLower = task.description.toLowerCase();
		for (const tmpl of config.verificationTemplates) {
			if (descLower.includes(tmpl.name.toLowerCase())) {
				return tmpl.verifiers;
			}
		}
	}

	const defaults: VerifierConfig[] = [{ type: 'checkbox' }, { type: 'tsc' }];

	if (config.autoClassifyTasks) {
		const descLower = task.description.toLowerCase();
		if (descLower.includes('test')) {
			defaults.push({ type: 'vitest' });
		}
	}

	return defaults;
}

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

const CONFIDENCE_WEIGHTS: Record<string, number> = {
	checkbox: 100,
	vitest: 20,
	tsc: 20,
	diff: 20,
	no_errors: 10,
	progress_updated: 10,
};

export function computeConfidenceScore(
	checks: VerifyCheck[],
	diffResult?: DiffValidationResult,
): { score: number; breakdown: Record<string, number> } {
	const breakdown: Record<string, number> = {};

	for (const key of Object.keys(CONFIDENCE_WEIGHTS)) {
		breakdown[key] = 0;
	}

	for (const check of checks) {
		if (check.name in CONFIDENCE_WEIGHTS && check.result === VerifyResult.Pass) {
			breakdown[check.name] = CONFIDENCE_WEIGHTS[check.name];
		}
	}

	if (diffResult?.hasDiff) {
		breakdown['diff'] = CONFIDENCE_WEIGHTS['diff'];
	}

	const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
	return { score, breakdown };
}

export function dualExitGateCheck(
	modelSignal: boolean,
	machineVerification: VerifyCheck[],
): { canComplete: boolean; reason?: string } {
	const machinePassed = allChecksPassed(machineVerification);

	if (modelSignal && machinePassed) {
		return { canComplete: true };
	}

	if (modelSignal && !machinePassed) {
		const failing = machineVerification
			.filter(c => c.result === VerifyResult.Fail)
			.map(c => c.detail ? `${c.name}: ${c.detail}` : c.name)
			.join(', ');
		return { canComplete: false, reason: `Model claims complete but verification failed: ${failing}` };
	}

	if (!modelSignal && machinePassed) {
		return { canComplete: false, reason: 'Verification passes but task not marked complete in PRD' };
	}

	const failing = machineVerification
		.filter(c => c.result === VerifyResult.Fail)
		.map(c => c.detail ? `${c.name}: ${c.detail}` : c.name)
		.join(', ');
	return { canComplete: false, reason: `Task not marked complete and verification failed: ${failing}` };
}
