import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DOC_PATH = resolve(__dirname, '../docs/patterns/frontmatter-sealing.md');

describe('Frontmatter Sealing Pattern Documentation', () => {
	it('should exist at docs/patterns/frontmatter-sealing.md', () => {
		expect(existsSync(DOC_PATH)).toBe(true);
	});

	describe('required sections', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(DOC_PATH, 'utf-8');
		});

		it('should have a title referencing frontmatter sealing', () => {
			expect(content).toMatch(/^# .*(Frontmatter|frontmatter).*(Seal|seal)/m);
		});

		it('should explain the core constraint: frontmatter is the last transformation', () => {
			expect(content).toMatch(/last\s+transformation/i);
		});

		it('should describe the pipeline sequence', () => {
			expect(content).toMatch(/Research/);
			expect(content).toMatch(/Spec.*raw|raw.*spec/i);
			expect(content).toMatch(/User\s+refine/i);
			expect(content).toMatch(/Seal/i);
			expect(content).toMatch(/PRD\s+entries/i);
		});

		it('should explain why premature frontmatter causes partial specs', () => {
			expect(content).toMatch(/partial\s+spec/i);
		});

		it('should reference buildPrompt reading frontmatter', () => {
			expect(content).toMatch(/buildPrompt/);
		});

		it('should include examples from existing research files', () => {
			expect(content).toMatch(/research\//);
		});

		it('should document frontmatter fields: tasks, verification, completion_steps, principles', () => {
			expect(content).toMatch(/\btasks\b/);
			expect(content).toMatch(/\bverification\b/);
			expect(content).toMatch(/\bcompletion_steps\b/);
			expect(content).toMatch(/\bprinciples\b/);
		});

		it('should include a sealed vs unsealed example', () => {
			expect(content).toMatch(/unsealed|before.*seal|without.*frontmatter/i);
			expect(content).toMatch(/sealed|after.*seal|with.*frontmatter/i);
		});

		it('should document the Spec: pointer pattern for PRD entries', () => {
			expect(content).toMatch(/→\s*Spec:|Spec:\s*pointer/i);
		});
	});
});
