import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/prompt';

describe('buildPrompt', () => {
	it('includes task description', () => {
		const prompt = buildPrompt('Implement login', '- [ ] Implement login', '');
		expect(prompt).toContain('Implement login');
	});

	it('includes PRD content', () => {
		const prd = '- [ ] Task A\n- [ ] Task B';
		const prompt = buildPrompt('Task A', prd, '');
		expect(prompt).toContain('Task A');
		expect(prompt).toContain('Task B');
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
});
