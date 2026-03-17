import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ContextSnippet {
	source: string;
	content: string;
	tokenEstimate?: number;
}

export type ContextSource = (workspace: string) => ContextSnippet;

export interface ContextSourceChainConfig {
	sources: ContextSource[];
	tokenBudget?: number;
}

export interface ContextSourceChainResult {
	snippets: ContextSnippet[];
	combined: string;
	totalTokenEstimate: number;
	tokenBudget: number;
}

const DEFAULT_TOKEN_BUDGET = 2000;

function estimateTokens(text: string): number {
	// ~4 chars per token is a standard rough estimate
	return Math.ceil(text.length / 4);
}

function readFileSafe(filePath: string): string {
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return '';
	}
}

export const prdSource: ContextSource = (workspace: string) => ({
	source: 'prd',
	content: readFileSafe(path.join(workspace, 'PRD.md')),
});

export const readmeSource: ContextSource = (workspace: string) => ({
	source: 'readme',
	content: readFileSafe(path.join(workspace, 'README.md')),
});

export const changelogSource: ContextSource = (workspace: string) => ({
	source: 'changelog',
	content: readFileSafe(path.join(workspace, 'CHANGELOG.md')),
});

export const commits3ZoneSource: ContextSource = (workspace: string) => {
	try {
		const log = execSync('git log --oneline -30', { cwd: workspace, encoding: 'utf-8', timeout: 10000 });
		return { source: 'commits-3zone', content: log.trim() };
	} catch {
		return { source: 'commits-3zone', content: '' };
	}
};

export function fileSource(relativePath: string): ContextSource {
	return (workspace: string) => ({
		source: relativePath,
		content: readFileSafe(path.join(workspace, relativePath)),
	});
}

function trimToTokenBudget(snippets: ContextSnippet[], budget: number): ContextSnippet[] {
	const result: ContextSnippet[] = [];
	let used = 0;

	for (const snippet of snippets) {
		const tokens = snippet.tokenEstimate ?? estimateTokens(snippet.content);
		if (used + tokens > budget) {
			const remaining = budget - used;
			if (remaining <= 0) { break; }
			const charBudget = remaining * 4;
			result.push({
				source: snippet.source,
				content: snippet.content.slice(0, charBudget),
				tokenEstimate: remaining,
			});
			used = budget;
			break;
		}
		result.push({ ...snippet, tokenEstimate: tokens });
		used += tokens;
	}
	return result;
}

export function runContextSourceChain(workspace: string, config: ContextSourceChainConfig): ContextSourceChainResult {
	const budget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

	const raw = config.sources.map(src => src(workspace));
	const nonEmpty = raw.filter(s => s.content.length > 0);

	const withEstimates = nonEmpty.map(s => ({
		...s,
		tokenEstimate: s.tokenEstimate ?? estimateTokens(s.content),
	}));

	const trimmed = trimToTokenBudget(withEstimates, budget);
	const combined = trimmed.map(s => `### ${s.source}\n${s.content}`).join('\n\n');
	const totalTokenEstimate = trimmed.reduce((sum, s) => sum + (s.tokenEstimate ?? 0), 0);

	return { snippets: trimmed, combined, totalTokenEstimate, tokenBudget: budget };
}
