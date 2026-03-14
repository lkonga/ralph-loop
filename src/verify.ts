import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { Task, TaskStatus, VerifyResult, VerifyCheck, VerifierFn, VerifierConfig, RalphConfig, ILogger } from './types';
import { readPrdSnapshot } from './prd';

// --- VerifierRegistry ---

export class VerifierRegistry {
	private readonly verifiers = new Map<string, VerifierFn>();

	register(type: string, fn: VerifierFn): void {
		this.verifiers.set(type, fn);
	}

	get(type: string): VerifierFn {
		const fn = this.verifiers.get(type);
		if (!fn) { throw new Error(`Unknown verifier type: ${type}`); }
		return fn;
	}
}

// --- Built-in verifier functions ---

function runShellCommand(command: string, cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		execFile('sh', ['-c', command], { cwd }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

const checkboxVerifier: VerifierFn = async (task, _workspaceRoot, args) => {
	const prdPath = args?.prdPath;
	if (!prdPath) {
		return { name: 'checkbox', result: VerifyResult.Fail, detail: 'No prdPath provided' };
	}
	const snapshot = readPrdSnapshot(prdPath);
	const updatedTask = snapshot.tasks.find(t => t.description === task.description);
	const prdUpdated = updatedTask?.status === TaskStatus.Complete;
	return {
		name: 'checkbox',
		result: prdUpdated ? VerifyResult.Pass : VerifyResult.Fail,
		detail: prdUpdated ? 'Task marked complete in PRD.md' : 'Task NOT marked complete in PRD.md',
	};
};

const tscVerifier: VerifierFn = async (_task, workspaceRoot) => {
	const { ok, stdout, stderr } = await runShellCommand('npx tsc --noEmit', workspaceRoot);
	return {
		name: 'tsc',
		result: ok ? VerifyResult.Pass : VerifyResult.Fail,
		detail: ok ? 'TypeScript compilation passed' : `tsc failed: ${stdout || stderr}`,
	};
};

const vitestVerifier: VerifierFn = async (_task, workspaceRoot) => {
	const { ok, stdout, stderr } = await runShellCommand('npx vitest run', workspaceRoot);
	return {
		name: 'vitest',
		result: ok ? VerifyResult.Pass : VerifyResult.Fail,
		detail: ok ? 'All tests passed' : `Tests failed: ${stdout || stderr}`,
	};
};

const fileExistsVerifier: VerifierFn = async (_task, workspaceRoot, args) => {
	const filePath = args?.path;
	if (!filePath) {
		return { name: 'fileExists', result: VerifyResult.Fail, detail: 'No path provided' };
	}
	const fullPath = path.resolve(workspaceRoot, filePath);
	const exists = fs.existsSync(fullPath);
	return {
		name: 'fileExists',
		result: exists ? VerifyResult.Pass : VerifyResult.Fail,
		detail: exists ? `File exists: ${filePath}` : `File not found: ${filePath}`,
	};
};

const fileContainsVerifier: VerifierFn = async (_task, workspaceRoot, args) => {
	const filePath = args?.path;
	const content = args?.content;
	if (!filePath || !content) {
		return { name: 'fileContains', result: VerifyResult.Fail, detail: 'Missing path or content arg' };
	}
	const fullPath = path.resolve(workspaceRoot, filePath);
	if (!fs.existsSync(fullPath)) {
		return { name: 'fileContains', result: VerifyResult.Fail, detail: `File not found: ${filePath}` };
	}
	const fileContent = fs.readFileSync(fullPath, 'utf-8');
	const found = fileContent.includes(content);
	return {
		name: 'fileContains',
		result: found ? VerifyResult.Pass : VerifyResult.Fail,
		detail: found ? `File contains expected content` : `Content not found in ${filePath}`,
	};
};

const commandExitCodeVerifier: VerifierFn = async (_task, workspaceRoot, args) => {
	const command = args?.command;
	if (!command) {
		return { name: 'commandExitCode', result: VerifyResult.Fail, detail: 'No command provided' };
	}
	const { ok, stderr } = await runShellCommand(command, workspaceRoot);
	return {
		name: 'commandExitCode',
		result: ok ? VerifyResult.Pass : VerifyResult.Fail,
		detail: ok ? `Command passed: ${command}` : `Command failed: ${command} — ${stderr}`,
	};
};

const customVerifier: VerifierFn = async (_task, workspaceRoot, args) => {
	const command = args?.command;
	if (!command) {
		return { name: 'custom', result: VerifyResult.Fail, detail: 'No command provided' };
	}
	const { ok, stderr } = await runShellCommand(command, workspaceRoot);
	return {
		name: 'custom',
		result: ok ? VerifyResult.Pass : VerifyResult.Fail,
		detail: ok ? `Custom check passed` : `Custom check failed: ${stderr}`,
	};
};

export function createBuiltinRegistry(): VerifierRegistry {
	const registry = new VerifierRegistry();
	registry.register('checkbox', checkboxVerifier);
	registry.register('tsc', tscVerifier);
	registry.register('vitest', vitestVerifier);
	registry.register('fileExists', fileExistsVerifier);
	registry.register('fileContains', fileContainsVerifier);
	registry.register('commandExitCode', commandExitCodeVerifier);
	registry.register('custom', customVerifier);
	return registry;
}

// --- Chain runner ---

export async function runVerifierChain(
	task: Task,
	workspaceRoot: string,
	configs: VerifierConfig[],
	registry: VerifierRegistry,
	logger: ILogger,
): Promise<VerifyCheck[]> {
	const results: VerifyCheck[] = [];
	for (const config of configs) {
		try {
			const fn = registry.get(config.type);
			const result = await fn(task, workspaceRoot, config.args);
			results.push(result);
		} catch (err) {
			logger.error(`Verifier '${config.type}' error: ${err}`);
			results.push({ name: config.type, result: VerifyResult.Fail, detail: `Error: ${err}` });
		}
	}
	return results;
}

// --- Verifier resolver ---

const AUTO_CLASSIFY_KEYWORDS: Record<string, string> = {
	test: 'vitest',
	spec: 'vitest',
};

export function resolveVerifiers(task: Task, config: RalphConfig, _registry: VerifierRegistry): VerifierConfig[] {
	// (1) Explicit verifiers in config
	if (config.verifiers && config.verifiers.length > 0) {
		return config.verifiers;
	}

	// (2) Match verificationTemplates by task category (template name appears in description)
	if (config.verificationTemplates && config.verificationTemplates.length > 0) {
		const desc = task.description.toLowerCase();
		for (const template of config.verificationTemplates) {
			if (desc.includes(template.name.toLowerCase())) {
				return template.verifiers;
			}
		}
	}

	// (3) Default fallback
	const defaults: VerifierConfig[] = [{ type: 'checkbox' }, { type: 'tsc' }];

	// Auto-classify: append verifiers based on keyword matching
	if (config.autoClassifyTasks) {
		const desc = task.description.toLowerCase();
		for (const [keyword, verifierType] of Object.entries(AUTO_CLASSIFY_KEYWORDS)) {
			if (desc.includes(keyword) && !defaults.some(v => v.type === verifierType)) {
				defaults.push({ type: verifierType });
			}
		}
	}

	return defaults;
}

// --- Legacy functions (preserved) ---

export function verifyTaskCompletion(prdPath: string, task: Task, logger: ILogger): VerifyCheck[] {
	const checks: VerifyCheck[] = [];

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

export function isAllDone(prdPath: string): boolean {
	const snapshot = readPrdSnapshot(prdPath);
	return snapshot.remaining === 0 && snapshot.total > 0;
}

export function progressSummary(prdPath: string): { total: number; completed: number; remaining: number } {
	const snapshot = readPrdSnapshot(prdPath);
	return { total: snapshot.total, completed: snapshot.completed, remaining: snapshot.remaining };
}
