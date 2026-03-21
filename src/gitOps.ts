import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Task } from './types';

export interface CommitResult {
	success: boolean;
	commitHash?: string;
	error?: string;
}

function runGit(workspaceRoot: string, args: string[]): Promise<{ stdout: string; stderr: string; err?: Error }> {
	return new Promise((resolve) => {
		execFile('git', args, { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				resolve({ stdout: stdout ?? '', stderr: stderr ?? '', err });
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

const FIX_KEYWORDS = /\b(fix|bug|debug|patch|repair|resolve|hotfix|error|crash|broken|issue|handle)\b/i;

export function inferCommitType(description: string): 'feat' | 'fix' {
	return FIX_KEYWORDS.test(description) ? 'fix' : 'feat';
}

export function buildCommitMessage(task: Task, taskInvocationId: string, changedFiles: string[], testSummary?: string): string {
	const type = inferCommitType(task.description);
	const scope = task.taskId;
	const prefix = `${type}(${scope}): `;
	const maxSubjectLen = 72;
	const descriptionTruncated = task.description.slice(0, maxSubjectLen - prefix.length);
	const subject = `${prefix}${descriptionTruncated}`;

	const bodyParts: string[] = [
		'',
		task.description,
		'',
		`Task-Invocation-Id: ${taskInvocationId}`,
		'',
		'Changed files:',
		...changedFiles.map(f => `  - ${f}`),
	];

	if (testSummary) {
		bodyParts.push('', 'Test results:', testSummary);
	}

	return subject + '\n' + bodyParts.join('\n');
}

export async function atomicCommit(workspaceRoot: string, task: Task, taskInvocationId: string): Promise<CommitResult> {
	// (1) Verify committable state
	const gitDir = path.join(workspaceRoot, '.git');
	if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
		return { success: false, error: 'Cannot commit: rebase in progress' };
	}
	if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
		return { success: false, error: 'Cannot commit: merge in progress' };
	}
	if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
		return { success: false, error: 'Cannot commit: cherry-pick in progress' };
	}

	// (2) git add -A
	const addResult = await runGit(workspaceRoot, ['add', '-A']);
	if (addResult.err) {
		return { success: false, error: `git add failed: ${addResult.err.message}` };
	}

	// (3) Get changed files
	const diffResult = await runGit(workspaceRoot, ['diff', '--cached', '--name-only']);
	const changedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);

	if (changedFiles.length === 0) {
		return { success: false, error: 'nothing to commit — no staged changes' };
	}

	// (4) Build message and commit
	const message = buildCommitMessage(task, taskInvocationId, changedFiles);
	const commitResult = await runGit(workspaceRoot, ['commit', '-m', message, '--no-verify']);
	if (commitResult.err) {
		return { success: false, error: `git commit failed: ${commitResult.err.message}` };
	}

	// (5) Capture commit hash
	const hashResult = await runGit(workspaceRoot, ['rev-parse', 'HEAD']);
	const commitHash = hashResult.stdout.trim();

	return { success: true, commitHash };
}

export async function getCurrentBranch(workspaceRoot: string): Promise<string> {
	const result = await runGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
	return result.stdout.trim() || 'HEAD';
}

export async function createAndCheckoutBranch(workspaceRoot: string, branchName: string): Promise<{ success: boolean; error?: string }> {
	const result = await runGit(workspaceRoot, ['checkout', '-b', branchName]);
	if (result.err) {
		return { success: false, error: result.err.message };
	}
	return { success: true };
}

export async function checkoutBranch(workspaceRoot: string, branchName: string): Promise<{ success: boolean; error?: string }> {
	const result = await runGit(workspaceRoot, ['checkout', branchName]);
	if (result.err) {
		return { success: false, error: result.err.message };
	}
	return { success: true };
}

export async function branchExists(workspaceRoot: string, branchName: string): Promise<boolean> {
	const result = await runGit(workspaceRoot, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
	return !result.err;
}
