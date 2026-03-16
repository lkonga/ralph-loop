import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeManager, HarvestPipeline, computeEntryHash, categorizeEntry, dedup, extract, categorize, KnowledgeGC } from '../src/knowledge';
import type { KnowledgeEntry, HarvestConfig, GCPolicy } from '../src/types';
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

describe('KnowledgeGC', () => {
	const defaultPolicy: GCPolicy = {
		triggerEveryNRuns: 10,
		maxEntries: 200,
		stalenessThreshold: 20,
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('shouldTrigger', () => {
		it('triggers when runCount is a multiple of triggerEveryNRuns', () => {
			const gc = new KnowledgeGC(defaultPolicy);
			expect(gc.shouldTrigger(10)).toBe(true);
			expect(gc.shouldTrigger(20)).toBe(true);
			expect(gc.shouldTrigger(30)).toBe(true);
		});

		it('does not trigger when runCount is not a multiple', () => {
			const gc = new KnowledgeGC(defaultPolicy);
			expect(gc.shouldTrigger(1)).toBe(false);
			expect(gc.shouldTrigger(5)).toBe(false);
			expect(gc.shouldTrigger(11)).toBe(false);
		});

		it('does not trigger on runCount 0', () => {
			const gc = new KnowledgeGC(defaultPolicy);
			expect(gc.shouldTrigger(0)).toBe(false);
		});
	});

	describe('recordHit', () => {
		it('increments hit count in meta for a given hash', () => {
			const gc = new KnowledgeGC(defaultPolicy);
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {};
			gc.recordHit(meta, 'abc123', 5);
			expect(meta['abc123'].hits).toBe(1);
			expect(meta['abc123'].lastHitRun).toBe(5);

			gc.recordHit(meta, 'abc123', 8);
			expect(meta['abc123'].hits).toBe(2);
			expect(meta['abc123'].lastHitRun).toBe(8);
		});
	});

	describe('collectGarbage', () => {
		it('archives stale entries (0 hits + age > stalenessThreshold)', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = [
				'- 2026-03-14: Stale entry one <!-- hash:aa0001 -->',
				'- 2026-03-14: Stale entry two <!-- hash:aa0002 -->',
				'- 2026-03-16: Fresh entry <!-- hash:bb0001 -->',
			].join('\n');
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				aa0001: { hits: 0, createdAtRun: 1, lastHitRun: 0 },
				aa0002: { hits: 0, createdAtRun: 2, lastHitRun: 0 },
				bb0001: { hits: 0, createdAtRun: 8, lastHitRun: 0 },
			};

			const result = gc.collectGarbage(knowledgeContent, meta, 10);
			expect(result.archived).toHaveLength(2);
			expect(result.kept).toHaveLength(1);
			expect(result.kept[0]).toContain('Fresh entry');
		});

		it('keeps entries with hits even if old', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = '- 2026-03-14: Active entry <!-- hash:ac0001 -->';
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				ac0001: { hits: 3, createdAtRun: 1, lastHitRun: 9 },
			};

			const result = gc.collectGarbage(knowledgeContent, meta, 10);
			expect(result.archived).toHaveLength(0);
			expect(result.kept).toHaveLength(1);
		});

		it('enforces maxEntries cap — archives lowest-scoring entries beyond cap', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, maxEntries: 2, stalenessThreshold: 100 });
			const lines = [
				'- 2026-03-14: Entry A <!-- hash:aaa001 -->',
				'- 2026-03-14: Entry B <!-- hash:bbb002 -->',
				'- 2026-03-14: Entry C <!-- hash:ccc003 -->',
				'- 2026-03-14: Entry D <!-- hash:ddd004 -->',
			].join('\n');
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				aaa001: { hits: 10, createdAtRun: 1, lastHitRun: 9 },
				bbb002: { hits: 0, createdAtRun: 1, lastHitRun: 0 },
				ccc003: { hits: 5, createdAtRun: 2, lastHitRun: 8 },
				ddd004: { hits: 1, createdAtRun: 3, lastHitRun: 5 },
			};

			const result = gc.collectGarbage(lines, meta, 10);
			expect(result.kept).toHaveLength(2);
			expect(result.archived.length).toBe(2);
			// The kept entries should be the highest-scoring: a (10 hits) and c (5 hits)
			expect(result.kept.join('\n')).toContain('Entry A');
			expect(result.kept.join('\n')).toContain('Entry C');
		});

		it('creates archive file content with header', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = '- 2026-03-14: Old entry <!-- hash:000aef -->';
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				'000aef': { hits: 0, createdAtRun: 1, lastHitRun: 0 },
			};

			const result = gc.collectGarbage(knowledgeContent, meta, 10);
			expect(result.archived).toHaveLength(1);
			expect(result.archived[0]).toContain('Old entry');
		});

		it('returns empty archived array when nothing to archive', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = '- 2026-03-16: Recent entry <!-- hash:eee001 -->';
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				eee001: { hits: 2, createdAtRun: 8, lastHitRun: 10 },
			};

			const result = gc.collectGarbage(knowledgeContent, meta, 10);
			expect(result.archived).toHaveLength(0);
			expect(result.kept).toHaveLength(1);
		});

		it('handles entries without meta by treating them as newly created at current run', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = '- 2026-03-16: No meta entry <!-- hash:def000 -->';
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {};

			const result = gc.collectGarbage(knowledgeContent, meta, 10);
			// Entry without meta should be treated as just created, so not stale
			expect(result.archived).toHaveLength(0);
			expect(result.kept).toHaveLength(1);
		});
	});

	describe('runGC (integration)', () => {
		it('writes kept entries back to knowledge file and archived to archive file', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = [
				'# Knowledge',
				'',
				'## Learnings',
				'',
				'- 2026-03-14: Stale learning <!-- hash:aaa111 -->',
				'- 2026-03-16: Fresh learning <!-- hash:bbb222 -->',
				'',
				'## Gaps',
				'',
			].join('\n');
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				aaa111: { hits: 0, createdAtRun: 1, lastHitRun: 0 },
				bbb222: { hits: 3, createdAtRun: 8, lastHitRun: 10 },
			};

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
				if (String(p).includes('knowledge-meta.json')) {
					return JSON.stringify(meta);
				}
				if (String(p).includes('knowledge-archive.md')) {
					return '# Knowledge Archive\n\n';
				}
				return knowledgeContent;
			});
			const writeCalls: Array<{ path: string; content: string }> = [];
			vi.mocked(fs.writeFileSync).mockImplementation((p: any, c: any) => {
				writeCalls.push({ path: String(p), content: String(c) });
			});

			gc.runGC('/workspace', 'knowledge.md', 10);

			// Should have written knowledge.md (kept) and knowledge-archive.md (archived)
			expect(writeCalls.length).toBeGreaterThanOrEqual(2);
			const knowledgeWrite = writeCalls.find(c => c.path.endsWith('knowledge.md') && !c.path.includes('archive') && !c.path.includes('meta'));
			const archiveWrite = writeCalls.find(c => c.path.includes('knowledge-archive.md'));
			expect(knowledgeWrite).toBeDefined();
			expect(archiveWrite).toBeDefined();
			expect(knowledgeWrite!.content).toContain('Fresh learning');
			expect(knowledgeWrite!.content).not.toContain('Stale learning');
			expect(archiveWrite!.content).toContain('Stale learning');
		});

		it('appends to existing archive file', () => {
			const gc = new KnowledgeGC({ ...defaultPolicy, stalenessThreshold: 5 });
			const knowledgeContent = '- 2026-03-14: Stale <!-- hash:ccc333 -->';
			const existingArchive = '# Knowledge Archive\n\n- 2026-03-10: Previously archived <!-- hash:ddd444 -->\n';
			const meta: Record<string, { hits: number; createdAtRun: number; lastHitRun: number }> = {
				ccc333: { hits: 0, createdAtRun: 1, lastHitRun: 0 },
			};

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
				if (String(p).includes('knowledge-meta.json')) {
					return JSON.stringify(meta);
				}
				if (String(p).includes('knowledge-archive.md')) {
					return existingArchive;
				}
				return knowledgeContent;
			});
			const writeCalls: Array<{ path: string; content: string }> = [];
			vi.mocked(fs.writeFileSync).mockImplementation((p: any, c: any) => {
				writeCalls.push({ path: String(p), content: String(c) });
			});

			gc.runGC('/workspace', 'knowledge.md', 10);

			const archiveWrite = writeCalls.find(c => c.path.includes('knowledge-archive.md'));
			expect(archiveWrite).toBeDefined();
			expect(archiveWrite!.content).toContain('Previously archived');
			expect(archiveWrite!.content).toContain('Stale');
		});
	});
});
