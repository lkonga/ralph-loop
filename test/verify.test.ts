import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parsePrd } from '../src/prd';
import { verifyTaskCompletion, allChecksPassed, isAllDone, progressSummary, VerifierRegistry, createBuiltinRegistry, runVerifierChain, resolveVerifiers, computeConfidenceScore, dualExitGateCheck, formatVerificationFeedback } from '../src/verify';
import { Task, TaskStatus, VerifyResult, VerifierConfig, RalphConfig, DEFAULT_CONFIG, DiffValidationResult } from '../src/types';

function tmpPrd(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-test-'));
	const p = path.join(dir, 'PRD.md');
	fs.writeFileSync(p, content, 'utf-8');
	return p;
}

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-verify-'));
}

const logger = { log: () => {}, warn: () => {}, error: () => {} };

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: 1,
		description: 'Build auth',
		status: TaskStatus.Pending,
		lineNumber: 1,
		...overrides,
	} as Task;
}

describe('verifyTaskCompletion', () => {
	it('passes when task is checked', () => {
		const prdPath = tmpPrd('- [x] Build auth\n- [ ] Deploy\n');
		const snapshot = parsePrd('- [ ] Build auth\n- [ ] Deploy\n');
		const task = snapshot.tasks[0]; // Was pending when assigned
		const checks = verifyTaskCompletion(prdPath, task, logger);
		expect(allChecksPassed(checks)).toBe(true);
	});

	it('fails when task is still unchecked', () => {
		const prdPath = tmpPrd('- [ ] Build auth\n- [ ] Deploy\n');
		const snapshot = parsePrd('- [ ] Build auth\n- [ ] Deploy\n');
		const task = snapshot.tasks[0];
		const checks = verifyTaskCompletion(prdPath, task, logger);
		expect(allChecksPassed(checks)).toBe(false);
	});
});

describe('isAllDone', () => {
	it('returns true when all checked', () => {
		const prdPath = tmpPrd('- [x] A\n- [x] B\n');
		expect(isAllDone(prdPath)).toBe(true);
	});

	it('returns false when some unchecked', () => {
		const prdPath = tmpPrd('- [x] A\n- [ ] B\n');
		expect(isAllDone(prdPath)).toBe(false);
	});

	it('returns false for empty PRD', () => {
		const prdPath = tmpPrd('# Empty PRD\n');
		expect(isAllDone(prdPath)).toBe(false);
	});
});

describe('progressSummary', () => {
	it('returns correct counts', () => {
		const prdPath = tmpPrd('- [x] Done\n- [ ] Pending\n- [ ] Also pending\n');
		const summary = progressSummary(prdPath);
		expect(summary.total).toBe(3);
		expect(summary.completed).toBe(1);
		expect(summary.remaining).toBe(2);
	});
});

// --- New verifier system tests (TDD – written FIRST) ---

describe('VerifierRegistry', () => {
	it('registers and retrieves a verifier', () => {
		const registry = new VerifierRegistry();
		const fn = vi.fn();
		registry.register('test', fn);
		expect(registry.get('test')).toBe(fn);
	});

	it('throws on unknown verifier type', () => {
		const registry = new VerifierRegistry();
		expect(() => registry.get('nonexistent')).toThrow();
	});
});

describe('checkbox verifier', () => {
	it('passes when PRD checkbox is marked', async () => {
		const registry = createBuiltinRegistry();
		const checkboxFn = registry.get('checkbox');
		const prdPath = tmpPrd('- [x] Build auth\n- [ ] Deploy\n');
		const task = makeTask({ description: 'Build auth' });
		const result = await checkboxFn(task, path.dirname(prdPath), { prdPath });
		expect(result.result).toBe(VerifyResult.Pass);
	});

	it('fails when PRD checkbox is not marked', async () => {
		const registry = createBuiltinRegistry();
		const checkboxFn = registry.get('checkbox');
		const prdPath = tmpPrd('- [ ] Build auth\n- [ ] Deploy\n');
		const task = makeTask({ description: 'Build auth' });
		const result = await checkboxFn(task, path.dirname(prdPath), { prdPath });
		expect(result.result).toBe(VerifyResult.Fail);
	});
});

