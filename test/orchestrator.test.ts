import { describe, it, expect } from 'vitest';
import {
	shouldContinueLoop,
	shouldNudge,
	shouldRetryError,
	MAX_RETRIES_PER_TASK,
} from '../src/decisions';

describe('shouldContinueLoop', () => {
	it('returns false when all tasks are done', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 0,
			iteration: 2,
			maxIterations: 10,
		})).toBe(false);
	});

	it('returns true when tasks remain', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 3,
			iteration: 1,
			maxIterations: 10,
		})).toBe(true);
	});

	it('returns false when stop is requested', () => {
		expect(shouldContinueLoop({
			stopRequested: true,
			tasksRemaining: 3,
			iteration: 0,
			maxIterations: 10,
		})).toBe(false);
	});

	it('returns false when iteration limit is reached', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 2,
			iteration: 10,
			maxIterations: 10,
		})).toBe(false);
	});

	it('ignores iteration limit when maxIterations is 0', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 1,
			iteration: 999,
			maxIterations: 0,
		})).toBe(true);
	});
});

describe('shouldNudge', () => {
	it('returns nudge text when task not complete and nudgeCount < max', () => {
		const result = shouldNudge({
			taskCompleted: false,
			nudgeCount: 1,
			maxNudgesPerTask: 3,
		});
		expect(result).toBeTypeOf('string');
		expect(result).toContain('Continue with the current task');
	});

	it('returns undefined when nudgeCount is at max', () => {
		expect(shouldNudge({
			taskCompleted: false,
			nudgeCount: 3,
			maxNudgesPerTask: 3,
		})).toBeUndefined();
	});

	it('returns undefined when task is already completed', () => {
		expect(shouldNudge({
			taskCompleted: true,
			nudgeCount: 0,
			maxNudgesPerTask: 3,
		})).toBeUndefined();
	});
});

describe('shouldRetryError', () => {
	it('returns true for transient network error under cap', () => {
		expect(shouldRetryError(new Error('network error'), 0)).toBe(true);
	});

	it('returns true for timeout error under cap', () => {
		expect(shouldRetryError(new Error('Request timeout'), 1)).toBe(true);
	});

	it('returns true for ECONNRESET under cap', () => {
		expect(shouldRetryError(new Error('ECONNRESET'), 2)).toBe(true);
	});

	it('returns false for transient error at retry cap', () => {
		expect(shouldRetryError(new Error('network error'), MAX_RETRIES_PER_TASK)).toBe(false);
	});

	it('returns false for fatal (non-transient) error', () => {
		expect(shouldRetryError(new Error('Cannot read properties of undefined'), 0)).toBe(false);
	});

	it('returns false when stop is requested', () => {
		expect(shouldRetryError(new Error('timeout'), 0, true)).toBe(false);
	});
});
