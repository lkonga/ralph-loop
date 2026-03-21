import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, lstatSync } from 'fs';
import { resolve } from 'path';

/**
 * E2E Pipeline Smoke Test — Task 90
 *
 * Validates the --ralph-prd pipeline is structurally complete and correctly wired.
 * Since the pipeline is agent/prompt-based (not programmatic), this smoke test
 * verifies all phases exist, agents are reachable, input/output contracts are
 * consistent, and cross-references between phases resolve.
 */

const AGENTS_DIR = resolve(__dirname, '../../vscode-config-files/agents.source');
const PROMPTS_DIR = resolve(__dirname, '../../vscode-config-files/prompts.source');
const DOCS_DIR = resolve(__dirname, '../docs/patterns');

const PIPELINE_AGENTS = {
	orchestrator: resolve(AGENTS_DIR, 'wave-orchestrator.agent.md'),
	contextGrounder: resolve(AGENTS_DIR, 'wave-context-grounder.agent.md'),
	specGenerator: resolve(AGENTS_DIR, 'wave-spec-generator.agent.md'),
	prdGenerator: resolve(AGENTS_DIR, 'wave-prd-generator.agent.md'),
};

const ENTRY_POINT = resolve(PROMPTS_DIR, 'wave-explore-fast.prompt.md');

