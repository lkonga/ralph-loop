import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const AGENT_PATH = resolve(__dirname, '../../vscode-config-files/agents.source/wave-context-grounder.agent.md');

describe('Commit-Sampling Hook (Task 32)', () => {
	let content: string;

	beforeAll(() => {
		expect(existsSync(AGENT_PATH)).toBe(true);
		content = readFileSync(AGENT_PATH, 'utf-8');
	});

	describe('3-zone git log analysis', () => {
		it('should have a section for commit-sampling / git analysis', () => {
			expect(content).toMatch(/commit.?sampl|git\s*(log|history)\s*analysis|3.?zone/i);
		});

		it('should describe the first zone: founding intentions (first 10 commits)', () => {
			expect(content).toMatch(/first\s*10\s*commits|founding\s*intentions|earliest\s*commits/i);
		});

		it('should describe the middle zone: evolutionary trajectory (middle 10 commits)', () => {
			expect(content).toMatch(/middle\s*10\s*commits|evolution(ary)?\s*trajectory/i);
		});

		it('should describe the last zone: current state (last 10 commits)', () => {
			expect(content).toMatch(/last\s*10\s*commits|current\s*state|recent\s*commits/i);
		});
	});

	describe('git commands', () => {
		it('should reference git log --oneline', () => {
			expect(content).toMatch(/git\s+log\s+--oneline/);
		});

		it('should reference git show --stat', () => {
			expect(content).toMatch(/git\s+show\s+--stat/);
		});
	});

	describe('LLM summarization', () => {
		it('should describe LLM summarization into codebase fingerprint', () => {
			expect(content).toMatch(/codebase\s*fingerprint|LLM\s*summar/i);
		});

		it('should mention top files by churn', () => {
			expect(content).toMatch(/files\s*by\s*churn|churn/i);
		});

		it('should mention key function signatures or patterns', () => {
			expect(content).toMatch(/function\s*signature|key\s*pattern|key.*signature/i);
		});

		it('should mention dependency list', () => {
			expect(content).toMatch(/dependenc(y|ies)\s*list|dependenc(y|ies)/i);
		});
	});

	describe('ContextBrief integration', () => {
		it('should add a Codebase Fingerprint section to the output format', () => {
			expect(content).toMatch(/###\s*Codebase\s*Fingerprint|Codebase\s*Fingerprint/i);
		});

		it('should remain within ContextBrief token/line constraints', () => {
			expect(content).toMatch(/≤\s*2K\s*tokens|token\s*budget|≤\s*30\s*lines/i);
		});
	});

	describe('cache consideration', () => {
		it('should mention pre-computed cache or Task 35 reference', () => {
			expect(content).toMatch(/cache|pre.?computed|Task\s*35/i);
		});
	});

	describe('workflow steps', () => {
		it('should define numbered workflow steps including commit sampling', () => {
			const workflowSection = content.split(/## Workflow/i)[1]?.split(/^## /m)[0] ?? '';
			expect(workflowSection).toMatch(/git\s+log|commit/i);
		});

		it('should still include reading PRD.md and README.md', () => {
			expect(content).toMatch(/PRD\.md/);
			expect(content).toMatch(/README\.md/);
		});
	});
});
