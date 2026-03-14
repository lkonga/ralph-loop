import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/prompt';
import { generateStopHookScript } from '../src/hookBridge';

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
