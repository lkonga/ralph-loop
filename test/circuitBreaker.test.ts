import { describe, it, expect } from 'vitest';
import {
	MaxRetriesBreaker,
	MaxNudgesBreaker,
	StagnationBreaker,
	ErrorRateBreaker,
	TimeBudgetBreaker,
	CircuitBreakerChain,
	createDefaultChain,
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
