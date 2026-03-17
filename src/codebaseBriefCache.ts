import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ContextSource } from './contextSourceChain';

export const CACHE_PATH = '.ralph/codebase-brief.md';

// 4+ files changed in last 5 commits = significant
const SIGNIFICANCE_THRESHOLD = 4;

function parseDiffStatFileCount(diffOutput: string): number {
	// Last line of git diff --stat looks like: " 5 files changed, 58 insertions(+)"
	const summaryMatch = diffOutput.match(/(\d+)\s+files?\s+changed/);
	return summaryMatch ? parseInt(summaryMatch[1], 10) : 0;
}

export function isCacheValid(workspace: string): boolean {
	const cachePath = path.join(workspace, CACHE_PATH);
	if (!fs.existsSync(cachePath)) {
		return false;
	}

	try {
		const diffStat = execSync('git diff --stat HEAD~5', {
			cwd: workspace,
			encoding: 'utf-8',
			timeout: 10000,
		});

		if (!diffStat.trim()) {
			return true;
		}

		const filesChanged = parseDiffStatFileCount(diffStat);
		return filesChanged < SIGNIFICANCE_THRESHOLD;
	} catch {
		return false;
	}
}

export function readCachedBrief(workspace: string): string {
	try {
		return fs.readFileSync(path.join(workspace, CACHE_PATH), 'utf-8');
	} catch {
		return '';
	}
}

export function writeCachedBrief(workspace: string, content: string): void {
	const ralphDir = path.join(workspace, '.ralph');
	if (!fs.existsSync(ralphDir)) {
		fs.mkdirSync(ralphDir, { recursive: true });
	}
	fs.writeFileSync(path.join(workspace, CACHE_PATH), content, 'utf-8');
}

export const codebaseBriefCacheSource: ContextSource = (workspace: string) => {
	if (!isCacheValid(workspace)) {
		return { source: 'codebase-brief-cache', content: '' };
	}
	return { source: 'codebase-brief-cache', content: readCachedBrief(workspace) };
};
