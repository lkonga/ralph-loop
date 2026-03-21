import { describe, it, expect } from 'vitest';
import {
	type ContextSnippet,
	type ContextSource,
	type ContextSourceChainConfig,
	runContextSourceChain,
	prdSource,
	readmeSource,
	changelogSource,
	commits3ZoneSource,
	fileSource,
} from '../src/contextSourceChain';

describe('Context Source Chain (Task 34)', () => {
	describe('ContextSnippet type', () => {
		it('should have label or source, content, and optional tokenEstimate', () => {
			const snippet: ContextSnippet = {
				source: 'prd',
				content: 'some content',
				tokenEstimate: 100,
			};
			expect(snippet.source).toBe('prd');
			expect(snippet.content).toBe('some content');
			expect(snippet.tokenEstimate).toBe(100);
		});
	});

	describe('ContextSource type', () => {
		it('should be a function (workspace) → ContextSnippet', () => {
			const src: ContextSource = (_workspace: string) => ({
				source: 'test',
				content: 'test content',
			});
			const result = src('/tmp/workspace');
			expect(result.source).toBe('test');
			expect(result.content).toBe('test content');
		});
	});

	describe('built-in sources', () => {
		it('prdSource should return a ContextSnippet with source "prd"', () => {
			const snippet = prdSource('/nonexistent/path');
			expect(snippet.source).toBe('prd');
			expect(typeof snippet.content).toBe('string');
		});

		it('readmeSource should return a ContextSnippet with source "readme"', () => {
			const snippet = readmeSource('/nonexistent/path');
			expect(snippet.source).toBe('readme');
			expect(typeof snippet.content).toBe('string');
		});

		it('changelogSource should return a ContextSnippet with source "changelog"', () => {
			const snippet = changelogSource('/nonexistent/path');
			expect(snippet.source).toBe('changelog');
			expect(typeof snippet.content).toBe('string');
		});

		it('commits3ZoneSource should return a ContextSnippet with source "commits-3zone"', () => {
			const snippet = commits3ZoneSource('/nonexistent/path');
			expect(snippet.source).toBe('commits-3zone');
			expect(typeof snippet.content).toBe('string');
		});

		it('fileSource should create a source for a custom file path', () => {
			const src = fileSource('architecture.md');
			const snippet = src('/nonexistent/path');
			expect(snippet.source).toBe('architecture.md');
			expect(typeof snippet.content).toBe('string');
		});
	});

	describe('runContextSourceChain', () => {
		it('should concatenate snippets from all sources in order', () => {
			const srcA: ContextSource = () => ({ source: 'a', content: 'AAA' });
			const srcB: ContextSource = () => ({ source: 'b', content: 'BBB' });

			const config: ContextSourceChainConfig = {
				sources: [srcA, srcB],
				tokenBudget: 10000,
			};
			const result = runContextSourceChain('/tmp', config);
			expect(result.snippets).toHaveLength(2);
			expect(result.snippets[0].source).toBe('a');
			expect(result.snippets[1].source).toBe('b');
			expect(result.combined).toContain('AAA');
			expect(result.combined).toContain('BBB');
			// A should come before B
			expect(result.combined.indexOf('AAA')).toBeLessThan(result.combined.indexOf('BBB'));
		});

		it('should trim to token budget', () => {
			const longContent = 'word '.repeat(5000);
			const srcA: ContextSource = () => ({ source: 'a', content: longContent, tokenEstimate: 6000 });
			const srcB: ContextSource = () => ({ source: 'b', content: 'BBB', tokenEstimate: 10 });

			const config: ContextSourceChainConfig = {
				sources: [srcA, srcB],
				tokenBudget: 2000,
			};
			const result = runContextSourceChain('/tmp', config);
			expect(result.totalTokenEstimate).toBeLessThanOrEqual(2000);
		});

		it('should use default token budget of 2000 when not specified', () => {
			const config: ContextSourceChainConfig = {
				sources: [],
			};
			const result = runContextSourceChain('/tmp', config);
			expect(result.tokenBudget).toBe(2000);
		});

		it('should skip sources that return empty content', () => {
			const srcA: ContextSource = () => ({ source: 'a', content: '' });
			const srcB: ContextSource = () => ({ source: 'b', content: 'real content' });

			const config: ContextSourceChainConfig = {
				sources: [srcA, srcB],
				tokenBudget: 10000,
			};
			const result = runContextSourceChain('/tmp', config);
			expect(result.snippets).toHaveLength(1);
			expect(result.snippets[0].source).toBe('b');
		});

		it('should handle custom sources alongside built-ins', () => {
			const prdMock: ContextSource = () => ({ source: 'prd', content: 'PRD content' });
			const customSrc: ContextSource = () => ({ source: 'custom', content: 'custom data' });
			const config: ContextSourceChainConfig = {
				sources: [prdMock, customSrc],
				tokenBudget: 10000,
			};
			const result = runContextSourceChain('/tmp', config);
			expect(result.snippets.some(s => s.source === 'prd')).toBe(true);
			expect(result.snippets.some(s => s.source === 'custom')).toBe(true);
		});

		it('should accept an empty sources array (disabled all)', () => {
			const config: ContextSourceChainConfig = {
				sources: [],
				tokenBudget: 2000,
			};
			const result = runContextSourceChain('/tmp', config);
			expect(result.snippets).toHaveLength(0);
			expect(result.combined).toBe('');
		});
	});

	describe('agent markdown validation', () => {
		let agentContent: string;

		it('should load agent markdown', async () => {
			const { readFileSync, existsSync } = await import('fs');
			const { resolve } = await import('path');
			const agentPath = resolve(__dirname, '../../vscode-config-files/agents.source/wave-context-grounder.agent.md');
			expect(existsSync(agentPath)).toBe(true);
			agentContent = readFileSync(agentPath, 'utf-8');
		});

		it('should mention configurable context source chain or composable sources', () => {
			expect(agentContent).toMatch(/context\s*source\s*chain|composable\s*source|configurable\s*source/i);
		});

		it('should describe ContextSnippet or snippet concept', () => {
			expect(agentContent).toMatch(/ContextSnippet|context\s*snippet/i);
		});

		it('should describe token budget trimming', () => {
			expect(agentContent).toMatch(/token\s*budget|trim.*budget|budget.*trim/i);
		});

		it('should mention custom sources or user-defined sources', () => {
			expect(agentContent).toMatch(/custom\s*source|user.?defined\s*source|architecture\.md/i);
		});

		it('should mention disabling sources', () => {
			expect(agentContent).toMatch(/disable|disabl(e|ing)\s*(any|source)|opt.?out/i);
		});

		it('should list built-in sources: prd, readme, commits-3zone, changelog', () => {
			expect(agentContent).toMatch(/prd/i);
			expect(agentContent).toMatch(/readme/i);
			expect(agentContent).toMatch(/commits.?3zone|commit.?sampl/i);
			expect(agentContent).toMatch(/changelog/i);
		});
	});
});
