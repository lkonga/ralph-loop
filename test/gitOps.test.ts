import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { atomicCommit, inferCommitType, buildCommitMessage, getCurrentBranch, createAndCheckoutBranch, checkoutBranch, branchExists, getShortHash } from '../src/gitOps';
import type { Task } from '../src/types';
import { TaskStatus } from '../src/types';

vi.mock('child_process', () => ({
	execFile: vi.fn(),
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

function makeTask(id: number, description: string, taskId?: string): Task {
	return { id, description, status: TaskStatus.Pending, lineNumber: id, taskId: taskId ?? `Task-${String(id + 1).padStart(3, '0')}` };
}

type GitCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockGitCommands(responses: Record<string, { stdout?: string; stderr?: string; err?: Error }>) {
	const execFileMock = vi.mocked(childProcess.execFile);
	execFileMock.mockImplementation(((cmd: string, args: string[], opts: any, cb: GitCallback) => {
		const key = args.join(' ');
		for (const [pattern, resp] of Object.entries(responses)) {
			if (key.includes(pattern)) {
				cb(resp.err ?? null, resp.stdout ?? '', resp.stderr ?? '');
				return;
			}
		}
		cb(null, '', '');
	}) as any);
}

function mockSuccessfulCommit(hash = 'abc1234def5678') {
	mockGitCommands({
		'add -A': { stdout: '' },
		'diff --cached --name-only': { stdout: 'src/foo.ts\nsrc/bar.ts\n' },
		'commit -m': { stdout: '' },
		'rev-parse HEAD': { stdout: hash + '\n' },
	});
}

describe('gitOps', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('inferCommitType', () => {
		it('returns fix for bug-related keywords', () => {
			expect(inferCommitType('Fix the broken login page')).toBe('fix');
			expect(inferCommitType('debug the memory leak')).toBe('fix');
			expect(inferCommitType('patch security vulnerability')).toBe('fix');
			expect(inferCommitType('repair the database connection')).toBe('fix');
			expect(inferCommitType('resolve the race condition')).toBe('fix');
			expect(inferCommitType('hotfix for crash')).toBe('fix');
			expect(inferCommitType('Handle the error case')).toBe('fix');
		});

		it('returns feat for everything else', () => {
			expect(inferCommitType('Add new dashboard feature')).toBe('feat');
			expect(inferCommitType('Create user management module')).toBe('feat');
			expect(inferCommitType('Implement parallel tasks')).toBe('feat');
		});
	});

	describe('buildCommitMessage', () => {
		it('truncates subject to 72 chars', () => {
			const task = makeTask(5, 'A'.repeat(100));
			const msg = buildCommitMessage(task, 'inv-123', ['src/a.ts']);
			const subject = msg.split('\n')[0];
			expect(subject.length).toBeLessThanOrEqual(72);
		});

		it('includes conventional commit format in subject', () => {
			const task = makeTask(3, 'Add new feature for dashboard');
			const msg = buildCommitMessage(task, 'inv-abc', ['src/dash.ts']);
			const subject = msg.split('\n')[0];
			expect(subject).toMatch(/^feat\(Task-004\): /);
		});

		it('uses fix type for fix-related descriptions', () => {
			const task = makeTask(7, 'Fix the broken authentication');
			const msg = buildCommitMessage(task, 'inv-xyz', ['src/auth.ts']);
			const subject = msg.split('\n')[0];
			expect(subject).toMatch(/^fix\(Task-008\): /);
		});

		it('includes task ID prefix in commit subject', () => {
			const task = makeTask(0, 'Add dashboard', 'Task-001');
			const msg = buildCommitMessage(task, 'inv-1', ['src/dash.ts']);
			const subject = msg.split('\n')[0];
			expect(subject).toMatch(/^feat\(Task-001\): /);
		});

		it('includes taskInvocationId in body', () => {
			const task = makeTask(1, 'Create something');
			const msg = buildCommitMessage(task, 'inv-999', ['src/thing.ts']);
			expect(msg).toContain('inv-999');
		});

		it('includes changed files in body', () => {
			const task = makeTask(1, 'Do stuff');
			const msg = buildCommitMessage(task, 'inv-1', ['src/a.ts', 'src/b.ts']);
			expect(msg).toContain('src/a.ts');
			expect(msg).toContain('src/b.ts');
		});

		it('includes full description in body', () => {
			const task = makeTask(1, 'Implement the full feature with all bells and whistles');
			const msg = buildCommitMessage(task, 'inv-1', ['src/f.ts']);
			expect(msg).toContain('Implement the full feature with all bells and whistles');
		});
	});

	describe('atomicCommit', () => {
		it('returns CommitResult with hash on success', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockSuccessfulCommit('deadbeef12345678');
			const task = makeTask(1, 'Add feature X');
			const result = await atomicCommit('/workspace', task, 'inv-1');
			expect(result.success).toBe(true);
			expect(result.commitHash).toBe('deadbeef12345678');
			expect(result.error).toBeUndefined();
		});

		it('returns error when rebase in progress', async () => {
			vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
				return String(p).includes('rebase-merge');
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1');
			expect(result.success).toBe(false);
			expect(result.error).toContain('rebase');
		});

		it('returns error when merge in progress', async () => {
			vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
				return String(p).includes('MERGE_HEAD');
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1');
			expect(result.success).toBe(false);
			expect(result.error).toContain('merge');
		});

		it('returns error when cherry-pick in progress', async () => {
			vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
				return String(p).includes('CHERRY_PICK_HEAD');
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1');
			expect(result.success).toBe(false);
			expect(result.error).toContain('cherry-pick');
		});

		it('returns error when nothing to commit', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockGitCommands({
				'add -A': { stdout: '' },
				'diff --cached --name-only': { stdout: '' },
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1');
			expect(result.success).toBe(false);
			expect(result.error).toContain('nothing to commit');
		});

		it('returns error when git commit fails', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockGitCommands({
				'add -A': { stdout: '' },
				'diff --cached --name-only': { stdout: 'src/foo.ts\n' },
				'commit -m': { err: new Error('commit failed') },
				'rev-parse HEAD': { stdout: '' },
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1');
			expect(result.success).toBe(false);
			expect(result.error).toContain('commit failed');
		});

		it('calls git add -A before diff and commit', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockSuccessfulCommit();
			const task = makeTask(1, 'Add feature');
			await atomicCommit('/workspace', task, 'inv-1');
			const calls = vi.mocked(childProcess.execFile).mock.calls;
			const addCallIndex = calls.findIndex(c => (c[1] as string[]).includes('add'));
			const diffCallIndex = calls.findIndex(c => (c[1] as string[]).join(' ').includes('diff --cached'));
			const commitCallIndex = calls.findIndex(c => (c[1] as string[]).join(' ').includes('commit'));
			expect(addCallIndex).toBeLessThan(diffCallIndex);
			expect(diffCallIndex).toBeLessThan(commitCallIndex);
		});

		it('blocks commit on protected branch (main)', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockGitCommands({
				'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1', {
				protectedBranches: ['main', 'master'],
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain('Refusing to commit on protected branch');
		});

		it('allows commit on feature branch', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockGitCommands({
				'rev-parse --abbrev-ref HEAD': { stdout: 'ralph/my-feature\n' },
				'add -A': { stdout: '' },
				'diff --cached --name-only': { stdout: 'src/foo.ts\n' },
				'commit -m': { stdout: '' },
				'rev-parse HEAD': { stdout: 'abc123\n' },
			});
			const task = makeTask(1, 'Add feature');
			const result = await atomicCommit('/workspace', task, 'inv-1', {
				protectedBranches: ['main', 'master'],
			});
			expect(result.success).toBe(true);
		});

		it('logs warning when commit blocked on protected branch', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			mockGitCommands({
				'rev-parse --abbrev-ref HEAD': { stdout: 'master\n' },
			});
			const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
			const task = makeTask(1, 'Add feature');
			await atomicCommit('/workspace', task, 'inv-1', {
				protectedBranches: ['main', 'master'],
				logger,
			});
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('protected branch')
			);
		});
	});

	describe('getCurrentBranch', () => {
		it('returns branch name', async () => {
			mockGitCommands({
				'rev-parse --abbrev-ref HEAD': { stdout: 'feature/my-branch\n' },
			});
			const branch = await getCurrentBranch('/workspace');
			expect(branch).toBe('feature/my-branch');
		});

		it('returns HEAD for detached state', async () => {
			mockGitCommands({
				'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
			});
			const branch = await getCurrentBranch('/workspace');
			expect(branch).toBe('HEAD');
		});
	});

	describe('createAndCheckoutBranch', () => {
		it('succeeds when branch creation works', async () => {
			mockGitCommands({
				'checkout -b': { stdout: "Switched to a new branch 'my-branch'\n" },
			});
			const result = await createAndCheckoutBranch('/workspace', 'my-branch');
			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('returns error when branch already exists', async () => {
			mockGitCommands({
				'checkout -b': { err: new Error("fatal: a branch named 'my-branch' already exists") },
			});
			const result = await createAndCheckoutBranch('/workspace', 'my-branch');
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('branchExists', () => {
		it('returns true for existing branch', async () => {
			mockGitCommands({
				'rev-parse --verify': { stdout: 'abc123\n' },
			});
			const exists = await branchExists('/workspace', 'main');
			expect(exists).toBe(true);
		});

		it('returns false for missing branch', async () => {
			mockGitCommands({
				'rev-parse --verify': { err: new Error('fatal: not a valid ref') },
			});
			const exists = await branchExists('/workspace', 'nonexistent');
			expect(exists).toBe(false);
		});
	});

	describe('checkoutBranch', () => {
		it('checks out an existing branch successfully', async () => {
			mockGitCommands({
				'checkout': { stdout: "Switched to branch 'feature'\n" },
			});
			const result = await checkoutBranch('/workspace', 'feature');
			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('returns error when branch does not exist', async () => {
			mockGitCommands({
				'checkout': { err: new Error("error: pathspec 'nonexistent' did not match any file(s) known to git") },
			});
			const result = await checkoutBranch('/workspace', 'nonexistent');
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('getShortHash', () => {
		it('returns a 7-char hex string', async () => {
			mockGitCommands({
				'rev-parse --short HEAD': { stdout: 'a1b2c3d\n' },
			});
			const hash = await getShortHash('/workspace');
			expect(hash).toBe('a1b2c3d');
			expect(hash).toMatch(/^[0-9a-f]{7}$/);
		});

		it('returns trimmed output', async () => {
			mockGitCommands({
				'rev-parse --short HEAD': { stdout: '  ff00bb1  \n' },
			});
			const hash = await getShortHash('/workspace');
			expect(hash).toBe('ff00bb1');
		});
	});
});
