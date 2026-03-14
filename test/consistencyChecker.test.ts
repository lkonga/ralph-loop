import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DeterministicConsistencyChecker, LlmConsistencyCheckerStub } from '../src/consistencyChecker';
import type { ConsistencyCheckInput } from '../src/types';

vi.mock('fs');

function makeInput(overrides: Partial<ConsistencyCheckInput> = {}): ConsistencyCheckInput {
	return {
		prdPath: '/workspace/PRD.md',
		progressPath: '/workspace/progress.txt',
		workspaceRoot: '/workspace',
		expectedPhase: 'in_progress',
		taskDescription: 'Implement feature in src/foo.ts and test/foo.test.ts',
		...overrides,
	};
}

describe('DeterministicConsistencyChecker', () => {
	let checker: DeterministicConsistencyChecker;

	beforeEach(() => {
		checker = new DeterministicConsistencyChecker();
		vi.restoreAllMocks();
	});

	it('passes all checks when conditions are met', async () => {
		const input = makeInput({ expectedPhase: 'in_progress' });

		// PRD has unchecked task matching in_progress phase
		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [ ] Implement feature in src/foo.ts and test/foo.test.ts\n';
			}
			return '';
		});

		// progress.txt exists and was modified recently
		vi.mocked(fs.statSync).mockReturnValue({
			mtimeMs: Date.now() - 60_000, // 1 minute ago
		} as any);

		// File paths mentioned in task exist
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = await checker.runDeterministic(input);
		expect(result.passed).toBe(true);
		expect(result.checks).toHaveLength(3);
		expect(result.checks.every(c => c.passed)).toBe(true);
	});

	it('fails checkbox check when phase is in_progress but no unchecked tasks', async () => {
		const input = makeInput({ expectedPhase: 'in_progress' });

		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [x] All tasks done\n';
			}
			return '';
		});
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 60_000 } as any);
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = await checker.runDeterministic(input);
		expect(result.passed).toBe(false);
		expect(result.checks[0].passed).toBe(false);
		expect(result.failureReason).toContain('checkbox');
	});

	it('fails progress.txt mtime check when file is stale (>5 min)', async () => {
		const input = makeInput();

		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [ ] Some task\n';
			}
			return '';
		});
		// More than 5 minutes old
		vi.mocked(fs.statSync).mockReturnValue({
			mtimeMs: Date.now() - 6 * 60 * 1000,
		} as any);
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = await checker.runDeterministic(input);
		expect(result.passed).toBe(false);
		const mtimeCheck = result.checks.find(c => c.name === 'progress_mtime');
		expect(mtimeCheck?.passed).toBe(false);
	});

	it('fails file paths check when mentioned files do not exist', async () => {
		const input = makeInput({
			taskDescription: 'Create src/missing.ts',
		});

		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [ ] Create src/missing.ts\n';
			}
			return '';
		});
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 60_000 } as any);
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const result = await checker.runDeterministic(input);
		expect(result.passed).toBe(false);
		const fileCheck = result.checks.find(c => c.name === 'file_paths_exist');
		expect(fileCheck?.passed).toBe(false);
	});

	it('passes file paths check when no file paths are found in description', async () => {
		const input = makeInput({
			taskDescription: 'Do something abstract with no file references',
		});

		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [ ] Do something abstract\n';
			}
			return '';
		});
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 60_000 } as any);
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = await checker.runDeterministic(input);
		const fileCheck = result.checks.find(c => c.name === 'file_paths_exist');
		expect(fileCheck?.passed).toBe(true);
	});

	it('handles missing progress.txt gracefully', async () => {
		const input = makeInput();

		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [ ] Some task\n';
			}
			return '';
		});
		vi.mocked(fs.statSync).mockImplementation(() => {
			throw new Error('ENOENT');
		});
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = await checker.runDeterministic(input);
		expect(result.passed).toBe(false);
		const mtimeCheck = result.checks.find(c => c.name === 'progress_mtime');
		expect(mtimeCheck?.passed).toBe(false);
	});
});

describe('LlmConsistencyCheckerStub', () => {
	it('runLlmVerification returns skip result', async () => {
		const stub = new LlmConsistencyCheckerStub();
		const input = makeInput();

		const result = await stub.runLlmVerification(input);
		expect(result.passed).toBe(true);
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0].name).toBe('llm_verification');
		expect(result.checks[0].detail).toContain('skip');
	});

	it('runDeterministic delegates to DeterministicConsistencyChecker', async () => {
		const stub = new LlmConsistencyCheckerStub();
		const input = makeInput();

		vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
			if (String(p) === input.prdPath) {
				return '- [ ] Some task\n';
			}
			return '';
		});
		vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 60_000 } as any);
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = await stub.runDeterministic(input);
		expect(result.checks).toHaveLength(3);
	});
});
