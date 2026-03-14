import type { CircuitBreakerConfig } from './types';

export interface CircuitBreakerState {
	nudgeCount: number;
	retryCount: number;
	elapsedMs: number;
	fileChanges: number;
	errorHistory: boolean[]; // true = error, false = success
	consecutiveNudgesWithoutFileChanges: number;
}

export interface CircuitBreakerResult {
	tripped: boolean;
	reason?: string;
	action: 'continue' | 'retry' | 'skip' | 'stop' | 'nudge';
}

export interface CircuitBreaker {
	name: string;
	check(state: CircuitBreakerState): CircuitBreakerResult;
}

export type OnTripCallback = (breaker: CircuitBreaker, result: CircuitBreakerResult, state: CircuitBreakerState) => void;

const NO_TRIP: CircuitBreakerResult = { tripped: false, action: 'continue' };

// --- Pure-function breakers ---

export function MaxRetriesBreaker(maxRetries: number = 3): CircuitBreaker {
	return {
		name: 'maxRetries',
		check(state: CircuitBreakerState): CircuitBreakerResult {
			if (state.retryCount >= maxRetries) {
				return { tripped: true, reason: `Retry limit reached (${state.retryCount}/${maxRetries})`, action: 'stop' };
			}
			return NO_TRIP;
		},
	};
}

export function MaxNudgesBreaker(maxNudges: number = 3): CircuitBreaker {
	return {
		name: 'maxNudges',
		check(state: CircuitBreakerState): CircuitBreakerResult {
			if (state.nudgeCount >= maxNudges) {
				return { tripped: true, reason: `Nudge limit reached (${state.nudgeCount}/${maxNudges})`, action: 'stop' };
			}
			return NO_TRIP;
		},
	};
}

export function StagnationBreaker(threshold: number = 2): CircuitBreaker {
	return {
		name: 'stagnation',
		check(state: CircuitBreakerState): CircuitBreakerResult {
			if (state.consecutiveNudgesWithoutFileChanges >= threshold) {
				return { tripped: true, reason: `Stagnation detected: ${state.consecutiveNudgesWithoutFileChanges} consecutive nudges without file changes`, action: 'skip' };
			}
			return NO_TRIP;
		},
	};
}

export function ErrorRateBreaker(threshold: number = 0.6, windowSize: number = 5): CircuitBreaker {
	return {
		name: 'errorRate',
		check(state: CircuitBreakerState): CircuitBreakerResult {
			if (state.errorHistory.length === 0) { return NO_TRIP; }
			const window = state.errorHistory.slice(-windowSize);
			const errorCount = window.filter(Boolean).length;
			const rate = errorCount / window.length;
			if (rate > threshold) {
				return { tripped: true, reason: `Error rate ${(rate * 100).toFixed(0)}% exceeds threshold ${(threshold * 100).toFixed(0)}%`, action: 'stop' };
			}
			return NO_TRIP;
		},
	};
}

export function TimeBudgetBreaker(timeBudgetMs: number = 600_000): CircuitBreaker {
	return {
		name: 'timeBudget',
		check(state: CircuitBreakerState): CircuitBreakerResult {
			if (state.elapsedMs > timeBudgetMs) {
				return { tripped: true, reason: `Time budget exceeded (${Math.round(state.elapsedMs / 1000)}s / ${Math.round(timeBudgetMs / 1000)}s)`, action: 'skip' };
			}
			return NO_TRIP;
		},
	};
}

// --- Chain ---

export class CircuitBreakerChain {
	private readonly breakers: CircuitBreaker[];
	private readonly disabled: Set<string>;

	constructor(breakers: CircuitBreaker[], disabled?: Set<string>) {
		this.breakers = breakers;
		this.disabled = disabled ?? new Set();
	}

	check(state: CircuitBreakerState): CircuitBreakerResult {
		for (const breaker of this.breakers) {
			if (this.disabled.has(breaker.name)) { continue; }
			const result = breaker.check(state);
			if (result.tripped) { return result; }
		}
		return NO_TRIP;
	}
}

// --- Factory ---

const DEFAULT_CB_CONFIG: CircuitBreakerConfig[] = [
	{ name: 'maxRetries', enabled: true },
	{ name: 'maxNudges', enabled: true },
	{ name: 'stagnation', enabled: true },
	{ name: 'errorRate', enabled: false },
	{ name: 'timeBudget', enabled: false },
];

export function createDefaultChain(config?: CircuitBreakerConfig[]): CircuitBreakerChain {
	const cfgs = config ?? DEFAULT_CB_CONFIG;
	const disabled = new Set<string>();
	const breakerMap = new Map<string, CircuitBreakerConfig>();
	for (const c of cfgs) {
		breakerMap.set(c.name, c);
		if (!c.enabled) { disabled.add(c.name); }
	}

	const breakers: CircuitBreaker[] = [];

	const retriesCfg = breakerMap.get('maxRetries');
	breakers.push(MaxRetriesBreaker(typeof retriesCfg?.maxRetries === 'number' ? retriesCfg.maxRetries : undefined));

	const nudgesCfg = breakerMap.get('maxNudges');
	breakers.push(MaxNudgesBreaker(typeof nudgesCfg?.maxNudges === 'number' ? nudgesCfg.maxNudges : undefined));

	const stagnationCfg = breakerMap.get('stagnation');
	breakers.push(StagnationBreaker(typeof stagnationCfg?.threshold === 'number' ? stagnationCfg.threshold : undefined));

	const errorRateCfg = breakerMap.get('errorRate');
	breakers.push(ErrorRateBreaker(
		typeof errorRateCfg?.threshold === 'number' ? errorRateCfg.threshold : undefined,
		typeof errorRateCfg?.windowSize === 'number' ? errorRateCfg.windowSize : undefined,
	));

	const timeBudgetCfg = breakerMap.get('timeBudget');
	breakers.push(TimeBudgetBreaker(typeof timeBudgetCfg?.timeBudgetMs === 'number' ? timeBudgetCfg.timeBudgetMs : undefined));

	return new CircuitBreakerChain(breakers, disabled);
}
