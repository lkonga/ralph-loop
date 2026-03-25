import { describe, expect, it } from 'vitest';
import {
	buildStagnationQuestions,
	buildCheckpointQuestions,
	buildSessionEndQuestions,
	parseStagnationAnswer,
	parseCheckpointAnswer,
	parseSessionEndAnswer,
} from '../src/checkpointQuestions';

describe('checkpointQuestions', () => {
	describe('buildStagnationQuestions', () => {
		it('includes task ID and fail count', () => {
			const qs = buildStagnationQuestions('Task-42', 5);
			expect(qs).toHaveLength(1);
			expect(qs[0].question).toContain('Task-42');
			expect(qs[0].question).toContain('5');
			expect(qs[0].header).toBe('stagnation-recovery');
		});

		it('has 5 options', () => {
			const qs = buildStagnationQuestions('Task-1', 3);
			expect(qs[0].options).toHaveLength(5);
		});

		it('recommends retry by default', () => {
			const qs = buildStagnationQuestions('Task-1', 3);
			const recommended = qs[0].options.find(o => o.recommended);
			expect(recommended?.label).toContain('Retry');
		});
	});

	describe('buildCheckpointQuestions', () => {
		it('includes task ID and description', () => {
			const qs = buildCheckpointQuestions('Task-10', 'Verify integration');
			expect(qs[0].question).toContain('Task-10');
			expect(qs[0].question).toContain('Verify integration');
			expect(qs[0].header).toBe('checkpoint-decision');
		});

		it('has 4 options', () => {
			const qs = buildCheckpointQuestions('Task-1', 'desc');
			expect(qs[0].options).toHaveLength(4);
		});
	});

	describe('buildSessionEndQuestions', () => {
		it('includes completion counts', () => {
			const qs = buildSessionEndQuestions(15, 20);
			expect(qs[0].question).toContain('15/20');
			expect(qs[0].header).toBe('session-end-action');
		});

		it('recommends new session when tasks remain', () => {
			const qs = buildSessionEndQuestions(10, 20);
			const newSession = qs[0].options.find(o => o.label.includes('new session'));
			expect(newSession?.recommended).toBe(true);
		});

		it('recommends done when all tasks complete', () => {
			const qs = buildSessionEndQuestions(20, 20);
			const done = qs[0].options.find(o => o.label === 'Done');
			expect(done?.recommended).toBe(true);
		});
	});

	describe('parseStagnationAnswer', () => {
		it('parses decompose', () => expect(parseStagnationAnswer('Decompose into sub-tasks')).toBe('decompose'));
		it('parses skip', () => expect(parseStagnationAnswer('Skip this task')).toBe('skip'));
		it('parses debug', () => expect(parseStagnationAnswer('Debug interactively')).toBe('debug'));
		it('parses change strategy', () => expect(parseStagnationAnswer('Change strategy')).toBe('change-strategy'));
		it('defaults to retry', () => expect(parseStagnationAnswer('Retry with different approach')).toBe('retry'));
		it('defaults unknown to retry', () => expect(parseStagnationAnswer('something else')).toBe('retry'));
	});

	describe('parseCheckpointAnswer', () => {
		it('parses continue', () => expect(parseCheckpointAnswer('Continue')).toBe('continue'));
		it('parses pause', () => expect(parseCheckpointAnswer('Pause for review')).toBe('pause'));
		it('parses stop', () => expect(parseCheckpointAnswer('Stop loop')).toBe('stop'));
		it('parses rollback', () => expect(parseCheckpointAnswer('Rollback last task')).toBe('rollback'));
		it('defaults to continue', () => expect(parseCheckpointAnswer('anything')).toBe('continue'));
	});

	describe('parseSessionEndAnswer', () => {
		it('parses new session', () => expect(parseSessionEndAnswer('Start new session')).toBe('new-session'));
		it('parses review', () => expect(parseSessionEndAnswer('Review changes')).toBe('review'));
		it('parses report', () => expect(parseSessionEndAnswer('Generate report')).toBe('report'));
		it('parses done', () => expect(parseSessionEndAnswer('Done')).toBe('done'));
		it('defaults to new-session', () => expect(parseSessionEndAnswer('anything')).toBe('new-session'));
	});
});