describe('E2E Pipeline Smoke Test — Task 90', () => {
	const files: Record<string, string> = {};

	beforeAll(() => {
		for (const [key, path] of Object.entries(PIPELINE_AGENTS)) {
			expect(existsSync(path), `Missing agent: ${path}`).toBe(true);
			files[key] = readFileSync(path, 'utf-8');
		}
		expect(existsSync(ENTRY_POINT), `Missing entry point: ${ENTRY_POINT}`).toBe(true);
		files.entryPoint = readFileSync(ENTRY_POINT, 'utf-8');
	});

	describe('Phase 0 — Entry Point & Delegation', () => {
		it('wave-explore-fast.prompt.md should include --ralph-prd in argument-hint', () => {
			const fm = files.entryPoint.match(/^---\n([\s\S]*?)\n---/);
			expect(fm).not.toBeNull();
			expect(fm![1]).toContain('--ralph-prd');
		});

		it('wave-explore-fast.prompt.md should delegate to wave-orchestrator', () => {
			expect(files.entryPoint).toContain('wave-orchestrator');
			expect(files.entryPoint).toMatch(/delegate.*--ralph-prd|--ralph-prd.*mode/i);
		});

		it('wave-explore-fast.prompt.md should specify wave-orchestrator as agent', () => {
			const fm = files.entryPoint.match(/^---\n([\s\S]*?)\n---/);
			expect(fm![1]).toMatch(/agent:\s*wave-orchestrator/);
		});
	});

	describe('Phase 0 — Context Grounding produces ContextBrief', () => {
		it('orchestrator should dispatch wave-context-grounder in Phase 0', () => {
			expect(files.orchestrator).toMatch(/Phase\s*0.*[Cc]ontext/);
			expect(files.orchestrator).toContain('wave-context-grounder');
		});

		it('context grounder should produce ContextBrief output', () => {
			expect(files.contextGrounder).toMatch(/ContextBrief/);
			expect(files.contextGrounder).toMatch(/≤\s*2K\s*tokens|2000\s*tokens|2K\s*token/i);
			expect(files.contextGrounder).toMatch(/≤\s*30\s*lines|30\s*line/i);
		});

		it('orchestrator should save ContextBrief to research/_wave/{WAVE_ID}/context-brief.md', () => {
			expect(files.orchestrator).toMatch(/context-brief\.md/);
		});

		it('ContextBrief should be injected into subsequent subagent prompts', () => {
			expect(files.orchestrator).toMatch(/ContextBrief.*inject|inject.*ContextBrief/i);
		});
	});

	describe('Phase 1 — Research Wave produces FINAL-REPORT.md', () => {
		it('orchestrator should define Phase 1 as research wave', () => {
			expect(files.orchestrator).toMatch(/Phase\s*1.*[Rr]esearch/);
		});

		it('Phase 1 should use Aggregate Mode flow', () => {
			expect(files.orchestrator).toMatch(/Aggregate\s*Mode/);
		});

		it('Phase 1 should produce FINAL-REPORT.md', () => {
			expect(files.orchestrator).toMatch(/FINAL-REPORT\.md/);
		});

		it('Phase 1 should write phase-1-state.json with required fields', () => {
			expect(files.orchestrator).toMatch(/phase-1-state\.json/);
			expect(files.orchestrator).toMatch(/waveId/);
			expect(files.orchestrator).toMatch(/finalReportPath/);
		});
	});

	describe('Checkpoint 1 — FINAL-REPORT Review', () => {
		it('should present Checkpoint 1 after Phase 1', () => {
			expect(files.orchestrator).toMatch(/Checkpoint\s*1.*FINAL-REPORT|FINAL-REPORT.*Checkpoint\s*1/i);
		});

		it('should offer Continue/Refine/Back/Stop options', () => {
			const cp1Section = files.orchestrator.split(/### Checkpoint 1/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(cp1Section).toMatch(/\[Continue\]/);
			expect(cp1Section).toMatch(/\[Refine\]/);
			expect(cp1Section).toMatch(/\[Back\]/);
			expect(cp1Section).toMatch(/\[Stop\]/);
		});
	});

	describe('Phase 2 — Spec Generation produces spec file', () => {
		it('orchestrator should dispatch wave-spec-generator in Phase 2', () => {
			expect(files.orchestrator).toMatch(/Phase\s*2.*[Ss]pec/);
			expect(files.orchestrator).toContain('wave-spec-generator');
		});

		it('spec generator should accept FINAL-REPORT.md + ContextBrief as inputs', () => {
			expect(files.specGenerator).toMatch(/FINAL-REPORT\.md/);
			expect(files.specGenerator).toMatch(/ContextBrief/);
		});

		it('spec generator should produce raw spec with NO frontmatter', () => {
			expect(files.specGenerator).toMatch(/NO\s*(YAML\s*)?frontmatter|no\s+frontmatter/i);
		});

		it('spec generator should auto-number phases and tasks', () => {
			expect(files.specGenerator).toMatch(/auto.?number|auto.?detect/i);
			expect(files.specGenerator).toMatch(/max\s*\(\s*N\s*\)\s*\+\s*1/);
			expect(files.specGenerator).toMatch(/max\s*\(\s*NN\s*\)\s*\+\s*1/);
		});

		it('orchestrator Phase 2 should pass FINAL-REPORT path and ContextBrief to spec generator', () => {
			const phase2Section = files.orchestrator.split(/### Phase 2/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(phase2Section).toMatch(/FINAL-REPORT/);
			expect(phase2Section).toMatch(/ContextBrief|context-brief/);
		});
	});

	describe('Checkpoint 2 — Task List Review', () => {
		it('should present Checkpoint 2 after Phase 2', () => {
			expect(files.orchestrator).toMatch(/Checkpoint\s*2/);
		});

		it('should offer Continue/Refine/Back/Stop options', () => {
			const cp2Section = files.orchestrator.split(/### Checkpoint 2/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(cp2Section).toMatch(/\[Continue\]/);
			expect(cp2Section).toMatch(/\[Refine\]/);
			expect(cp2Section).toMatch(/\[Back\]/);
			expect(cp2Section).toMatch(/\[Stop\]/);
		});
	});

	describe('Phase 3 — Seal Spec with Frontmatter', () => {
		it('orchestrator should define Phase 3 as seal step', () => {
			expect(files.orchestrator).toMatch(/Phase\s*3.*[Ss]eal/);
		});

		it('Phase 3 should apply YAML frontmatter to the spec', () => {
			expect(files.orchestrator).toMatch(/frontmatter/i);
			expect(files.orchestrator).toMatch(/type:\s*spec/);
		});

		it('Phase 3 should reference frontmatter-sealing pattern doc', () => {
			expect(files.orchestrator).toMatch(/frontmatter-sealing\.md/);
		});

		it('frontmatter-sealing pattern doc should exist', () => {
			expect(existsSync(resolve(DOCS_DIR, 'frontmatter-sealing.md'))).toBe(true);
		});
	});

	describe('Phase 4 — PRD Generation produces PRD entries', () => {
		it('orchestrator should dispatch wave-prd-generator in Phase 4', () => {
			expect(files.orchestrator).toMatch(/Phase\s*4.*PRD/i);
			expect(files.orchestrator).toContain('wave-prd-generator');
		});

		it('PRD generator should accept sealed spec file', () => {
			expect(files.prdGenerator).toMatch(/[Ss]ealed\s+spec/);
			expect(files.prdGenerator).toMatch(/frontmatter/);
		});

		it('PRD generator should classify Tier 1 vs Tier 2 tasks', () => {
			expect(files.prdGenerator).toMatch(/Tier\s*1/);
			expect(files.prdGenerator).toMatch(/Tier\s*2/);
		});

		it('PRD generator should produce ralph-loop PRD format entries', () => {
			expect(files.prdGenerator).toMatch(/- \[ \] \*\*Task/);
		});

		it('PRD generator should generate → Spec: line-range pointers for Tier 2', () => {
			expect(files.prdGenerator).toMatch(/→ Spec:/);
		});
	});

	describe('Checkpoint 3 — PRD Entries Review', () => {
		it('should present Checkpoint 3 after Phase 4', () => {
			expect(files.orchestrator).toMatch(/Checkpoint\s*3/);
		});

		it('should offer Continue/Refine/Back/Stop options', () => {
			const cp3Section = files.orchestrator.split(/### Checkpoint 3/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(cp3Section).toMatch(/\[Continue\]/);
			expect(cp3Section).toMatch(/\[Refine\]/);
			expect(cp3Section).toMatch(/\[Back\]/);
			expect(cp3Section).toMatch(/\[Stop\]/);
		});
	});

	describe('Phase 5 — Finalize', () => {
		it('orchestrator should define Phase 5 as finalize step', () => {
			expect(files.orchestrator).toMatch(/Phase\s*5.*[Ff]inalize/);
		});
	});

	describe('Pipeline Wiring — agents listed in orchestrator frontmatter', () => {
		it('orchestrator frontmatter should list wave-context-grounder', () => {
			const fm = files.orchestrator.match(/^---\n([\s\S]*?)\n---/);
			expect(fm).not.toBeNull();
			expect(fm![1]).toContain('wave-context-grounder');
		});

		it('orchestrator frontmatter should list wave-spec-generator', () => {
			const fm = files.orchestrator.match(/^---\n([\s\S]*?)\n---/);
			expect(fm![1]).toContain('wave-spec-generator');
		});

		it('orchestrator frontmatter should list wave-prd-generator', () => {
			const fm = files.orchestrator.match(/^---\n([\s\S]*?)\n---/);
			expect(fm![1]).toContain('wave-prd-generator');
		});
	});

	describe('Pipeline Wiring — wave agents exist as canonical files', () => {
		const requiredAgents = [
			'wave-context-grounder.agent.md',
			'wave-orchestrator.agent.md',
			'wave-spec-generator.agent.md',
			'wave-prd-generator.agent.md',
		];

		for (const name of requiredAgents) {
			it(`${name} exists in vscode-config-files/agents.source/`, () => {
				const filePath = resolve(AGENTS_DIR, name);
				expect(existsSync(filePath), `Missing agent: ${filePath}`).toBe(true);
				const stat = lstatSync(filePath);
				expect(stat.isFile()).toBe(true);
			});
		}
	});

	describe('Pipeline Wiring — checkpoint-retry pattern doc', () => {
		it('checkpoint-retry.md should exist in docs/patterns/', () => {
			expect(existsSync(resolve(DOCS_DIR, 'checkpoint-retry.md'))).toBe(true);
		});

		it('orchestrator should reference checkpoint-retry pattern', () => {
			expect(files.orchestrator).toMatch(/checkpoint-retry/);
		});
	});

	describe('Pipeline Wiring — state persistence between phases', () => {
		it('orchestrator should define WAVE_ID-based file organization', () => {
			expect(files.orchestrator).toMatch(/WAVE_ID/);
			expect(files.orchestrator).toMatch(/research\/_wave\/\{WAVE_ID\}/);
		});

		it('orchestrator should write phase state files for checkpoint recovery', () => {
			expect(files.orchestrator).toMatch(/phase-\d+-state\.json/);
		});

		it('state schema should include required fields', () => {
			expect(files.orchestrator).toMatch(/waveId/);
			expect(files.orchestrator).toMatch(/userSteering/);
			expect(files.orchestrator).toMatch(/inputs/);
			expect(files.orchestrator).toMatch(/outputs/);
			expect(files.orchestrator).toMatch(/timestamp/);
		});
	});

	describe('Pipeline Wiring — phase ordering is sequential', () => {
		it('Phase 0 should appear before Phase 1 in the orchestrator', () => {
			const p0 = files.orchestrator.search(/### Phase 0/);
			const p1 = files.orchestrator.search(/### Phase 1/);
			expect(p0).toBeGreaterThan(-1);
			expect(p1).toBeGreaterThan(p0);
		});

		it('Phase 1 should appear before Checkpoint 1', () => {
			const p1 = files.orchestrator.search(/### Phase 1/);
			const cp1 = files.orchestrator.search(/### Checkpoint 1/);
			expect(p1).toBeGreaterThan(-1);
			expect(cp1).toBeGreaterThan(p1);
		});

		it('Checkpoint 1 should appear before Phase 2', () => {
			const cp1 = files.orchestrator.search(/### Checkpoint 1/);
			const p2 = files.orchestrator.search(/### Phase 2/);
			expect(cp1).toBeGreaterThan(-1);
			expect(p2).toBeGreaterThan(cp1);
		});

		it('Phase 2 should appear before Checkpoint 2', () => {
			const p2 = files.orchestrator.search(/### Phase 2/);
			const cp2 = files.orchestrator.search(/### Checkpoint 2/);
			expect(p2).toBeGreaterThan(-1);
			expect(cp2).toBeGreaterThan(p2);
		});

		it('Checkpoint 2 should appear before Phase 3', () => {
			const cp2 = files.orchestrator.search(/### Checkpoint 2/);
			const p3 = files.orchestrator.search(/### Phase 3/);
			expect(cp2).toBeGreaterThan(-1);
			expect(p3).toBeGreaterThan(cp2);
		});

		it('Phase 3 should appear before Phase 4', () => {
			const p3 = files.orchestrator.search(/### Phase 3/);
			const p4 = files.orchestrator.search(/### Phase 4/);
			expect(p3).toBeGreaterThan(-1);
			expect(p4).toBeGreaterThan(p3);
		});

		it('Phase 4 should appear before Checkpoint 3', () => {
			const p4 = files.orchestrator.search(/### Phase 4/);
			const cp3 = files.orchestrator.search(/### Checkpoint 3/);
			expect(p4).toBeGreaterThan(-1);
			expect(cp3).toBeGreaterThan(p4);
		});

		it('Checkpoint 3 should appear before Phase 5', () => {
			const cp3 = files.orchestrator.search(/### Checkpoint 3/);
			const p5 = files.orchestrator.search(/### Phase 5/);
			expect(cp3).toBeGreaterThan(-1);
			expect(p5).toBeGreaterThan(cp3);
		});
	});

	describe('Input/Output contract consistency', () => {
		it('Phase 0 output (ContextBrief) should be Phase 1 input', () => {
			const phase1Section = files.orchestrator.split(/### Phase 1/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(phase1Section).toMatch(/ContextBrief|context-brief/i);
		});

		it('Phase 1 output (FINAL-REPORT) should be Phase 2 input', () => {
			const phase2Section = files.orchestrator.split(/### Phase 2/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(phase2Section).toMatch(/FINAL-REPORT/);
		});

		it('Phase 2 output (raw spec) should be Phase 3 input', () => {
			const phase3Section = files.orchestrator.split(/### Phase 3/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(phase3Section).toMatch(/spec|raw/i);
		});

		it('Phase 3 output (sealed spec) should be Phase 4 input', () => {
			const phase4Section = files.orchestrator.split(/### Phase 4/i)[1]?.split(/### (Phase|Checkpoint)/i)[0] ?? '';
			expect(phase4Section).toMatch(/sealed\s*spec/i);
		});
	});

	describe('Task 102 — wave-researcher github_repo tool', () => {
		const researcherPath = resolve(AGENTS_DIR, 'wave-researcher.agent.md');
		let researcherContent: string;

		beforeAll(() => {
			expect(existsSync(researcherPath), `Missing agent: ${researcherPath}`).toBe(true);
			researcherContent = readFileSync(researcherPath, 'utf-8');
		});

		it('frontmatter tools list should include githubRepo', () => {
			const fm = researcherContent.match(/^---\n([\s\S]*?)\n---/);
			expect(fm).not.toBeNull();
			expect(fm![1]).toContain('githubRepo');
		});

		it('body should contain github_repo usage instruction', () => {
			const body = researcherContent.replace(/^---\n[\s\S]*?\n---/, '');
			expect(body).toContain('github_repo');
		});

		it('wave-researcher.agent.md exists as canonical file in vscode-config-files', () => {
			expect(existsSync(researcherPath), `Missing agent: ${researcherPath}`).toBe(true);
			const stat = lstatSync(researcherPath);
			expect(stat.isFile()).toBe(true);
		});
	});
});
