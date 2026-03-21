import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, lstatSync } from 'fs';
import { resolve } from 'path';

const CANONICAL_PATH = resolve(__dirname, '../../vscode-config-files/agents.source/wave-context-grounder.agent.md');

describe('Wave Context Grounder Agent — Task 25', () => {
	it('should exist at vscode-config-files/agents.source/wave-context-grounder.agent.md', () => {
		expect(existsSync(CANONICAL_PATH)).toBe(true);
	});

	describe('required content', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(CANONICAL_PATH, 'utf-8');
		});

		it('should contain PRD.md + README.md reading instructions', () => {
			expect(content).toMatch(/PRD\.md/);
			expect(content).toMatch(/README\.md/);
			expect(content).toMatch(/[Rr]ead.*PRD|PRD.*[Rr]ead/);
		});

		it('should define ContextBrief output format with token/line budget', () => {
			expect(content).toMatch(/ContextBrief/);
			expect(content).toMatch(/≤\s*2K\s*tokens|2000\s*tokens|2K\s*token/i);
			expect(content).toMatch(/≤\s*30\s*lines|30\s*line/i);
		});

		it('should capture existing capabilities to prevent researching solved problems', () => {
			expect(content).toMatch(/[Cc]ompleted|already\s+has|existing\s+capabilit/);
			expect(content).toMatch(/prevent.*research|solved\s+problem/i);
		});

		it('should capture naming conventions', () => {
			expect(content).toMatch(/[Nn]aming\s+convention/);
		});

		it('should capture current architecture', () => {
			expect(content).toMatch(/[Aa]rchitecture/);
		});

		it('should capture phase/task numbering', () => {
			expect(content).toMatch(/[Pp]hase.*[Nn]umber|[Tt]ask.*[Nn]umber/);
		});

		it('should instruct that ContextBrief is injected into subsequent subagent prompts', () => {
			expect(content).toMatch(/inject.*subagent|inject.*subsequent|subagent.*prompt/i);
		});

		it('should contain 3-zone commit-sampling section', () => {
			expect(content).toMatch(/3-zone/);
			expect(content).toMatch(/commit-sampling|commit.sampling/i);
			expect(content).toMatch(/Zone\s*1|first\s+10\s+commit/i);
			expect(content).toMatch(/Zone\s*2|middle\s+10\s+commit/i);
			expect(content).toMatch(/Zone\s*3|last\s+10\s+commit/i);
		});

		it('should contain contextSources composable chain', () => {
			expect(content).toMatch(/contextSources/);
			expect(content).toMatch(/composable|chain/i);
			expect(content).toMatch(/pure\s+function/i);
		});

		it('should pass keyword grep with ≥4 matches', () => {
			const keywords = /3-zone|commit.sampling|ContextBrief|contextSources/gi;
			const matches = content.match(keywords);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBeGreaterThanOrEqual(4);
		});
	});

	describe('Task 32 — commit-sampling git commands and fingerprint', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(CANONICAL_PATH, 'utf-8');
		});

		it('should contain explicit git log commands for all 3 zones', () => {
			expect(content).toMatch(/git log --oneline --reverse.*head.*10/i);
			expect(content).toMatch(/git log --oneline --skip.*-10/i);
			expect(content).toMatch(/git log --oneline -10/);
		});

		it('should contain git show --stat for inspecting each commit', () => {
			expect(content).toMatch(/git show --stat/);
		});

		it('should define codebase fingerprint output with churn, signatures, and dependencies', () => {
			expect(content).toMatch(/[Cc]odebase [Ff]ingerprint/);
			expect(content).toMatch(/top files by churn/i);
			expect(content).toMatch(/key function signatures/i);
			expect(content).toMatch(/[Dd]ependenc/);
		});

		it('should reference pre-computed cache at .ralph/codebase-brief.md (Task 35)', () => {
			expect(content).toMatch(/\.ralph\/codebase-brief\.md/);
			expect(content).toMatch(/cache|pre-computed/i);
		});

		it('should mention latency and cache as mitigation', () => {
			expect(content).toMatch(/30s|latency/i);
			expect(content).toMatch(/cache|pre-computed/i);
		});
	});

	describe('Task 35 — Codebase Brief Cache', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(CANONICAL_PATH, 'utf-8');
		});

		it('should document cache file location at .ralph/codebase-brief.md', () => {
			expect(content).toMatch(/\.ralph\/codebase-brief\.md/);
		});

		it('should describe regeneration trigger via git hook or periodic script', () => {
			expect(content).toMatch(/git\s+hook|post-commit|periodic\s+script|regenerat/i);
		});

		it('should describe cache invalidation using git diff --stat HEAD~5', () => {
			expect(content).toMatch(/git diff --stat HEAD~5/);
			expect(content).toMatch(/invalidat|stale|significant\s+change/i);
		});

		it('should describe fallback to live summarization when cache is stale', () => {
			expect(content).toMatch(/fallback|fall\s+back/i);
			expect(content).toMatch(/live\s+summariz|commit-sampling/i);
		});

		it('should document the .ralph/ directory convention', () => {
			expect(content).toMatch(/\.ralph\//);
			expect(content).toMatch(/directory|folder|convention/i);
		});
	});

	describe('canonical file ownership', () => {
		it('canonical file exists in vscode-config-files/agents.source/', () => {
			expect(existsSync(CANONICAL_PATH)).toBe(true);
		});

		it('canonical file is a regular file (not a symlink)', () => {
			const stat = lstatSync(CANONICAL_PATH);
			expect(stat.isSymbolicLink()).toBe(false);
			expect(stat.isFile()).toBe(true);
		});
	});
});
