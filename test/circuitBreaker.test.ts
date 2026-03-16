import { describe, it, expect } from 'vitest';
import {
	MaxRetriesBreaker,
	MaxNudgesBreaker,
	StagnationBreaker,
	ErrorRateBreaker,
	TimeBudgetBreaker,
	CircuitBreakerChain,
	createDefaultChain,
	ErrorHashTracker,
	RepeatedErrorBreaker,
	PlanRegenerationBreaker,
	PlanRegenerationTracker,
	type CircuitBreakerState,
} from '../src/circuitBreaker';

function makeState(overrides: Partial<CircuitBreakerState> = {}): CircuitBreakerState {
	return {
		nudgeCount: 0,
		retryCount: 0,
		elapsedMs: 0,
		fileChanges: 0,
		errorHistory: [],
		consecutiveNudgesWithoutFileChanges: 0,
		...overrides,
	};
}

// --- MaxRetriesBreaker ---

describe('MaxRetriesBreaker', () => {
	it('does not trip when retryCount < maxRetries', () => {
		const breaker = MaxRetriesBreaker();
		const result = breaker.check(makeState({ retryCount: 2 }));
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('trips when retryCount >= maxRetries (default 3)', () => {
		const breaker = MaxRetriesBreaker();
		const result = breaker.check(makeState({ retryCount: 3 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop');
		expect(result.reason).toBeDefined();
	});

	it('trips with custom maxRetries', () => {
		const breaker = MaxRetriesBreaker(5);
		expect(breaker.check(makeState({ retryCount: 4 })).tripped).toBe(false);
		expect(breaker.check(makeState({ retryCount: 5 })).tripped).toBe(true);
	});
});

// --- MaxNudgesBreaker ---

describe('MaxNudgesBreaker', () => {
	it('does not trip when nudgeCount < maxNudges', () => {
		const breaker = MaxNudgesBreaker(3);
		const result = breaker.check(makeState({ nudgeCount: 2 }));
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('trips when nudgeCount >= maxNudges', () => {
		const breaker = MaxNudgesBreaker(3);
		const result = breaker.check(makeState({ nudgeCount: 3 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop');
	});
});

// --- StagnationBreaker ---

describe('StagnationBreaker', () => {
	it('does not trip when consecutive nudges without file changes < threshold', () => {
		const breaker = StagnationBreaker();
		const result = breaker.check(makeState({ consecutiveNudgesWithoutFileChanges: 1 }));
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('trips when consecutive nudges without file changes >= threshold (default 2)', () => {
		const breaker = StagnationBreaker();
		const result = breaker.check(makeState({ consecutiveNudgesWithoutFileChanges: 2 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('skip');
	});

	it('does not trip when file changes occurred (counter resets)', () => {
		const breaker = StagnationBreaker(2);
		const result = breaker.check(makeState({ consecutiveNudgesWithoutFileChanges: 0, fileChanges: 5 }));
		expect(result.tripped).toBe(false);
	});

	it('trips with custom threshold', () => {
		const breaker = StagnationBreaker(4);
		expect(breaker.check(makeState({ consecutiveNudgesWithoutFileChanges: 3 })).tripped).toBe(false);
		expect(breaker.check(makeState({ consecutiveNudgesWithoutFileChanges: 4 })).tripped).toBe(true);
	});
});

// --- ErrorRateBreaker ---

describe('ErrorRateBreaker', () => {
	it('does not trip when error rate is below threshold', () => {
		const breaker = ErrorRateBreaker();
		const result = breaker.check(makeState({
			errorHistory: [false, false, true, false, false],
		}));
		expect(result.tripped).toBe(false);
	});

	it('trips when error rate exceeds threshold (0.6) in window', () => {
		const breaker = ErrorRateBreaker();
		const result = breaker.check(makeState({
			errorHistory: [true, true, true, true, false],
		}));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop');
	});

	it('does not trip when error history is empty', () => {
		const breaker = ErrorRateBreaker();
		const result = breaker.check(makeState({ errorHistory: [] }));
		expect(result.tripped).toBe(false);
	});

	it('uses sliding window of last N iterations', () => {
		const breaker = ErrorRateBreaker(0.6, 3);
		// Only last 3 items: [false, true, false] → 1/3 = 0.33 < 0.6
		const result = breaker.check(makeState({
			errorHistory: [true, true, false, true, false],
		}));
		expect(result.tripped).toBe(false);
		// Last 3: [true, true, true] → 1.0 > 0.6
		const result2 = breaker.check(makeState({
			errorHistory: [false, false, true, true, true],
		}));
		expect(result2.tripped).toBe(true);
	});

	it('handles fewer entries than window size', () => {
		const breaker = ErrorRateBreaker(0.6, 5);
		const result = breaker.check(makeState({
			errorHistory: [true, true],
		}));
		expect(result.tripped).toBe(true); // 2/2 = 1.0 > 0.6
	});
});

// --- TimeBudgetBreaker ---

describe('TimeBudgetBreaker', () => {
	it('does not trip when elapsed < timeBudgetMs', () => {
		const breaker = TimeBudgetBreaker();
		const result = breaker.check(makeState({ elapsedMs: 500_000 }));
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('trips when elapsed > timeBudgetMs (default 600s)', () => {
		const breaker = TimeBudgetBreaker();
		const result = breaker.check(makeState({ elapsedMs: 601_000 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('skip');
	});

	it('trips with custom timeBudgetMs', () => {
		const breaker = TimeBudgetBreaker(10_000);
		expect(breaker.check(makeState({ elapsedMs: 9_999 })).tripped).toBe(false);
		expect(breaker.check(makeState({ elapsedMs: 10_001 })).tripped).toBe(true);
	});
});

// --- CircuitBreakerChain ---

describe('CircuitBreakerChain', () => {
	it('returns continue when no breakers trip', () => {
		const chain = new CircuitBreakerChain([
			MaxRetriesBreaker(),
			MaxNudgesBreaker(3),
		]);
		const result = chain.check(makeState());
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('returns first tripped result in priority order', () => {
		const chain = new CircuitBreakerChain([
			MaxRetriesBreaker(1),		// Will trip (retryCount=2)
			TimeBudgetBreaker(100),		// Would also trip (elapsed=200)
		]);
		const result = chain.check(makeState({ retryCount: 2, elapsedMs: 200 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop'); // MaxRetries action, not TimeBudget's 'skip'
	});

	it('skips disabled breakers', () => {
		const chain = new CircuitBreakerChain([
			MaxRetriesBreaker(1),		// Would trip but disabled
			TimeBudgetBreaker(100),		// Will trip
		], new Set(['maxRetries']));
		const result = chain.check(makeState({ retryCount: 2, elapsedMs: 200 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('skip'); // TimeBudget's action, since MaxRetries is disabled
	});

	it('handles empty breaker list', () => {
		const chain = new CircuitBreakerChain([]);
		const result = chain.check(makeState());
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});
});

// --- createDefaultChain ---

describe('createDefaultChain', () => {
	it('creates chain with maxRetries, maxNudges, stagnation enabled by default', () => {
		const chain = createDefaultChain();
		// Should not trip with clean state
		const result = chain.check(makeState());
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('maxRetries is enabled and trips', () => {
		const chain = createDefaultChain();
		const result = chain.check(makeState({ retryCount: 3 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop');
	});

	it('maxNudges is enabled and trips', () => {
		const chain = createDefaultChain([
			{ name: 'maxRetries', enabled: true },
			{ name: 'maxNudges', enabled: true, maxNudges: 2 },
			{ name: 'stagnation', enabled: true },
		]);
		const result = chain.check(makeState({ nudgeCount: 2 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop');
	});

	it('stagnation is enabled and trips', () => {
		const chain = createDefaultChain();
		const result = chain.check(makeState({ consecutiveNudgesWithoutFileChanges: 2 }));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('skip');
	});

	it('errorRate is disabled by default', () => {
		const chain = createDefaultChain();
		// Even with high error rate, should not trip because errorRate is disabled
		const result = chain.check(makeState({
			errorHistory: [true, true, true, true, true],
		}));
		// Only stagnation/maxRetries/maxNudges are enabled — none should trip here
		expect(result.tripped).toBe(false);
	});

	it('timeBudget is disabled by default', () => {
		const chain = createDefaultChain();
		const result = chain.check(makeState({ elapsedMs: 999_999 }));
		expect(result.tripped).toBe(false);
	});

	it('respects config to enable errorRate', () => {
		const chain = createDefaultChain([
			{ name: 'maxRetries', enabled: true },
			{ name: 'maxNudges', enabled: true, maxNudges: 10 },
			{ name: 'stagnation', enabled: true },
			{ name: 'errorRate', enabled: true },
		]);
		const result = chain.check(makeState({
			errorHistory: [true, true, true, true, true],
		}));
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('stop');
	});

	it('respects config to disable maxRetries', () => {
		const chain = createDefaultChain([
			{ name: 'maxRetries', enabled: false },
			{ name: 'maxNudges', enabled: true, maxNudges: 10 },
			{ name: 'stagnation', enabled: true },
		]);
		const result = chain.check(makeState({ retryCount: 100 }));
		expect(result.tripped).toBe(false);
	});
});

// --- ErrorHashTracker ---

describe('ErrorHashTracker', () => {
	it('normalizeError strips ISO 8601 timestamps', () => {
		const tracker = new ErrorHashTracker();
		const input = 'Error at 2026-03-14T06:10:30.923Z: something failed';
		const normalized = tracker.normalizeError(input);
		expect(normalized).not.toContain('2026-03-14T06:10:30.923Z');
		expect(normalized).toContain('something failed');
	});

	it('normalizeError strips line numbers like :123:', () => {
		const tracker = new ErrorHashTracker();
		const input = 'Error in file.ts:42:10 something broke';
		const normalized = tracker.normalizeError(input);
		expect(normalized).not.toContain(':42:');
		expect(normalized).not.toContain(':10');
	});

	it('normalizeError strips ANSI escape codes', () => {
		const tracker = new ErrorHashTracker();
		const input = '\x1b[31mError\x1b[0m: something failed';
		const normalized = tracker.normalizeError(input);
		expect(normalized).not.toContain('\x1b[');
		expect(normalized).toContain('Error');
	});

	it('normalizeError strips stack frame paths', () => {
		const tracker = new ErrorHashTracker();
		const input = 'Error: fail\n    at Object.<anonymous> (/home/user/project/src/file.ts:10:5)';
		const normalized = tracker.normalizeError(input);
		expect(normalized).not.toContain('/home/user/project/src/file.ts');
	});

	it('normalizeError collapses whitespace', () => {
		const tracker = new ErrorHashTracker();
		const input = 'Error:   something    failed   badly';
		const normalized = tracker.normalizeError(input);
		expect(normalized).toBe('Error: something failed badly');
	});

	it('identical errors produce same hash', () => {
		const tracker = new ErrorHashTracker();
		const h1 = tracker.hashError('TypeError: Cannot read property x');
		const h2 = tracker.hashError('TypeError: Cannot read property x');
		expect(h1).toBe(h2);
	});

	it('same error with different timestamps produces same hash', () => {
		const tracker = new ErrorHashTracker();
		const h1 = tracker.hashError('Error at 2026-03-14T06:10:30.923Z: fail');
		const h2 = tracker.hashError('Error at 2026-03-15T12:00:00.000Z: fail');
		expect(h1).toBe(h2);
	});

	it('different errors produce different hashes', () => {
		const tracker = new ErrorHashTracker();
		const h1 = tracker.hashError('TypeError: Cannot read property x');
		const h2 = tracker.hashError('ReferenceError: y is not defined');
		expect(h1).not.toBe(h2);
	});

	it('record increments count for repeated errors', () => {
		const tracker = new ErrorHashTracker();
		const r1 = tracker.record('Error: fail');
		expect(r1.count).toBe(1);
		const r2 = tracker.record('Error: fail');
		expect(r2.count).toBe(2);
		expect(r2.hash).toBe(r1.hash);
	});

	it('isRepeating returns false below threshold', () => {
		const tracker = new ErrorHashTracker();
		const { hash } = tracker.record('Error: fail');
		tracker.record('Error: fail');
		expect(tracker.isRepeating(hash)).toBe(false);
	});

	it('isRepeating returns true at threshold (default 3)', () => {
		const tracker = new ErrorHashTracker();
		const { hash } = tracker.record('Error: fail');
		tracker.record('Error: fail');
		tracker.record('Error: fail');
		expect(tracker.isRepeating(hash)).toBe(true);
	});

	it('isRepeating respects custom threshold', () => {
		const tracker = new ErrorHashTracker();
		const { hash } = tracker.record('Error: fail');
		tracker.record('Error: fail');
		expect(tracker.isRepeating(hash, 2)).toBe(true);
	});

	it('reset clears all counts', () => {
		const tracker = new ErrorHashTracker();
		const { hash } = tracker.record('Error: fail');
		tracker.record('Error: fail');
		tracker.record('Error: fail');
		expect(tracker.isRepeating(hash)).toBe(true);
		tracker.reset();
		expect(tracker.isRepeating(hash)).toBe(false);
	});
});

// --- RepeatedErrorBreaker ---

describe('RepeatedErrorBreaker', () => {
	it('does not trip when no errors are repeating', () => {
		const tracker = new ErrorHashTracker();
		tracker.record('Error: A');
		const breaker = RepeatedErrorBreaker(tracker);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('trips when an error hash reaches the threshold', () => {
		const tracker = new ErrorHashTracker();
		tracker.record('Error: same thing');
		tracker.record('Error: same thing');
		tracker.record('Error: same thing');
		const breaker = RepeatedErrorBreaker(tracker);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('skip');
		expect(result.reason).toContain('Error: same thing');
	});

	it('reason includes first 100 chars of the repeated error', () => {
		const tracker = new ErrorHashTracker();
		const longError = 'A'.repeat(200);
		tracker.record(longError);
		tracker.record(longError);
		tracker.record(longError);
		const breaker = RepeatedErrorBreaker(tracker);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.reason!.length).toBeLessThanOrEqual(200); // reason length is bounded
	});

	it('respects custom threshold', () => {
		const tracker = new ErrorHashTracker();
		tracker.record('Error: x');
		tracker.record('Error: x');
		const breaker = RepeatedErrorBreaker(tracker, 2);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(true);
	});
});

// --- createDefaultChain with repeatedError ---

describe('createDefaultChain with repeatedError', () => {
	it('repeatedError is disabled by default', () => {
		const chain = createDefaultChain();
		// Even with a tracker that would trip, it should be disabled
		const result = chain.check(makeState());
		expect(result.tripped).toBe(false);
	});

	it('repeatedError can be enabled via config', () => {
		const tracker = new ErrorHashTracker();
		tracker.record('Error: repeated');
		tracker.record('Error: repeated');
		tracker.record('Error: repeated');
		const chain = createDefaultChain([
			{ name: 'maxRetries', enabled: true },
			{ name: 'maxNudges', enabled: true },
			{ name: 'stagnation', enabled: true },
			{ name: 'repeatedError', enabled: true, repeatedErrorThreshold: 3 },
			{ name: 'errorRate', enabled: false },
			{ name: 'timeBudget', enabled: false },
		], tracker);
		const result = chain.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('skip');
	});
});

// --- PlanRegenerationTracker ---

describe('PlanRegenerationTracker', () => {
	it('starts with zero counts', () => {
		const tracker = new PlanRegenerationTracker();
		expect(tracker.hasDecomposed()).toBe(false);
		expect(tracker.getFailuresAfterDecomp()).toBe(0);
		expect(tracker.getRegenerationCount()).toBe(0);
	});

	it('records decomposition', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		expect(tracker.hasDecomposed()).toBe(true);
	});

	it('records failure after decomposition', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp();
		tracker.recordFailureAfterDecomp();
		expect(tracker.getFailuresAfterDecomp()).toBe(2);
	});

	it('records regeneration', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordRegeneration();
		expect(tracker.getRegenerationCount()).toBe(1);
	});

	it('reset clears all state', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp();
		tracker.recordRegeneration();
		tracker.reset();
		expect(tracker.hasDecomposed()).toBe(false);
		expect(tracker.getFailuresAfterDecomp()).toBe(0);
		expect(tracker.getRegenerationCount()).toBe(0);
	});
});

// --- PlanRegenerationBreaker ---

describe('PlanRegenerationBreaker', () => {
	it('does not trip without decomposition', () => {
		const tracker = new PlanRegenerationTracker();
		const breaker = PlanRegenerationBreaker(tracker);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('does not trip with decomposition but insufficient failures', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp(); // only 1, need 2
		const breaker = PlanRegenerationBreaker(tracker);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(false);
	});

	it('trips after decomposition + N failures (default 2)', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp();
		tracker.recordFailureAfterDecomp();
		const breaker = PlanRegenerationBreaker(tracker);
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('regenerate');
		expect(result.reason).toContain('Decomposition failed');
	});

	it('respects custom triggerAfterDecompFailures', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp();
		tracker.recordFailureAfterDecomp();
		tracker.recordFailureAfterDecomp();
		const breaker = PlanRegenerationBreaker(tracker, { triggerAfterDecompFailures: 3 });
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('regenerate');
	});

	it('maxRegenerations cap prevents further trips', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp();
		tracker.recordFailureAfterDecomp();
		tracker.recordRegeneration(); // already regenerated once
		const breaker = PlanRegenerationBreaker(tracker, { maxRegenerations: 1 });
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(false);
		expect(result.action).toBe('continue');
	});

	it('allows regeneration when below max', () => {
		const tracker = new PlanRegenerationTracker();
		tracker.recordDecomposition();
		tracker.recordFailureAfterDecomp();
		tracker.recordFailureAfterDecomp();
		const breaker = PlanRegenerationBreaker(tracker, { maxRegenerations: 2 });
		const result = breaker.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('regenerate');
	});

	it('has name planRegeneration', () => {
		const tracker = new PlanRegenerationTracker();
		const breaker = PlanRegenerationBreaker(tracker);
		expect(breaker.name).toBe('planRegeneration');
	});
});

// --- createDefaultChain with planRegeneration ---

describe('createDefaultChain with planRegeneration', () => {
	it('planRegeneration is disabled by default', () => {
		const chain = createDefaultChain();
		const result = chain.check(makeState());
		expect(result.tripped).toBe(false);
	});

	it('planRegeneration placed after stagnation, before repeatedError', () => {
		const regenTracker = new PlanRegenerationTracker();
		regenTracker.recordDecomposition();
		regenTracker.recordFailureAfterDecomp();
		regenTracker.recordFailureAfterDecomp();
		const chain = createDefaultChain([
			{ name: 'maxRetries', enabled: false },
			{ name: 'maxNudges', enabled: false },
			{ name: 'stagnation', enabled: false },
			{ name: 'planRegeneration', enabled: true, maxRegenerations: 1, triggerAfterDecompFailures: 2 },
			{ name: 'repeatedError', enabled: false },
			{ name: 'errorRate', enabled: false },
			{ name: 'timeBudget', enabled: false },
		], undefined, regenTracker);
		const result = chain.check(makeState());
		expect(result.tripped).toBe(true);
		expect(result.action).toBe('regenerate');
	});
});
