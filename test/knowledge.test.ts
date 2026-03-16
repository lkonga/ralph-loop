import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeManager, HarvestPipeline, computeEntryHash, categorizeEntry, dedup, extract, categorize } from '../src/knowledge';
import type { KnowledgeEntry, HarvestConfig } from '../src/types';
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

describe('computeEntryHash', () => {
	it('produces consistent hash for same content', () => {
		const hash1 = computeEntryHash('some content');
		const hash2 = computeEntryHash('some content');
		expect(hash1).toBe(hash2);
	});

	it('normalizes by lowercasing and trimming', () => {
		const hash1 = computeEntryHash('  Some Content  ');
		const hash2 = computeEntryHash('some content');
		expect(hash1).toBe(hash2);
	});

	it('returns a hex string', () => {
		const hash = computeEntryHash('test');
		expect(hash).toMatch(/^[0-9a-f]+$/);
	});
});

describe('categorizeEntry', () => {
	it('classifies "fix"/"resolve"/"error" as fix', () => {
		expect(categorizeEntry('Fix the broken build')).toBe('fix');
		expect(categorizeEntry('Resolve the merge conflict')).toBe('fix');
		expect(categorizeEntry('Error handling is critical')).toBe('fix');
	});

	it('classifies "pattern"/"approach"/"strategy" as pattern', () => {
		expect(categorizeEntry('Use the singleton pattern')).toBe('pattern');
		expect(categorizeEntry('An approach for testing')).toBe('pattern');
		expect(categorizeEntry('Strategy for deployment')).toBe('pattern');
	});

	it('classifies [GAP] entries as gap', () => {
		expect(categorizeEntry('[GAP] Missing test coverage')).toBe('gap');
	});

	it('classifies remainder as context', () => {
		expect(categorizeEntry('TypeScript uses type inference')).toBe('context');
	});
});

describe('extract stage', () => {
	it('extracts learnings and gaps into KnowledgeEntry array', () => {
		const output = '[LEARNING] Always test first\n[GAP] Missing docs\nPlain line';
		const entries = extract(output, 'task-1');
		expect(entries).toHaveLength(2);
		expect(entries[0].content).toBe('Always test first');
		expect(entries[0].taskId).toBe('task-1');
		expect(entries[0].hash).toBeTruthy();
		expect(entries[1].content).toBe('Missing docs');
	});

	it('returns empty for no tagged lines', () => {
		expect(extract('plain text only', 'task-1')).toEqual([]);
	});
});

describe('dedup stage', () => {
	it('removes entries whose hash exists in knowledge file', () => {
		const entries: KnowledgeEntry[] = [
			{ content: 'new learning', category: 'context', timestamp: '2026-03-16', taskId: 'task-1', hash: 'abc123' },
			{ content: 'existing learning', category: 'context', timestamp: '2026-03-16', taskId: 'task-1', hash: 'def456' },
		];
		const existingContent = '- 2026: existing learning <!-- hash:def456 -->\n';
		const result = dedup(entries, existingContent);
		expect(result).toHaveLength(1);
		expect(result[0].hash).toBe('abc123');
	});

	it('removes duplicates within the batch itself', () => {
		const entries: KnowledgeEntry[] = [
			{ content: 'same thing', category: 'context', timestamp: '2026-03-16', taskId: 'task-1', hash: 'aaa' },
			{ content: 'same thing', category: 'context', timestamp: '2026-03-16', taskId: 'task-1', hash: 'aaa' },
		];
		const result = dedup(entries, '');
		expect(result).toHaveLength(1);
	});

	it('passes all entries when no existing hashes', () => {
		const entries: KnowledgeEntry[] = [
			{ content: 'new one', category: 'context', timestamp: '2026-03-16', taskId: 'task-1', hash: 'xxx' },
		];
		const result = dedup(entries, '');
		expect(result).toHaveLength(1);
	});
});

