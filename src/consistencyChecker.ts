import * as fs from 'fs';
import * as path from 'path';
import type {
	IConsistencyChecker,
	ConsistencyCheckInput,
	ConsistencyCheckResult,
	ConsistencyCheckDetail,
} from './types';

function checkCheckboxState(input: ConsistencyCheckInput): ConsistencyCheckDetail {
	try {
		const prdContent = fs.readFileSync(input.prdPath, 'utf-8');
		const lines = prdContent.split('\n');
		const hasUnchecked = lines.some(l => /^\s*-\s*\[\s*\]\s+/.test(l));
		const hasChecked = lines.some(l => /^\s*-\s*\[x\]/i.test(l));

		if (input.expectedPhase === 'in_progress') {
			if (!hasUnchecked) {
				return { name: 'checkbox_state', passed: false, detail: 'Expected unchecked tasks for in_progress phase but found none' };
			}
			return { name: 'checkbox_state', passed: true, detail: 'Unchecked tasks present — matches in_progress phase' };
		}

		if (input.expectedPhase === 'complete') {
			if (hasUnchecked) {
				return { name: 'checkbox_state', passed: false, detail: 'Expected all tasks checked for complete phase but found unchecked tasks' };
			}
			return { name: 'checkbox_state', passed: true, detail: 'All tasks checked — matches complete phase' };
		}

		return { name: 'checkbox_state', passed: true, detail: `Phase ${input.expectedPhase} — no checkbox constraint` };
	} catch {
		return { name: 'checkbox_state', passed: false, detail: 'Could not read PRD file' };
	}
}

function checkProgressMtime(input: ConsistencyCheckInput): ConsistencyCheckDetail {
	try {
		const stat = fs.statSync(input.progressPath);
		const fiveMinAgo = Date.now() - 5 * 60 * 1000;
		if (stat.mtimeMs < fiveMinAgo) {
			return { name: 'progress_mtime', passed: false, detail: 'progress.txt not modified within the last 5 minutes' };
		}
		return { name: 'progress_mtime', passed: true, detail: 'progress.txt recently modified' };
	} catch {
		return { name: 'progress_mtime', passed: false, detail: 'progress.txt not found or not accessible' };
	}
}

function extractFilePaths(description: string): string[] {
	// Match patterns like src/foo.ts, test/bar.test.ts, etc.
	const matches = description.match(/(?:src|test|lib|dist|docs|cli|__mocks__)\/[\w./-]+\.\w+/g);
	return matches ? [...new Set(matches)] : [];
}

function checkFilePathsExist(input: ConsistencyCheckInput): ConsistencyCheckDetail {
	const filePaths = extractFilePaths(input.taskDescription);
	if (filePaths.length === 0) {
		return { name: 'file_paths_exist', passed: true, detail: 'No file paths found in task description' };
	}

	const missing: string[] = [];
	for (const fp of filePaths) {
		const fullPath = path.resolve(input.workspaceRoot, fp);
		if (!fs.existsSync(fullPath)) {
			missing.push(fp);
		}
	}

	if (missing.length > 0) {
		return { name: 'file_paths_exist', passed: false, detail: `Missing files: ${missing.join(', ')}` };
	}
	return { name: 'file_paths_exist', passed: true, detail: `All ${filePaths.length} referenced files exist` };
}

export class DeterministicConsistencyChecker implements IConsistencyChecker {
	async runDeterministic(input: ConsistencyCheckInput): Promise<ConsistencyCheckResult> {
		const checks: ConsistencyCheckDetail[] = [
			checkCheckboxState(input),
			checkProgressMtime(input),
			checkFilePathsExist(input),
		];

		const failures = checks.filter(c => !c.passed);
		return {
			passed: failures.length === 0,
			checks,
			failureReason: failures.length > 0
				? failures.map(f => `${f.name}: ${f.detail}`).join('; ')
				: undefined,
		};
	}

	async runLlmVerification(_input: ConsistencyCheckInput): Promise<ConsistencyCheckResult> {
		return {
			passed: true,
			checks: [{ name: 'llm_verification', passed: true, detail: 'LLM verification skipped (stub)' }],
		};
	}
}

export class LlmConsistencyCheckerStub implements IConsistencyChecker {
	private readonly deterministicChecker = new DeterministicConsistencyChecker();

	async runDeterministic(input: ConsistencyCheckInput): Promise<ConsistencyCheckResult> {
		return this.deterministicChecker.runDeterministic(input);
	}

	async runLlmVerification(_input: ConsistencyCheckInput): Promise<ConsistencyCheckResult> {
		return {
			passed: true,
			checks: [{ name: 'llm_verification', passed: true, detail: 'LLM verification skipped (stub)' }],
		};
	}
}