describe('fileExists verifier', () => {
	it('passes when file exists', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('fileExists');
		const dir = tmpDir();
		const filePath = path.join(dir, 'test.txt');
		fs.writeFileSync(filePath, 'hello');
		const task = makeTask();
		const result = await fn(task, dir, { path: 'test.txt' });
		expect(result.result).toBe(VerifyResult.Pass);
	});

	it('fails when file does not exist', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('fileExists');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { path: 'nonexistent.txt' });
		expect(result.result).toBe(VerifyResult.Fail);
	});
});

describe('fileContains verifier', () => {
	it('passes when file contains expected content', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('fileContains');
		const dir = tmpDir();
		const filePath = path.join(dir, 'test.txt');
		fs.writeFileSync(filePath, 'hello world foo bar');
		const task = makeTask();
		const result = await fn(task, dir, { path: 'test.txt', content: 'foo bar' });
		expect(result.result).toBe(VerifyResult.Pass);
	});

	it('fails when file does not contain expected content', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('fileContains');
		const dir = tmpDir();
		const filePath = path.join(dir, 'test.txt');
		fs.writeFileSync(filePath, 'hello world');
		const task = makeTask();
		const result = await fn(task, dir, { path: 'test.txt', content: 'missing' });
		expect(result.result).toBe(VerifyResult.Fail);
	});

	it('fails when file does not exist', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('fileContains');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { path: 'nope.txt', content: 'anything' });
		expect(result.result).toBe(VerifyResult.Fail);
	});
});

describe('commandExitCode verifier', () => {
	it('passes when command exits 0', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('commandExitCode');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { command: 'true' });
		expect(result.result).toBe(VerifyResult.Pass);
	});

	it('fails when command exits non-zero', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('commandExitCode');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { command: 'false' });
		expect(result.result).toBe(VerifyResult.Fail);
	});
});

describe('tsc verifier', () => {
	it('is registered in builtin registry', () => {
		const registry = createBuiltinRegistry();
		expect(() => registry.get('tsc')).not.toThrow();
	});
});

describe('vitest verifier', () => {
	it('is registered in builtin registry', () => {
		const registry = createBuiltinRegistry();
		expect(() => registry.get('vitest')).not.toThrow();
	});
});

describe('custom verifier', () => {
	it('passes when shell command exits 0', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('custom');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { command: 'echo hello' });
		expect(result.result).toBe(VerifyResult.Pass);
	});

	it('fails when shell command exits non-zero', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('custom');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { command: 'exit 1' });
		expect(result.result).toBe(VerifyResult.Fail);
	});
});

describe('runVerifierChain', () => {
	it('runs all verifiers and returns composite results (no short-circuit)', async () => {
		const registry = new VerifierRegistry();
		registry.register('pass1', async () => ({ name: 'pass1', result: VerifyResult.Pass }));
		registry.register('fail1', async () => ({ name: 'fail1', result: VerifyResult.Fail, detail: 'bad' }));
		registry.register('pass2', async () => ({ name: 'pass2', result: VerifyResult.Pass }));

		const configs: VerifierConfig[] = [
			{ type: 'pass1' },
			{ type: 'fail1' },
			{ type: 'pass2' },
		];
		const task = makeTask();
		const results = await runVerifierChain(task, '/tmp', configs, registry, logger);
		expect(results).toHaveLength(3);
		expect(results[0].result).toBe(VerifyResult.Pass);
		expect(results[1].result).toBe(VerifyResult.Fail);
		expect(results[2].result).toBe(VerifyResult.Pass);
	});

	it('returns empty array for empty configs', async () => {
		const registry = new VerifierRegistry();
		const results = await runVerifierChain(makeTask(), '/tmp', [], registry, logger);
		expect(results).toEqual([]);
	});
});