describe('categorize stage', () => {
	it('assigns categories based on content keywords', () => {
		const entries: KnowledgeEntry[] = [
			{ content: 'Fix the broken test', category: 'context', timestamp: '2026-03-16', taskId: 't1', hash: 'a' },
			{ content: 'Use strategy pattern', category: 'context', timestamp: '2026-03-16', taskId: 't1', hash: 'b' },
			{ content: '[GAP] Missing coverage', category: 'context', timestamp: '2026-03-16', taskId: 't1', hash: 'c' },
			{ content: 'TypeScript inference', category: 'context', timestamp: '2026-03-16', taskId: 't1', hash: 'd' },
		];
		const result = categorize(entries);
		expect(result[0].category).toBe('fix');
		expect(result[1].category).toBe('pattern');
		expect(result[2].category).toBe('gap');
		expect(result[3].category).toBe('context');
	});
});

describe('HarvestPipeline', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('chains stages in order: extract→dedup→categorize→persist', () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(fs.writeFileSync).mockImplementation(() => {});
		vi.mocked(fs.appendFileSync).mockImplementation(() => {});

		const pipeline = new HarvestPipeline({ stages: ['extract', 'dedup', 'categorize', 'persist'] });
		const output = '[LEARNING] Fix the broken build\n[GAP] Missing error handling';
		const result = pipeline.run(output, 'task-1', '/workspace', 'knowledge.md');

		expect(result).toHaveLength(2);
		expect(result[0].category).toBe('fix');
		expect(result[1].category).toBe('gap');
	});

	it('persists entries with hash annotations', () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue('# Knowledge\n\n## Learnings\n\n## Gaps\n');
		const appendCalls: string[] = [];
		vi.mocked(fs.appendFileSync).mockImplementation((_p: any, c: any) => {
			appendCalls.push(String(c));
		});

		const pipeline = new HarvestPipeline({ stages: ['extract', 'dedup', 'categorize', 'persist'] });
		pipeline.run('[LEARNING] Always test first', 'task-1', '/workspace', 'knowledge.md');

		const appended = appendCalls.join('');
		expect(appended).toContain('Always test first');
		expect(appended).toMatch(/<!-- hash:[0-9a-f]+ -->/);
	});

	it('dedup skips entries already in knowledge file', () => {
		const existingHash = computeEntryHash('Always test first');
		const existingContent = `# Knowledge\n\n## Learnings\n\n- 2026-03-16: Always test first <!-- hash:${existingHash} -->\n\n## Gaps\n`;
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(existingContent);
		vi.mocked(fs.appendFileSync).mockImplementation(() => {});

		const pipeline = new HarvestPipeline({ stages: ['extract', 'dedup', 'categorize', 'persist'] });
		const result = pipeline.run('[LEARNING] Always test first', 'task-1', '/workspace', 'knowledge.md');

		expect(result).toHaveLength(0);
	});

	it('produces no output for empty input', () => {
		const pipeline = new HarvestPipeline({ stages: ['extract', 'dedup', 'categorize', 'persist'] });
		const result = pipeline.run('', 'task-1', '/workspace', 'knowledge.md');
		expect(result).toEqual([]);
	});

	it('respects stage toggle — skips dedup when not in stages', () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(fs.writeFileSync).mockImplementation(() => {});
		vi.mocked(fs.appendFileSync).mockImplementation(() => {});

		const pipeline = new HarvestPipeline({ stages: ['extract', 'categorize', 'persist'] });
		const output = '[LEARNING] Fix the issue\n[LEARNING] Fix the issue';
		const result = pipeline.run(output, 'task-1', '/workspace', 'knowledge.md');

		// Without dedup, both duplicate entries survive
		expect(result).toHaveLength(2);
	});

	it('skips persist when not in stages', () => {
		const pipeline = new HarvestPipeline({ stages: ['extract', 'categorize'] });
		const result = pipeline.run('[LEARNING] Something new', 'task-1', '/workspace', 'knowledge.md');

		expect(result).toHaveLength(1);
		expect(fs.appendFileSync).not.toHaveBeenCalled();
		expect(fs.writeFileSync).not.toHaveBeenCalled();
	});
});
