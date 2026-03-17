import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const PROMPT_PATH = resolve(__dirname, '../../vscode-config-files/prompts/researchPhase.prompt.md');
const README_PATH = resolve(__dirname, '../README.md');

describe('researchPhase prompt refactor (Task 28)', () => {
	let content: string;

	beforeAll(() => {
		content = readFileSync(PROMPT_PATH, 'utf-8');
	});

	it('should exist at prompts/researchPhase.prompt.md', () => {
		expect(existsSync(PROMPT_PATH)).toBe(true);
	});

	describe('YAML frontmatter', () => {
		it('should have updated description focusing on spec transformation', () => {
			const fm = content.match(/^---\n([\s\S]*?)\n---/);
			expect(fm).not.toBeNull();
			expect(fm![1]).toMatch(/spec/i);
			expect(fm![1]).not.toMatch(/fan-out/i);
		});

		it('should retain the research-phase name', () => {
			expect(content).toMatch(/^---\n[\s\S]*?name:\s*research-phase/m);
		});
	});

	describe('Wave 1 (fan-out) removed', () => {
		it('should NOT contain Wave 1 fan-out section', () => {
			expect(content).not.toMatch(/### Wave 1:\s*Fan-Out/i);
		});

		it('should NOT contain fan-out subagent dispatch instructions', () => {
			expect(content).not.toMatch(/dispatch a subagent.*Explore.*agent/i);
		});

		it('should NOT mention parallel analysis subagents for fan-out', () => {
			expect(content).not.toMatch(/Collect results from all subagents before proceeding/i);
		});
	});

	describe('Wave 2 (synthesis) removed', () => {
		it('should NOT contain Wave 2 synthesis section', () => {
			expect(content).not.toMatch(/### Wave 2:\s*Synthesis/i);
		});

		it('should NOT contain synthesis aggregation instructions', () => {
			expect(content).not.toMatch(/Aggregate all Wave 1 findings/i);
		});
	});

	describe('spec generation logic preserved', () => {
		it('should contain task specification transformation logic', () => {
			expect(content).toMatch(/task\s+(spec|specification)/i);
		});

		it('should contain task ordering or dependency-aware sequencing', () => {
			expect(content).toMatch(/dependency.aware|task\s+order/i);
		});

		it('should contain spec format block with Goal, Design, Tests sections', () => {
			expect(content).toMatch(/\*\*Goal\*\*/);
			expect(content).toMatch(/\*\*Design\*\*/);
			expect(content).toMatch(/\*\*Tests/);
		});

		it('should contain line range tracking for PRD references', () => {
			expect(content).toMatch(/line\s+range/i);
		});
	});

	describe('frontmatter application preserved', () => {
		it('should reference normalizeResearchFiles or frontmatter application', () => {
			expect(content).toMatch(/normalizeResearchFiles|frontmatter/i);
		});

		it('should contain PRD integration or entry generation', () => {
			expect(content).toMatch(/PRD.*integrat|PRD.*entr/i);
		});

		it('should reference two-tier PD format', () => {
			expect(content).toMatch(/tier|Tier\s*[12]/i);
		});
	});

	describe('delegation to wave-orchestrator', () => {
		it('should mention wave-orchestrator handles fan-out and synthesis', () => {
			expect(content).toMatch(/wave-orchestrator/i);
		});

		it('should describe receiving consolidated findings as input', () => {
			expect(content).toMatch(/consolidated|FINAL-REPORT|findings.*input/i);
		});
	});

	describe('README reference updated', () => {
		let readmeContent: string;

		beforeAll(() => {
			readmeContent = readFileSync(README_PATH, 'utf-8');
		});

		it('should update the /researchPhase description in README to reflect spec-only focus', () => {
			const researchLine = readmeContent.split('\n').find(line => line.includes('/researchPhase'));
			expect(researchLine).toBeDefined();
			expect(researchLine).not.toMatch(/fan-out/i);
			expect(researchLine).toMatch(/spec/i);
		});
	});
});