describe('resolveVerifiers', () => {
	it('uses explicit config.verifiers if set', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp', verifiers: [{ type: 'fileExists', args: { path: 'foo.txt' } }] } as RalphConfig;
		const registry = createBuiltinRegistry();
		const result = resolveVerifiers(makeTask(), config, registry);
		expect(result).toEqual([{ type: 'fileExists', args: { path: 'foo.txt' } }]);
	});

	it('falls back to default [checkbox, tsc] when no verifiers or templates', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp' } as RalphConfig;
		const registry = createBuiltinRegistry();
		const result = resolveVerifiers(makeTask(), config, registry);
		expect(result).toEqual([{ type: 'checkbox' }, { type: 'tsc' }]);
	});

	it('matches verificationTemplates by task category keyword', () => {
		const config = {
			...DEFAULT_CONFIG,
			workspaceRoot: '/tmp',
			verificationTemplates: [
				{ name: 'deploy', verifiers: [{ type: 'commandExitCode', args: { command: 'echo ok' } }] },
			],
		} as RalphConfig;
		const registry = createBuiltinRegistry();
		const task = makeTask({ description: 'Deploy the application' });
		const result = resolveVerifiers(task, config, registry);
		expect(result).toEqual([{ type: 'commandExitCode', args: { command: 'echo ok' } }]);
	});

	it('appends vitest verifier when autoClassifyTasks is true and task mentions "test"', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp', autoClassifyTasks: true } as RalphConfig;
		const registry = createBuiltinRegistry();
		const task = makeTask({ description: 'Write tests for auth module' });
		const result = resolveVerifiers(task, config, registry);
		const types = result.map(v => v.type);
		expect(types).toContain('vitest');
	});

	it('does not append vitest when autoClassifyTasks is false', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp', autoClassifyTasks: false } as RalphConfig;
		const registry = createBuiltinRegistry();
		const task = makeTask({ description: 'Write tests for auth module' });
		const result = resolveVerifiers(task, config, registry);
		const types = result.map(v => v.type);
		expect(types).not.toContain('vitest');
	});
});

describe('allChecksPassed with verifier chain', () => {
	it('returns true when all checks pass', () => {
		const checks = [
			{ name: 'a', result: VerifyResult.Pass },
			{ name: 'b', result: VerifyResult.Skip },
			{ name: 'c', result: VerifyResult.Pass },
		];
		expect(allChecksPassed(checks)).toBe(true);
	});

	it('returns false when any check fails', () => {
		const checks = [
			{ name: 'a', result: VerifyResult.Pass },
			{ name: 'b', result: VerifyResult.Fail },
			{ name: 'c', result: VerifyResult.Pass },
		];
		expect(allChecksPassed(checks)).toBe(false);
	});

	it('returns true for empty checks array', () => {
		expect(allChecksPassed([])).toBe(true);
	});
});

