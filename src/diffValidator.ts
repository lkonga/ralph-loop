import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DiffValidationConfig, DiffValidationResult } from './types';
import { DEFAULT_DIFF_VALIDATION } from './types';

function runGit(workspaceRoot: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

function parseDiffStat(statOutput: string): { linesAdded: number; linesRemoved: number } {
	let linesAdded = 0;
	let linesRemoved = 0;

	const lines = statOutput.trim().split('\n');
	for (const line of lines) {
		// Match lines like: " src/file.ts | 10 ++++----"
		// or the summary line: " 3 files changed, 20 insertions(+), 5 deletions(-)"
		const summaryMatch = /(\d+)\s+insertion/.exec(line);
		const delMatch = /(\d+)\s+deletion/.exec(line);
		if (summaryMatch) { linesAdded = parseInt(summaryMatch[1], 10); }
		if (delMatch) { linesRemoved = parseInt(delMatch[1], 10); }
	}

	return { linesAdded, linesRemoved };
}

export class DiffValidator {
	private readonly config: DiffValidationConfig;

	constructor(config?: Partial<DiffValidationConfig>) {
		this.config = { ...DEFAULT_DIFF_VALIDATION, ...config };
	}

	async validateDiff(workspaceRoot: string, taskInvocationId: string): Promise<DiffValidationResult> {
		const [statResult, nameResult] = await Promise.all([
			runGit(workspaceRoot, ['diff', '--stat', 'HEAD']),
			runGit(workspaceRoot, ['diff', '--name-only', 'HEAD']),
		]);

		const filesChanged = nameResult.stdout.trim().split('\n').filter(Boolean);
		const { linesAdded, linesRemoved } = parseDiffStat(statResult.stdout);
		const hasDiff = filesChanged.length > 0;

		let summary = '';
		if (hasDiff) {
			let statSummary = statResult.stdout.trim();
			if (this.config.maxDiffLines !== undefined && this.config.maxDiffLines > 0) {
				const lines = statSummary.split('\n');
				if (lines.length > this.config.maxDiffLines) {
					statSummary = lines.slice(0, this.config.maxDiffLines).join('\n') + `\n... (${lines.length - this.config.maxDiffLines} more lines)`;
				}
			}
			summary = statSummary;
		}

		let nudge: string | undefined;
		if (!hasDiff && this.config.requireChanges) {
			nudge = 'No code changes detected. Review the task requirements and make the necessary code modifications.';
		}

		return { filesChanged, linesAdded, linesRemoved, hasDiff, summary, nudge };
	}

	buildStateBlock(taskId: string | number, result: DiffValidationResult): string {
		return `### Task ${taskId} State | Files: [${result.filesChanged.join(', ')}] | Lines: +${result.linesAdded}/-${result.linesRemoved} | Status: pass`;
	}

	async appendStateToProgress(progressPath: string, taskId: string | number, result: DiffValidationResult): Promise<void> {
		const block = this.buildStateBlock(taskId, result);
		fs.appendFileSync(progressPath, '\n' + block + '\n');
	}
}
