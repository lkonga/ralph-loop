import { describe, it, expect } from 'vitest';
import { buildPrompt, sanitizeTaskDescription, buildReviewPrompt, renderTemplate, DEFAULT_PROMPT_TEMPLATE } from '../src/prompt';
import type { PromptVariables } from '../src/prompt';
import { generateStopHookScript } from '../src/hookBridge';
import { sendReviewPrompt, parseReviewVerdict } from '../src/copilot';
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

	it('includes task ID in YOUR TASK TO IMPLEMENT header when provided', () => {
		const prompt = buildPrompt('Fix bug', '- [ ] Fix bug', '', 20, undefined, undefined, undefined, 1, undefined, undefined, 'Task-003');
		expect(prompt).toContain('YOUR TASK TO IMPLEMENT — Task-003');
	});

	it('omits task ID from YOUR TASK TO IMPLEMENT header when not provided', () => {
		const prompt = buildPrompt('Fix bug', '- [ ] Fix bug', '');
		expect(prompt).toContain('YOUR TASK TO IMPLEMENT');
		expect(prompt).not.toContain('YOUR TASK TO IMPLEMENT —');
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

describe('buildReviewPrompt', () => {
	it('contains the structured review format template', () => {
		const prompt = buildReviewPrompt('Implement login feature', 'Task-001');
		expect(prompt).toContain('## Review: Task-{id}');
		expect(prompt).toContain('**Verdict**: APPROVED | NEEDS-RETRY');
		expect(prompt).toContain('### Acceptance Criteria Check');
		expect(prompt).toContain('### Issues Found (if NEEDS-RETRY)');
		expect(prompt).toContain('### Fix Instructions');
	});

	it('includes the task description and task ID', () => {
		const prompt = buildReviewPrompt('Add unit tests for parser', 'Task-042');
		expect(prompt).toContain('Add unit tests for parser');
		expect(prompt).toContain('Task-042');
	});

	it('includes reviewer instructions', () => {
		const prompt = buildReviewPrompt('Fix bug', 'Task-001');
		expect(prompt).toContain('You are a code reviewer');
		expect(prompt).toContain('Verify, don\'t fix');
		expect(prompt).toContain('APPROVED or NEEDS-RETRY');
	});
});

describe('parseReviewVerdict', () => {
	it('extracts APPROVED verdict', () => {
		const output = '## Review: Task-001 — Fix login\n**Verdict**: APPROVED\n### Acceptance Criteria Check\n- [x] Login works — verified';
		const verdict = parseReviewVerdict(output);
		expect(verdict.outcome).toBe('approved');
		expect(verdict.summary).toContain('APPROVED');
	});

	it('extracts NEEDS-RETRY verdict with issues', () => {
		const output = '## Review: Task-002 — Add tests\n**Verdict**: NEEDS-RETRY\n### Acceptance Criteria Check\n- [fail] Coverage — only 50%\n### Issues Found (if NEEDS-RETRY)\n1. **[Critical]**: Missing edge case test in parser.ts:42\n2. **[Minor]**: Unused import in utils.ts:5\n### Fix Instructions\n1. Add test for empty input';
		const verdict = parseReviewVerdict(output);
		expect(verdict.outcome).toBe('needs-retry');
		expect(verdict.issues).toBeDefined();
		expect(verdict.issues!.length).toBe(2);
		expect(verdict.issues![0]).toContain('Critical');
		expect(verdict.issues![1]).toContain('Minor');
	});

	it('defaults to approved on unparseable input', () => {
		const verdict = parseReviewVerdict('The code looks fine overall.');
		expect(verdict.outcome).toBe('approved');
	});

	it('handles case-insensitive verdict matching', () => {
		const verdict = parseReviewVerdict('**Verdict**: approved');
		expect(verdict.outcome).toBe('approved');
		const verdict2 = parseReviewVerdict('**Verdict**: needs-retry');
		expect(verdict2.outcome).toBe('needs-retry');
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

describe('progressive context trimming', () => {
	const manyProgressLines = Array.from({ length: 30 }, (_, i) => `[line ${i + 1}] did something`).join('\n');
	const prd = '- [x] Done A\n- [x] Done B\n- [ ] Task C\n- [ ] Task D\n- [ ] Task E';
	const learnings = ['learning 1', 'learning 2', 'learning 3', 'learning 4', 'learning 5',
		'learning 6', 'learning 7', 'learning 8', 'learning 9', 'learning 10'];

	it('iteration 1 produces full context (all unchecked tasks, full learnings, full progress)', () => {
		const prompt = buildPrompt('Task C', prd, manyProgressLines, 20, undefined, undefined, learnings, 1);
		// Full tier: all unchecked PRD tasks
		expect(prompt).toContain('- [ ] Task C');
		expect(prompt).toContain('- [ ] Task D');
		expect(prompt).toContain('- [ ] Task E');
		// Full tier: all 10 learnings present
		for (const l of learnings) {
			expect(prompt).toContain(l);
		}
		// Full tier: default maxProgressLines (20)
		expect(prompt).toContain('[...10 earlier entries omitted]');
		expect(prompt).toContain('[line 11] did something');
		// No trimming notes
		expect(prompt).not.toContain('[context trimmed for iteration efficiency]');
		expect(prompt).not.toContain('[minimal context mode');
	});

	it('iteration 5 produces abbreviated context (10 progress lines, 8 learnings, trimming note)', () => {
		const prompt = buildPrompt('Task C', prd, manyProgressLines, 20, undefined, undefined, learnings, 5);
		// Abbreviated tier: still shows all unchecked PRD tasks
		expect(prompt).toContain('- [ ] Task C');
		expect(prompt).toContain('- [ ] Task D');
		expect(prompt).toContain('- [ ] Task E');
		// Abbreviated tier: only first 8 learnings
		expect(prompt).toContain('learning 1');
		expect(prompt).toContain('learning 8');
		expect(prompt).not.toContain('learning 9');
		expect(prompt).not.toContain('learning 10');
		// Abbreviated tier: progress reduced to 10 lines
		expect(prompt).toContain('[...20 earlier entries omitted]');
		expect(prompt).toContain('[line 21] did something');
		expect(prompt).not.toContain('[line 20] did something');
		// Abbreviated trimming note
		expect(prompt).toContain('[context trimmed for iteration efficiency]');
		expect(prompt).not.toContain('[minimal context mode');
	});

	it('iteration 10 produces minimal context (only current task, no learnings, 5 progress lines)', () => {
		const prompt = buildPrompt('Task C', prd, manyProgressLines, 20, undefined, undefined, learnings, 10);
		// Minimal tier: only current task shown in PRD, not other unchecked
		expect(prompt).toContain('- [ ] Task C');
		expect(prompt).not.toContain('- [ ] Task D');
		expect(prompt).not.toContain('- [ ] Task E');
		// Minimal tier: no learnings
		expect(prompt).not.toContain('PRIOR LEARNINGS');
		for (const l of learnings) {
			expect(prompt).not.toContain(l);
		}
		// Minimal tier: progress reduced to 5 lines
		expect(prompt).toContain('[...25 earlier entries omitted]');
		expect(prompt).toContain('[line 26] did something');
		expect(prompt).not.toContain('[line 25] did something');
		// Minimal trimming note
		expect(prompt).toContain('[minimal context mode');
	});

	it('custom tier boundaries are respected', () => {
		const trimming = { fullUntil: 2, abbreviatedUntil: 5 };
		// Iteration 2 should be full (within fullUntil=2)
		const promptFull = buildPrompt('Task C', prd, manyProgressLines, 20, undefined, undefined, learnings, 2, trimming);
		expect(promptFull).not.toContain('[context trimmed');
		expect(promptFull).not.toContain('[minimal context mode');
		for (const l of learnings) {
			expect(promptFull).toContain(l);
		}

		// Iteration 3 should be abbreviated (fullUntil=2, abbreviatedUntil=5)
		const promptAbbr = buildPrompt('Task C', prd, manyProgressLines, 20, undefined, undefined, learnings, 3, trimming);
		expect(promptAbbr).toContain('[context trimmed for iteration efficiency]');
		expect(promptAbbr).not.toContain('[minimal context mode');

		// Iteration 6 should be minimal (above abbreviatedUntil=5)
		const promptMin = buildPrompt('Task C', prd, manyProgressLines, 20, undefined, undefined, learnings, 6, trimming);
		expect(promptMin).toContain('[minimal context mode');
		expect(promptMin).not.toContain('PRIOR LEARNINGS');
	});
});

describe('buildPrompt with operatorContext', () => {
	it('includes OPERATOR CONTEXT section when operatorContext is provided', () => {
		const prompt = buildPrompt('Task A', '- [ ] Task A', '', 20, undefined, undefined, ['some learning'], 1, undefined, 'The bug is in utils/parser.ts line 42');
		expect(prompt).toContain('OPERATOR CONTEXT (injected mid-loop)');
		expect(prompt).toContain('The bug is in utils/parser.ts line 42');
	});

	it('places OPERATOR CONTEXT section after PRIOR LEARNINGS', () => {
		const prompt = buildPrompt('Task A', '- [ ] Task A', '', 20, undefined, undefined, ['a learning'], 1, undefined, 'Extra context here');
		const learningsIdx = prompt.indexOf('PRIOR LEARNINGS');
		const operatorIdx = prompt.indexOf('OPERATOR CONTEXT (injected mid-loop)');
		expect(learningsIdx).toBeGreaterThan(-1);
		expect(operatorIdx).toBeGreaterThan(-1);
		expect(operatorIdx).toBeGreaterThan(learningsIdx);
	});

	it('does not include OPERATOR CONTEXT section when operatorContext is undefined', () => {
		const prompt = buildPrompt('Task A', '- [ ] Task A', '', 20, undefined, undefined, undefined, 1, undefined, undefined);
		expect(prompt).not.toContain('OPERATOR CONTEXT');
	});

	it('does not include OPERATOR CONTEXT section when operatorContext is empty string', () => {
		const prompt = buildPrompt('Task A', '- [ ] Task A', '', 20, undefined, undefined, undefined, 1, undefined, '');
		expect(prompt).not.toContain('OPERATOR CONTEXT');
	});
});

describe('renderTemplate', () => {
	it('replaces all variables in a template', () => {
		const template = '## Task: {{taskId}}\n{{task}}\nPRD: {{prd}}\nProgress: {{progress}}\nLearnings: {{learnings}}\nWorkspace: {{workspace}}\nIteration: {{iterationNumber}}';
		const vars: PromptVariables = {
			task: 'Implement login',
			prd: '- [ ] Login feature',
			progress: 'Started work',
			learnings: 'Use bcrypt',
			workspace: '/home/project',
			taskId: 'Task-007',
			iterationNumber: 3,
		};
		const result = renderTemplate(template, vars);
		expect(result).toBe('## Task: Task-007\nImplement login\nPRD: - [ ] Login feature\nProgress: Started work\nLearnings: Use bcrypt\nWorkspace: /home/project\nIteration: 3');
	});

	it('leaves unknown placeholders as-is', () => {
		const template = '{{task}} and {{unknown}} placeholder';
		const vars: PromptVariables = {
			task: 'Fix bug',
			prd: '',
			progress: '',
			learnings: '',
			workspace: '',
			taskId: '',
			iterationNumber: 1,
		};
		const result = renderTemplate(template, vars);
		expect(result).toBe('Fix bug and {{unknown}} placeholder');
	});

	it('default template produces expected output', () => {
		const vars: PromptVariables = {
			task: 'Add tests',
			prd: 'Progress: 1/3 tasks completed',
			progress: 'Previous work done',
			learnings: '',
			workspace: '/ws',
			taskId: 'Task-042',
			iterationNumber: 1,
		};
		const result = renderTemplate(DEFAULT_PROMPT_TEMPLATE, vars);
		expect(result).toContain('## Task: Task-042');
		expect(result).toContain('Add tests');
		expect(result).toContain('## Current PRD State');
		expect(result).toContain('Progress: 1/3 tasks completed');
		expect(result).toContain('## Recent Progress');
		expect(result).toContain('Previous work done');
	});
});

describe('buildPrompt with custom promptTemplate', () => {
	it('uses custom template for task-specific portion while keeping built-in sections', () => {
		const customTemplate = '## My Custom Task\n{{task}}\n## My PRD\n{{prd}}';
		const prompt = buildPrompt('Fix the bug', '- [ ] Fix the bug', 'some progress', 20, undefined, undefined, undefined, 1, undefined, undefined, 'Task-001', customTemplate);
		// Built-in sections are always present
		expect(prompt).toContain('ROLE & BEHAVIOR');
		expect(prompt).toContain('TDD GATE');
		expect(prompt).toContain('You are an autonomous coding agent');
		// Custom template content is present
		expect(prompt).toContain('## My Custom Task');
		expect(prompt).toContain('Fix the bug');
		expect(prompt).toContain('## My PRD');
	});
});
