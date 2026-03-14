import { describe, it, expect } from 'vitest';
import { buildPrompt, sanitizeTaskDescription } from '../src/prompt';
import { generateStopHookScript } from '../src/hookBridge';
import { sendReviewPrompt } from '../src/copilot';
import { parseReviewVerdict } from '../src/orchestrator';
import { DEFAULT_REVIEW_PROMPT_TEMPLATE } from '../src/types';
import type { ILogger } from '../src/types';

describe('buildPrompt', () => {
	it('includes task description', () => {
		const prompt = buildPrompt('Implement login', '- [ ] Implement login', '');
		expect(prompt).toContain('Implement login');
	});

	it('includes PRD content with only unchecked tasks', () => {
		const prd = '- [x] Done Task\n- [ ] Task A\n- [ ] Task B';
		const prompt = buildPrompt('Task A', prd, '');
		expect(prompt).toContain('Progress: 1/3 tasks completed');
		expect(prompt).toContain('- [ ] Task A');
		expect(prompt).toContain('- [ ] Task B');
		expect(prompt).not.toContain('- [x] Done Task');
	});

	it('includes progress when present', () => {
		const prompt = buildPrompt('Task', '- [ ] Task', 'Previous work done');
		expect(prompt).toContain('Previous work done');
		expect(prompt).toContain('progress.txt');
	});

	it('omits progress section when empty', () => {
		const prompt = buildPrompt('Task', '- [ ] Task', '');
		expect(prompt).not.toContain('## progress.txt:');
	});

	it('truncates task description to 5000 chars', () => {
		const longDesc = 'A'.repeat(6000);
		const prompt = buildPrompt(longDesc, '', '');
		// Task appears twice in prompt (task section + PRD instruction), each truncated to 5000
		const occurrences = prompt.split('A'.repeat(5000)).length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(1);
		// Original 6000-char string should NOT appear
		expect(prompt).not.toContain('A'.repeat(5001));
	});

	it('includes PRD update instructions', () => {
		const prompt = buildPrompt('Fix bug', '- [ ] Fix bug', '');
		expect(prompt).toContain('- [ ] Fix bug');
		expect(prompt).toContain('- [x] Fix bug');
		expect(prompt).toContain('MANDATORY');
		expect(prompt).toContain('Progress: 0/1 tasks completed');
	});

	it('truncates progress when exceeding maxProgressLines', () => {
		const lines = Array.from({ length: 30 }, (_, i) => `[line ${i + 1}] did something`);
		const progress = lines.join('\n');
		const prompt = buildPrompt('Task', '- [ ] Task', progress);
		expect(prompt).toContain('[...10 earlier entries omitted]');
		expect(prompt).toContain('[line 21] did something');
		expect(prompt).toContain('[line 30] did something');
		expect(prompt).not.toContain('[line 1] did something');
		expect(prompt).not.toContain('[line 10] did something');
	});

	it('includes ROLE & BEHAVIOR section', () => {
		const prompt = buildPrompt('Do something', '- [ ] Do something', '');
		expect(prompt).toContain('ROLE & BEHAVIOR');
		expect(prompt).toContain('You are an autonomous coding agent');
	});

	it('omits earlier entries when progress exceeds default maxProgressLines', () => {
		const lines = Array.from({ length: 30 }, (_, i) => `[entry ${i + 1}]`);
		const prompt = buildPrompt('Task', '- [ ] Task', lines.join('\n'));
		expect(prompt).toContain('[...10 earlier entries omitted]');
		expect(prompt).not.toContain('[entry 5]');
		expect(prompt).toContain('[entry 25]');
	});

	it('excludes checked PRD lines and includes unchecked ones', () => {
		const prd = '# PRD\n- [x] Already done\n- [x] Also done\n- [ ] Still todo\n- [ ] Another todo';
		const prompt = buildPrompt('Still todo', prd, '');
		expect(prompt).not.toContain('- [x] Already done');
		expect(prompt).not.toContain('- [x] Also done');
		expect(prompt).toContain('- [ ] Still todo');
		expect(prompt).toContain('- [ ] Another todo');
		expect(prompt).toContain('Progress: 2/4 tasks completed');
	});

	it('contains TDD GATE section with mandatory TDD instructions', () => {
		const prompt = buildPrompt('Fix bug', '- [ ] Fix bug', '');
		expect(prompt).toContain('TDD GATE');
		expect(prompt).toContain('Write a failing test FIRST');
	});
});

describe('generateStopHookScript', () => {
	it('always includes tsc and vitest checks in script source', () => {
		const script = generateStopHookScript('/tmp/PRD.md', '/tmp/progress.txt');
		expect(script).toContain('npx tsc --noEmit');
		expect(script).toContain('npx vitest run');
		expect(script).not.toContain('USE_VERIFICATION_GATE');
	});
});

const noopLogger: ILogger = { log() {}, warn() {}, error() {} };

