import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const PROMPT_PATH = resolve(__dirname, '../../vscode-config-files/prompts.source/updatePRD.prompt.md');

describe('updatePRD prompt handoff entry (Task 29)', () => {
	let content: string;

	beforeAll(() => {
		content = readFileSync(PROMPT_PATH, 'utf-8');
	});

	it('should exist at prompts/updatePRD.prompt.md', () => {
		expect(existsSync(PROMPT_PATH)).toBe(true);
	});

	describe('pipeline handoff entry point', () => {
		it('should have a section for pipeline/handoff invocation', () => {
			expect(content).toMatch(/pipeline|handoff|--ralph-prd/i);
		});

		it('should accept a spec file path as input', () => {
			expect(content).toMatch(/spec.?file.?path|specFilePath|spec_file_path/i);
		});

		it('should describe how the pipeline passes the spec file', () => {
			expect(content).toMatch(/pipeline.*spec|spec.*pipeline|wave-orchestrator|--ralph-prd/i);
		});

		it('should use {SPEC_FILE_PATH} placeholder for pipeline argument', () => {
			expect(content).toContain('{SPEC_FILE_PATH}');
		});

		it('should still support manual invocation', () => {
			expect(content).toMatch(/manual/i);
		});

		it('should document two invocation modes', () => {
			// Pipeline mode (automated from --ralph-prd) and manual mode
			expect(content).toMatch(/manual.*mode|mode.*manual/i);
			expect(content).toMatch(/pipeline.*mode|mode.*pipeline/i);
		});
	});

	describe('existing functionality preserved', () => {
		it('should retain the update-prd name', () => {
			expect(content).toMatch(/^---\n[\s\S]*?name:\s*update-prd/m);
		});

		it('should retain tier classification instructions', () => {
			expect(content).toMatch(/Tier 1.*Inline|Inline.*Tier 1/i);
			expect(content).toMatch(/Tier 2.*PD Reference|PD Reference.*Tier 2/i);
		});

		it('should retain the Steps section', () => {
			expect(content).toMatch(/## Steps/);
		});

		it('should retain the quality checklist', () => {
			expect(content).toMatch(/## Quality Checklist/);
		});

		it('should retain reference file organization', () => {
			expect(content).toMatch(/## Reference File Organization/);
		});
	});
});
