import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeManager } from '../src/knowledge';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('KnowledgeManager', () => {
	let km: KnowledgeManager;

	beforeEach(() => {
		vi.restoreAllMocks();
		km = new KnowledgeManager();
	});

	describe('extractLearnings', () => {
		it('finds lines containing [LEARNING] tag', () => {
			const output = `some output
[LEARNING] Always run tests before committing
more output
[LEARNING] Use vitest for TypeScript projects`;
			const result = km.extractLearnings(output);
			expect(result).toEqual([
				'Always run tests before committing',
				'Use vitest for TypeScript projects',
			]);
		});

		it('is case-insensitive', () => {
			const output = '[learning] lower case\n[Learning] mixed case\n[LEARNING] upper case';
			const result = km.extractLearnings(output);
			expect(result).toEqual(['lower case', 'mixed case', 'upper case']);
		});

		it('returns empty array for empty input', () => {
			expect(km.extractLearnings('')).toEqual([]);
		});

		it('returns empty array when no tags present', () => {
			expect(km.extractLearnings('just some plain text\nwith no tags')).toEqual([]);
		});
	});

	describe('extractGaps', () => {
		it('finds lines containing [GAP] tag', () => {
			const output = `output
[GAP] Missing error handling for edge case
more text
[GAP] No tests for concurrent access`;
			const result = km.extractGaps(output);
			expect(result).toEqual([
				'Missing error handling for edge case',
				'No tests for concurrent access',
			]);
		});

		it('is case-insensitive', () => {
			const output = '[gap] lower\n[Gap] mixed\n[GAP] upper';
			const result = km.extractGaps(output);
			expect(result).toEqual(['lower', 'mixed', 'upper']);
		});

		it('returns empty array for empty input', () => {
			expect(km.extractGaps('')).toEqual([]);
		});
	});

	describe('persist', () => {
		it('creates file with headers if missing', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const writeCalls: { path: string; content: string }[] = [];
			vi.mocked(fs.writeFileSync).mockImplementation((p: any, c: any) => {
				writeCalls.push({ path: String(p), content: String(c) });
			});
			vi.mocked(fs.appendFileSync).mockImplementation(() => {});

			km.persist('/workspace', ['learning 1'], ['gap 1']);

			expect(fs.writeFileSync).toHaveBeenCalled();
			const created = writeCalls[0].content;
			expect(created).toContain('## Learnings');
			expect(created).toContain('## Gaps');
		});

		it('appends timestamped entries to existing file', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue('# Knowledge\n\n## Learnings\n\n## Gaps\n');
			const appendCalls: string[] = [];
			vi.mocked(fs.appendFileSync).mockImplementation((_p: any, c: any) => {
				appendCalls.push(String(c));
			});

			km.persist('/workspace', ['learned something'], ['gap found']);

			expect(fs.appendFileSync).toHaveBeenCalled();
			const appended = appendCalls.join('');
			expect(appended).toContain('learned something');
			expect(appended).toContain('gap found');
		});

		it('does nothing when both arrays are empty', () => {
			km.persist('/workspace', [], []);
			expect(fs.appendFileSync).not.toHaveBeenCalled();
			expect(fs.writeFileSync).not.toHaveBeenCalled();
		});
	});

	describe('getRelevantLearnings', () => {
		it('filters learnings by keyword overlap', () => {
			const fileContent = `# Knowledge

## Learnings

- 2026-03-14: Always validate TypeScript types before committing code
- 2026-03-14: Use vitest runner for testing React components
- 2026-03-14: Database migrations need careful review

## Gaps
`;
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

			const result = km.getRelevantLearnings('/workspace', 'validate TypeScript code before deploying');
			expect(result.length).toBeGreaterThan(0);
			expect(result[0]).toContain('validate TypeScript types before committing code');
		});

		it('returns up to maxInjectLines most recent matches', () => {
			const learnings = Array.from({ length: 20 }, (_, i) =>
				`- 2026-03-14: Learning about TypeScript testing number ${i + 1}`
			).join('\n');
			const fileContent = `# Knowledge\n\n## Learnings\n\n${learnings}\n\n## Gaps\n`;
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

			const km5 = new KnowledgeManager('knowledge.md', 5);
			const result = km5.getRelevantLearnings('/workspace', 'TypeScript testing approach');
			expect(result.length).toBeLessThanOrEqual(5);
		});

		it('returns empty array when file does not exist', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const result = km.getRelevantLearnings('/workspace', 'anything');
			expect(result).toEqual([]);
		});

		it('returns empty array for empty task description', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue('## Learnings\n- 2026: some learning\n## Gaps\n');
			const result = km.getRelevantLearnings('/workspace', '');
			expect(result).toEqual([]);
		});

		it('requires ≥2 keyword matches from words ≥4 chars', () => {
			const fileContent = `# Knowledge\n\n## Learnings\n\n- 2026-03-14: TypeScript compiler checks are important\n- 2026-03-14: Python scripts need linting\n\n## Gaps\n`;
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

			// "TypeScript" matches but only 1 word ≥4 chars matches → should not match "Python scripts need linting"
			const result = km.getRelevantLearnings('/workspace', 'TypeScript compiler validation');
			expect(result.length).toBe(1);
			expect(result[0]).toContain('TypeScript compiler');
		});
	});

	describe('constructor defaults', () => {
		it('uses default knowledgePath and maxInjectLines', () => {
			const manager = new KnowledgeManager();
			// Verify defaults by testing behavior
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const result = manager.getRelevantLearnings('/workspace', 'test');
			expect(result).toEqual([]);
		});
	});
});