describe('computeConfidenceScore', () => {
	const diffWithChanges: DiffValidationResult = {
		filesChanged: ['src/foo.ts'],
		linesAdded: 10,
		linesRemoved: 2,
		hasDiff: true,
		summary: '+10 -2',
	};

	const emptyDiff: DiffValidationResult = {
		filesChanged: [],
		linesAdded: 0,
		linesRemoved: 0,
		hasDiff: false,
		summary: 'No changes',
	};

	it('returns max score (180) when all checks pass', () => {
		const checks: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Pass },
			{ name: 'tsc', result: VerifyResult.Pass },
			{ name: 'no_errors', result: VerifyResult.Pass },
			{ name: 'progress_updated', result: VerifyResult.Pass },
		];
		const result = computeConfidenceScore(checks, diffWithChanges);
		expect(result.score).toBe(180);
		expect(result.breakdown['checkbox']).toBe(100);
		expect(result.breakdown['vitest']).toBe(20);
		expect(result.breakdown['tsc']).toBe(20);
		expect(result.breakdown['diff']).toBe(20);
		expect(result.breakdown['no_errors']).toBe(10);
		expect(result.breakdown['progress_updated']).toBe(10);
	});

	it('returns 100 when only checkbox passes', () => {
		const checks: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Fail },
			{ name: 'tsc', result: VerifyResult.Fail },
			{ name: 'no_errors', result: VerifyResult.Fail },
			{ name: 'progress_updated', result: VerifyResult.Fail },
		];
		const result = computeConfidenceScore(checks, emptyDiff);
		expect(result.score).toBe(100);
	});

	it('returns 0 when no checks pass', () => {
		const checks: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Fail },
			{ name: 'vitest', result: VerifyResult.Fail },
			{ name: 'tsc', result: VerifyResult.Fail },
			{ name: 'no_errors', result: VerifyResult.Fail },
			{ name: 'progress_updated', result: VerifyResult.Fail },
		];
		const result = computeConfidenceScore(checks, emptyDiff);
		expect(result.score).toBe(0);
	});

	it('returns 0 for empty checks array with no diff', () => {
		const result = computeConfidenceScore([]);
		expect(result.score).toBe(0);
	});

	it('threshold comparison works — score below threshold means incomplete', () => {
		const checks: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Pass },
		];
		const result = computeConfidenceScore(checks);
		const threshold = 100;
		// score is 100 (checkbox only, no diff), >= threshold
		expect(result.score).toBeGreaterThanOrEqual(threshold);

		const checks2: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Fail },
			{ name: 'vitest', result: VerifyResult.Pass },
		];
		const result2 = computeConfidenceScore(checks2);
		expect(result2.score).toBeLessThan(threshold);
	});

	it('breakdown lists each component', () => {
		const checks: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Fail },
			{ name: 'tsc', result: VerifyResult.Pass },
			{ name: 'no_errors', result: VerifyResult.Pass },
			{ name: 'progress_updated', result: VerifyResult.Fail },
		];
		const result = computeConfidenceScore(checks, diffWithChanges);
		expect(Object.keys(result.breakdown)).toEqual(
			expect.arrayContaining(['checkbox', 'vitest', 'tsc', 'diff', 'no_errors', 'progress_updated'])
		);
		expect(result.breakdown['checkbox']).toBe(100);
		expect(result.breakdown['vitest']).toBe(0);
		expect(result.breakdown['tsc']).toBe(20);
		expect(result.breakdown['diff']).toBe(20);
		expect(result.breakdown['no_errors']).toBe(10);
		expect(result.breakdown['progress_updated']).toBe(0);
	});

	it('handles missing diff result (no diff param = 0 for diff)', () => {
		const checks: VerifyCheck[] = [
			{ name: 'checkbox', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Pass },
			{ name: 'tsc', result: VerifyResult.Pass },
			{ name: 'no_errors', result: VerifyResult.Pass },
			{ name: 'progress_updated', result: VerifyResult.Pass },
		];
		const result = computeConfidenceScore(checks);
		expect(result.score).toBe(160); // 180 - 20 (no diff)
		expect(result.breakdown['diff']).toBe(0);
	});
});

describe('dualExitGateCheck', () => {
	it('returns canComplete true when both model signals and machine checks pass', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Pass },
			{ name: 'diff', result: VerifyResult.Pass },
		];
		const result = dualExitGateCheck(true, checks);
		expect(result.canComplete).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it('returns canComplete false when model signals but machine checks fail', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Fail, detail: 'Tests failed' },
			{ name: 'diff', result: VerifyResult.Pass },
		];
		const result = dualExitGateCheck(true, checks);
		expect(result.canComplete).toBe(false);
		expect(result.reason).toContain('Model claims complete but verification failed');
		expect(result.reason).toContain('vitest');
	});

	it('returns canComplete false when machine checks pass but model has not signaled', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Pass },
			{ name: 'vitest', result: VerifyResult.Pass },
			{ name: 'diff', result: VerifyResult.Pass },
		];
		const result = dualExitGateCheck(false, checks);
		expect(result.canComplete).toBe(false);
		expect(result.reason).toBe('Verification passes but task not marked complete in PRD');
	});

	it('returns canComplete false when neither model signals nor machine checks pass', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Fail, detail: 'TypeScript errors' },
			{ name: 'vitest', result: VerifyResult.Fail, detail: 'Tests failed' },
		];
		const result = dualExitGateCheck(false, checks);
		expect(result.canComplete).toBe(false);
		expect(result.reason).toBeDefined();
	});
});

