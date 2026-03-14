import { describe, it, expect } from 'vitest';
import { generatePreCompactHookScript } from '../src/hookBridge';
import type { PreCompactBehavior } from '../src/types';
import { DEFAULT_PRE_COMPACT_BEHAVIOR } from '../src/types';

describe('generatePreCompactHookScript', () => {
	it('generates a valid Node.js script string', () => {
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', DEFAULT_PRE_COMPACT_BEHAVIOR);
		expect(typeof script).toBe('string');
		expect(script).toContain('#!/usr/bin/env node');
		expect(script).toContain('use strict');
	});

	it('includes progress.txt reading logic', () => {
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', DEFAULT_PRE_COMPACT_BEHAVIOR);
		expect(script).toContain('progress.txt');
		expect(script).toContain('readFileSync');
	});

	it('includes git diff logic when injectGitDiff is true', () => {
		const config: PreCompactBehavior = { ...DEFAULT_PRE_COMPACT_BEHAVIOR, injectGitDiff: true };
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', config);
		expect(script).toContain('git diff --stat');
		expect(script).toContain('git diff --name-only');
	});

	it('omits git diff logic when injectGitDiff is false', () => {
		const config: PreCompactBehavior = { ...DEFAULT_PRE_COMPACT_BEHAVIOR, injectGitDiff: false };
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', config);
		expect(script).not.toContain('git diff');
	});

	it('respects summaryMaxLines', () => {
		const config: PreCompactBehavior = { ...DEFAULT_PRE_COMPACT_BEHAVIOR, summaryMaxLines: 25 };
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', config);
		expect(script).toContain('25');
	});

	it('outputs JSON with session resumption context structure', () => {
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', DEFAULT_PRE_COMPACT_BEHAVIOR);
		expect(script).toContain('=== SESSION RESUMPTION CONTEXT ===');
		expect(script).toContain('## Progress So Far');
		expect(script).toContain('## Recent File Changes');
		expect(script).toContain('## Current Task');
		expect(script).toContain('=== END ===');
	});

	it('outputs HookResult with action continue', () => {
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', DEFAULT_PRE_COMPACT_BEHAVIOR);
		expect(script).toContain("'continue'");
		expect(script).toContain('additionalContext');
	});

	it('includes unchecked task extraction from PRD', () => {
		const script = generatePreCompactHookScript('/workspace/PRD.md', '/workspace/progress.txt', DEFAULT_PRE_COMPACT_BEHAVIOR);
		expect(script).toContain('unchecked');
		expect(script).toContain('readFileSync(PRD_PATH');
	});
});
