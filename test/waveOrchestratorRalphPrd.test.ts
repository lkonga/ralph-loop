import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const AGENT_PATH = resolve(__dirname, '../../vscode-config-files/agents/wave-orchestrator.agent.md');

describe('Wave Orchestrator --ralph-prd Mode', () => {
	let content: string;

	beforeAll(() => {
		expect(existsSync(AGENT_PATH)).toBe(true);
		content = readFileSync(AGENT_PATH, 'utf-8');
	});

	describe('flag parsing', () => {
		it('should list --ralph-prd in the Input/Arguments section', () => {
			expect(content).toMatch(/--ralph-prd/);
		});

		it('should describe --ralph-prd as a flag alongside existing flags', () => {
			const inputSection = content.split(/## Input/i)[1]?.split(/^## /m)[0] ?? '';
			expect(inputSection).toContain('--ralph-prd');
		});
	});

	describe('6-phase flow', () => {
		it('should have a section header for ralph-prd mode', () => {
			expect(content).toMatch(/## .*ralph-prd.*Mode|## .*Ralph.*PRD.*Mode/i);
		});

		it('should describe Phase 0: Context grounding via wave-context-grounder', () => {
			expect(content).toMatch(/Phase\s*0.*context\s*ground|context\s*ground.*Phase\s*0/i);
			expect(content).toMatch(/wave-context-grounder/);
		});

		it('should describe Phase 1: Research wave using existing aggregate flow', () => {
			expect(content).toMatch(/Phase\s*1.*research\s*wave|research\s*wave.*Phase\s*1/i);
		});

		it('should describe Phase 2: Spec generation via wave-spec-generator', () => {
			expect(content).toMatch(/Phase\s*2.*spec\s*gen|spec\s*gen.*Phase\s*2/i);
			expect(content).toMatch(/wave-spec-generator/);
		});

		it('should describe Phase 3: Seal spec with frontmatter', () => {
			expect(content).toMatch(/Phase\s*3.*seal|seal.*Phase\s*3/i);
			expect(content).toMatch(/frontmatter/i);
		});

		it('should describe Phase 4: PRD generation via wave-prd-generator', () => {
			expect(content).toMatch(/Phase\s*4.*PRD\s*gen|PRD\s*gen.*Phase\s*4/i);
			expect(content).toMatch(/wave-prd-generator/);
		});

		it('should describe Phase 5: Finalize (write to PRD.md)', () => {
			expect(content).toMatch(/Phase\s*5.*finalize|finalize.*Phase\s*5/i);
		});
	});

	describe('3 human checkpoints', () => {
		it('should define Checkpoint 1 after Phase 1 (FINAL-REPORT review)', () => {
			expect(content).toMatch(/Checkpoint\s*1/);
			expect(content).toMatch(/FINAL-REPORT/);
		});

		it('should define Checkpoint 2 after Phase 2 (task list review)', () => {
			expect(content).toMatch(/Checkpoint\s*2/);
		});

		it('should define Checkpoint 3 after Phase 4 (PRD entries review)', () => {
			expect(content).toMatch(/Checkpoint\s*3/);
		});

		it('should offer Continue/Refine/Stop at Checkpoint 1', () => {
			expect(content).toMatch(/\[Continue\].*\[Refine\].*\[Stop\]|\[Continue\][\s\S]*\[Refine\][\s\S]*\[Stop\]/);
		});

		it('should offer Continue/Refine/Back/Stop at Checkpoint 2', () => {
			expect(content).toMatch(/\[Continue\][\s\S]*\[Refine\][\s\S]*\[Back\][\s\S]*\[Stop\]/);
		});

		it('should offer Apply/Refine/Back/Stop at Checkpoint 3', () => {
			expect(content).toMatch(/\[Apply\][\s\S]*\[Refine\][\s\S]*\[Back\][\s\S]*\[Stop\]/);
		});
	});

	describe('agent references', () => {
		it('should list wave-context-grounder in agents frontmatter', () => {
			const frontmatter = content.split('---')[1] ?? '';
			expect(frontmatter).toContain('wave-context-grounder');
		});

		it('should list wave-spec-generator in agents frontmatter', () => {
			const frontmatter = content.split('---')[1] ?? '';
			expect(frontmatter).toContain('wave-spec-generator');
		});

		it('should list wave-prd-generator in agents frontmatter', () => {
			const frontmatter = content.split('---')[1] ?? '';
			expect(frontmatter).toContain('wave-prd-generator');
		});
	});

	describe('inter-phase state', () => {
		it('should specify file-based state passing (no context carryover)', () => {
			expect(content).toMatch(/file.*(state|based)|state.*file/i);
		});

		it('should reference ContextBrief injection into downstream prompts', () => {
			expect(content).toMatch(/ContextBrief/);
		});

		it('should reference WAVE_ID for file organization', () => {
			expect(content).toMatch(/WAVE_ID/);
		});
	});

	describe('section placement', () => {
		it('should appear after the existing aggregate mode section', () => {
			const aggregatePos = content.indexOf('## Aggregate Mode');
			const ralphPrdPos = content.search(/## .*ralph-prd.*Mode|## .*Ralph.*PRD.*Mode/i);
			expect(aggregatePos).toBeGreaterThan(-1);
			expect(ralphPrdPos).toBeGreaterThan(-1);
			expect(ralphPrdPos).toBeGreaterThan(aggregatePos);
		});

		it('should appear before the Constraints section', () => {
			const constraintsPos = content.indexOf('## Constraints');
			const ralphPrdPos = content.search(/## .*ralph-prd.*Mode|## .*Ralph.*PRD.*Mode/i);
			expect(constraintsPos).toBeGreaterThan(-1);
			expect(ralphPrdPos).toBeGreaterThan(-1);
			expect(ralphPrdPos).toBeLessThan(constraintsPos);
		});
	});
});
