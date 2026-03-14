import { describe, it, expect } from 'vitest';
import {
	shouldContinueLoop,
	shouldNudge,
	shouldRetryError,
	MAX_RETRIES_PER_TASK,
} from '../src/decisions';
import { runPreCompleteChain } from '../src/orchestrator';
import type {
	IRalphHookService,
	HookResult,
	PreCompleteHookConfig,
	PreCompleteInput,
	VerifyCheck,
} from '../src/types';
import { VerifyResult } from '../src/types';

// --- Helper to create a mock hook service ---
function createMockHookService(
	onPreCompleteFn: (input: PreCompleteInput) => Promise<HookResult>,
): IRalphHookService {
	const noOp = async () => ({ action: 'continue' as const });
	return {
		onSessionStart: noOp,
		onPreCompact: noOp,
		onPostToolUse: noOp,
		onPreComplete: onPreCompleteFn,
		onTaskComplete: noOp,
	};
}

const baseInput = {
	taskId: '1',
	taskInvocationId: 'inv-1',
	checksRun: [{ name: 'checkbox', result: VerifyResult.Pass }] as VerifyCheck[],
	prdPath: '/tmp/PRD.md',
};

describe('runPreCompleteChain', () => {
	it('all-continue proceeds to TaskComplete', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-b', type: 'builtin', enabled: true },
		];
		const service = createMockHookService(async () => ({ action: 'continue' }));
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(2);
		expect(result.results[0].hookName).toBe('hook-a');
		expect(result.results[1].hookName).toBe('hook-b');
	});

	it('retry causes re-entry (short-circuits remaining hooks)', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-retry', type: 'builtin', enabled: true },
			{ name: 'hook-c', type: 'builtin', enabled: true },
		];
		let callCount = 0;
		const service = createMockHookService(async () => {
			callCount++;
			if (callCount === 2) return { action: 'retry', reason: 'not ready' };
			return { action: 'continue' };
		});
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('retry');
		expect(result.results).toHaveLength(2);
		expect(callCount).toBe(2); // hook-c never called
	});

	it('stop yields Stopped immediately (short-circuits)', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-stop', type: 'builtin', enabled: true },
			{ name: 'hook-b', type: 'builtin', enabled: true },
		];
		const service = createMockHookService(async () => ({ action: 'stop', reason: 'blocked' }));
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('stop');
		expect(result.results).toHaveLength(1);
		expect(result.results[0].hookName).toBe('hook-stop');
	});

	it('previousResults accumulates across hooks', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-b', type: 'builtin', enabled: true },
			{ name: 'hook-c', type: 'builtin', enabled: true },
		];
		const receivedPreviousResults: (unknown[] | undefined)[] = [];
		const service = createMockHookService(async (input) => {
			receivedPreviousResults.push(input.previousResults ? [...input.previousResults] : undefined);
			return { action: 'continue' };
		});
		await runPreCompleteChain(hooks, service, baseInput);
		expect(receivedPreviousResults[0]).toHaveLength(0); // first hook gets empty
		expect(receivedPreviousResults[1]).toHaveLength(1); // second gets first result
		expect(receivedPreviousResults[2]).toHaveLength(2); // third gets first two
	});

	it('disabled hooks are skipped', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-disabled', type: 'builtin', enabled: false },
			{ name: 'hook-c', type: 'builtin', enabled: true },
		];
		let callCount = 0;
		const service = createMockHookService(async () => {
			callCount++;
			return { action: 'continue' };
		});
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(2);
		expect(callCount).toBe(2);
		expect(result.results.map(r => r.hookName)).toEqual(['hook-a', 'hook-c']);
	});

	it('returns continue with empty results when all hooks disabled', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: false },
		];
		const service = createMockHookService(async () => ({ action: 'continue' }));
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(0);
	});

	it('returns continue with empty results when hooks list is empty', async () => {
		const service = createMockHookService(async () => ({ action: 'continue' }));
		const result = await runPreCompleteChain([], service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(0);
	});
});

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
