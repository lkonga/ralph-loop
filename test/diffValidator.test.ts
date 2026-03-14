import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { DiffValidator } from '../src/diffValidator';
import type { DiffValidationResult } from '../src/types';

vi.mock('child_process', () => ({
	execFile: vi.fn(),
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		appendFileSync: vi.fn(),
	};
});

function mockGit(statStdout: string, nameStdout: string) {
	const execFileMock = vi.mocked(childProcess.execFile);
	execFileMock.mockImplementation(((cmd: string, args: string[], opts: any, cb: Function) => {
		if (args.includes('--stat')) {
			cb(null, statStdout, '');
		} else if (args.includes('--name-only')) {
			cb(null, nameStdout, '');
		} else {
			cb(null, '', '');
		}
	}) as any);
}

function mockGitEmpty() {
	mockGit('', '');
}

function mockGitWithChanges() {
	const stat = ` src/foo.ts | 10 ++++------
 src/bar.ts |  5 ++---
 2 files changed, 6 insertions(+), 9 deletions(-)`;
	const names = 'src/foo.ts\nsrc/bar.ts\n';
	mockGit(stat, names);
}

describe('DiffValidator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('validateDiff with mocked git', () => {
		it('returns hasDiff=false and nudge when no changes', async () => {
			mockGitEmpty();
			const validator = new DiffValidator({ requireChanges: true });
			const result = await validator.validateDiff('/workspace', 'inv-1');
			expect(result.hasDiff).toBe(false);
			expect(result.filesChanged).toEqual([]);
			expect(result.linesAdded).toBe(0);
			expect(result.linesRemoved).toBe(0);
			expect(result.nudge).toBe('No code changes detected. Review the task requirements and make the necessary code modifications.');
		});

		it('returns hasDiff=true with file list and line counts', async () => {
			mockGitWithChanges();
			const validator = new DiffValidator();
			const result = await validator.validateDiff('/workspace', 'inv-2');
			expect(result.hasDiff).toBe(true);
			expect(result.filesChanged).toEqual(['src/foo.ts', 'src/bar.ts']);
			expect(result.linesAdded).toBe(6);
			expect(result.linesRemoved).toBe(9);
			expect(result.nudge).toBeUndefined();
		});

		it('does not return nudge when requireChanges is false and no diff', async () => {
			mockGitEmpty();
			const validator = new DiffValidator({ requireChanges: false });
			const result = await validator.validateDiff('/workspace', 'inv-3');
			expect(result.hasDiff).toBe(false);
			expect(result.nudge).toBeUndefined();
		});

		it('truncates summary when maxDiffLines is set', async () => {
			const stat = `line1\nline2\nline3\nline4\nline5`;
			mockGit(stat, 'a.ts\n');
			const validator = new DiffValidator({ maxDiffLines: 2 });
			const result = await validator.validateDiff('/workspace', 'inv-4');
			expect(result.summary).toContain('line1');
			expect(result.summary).toContain('line2');
			expect(result.summary).toContain('... (3 more lines)');
			expect(result.summary).not.toContain('line3');
		});

		it('does not truncate when maxDiffLines is undefined', async () => {
			const stat = `line1\nline2\nline3`;
			mockGit(stat, 'a.ts\n');
			const validator = new DiffValidator();
			const result = await validator.validateDiff('/workspace', 'inv-5');
			expect(result.summary).toContain('line3');
		});
	});

	describe('structured state format', () => {
		it('builds correct state block format', () => {
			const validator = new DiffValidator();
			const result: DiffValidationResult = {
				filesChanged: ['src/foo.ts', 'src/bar.ts'],
				linesAdded: 10,
				linesRemoved: 3,
				hasDiff: true,
				summary: 'test',
			};
			const block = validator.buildStateBlock(5, result);
			expect(block).toBe('### Task 5 State | Files: [src/foo.ts, src/bar.ts] | Lines: +10/-3 | Status: pass');
		});

		it('handles string task id', () => {
			const validator = new DiffValidator();
			const result: DiffValidationResult = {
				filesChanged: ['a.ts'],
				linesAdded: 1,
				linesRemoved: 0,
				hasDiff: true,
				summary: '',
			};
			const block = validator.buildStateBlock('my-task', result);
			expect(block).toBe('### Task my-task State | Files: [a.ts] | Lines: +1/-0 | Status: pass');
		});

		it('appends state block to progress file', async () => {
			const validator = new DiffValidator();
			const result: DiffValidationResult = {
				filesChanged: ['x.ts'],
				linesAdded: 2,
				linesRemoved: 1,
				hasDiff: true,
				summary: '',
			};
			await validator.appendStateToProgress('/tmp/progress.txt', 3, result);
			expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledWith(
				'/tmp/progress.txt',
				expect.stringContaining('### Task 3 State'),
			);
		});
	});

	describe('nudge logic', () => {
		it('returns nudge message when hasDiff is false and requireChanges is true', async () => {
			mockGitEmpty();
			const validator = new DiffValidator({ requireChanges: true });
			const result = await validator.validateDiff('/workspace', 'inv-6');
			expect(result.nudge).toBe('No code changes detected. Review the task requirements and make the necessary code modifications.');
		});

		it('does not return nudge when hasDiff is true', async () => {
			mockGitWithChanges();
			const validator = new DiffValidator({ requireChanges: true });
			const result = await validator.validateDiff('/workspace', 'inv-7');
			expect(result.nudge).toBeUndefined();
		});
	});
});