describe('sendReviewPrompt', () => {
	it('uses default template when none provided', async () => {
		const result = await sendReviewPrompt('Fix login bug', 'same-session', undefined, noopLogger);
		expect(result).toContain('Fix login bug');
		expect(result).toContain('correctness');
		expect(result).toContain('APPROVED');
	});

	it('uses custom template with [TASK] substitution', async () => {
		const custom = 'Please review: [TASK]. Return APPROVED or NEEDS-RETRY.';
		const result = await sendReviewPrompt('Add tests', 'same-session', custom, noopLogger);
		expect(result).toBe('Please review: Add tests. Return APPROVED or NEEDS-RETRY.');
	});

	it('returns the review prompt string for same-session mode', async () => {
		const result = await sendReviewPrompt('Task X', 'same-session', undefined, noopLogger);
		expect(result).toBe(DEFAULT_REVIEW_PROMPT_TEMPLATE.replace('[TASK]', 'Task X'));
	});

	it('returns the review prompt string for new-session mode', async () => {
		const result = await sendReviewPrompt('Task Y', 'new-session', undefined, noopLogger);
		expect(result).toBe(DEFAULT_REVIEW_PROMPT_TEMPLATE.replace('[TASK]', 'Task Y'));
	});
});

describe('parseReviewVerdict', () => {
	it('returns approved for output containing APPROVED', () => {
		const verdict = parseReviewVerdict('All looks good. APPROVED. No issues found.');
		expect(verdict.outcome).toBe('approved');
		expect(verdict.summary).toContain('APPROVED');
	});

	it('returns needs-retry for output containing NEEDS-RETRY', () => {
		const verdict = parseReviewVerdict('Found issues. NEEDS-RETRY. Fix the following: missing validation.');
		expect(verdict.outcome).toBe('needs-retry');
		expect(verdict.summary).toContain('NEEDS-RETRY');
	});

	it('defaults to approved when neither keyword is found', () => {
		const verdict = parseReviewVerdict('The code looks fine overall.');
		expect(verdict.outcome).toBe('approved');
	});

	it('prefers NEEDS-RETRY when both keywords appear', () => {
		const verdict = parseReviewVerdict('APPROVED generally but NEEDS-RETRY for edge case.');
		expect(verdict.outcome).toBe('needs-retry');
	});
});

describe('sanitizeTaskDescription', () => {
	it('strips ASCII control characters except newline and tab', () => {
		const input = 'Hello\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F World';
		const result = sanitizeTaskDescription(input);
		expect(result).toBe('Hello World');
		expect(result).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
	});

	it('preserves newline and tab characters', () => {
		const input = 'Line1\nLine2\tTabbed';
		const result = sanitizeTaskDescription(input);
		expect(result).toBe('Line1\nLine2\tTabbed');
	});

	it('escapes triple backticks to prevent code fence injection', () => {
		const input = 'Some text ``` injected ``` end';
		const result = sanitizeTaskDescription(input);
		expect(result).toContain('\\`\\`\\`');
		expect(result).not.toContain('```');
	});

	it('truncates text exceeding 5000 characters', () => {
		const input = 'A'.repeat(6000);
		const result = sanitizeTaskDescription(input);
		expect(result.length).toBeLessThanOrEqual(5000 + '... [truncated]'.length);
		expect(result).toMatch(/\.\.\. \[truncated\]$/);
		expect(result).not.toContain('A'.repeat(5001));
	});

	it('does not truncate text at exactly 5000 characters', () => {
		const input = 'B'.repeat(5000);
		const result = sanitizeTaskDescription(input);
		expect(result).toBe('B'.repeat(5000));
	});

	it('strips <prompt> and </prompt> XML-style tags', () => {
		const input = 'Normal text <prompt>injected instructions</prompt> more text';
		const result = sanitizeTaskDescription(input);
		expect(result).not.toContain('<prompt>');
		expect(result).not.toContain('</prompt>');
		expect(result).toContain('Normal text');
		expect(result).toContain('more text');
	});

	it('leaves normal text unchanged', () => {
		const input = 'Fix the login bug in src/auth.ts and add tests.';
		const result = sanitizeTaskDescription(input);
		expect(result).toBe(input);
	});

	it('handles combined sanitization', () => {
		const input = '\x00Hello ``` <prompt>evil</prompt>\x01 world';
		const result = sanitizeTaskDescription(input);
		expect(result).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
		expect(result).not.toContain('```');
		expect(result).not.toContain('<prompt>');
		expect(result).not.toContain('</prompt>');
		expect(result).toContain('Hello');
		expect(result).toContain('world');
	});
});

describe('buildPrompt sanitization integration', () => {
	it('sanitizes the task description in the output', () => {
		const task = 'Fix bug\x00 with <prompt>injection</prompt> and ``` fences';
		const prompt = buildPrompt(task, '- [ ] Task', '');
		expect(prompt).not.toContain('\x00');
		expect(prompt).not.toContain('<prompt>');
		expect(prompt).not.toContain('</prompt>');
		expect(prompt).not.toContain('```\n fences');
	});
});
