import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, lstatSync, realpathSync } from 'fs';
import { resolve } from 'path';

const CANONICAL_PATH = resolve(__dirname, '../../vscode-config-files/agents/wave-prd-generator.agent.md');
const SYMLINK_PATH = resolve(__dirname, '../agents/wave-prd-generator.agent.md');

describe('Wave PRD Generator Agent — Task 27', () => {
	it('should exist at vscode-config-files/agents/wave-prd-generator.agent.md', () => {
		expect(existsSync(CANONICAL_PATH)).toBe(true);
	});

	describe('YAML frontmatter', () => {
		let content: string;

		beforeAll(() => {
			content = readFileSync(CANONICAL_PATH, 'utf-8');
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
			content = readFileSync(CANONICAL_PATH, 'utf-8');
		});

		it('should have a title referencing PRD Generator', () => {
			expect(content).toMatch(/^# .*(PRD|prd).*(Generator|generator)/m);
		});

		it('should require sealed spec file reading with frontmatter validation', () => {
			expect(content).toMatch(/[Ss]ealed\s+spec/);
			expect(content).toMatch(/frontmatter/);
			expect(content).toMatch(/type:\s*spec/);
			expect(content).toMatch(/[Rr]eject\s+unsealed|not\s+sealed/i);
		});

		describe('Tier 1 vs Tier 2 classification with concrete criteria', () => {
			it('should define Tier 1 as inline with sentence-count limit', () => {
				expect(content).toMatch(/Tier\s*1.*[Ii]nline/);
				expect(content).toMatch(/≤\s*3\s*sentences|3\s*sentences/);
			});

			it('should define Tier 1 as single surgical change', () => {
				expect(content).toMatch(/[Ss]ingle\s+surgical\s+change|[Ss]elf-contained/);
			});

			it('should define Tier 2 with multi-file or design detail criteria', () => {
				expect(content).toMatch(/Tier\s*2.*[Rr]eference|Tier\s*2.*PD/);
				expect(content).toMatch(/[Dd]esign\s+details|[Mm]ulti-file/);
			});

			it('should restrict Tier 2 to one sentence to force spec reads', () => {
				expect(content).toMatch(/[Oo]ne\s+sentence\s+only/);
				expect(content).toMatch(/deliberately\s+insufficient|forces?\s+spec\s+read|false\s+confidence/i);
			});
		});

		describe('→ Spec: line-range pointer generation', () => {
			it('should have a Build Line Range Index step', () => {
				expect(content).toMatch(/[Bb]uild\s+[Ll]ine\s+[Rr]ange\s+[Ii]ndex/);
			});

			it('should describe finding task section header lines', () => {
				expect(content).toMatch(/###\s*Task\s*NN|header\s+line\s+number/i);
				expect(content).toMatch(/L\{start\}-L\{end\}|L\d+-L\d+/);
			});

			it('should include → Spec: pointer format in output examples', () => {
				expect(content).toMatch(/→\s*Spec:/);
				expect(content).toMatch(/spec_path.*L\{?start\}?-L\{?end\}?|L\d+-L\d+/);
			});
		});

		describe('phase section header generation', () => {
			it('should generate ## Phase {P} — {Title} headers', () => {
				expect(content).toMatch(/##\s*Phase\s*\{P\}\s*—\s*\{Phase\s*Title\}/);
			});

			it('should derive phase number from spec frontmatter', () => {
				expect(content).toMatch(/frontmatter.*phase\s+field|phase.*frontmatter/i);
			});
		});

		describe('ralph-loop PRD format', () => {
			it('should generate - [ ] **Task {NN} — {Title}**: entries', () => {
				expect(content).toMatch(/- \[ \] \*\*Task \{NN\} — \{Title\}\*\*:/);
			});

			it('should include TDD mandatory footer in phase header block', () => {
				expect(content).toMatch(/TDD\s+is\s+MANDATORY/i);
				expect(content).toMatch(/npx\s+tsc\s+--noEmit/);
				expect(content).toMatch(/npx\s+vitest\s+run/);
			});

			it('should auto-detect next task number from existing PRD.md', () => {
				expect(content).toMatch(/max\(NN\)\s*\+\s*1/i);
				expect(content).toMatch(/[Ss]can.*PRD\.md|PRD\.md.*pattern/i);
			});
		});

		describe('user-review gate', () => {
			it('should present output for user review before writing', () => {
				expect(content).toMatch(/[Pp]resent.*user.*review|user.*review.*before/i);
			});

			it('should NOT write to PRD.md directly', () => {
				expect(content).toMatch(/[Dd]o\s+NOT\s+write\s+to\s+PRD\.md/i);
			});

			it('should provide Apply/Refine/Back/Stop options', () => {
				expect(content).toMatch(/\[Apply\]/);
				expect(content).toMatch(/\[Refine\]/);
				expect(content).toMatch(/\[Back\]/);
				expect(content).toMatch(/\[Stop\]/);
			});

			it('should require explicit user confirmation before writing', () => {
				expect(content).toMatch(/user\s+explicitly\s+confirms|explicit.*confirm/i);
			});
		});

		it('should have an input section describing sealed spec', () => {
			expect(content).toMatch(/## Input/i);
		});

		it('should have a workflow section', () => {
			expect(content).toMatch(/## (Workflow|Steps)/i);
		});

		it('should have an output format section with examples', () => {
			expect(content).toMatch(/## Output/i);
			expect(content).toMatch(/##\s*Phase\s*\d+\s*—/);
			expect(content).toMatch(/- \[ \] \*\*Task\s+\d+\s*—/);
		});
	});

	describe('symlink integration', () => {
		it('should have a symlink in ralph-loop/agents/', () => {
			expect(existsSync(SYMLINK_PATH)).toBe(true);
			const stat = lstatSync(SYMLINK_PATH);
			expect(stat.isSymbolicLink()).toBe(true);
		});

		it('symlink should resolve to the canonical file', () => {
			const resolved = realpathSync(SYMLINK_PATH);
			const canonical = realpathSync(CANONICAL_PATH);
			expect(resolved).toBe(canonical);
		});
	});
});
