import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const AGENT_PATH = resolve(__dirname, '../../vscode-config-files/agents/wave-prd-generator.agent.md');

describe('Wave PRD Generator Agent', () => {
	it('should exist at agents/wave-prd-generator.agent.md', () => {
		expect(existsSync(AGENT_PATH)).toBe(true);
	});

	describe('YAML frontmatter', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(AGENT_PATH, 'utf-8');
		});

		it('should have YAML frontmatter with description', () => {
			expect(content).toMatch(/^---\n[\s\S]*?description:.*PRD/m);
		});

		it('should specify tools in frontmatter', () => {
			expect(content).toMatch(/^---\n[\s\S]*?tools:/m);
		});

		it('should not be user-invocable (dispatched by orchestrator)', () => {
			expect(content).toMatch(/user-invocable:\s*false/);
		});
	});

	describe('required content', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(AGENT_PATH, 'utf-8');
		});

		it('should have a title referencing PRD Generator', () => {
			expect(content).toMatch(/^# .*(PRD|prd).*(Generator|generator)/m);
		});

		it('should describe reading sealed spec files with frontmatter', () => {
			expect(content).toMatch(/sealed\s+spec/i);
			expect(content).toMatch(/frontmatter/i);
		});

		it('should describe Tier 1 classification (inline)', () => {
			expect(content).toMatch(/Tier\s*1/);
			expect(content).toMatch(/inline/i);
		});

		it('should describe Tier 2 classification (spec reference)', () => {
			expect(content).toMatch(/Tier\s*2/);
			expect(content).toMatch(/→\s*Spec:/);
		});

		it('should include line range references in Tier 2 format', () => {
			expect(content).toMatch(/L\d+-L\d+|LNN-LNN/);
		});

		it('should show the PRD task format with checkbox syntax', () => {
			expect(content).toMatch(/- \[[ x]\] \*\*Task/);
		});

		it('should include phase section header generation', () => {
			expect(content).toMatch(/## Phase/);
		});

		it('should require user review before writing to PRD', () => {
			expect(content).toMatch(/review|confirm|approve/i);
			expect(content).toMatch(/before\s+(writing|append|insert|apply)/i);
		});

		it('should describe auto-detection of next task number', () => {
			expect(content).toMatch(/next\s+task\s+number|auto.detect|max\(NN\)/i);
		});

		it('should have an input section describing sealed spec', () => {
			expect(content).toMatch(/## Input/i);
		});

		it('should have a workflow or steps section', () => {
			expect(content).toMatch(/## (Workflow|Steps)/i);
		});

		it('should have an output format section', () => {
			expect(content).toMatch(/## Output/i);
		});

		it('should reference the updatePRD prompt or PRD format conventions', () => {
			expect(content).toMatch(/updatePRD|PRD format|ralph-loop PRD/i);
		});
	});
});
