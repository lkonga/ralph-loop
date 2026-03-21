import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, lstatSync } from 'fs';
import { resolve } from 'path';

const CANONICAL_PATH = resolve(__dirname, '../../vscode-config-files/agents.source/wave-spec-generator.agent.md');

describe('Wave Spec Generator Agent — Task 26', () => {
	it('should exist at vscode-config-files/agents.source/wave-spec-generator.agent.md', () => {
		expect(existsSync(CANONICAL_PATH)).toBe(true);
	});

	describe('required content', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(CANONICAL_PATH, 'utf-8');
		});

		it('should specify FINAL-REPORT.md + ContextBrief as inputs', () => {
			expect(content).toMatch(/FINAL-REPORT\.md/);
			expect(content).toMatch(/ContextBrief/);
			expect(content).toMatch(/[Ii]nput/);
		});

		it('should produce raw task specs with interfaces, config, and tests as markdown', () => {
			expect(content).toMatch(/[Ii]nterface|type\s+definition/i);
			expect(content).toMatch(/[Cc]onfig.*field|config.*default/i);
			expect(content).toMatch(/[Tt]est.*FIRST|test\s+case/i);
		});

		it('should describe refactored core of Waves 3-4 without fan-out/synthesis', () => {
			expect(content).toMatch(/Wave[s]?\s*3.*4|Waves?\s+3-4/);
			expect(content).toMatch(/fan-out|fan.out/i);
			expect(content).toMatch(/wave-orchestrator.*handle|orchestrator.*handle/i);
		});

		it('should output raw markdown with NO frontmatter', () => {
			expect(content).toMatch(/NO\s*(YAML\s*)?frontmatter|no\s+frontmatter/i);
			expect(content).toMatch(/frontmatter.*seal|seal.*frontmatter/i);
		});

		describe('auto-numbering with explicit regex patterns', () => {
			it('should detect next phase number from ## Phase N headers', () => {
				expect(content).toMatch(/##\s*Phase\s*N/);
				expect(content).toMatch(/max\s*\(\s*N\s*\)\s*\+\s*1/);
			});

			it('should include explicit regex for phase detection', () => {
				expect(content).toMatch(/\/.*Phase\s*\\[sd].*\/|`##\s*Phase\s*\(\\d\+\)`|regex.*phase|pattern.*phase/i);
			});

			it('should detect next task number from Task NN patterns', () => {
				expect(content).toMatch(/Task\s*NN/);
				expect(content).toMatch(/max\s*\(\s*NN\s*\)\s*\+\s*1/);
			});

			it('should include explicit regex for task detection', () => {
				expect(content).toMatch(/\/.*Task\s*\\[sd].*\/|`-\s*\[.\]\s*\*\*Task\s*\(\\d\+\)`|regex.*task|pattern.*task/i);
			});

			it('should detect next research file number from research/NN-*.md', () => {
				expect(content).toMatch(/research\//);
				expect(content).toMatch(/NN-\*\.md/);
				expect(content).toMatch(/max\s*\(\s*NN\s*\)\s*\+\s*1/);
			});

			it('should include explicit regex for research file detection', () => {
				expect(content).toMatch(/\/.*\\[sd].*\.md\/|`\(\\d\+\)-\*\.md`|regex.*research|pattern.*research|example.*research/i);
			});

			it('should provide concrete auto-numbering examples', () => {
				expect(content).toMatch(/[Ee]xample/);
				expect(content).toMatch(/Phase\s+\d+|Phase\s+1[0-2]/);
				expect(content).toMatch(/Task\s+\d{2,}/);
			});
		});

		it('should specify output path format research/{NN}-phase{P}-deep-research.md', () => {
			expect(content).toMatch(/research\/\{NN\}-phase\{P\}-deep-research\.md/);
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
