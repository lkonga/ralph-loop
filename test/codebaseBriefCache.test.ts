import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import {
	isCacheValid,
	readCachedBrief,
	writeCachedBrief,
	codebaseBriefCacheSource,
	CACHE_PATH,
} from '../src/codebaseBriefCache';

vi.mock('fs');
vi.mock('child_process');

const mockFs = vi.mocked(fs);
const mockExec = vi.mocked(childProcess.execSync);

describe('Codebase Brief Cache (Task 35)', () => {
	const workspace = '/tmp/test-workspace';
	const cachePath = path.join(workspace, CACHE_PATH);

	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('CACHE_PATH', () => {
		it('should be .ralph/codebase-brief.md', () => {
			expect(CACHE_PATH).toBe('.ralph/codebase-brief.md');
		});
	});

	describe('isCacheValid', () => {
		it('returns false when cache file does not exist', () => {
			mockFs.existsSync.mockReturnValue(false);
			expect(isCacheValid(workspace)).toBe(false);
		});

		it('returns false when git diff --stat HEAD~5 shows significant changes', () => {
			mockFs.existsSync.mockReturnValue(true);
			// Significant changes: many files changed
			mockExec.mockReturnValue(
				' src/a.ts | 10 ++++\n src/b.ts | 20 +++++\n src/c.ts | 5 +++\n src/d.ts | 15 +++++\n src/e.ts | 8 ++\n 5 files changed, 58 insertions(+)\n'
			);
			expect(isCacheValid(workspace)).toBe(false);
		});

		it('returns true when git diff --stat HEAD~5 shows no significant changes', () => {
			mockFs.existsSync.mockReturnValue(true);
			// Minor changes: few files
			mockExec.mockReturnValue(
				' README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n'
			);
			expect(isCacheValid(workspace)).toBe(true);
		});

		it('returns true when git diff --stat HEAD~5 is empty (no changes)', () => {
			mockFs.existsSync.mockReturnValue(true);
			mockExec.mockReturnValue('');
			expect(isCacheValid(workspace)).toBe(true);
		});

		it('returns false when git command fails (e.g., less than 5 commits)', () => {
			mockFs.existsSync.mockReturnValue(true);
			mockExec.mockImplementation(() => { throw new Error('fatal: bad revision'); });
			expect(isCacheValid(workspace)).toBe(false);
		});
	});

	describe('readCachedBrief', () => {
		it('returns cached content when file exists', () => {
			mockFs.readFileSync.mockReturnValue('## ContextBrief\ncached content');
			const result = readCachedBrief(workspace);
			expect(result).toBe('## ContextBrief\ncached content');
			expect(mockFs.readFileSync).toHaveBeenCalledWith(cachePath, 'utf-8');
		});

		it('returns empty string when file does not exist', () => {
			mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
			const result = readCachedBrief(workspace);
			expect(result).toBe('');
		});
	});

	describe('writeCachedBrief', () => {
		it('writes content to .ralph/codebase-brief.md', () => {
			mockFs.existsSync.mockReturnValue(true);
			writeCachedBrief(workspace, '## ContextBrief\nnew content');
			expect(mockFs.writeFileSync).toHaveBeenCalledWith(
				cachePath,
				'## ContextBrief\nnew content',
				'utf-8'
			);
		});

		it('creates .ralph directory if it does not exist', () => {
			mockFs.existsSync.mockReturnValue(false);
			writeCachedBrief(workspace, 'content');
			expect(mockFs.mkdirSync).toHaveBeenCalledWith(
				path.join(workspace, '.ralph'),
				{ recursive: true }
			);
			expect(mockFs.writeFileSync).toHaveBeenCalled();
		});
	});

	describe('codebaseBriefCacheSource', () => {
		it('returns a ContextSource function', () => {
			expect(typeof codebaseBriefCacheSource).toBe('function');
		});

		it('returns cached content when cache is valid', () => {
			// Cache file exists
			mockFs.existsSync.mockReturnValue(true);
			// No significant changes
			mockExec.mockReturnValue('');
			// Cache content
			mockFs.readFileSync.mockReturnValue('## Cached Brief');

			const snippet = codebaseBriefCacheSource(workspace);
			expect(snippet.source).toBe('codebase-brief-cache');
			expect(snippet.content).toBe('## Cached Brief');
		});

		it('returns empty content when cache is invalid', () => {
			// Cache file does not exist
			mockFs.existsSync.mockReturnValue(false);

			const snippet = codebaseBriefCacheSource(workspace);
			expect(snippet.source).toBe('codebase-brief-cache');
			expect(snippet.content).toBe('');
		});
	});

	describe('significance threshold', () => {
		it('considers 4+ source files changed as significant', () => {
			mockFs.existsSync.mockReturnValue(true);
			mockExec.mockReturnValue(
				' src/a.ts | 10 ++++\n src/b.ts | 20 +++++\n src/c.ts | 5 +++\n src/d.ts | 15 +++++\n 4 files changed, 50 insertions(+)\n'
			);
			expect(isCacheValid(workspace)).toBe(false);
		});

		it('considers 3 or fewer files changed as not significant', () => {
			mockFs.existsSync.mockReturnValue(true);
			mockExec.mockReturnValue(
				' src/a.ts | 2 +-\n src/b.ts | 3 ++-\n docs/x.md | 1 +\n 3 files changed, 4 insertions(+), 2 deletions(-)\n'
			);
			expect(isCacheValid(workspace)).toBe(true);
		});
	});
});