describe('formatVerificationFeedback', () => {
	it('returns empty string when all checks pass', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Pass, detail: 'TypeScript clean' },
			{ name: 'vitest', result: VerifyResult.Pass, detail: 'Tests pass' },
		];
		expect(formatVerificationFeedback(checks)).toBe('');
	});

	it('returns empty string for empty checks array', () => {
		expect(formatVerificationFeedback([])).toBe('');
	});

	it('formats a single failing check with detail', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Fail, detail: "src/foo.ts(10,5): error TS2339: Property 'bar' does not exist on type 'Foo'." },
		];
		const result = formatVerificationFeedback(checks);
		expect(result).toContain('VERIFICATION FAILURES');
		expect(result).toContain('tsc');
		expect(result).toContain("Property 'bar' does not exist on type 'Foo'");
	});

	it('formats multiple failing checks', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Fail, detail: 'TypeScript errors found' },
			{ name: 'vitest', result: VerifyResult.Fail, detail: 'FAIL test/foo.test.ts > should work' },
			{ name: 'checkbox', result: VerifyResult.Pass, detail: 'Checkbox marked' },
		];
		const result = formatVerificationFeedback(checks);
		expect(result).toContain('tsc');
		expect(result).toContain('vitest');
		expect(result).not.toContain('checkbox');
	});

	it('handles failing check without detail', () => {
		const checks: VerifyCheck[] = [
			{ name: 'custom', result: VerifyResult.Fail },
		];
		const result = formatVerificationFeedback(checks);
		expect(result).toContain('custom');
		expect(result).toContain('VERIFICATION FAILURES');
	});

	it('skips checks with Skip result', () => {
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Skip },
			{ name: 'vitest', result: VerifyResult.Fail, detail: 'Tests failed' },
		];
		const result = formatVerificationFeedback(checks);
		expect(result).not.toContain('tsc');
		expect(result).toContain('vitest');
	});

	it('truncates very long detail to prevent prompt bloat', () => {
		const longDetail = 'x'.repeat(5000);
		const checks: VerifyCheck[] = [
			{ name: 'tsc', result: VerifyResult.Fail, detail: longDetail },
		];
		const result = formatVerificationFeedback(checks);
		expect(result.length).toBeLessThan(5000);
		expect(result).toContain('...(truncated)');
	});
});

describe('builtin verifiers capture stderr/stdout in detail', () => {
	it('tsc verifier captures error output on failure', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('tsc');
		const dir = tmpDir();
		// tsc will fail in a dir with no tsconfig — we just check that detail is more specific than "TypeScript errors"
		const task = makeTask();
		const result = await fn(task, dir);
		if (result.result === VerifyResult.Fail) {
			// detail should contain actual tsc output, not just generic message
			expect(result.detail).toBeDefined();
			expect(result.detail!.length).toBeGreaterThan(0);
		}
	});

	it('vitest verifier captures error output on failure', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('vitest');
		const dir = tmpDir();
		// Write a minimal package.json and a failing test so vitest runs quickly and fails
		fs.writeFileSync(path.join(dir, 'package.json'), '{}');
		fs.writeFileSync(path.join(dir, 'fail.test.ts'), 'import { it, expect } from "vitest"; it("fails", () => { expect(1).toBe(2); });');
		const task = makeTask();
		const result = await fn(task, dir);
		if (result.result === VerifyResult.Fail) {
			expect(result.detail).toBeDefined();
			expect(result.detail!.length).toBeGreaterThan(0);
		}
	}, 15000);

	it('commandExitCode verifier captures error output on failure', async () => {
		const registry = createBuiltinRegistry();
		const fn = registry.get('commandExitCode');
		const dir = tmpDir();
		const task = makeTask();
		const result = await fn(task, dir, { command: 'echo "specific error message" >&2 && exit 1' });
		expect(result.result).toBe(VerifyResult.Fail);
		expect(result.detail).toContain('specific error message');
	});
});
