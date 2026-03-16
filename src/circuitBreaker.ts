import * as crypto from 'crypto';
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
	action: 'continue' | 'retry' | 'skip' | 'stop' | 'nudge' | 'regenerate';
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

// --- Error hash deduplication ---

export class ErrorHashTracker {
	private counts = new Map<string, number>();
	private errors = new Map<string, string>();

	normalizeError(error: string): string {
		let result = error;
		// Strip ANSI escape codes
		result = result.replace(/\x1b\[[0-9;]*m/g, '');
		// Strip ISO 8601 timestamps
		result = result.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '');
		// Strip stack frame paths (lines starting with "at" followed by a path)
		result = result.replace(/^\s*at\s+.*[\\/].*$/gm, '');
		// Strip line numbers like :123: or :123
		result = result.replace(/:\d+/g, '');
		// Collapse whitespace
		result = result.replace(/\s+/g, ' ').trim();
		return result;
	}

	hashError(error: string): string {
		const normalized = this.normalizeError(error);
		return crypto.createHash('md5').update(normalized).digest('hex');
	}

	record(error: string): { hash: string; count: number } {
		const hash = this.hashError(error);
		const count = (this.counts.get(hash) ?? 0) + 1;
		this.counts.set(hash, count);
		if (!this.errors.has(hash)) { this.errors.set(hash, error); }
		return { hash, count };
	}

	isRepeating(hash: string, threshold: number = 3): boolean {
		return (this.counts.get(hash) ?? 0) >= threshold;
	}

	getRepeatingEntries(threshold: number = 3): Array<{ hash: string; error: string; count: number }> {
		const entries: Array<{ hash: string; error: string; count: number }> = [];
		for (const [hash, count] of this.counts) {
			if (count >= threshold) {
				entries.push({ hash, error: this.errors.get(hash) ?? '', count });
			}
		}
		return entries;
	}

	reset(): void {
		this.counts.clear();
		this.errors.clear();
	}
}

// --- Plan Regeneration ---

export interface PlanRegenerationOptions {
	triggerAfterDecompFailures?: number;
	maxRegenerations?: number;
}

export class PlanRegenerationTracker {
	private decomposed = false;
	private failuresAfterDecomp = 0;
	private regenerationCount = 0;

	hasDecomposed(): boolean { return this.decomposed; }
	getFailuresAfterDecomp(): number { return this.failuresAfterDecomp; }
	getRegenerationCount(): number { return this.regenerationCount; }

	recordDecomposition(): void { this.decomposed = true; }
	recordFailureAfterDecomp(): void { this.failuresAfterDecomp++; }
	recordRegeneration(): void { this.regenerationCount++; }

	reset(): void {
		this.decomposed = false;
		this.failuresAfterDecomp = 0;
		this.regenerationCount = 0;
	}
}

export function PlanRegenerationBreaker(
	tracker: PlanRegenerationTracker,
	opts?: PlanRegenerationOptions,
): CircuitBreaker {
	const triggerAfterDecompFailures = opts?.triggerAfterDecompFailures ?? 2;
	const maxRegenerations = opts?.maxRegenerations ?? 1;
	return {
		name: 'planRegeneration',
		check(_state: CircuitBreakerState): CircuitBreakerResult {
			if (!tracker.hasDecomposed()) { return NO_TRIP; }
			if (tracker.getRegenerationCount() >= maxRegenerations) { return NO_TRIP; }
			if (tracker.getFailuresAfterDecomp() >= triggerAfterDecompFailures) {
				return { tripped: true, reason: 'Decomposition failed \u2014 regenerating plan', action: 'regenerate' };
			}
			return NO_TRIP;
		},
	};
}

export function RepeatedErrorBreaker(tracker: ErrorHashTracker, threshold: number = 3): CircuitBreaker {
	return {
		name: 'repeatedError',
		check(_state: CircuitBreakerState): CircuitBreakerResult {
			const repeating = tracker.getRepeatingEntries(threshold);
			if (repeating.length > 0) {
				const first = repeating[0];
				const pattern = first.error.slice(0, 100);
				return { tripped: true, reason: `Repeated error (${first.count}x): ${pattern}`, action: 'skip' };
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
	{ name: 'planRegeneration', enabled: false },
	{ name: 'repeatedError', enabled: false },
	{ name: 'errorRate', enabled: false },
	{ name: 'timeBudget', enabled: false },
];

export function createDefaultChain(config?: CircuitBreakerConfig[], errorHashTracker?: ErrorHashTracker, planRegenTracker?: PlanRegenerationTracker): CircuitBreakerChain {
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

	const regenCfg = breakerMap.get('planRegeneration');
	breakers.push(PlanRegenerationBreaker(planRegenTracker ?? new PlanRegenerationTracker(), {
		triggerAfterDecompFailures: typeof regenCfg?.triggerAfterDecompFailures === 'number' ? regenCfg.triggerAfterDecompFailures : undefined,
		maxRegenerations: typeof regenCfg?.maxRegenerations === 'number' ? regenCfg.maxRegenerations : undefined,
	}));

	const repeatedErrorCfg = breakerMap.get('repeatedError');
	const repeatedThreshold = typeof repeatedErrorCfg?.repeatedErrorThreshold === 'number' ? repeatedErrorCfg.repeatedErrorThreshold : 3;
	breakers.push(RepeatedErrorBreaker(errorHashTracker ?? new ErrorHashTracker(), repeatedThreshold));

	const errorRateCfg = breakerMap.get('errorRate');
	breakers.push(ErrorRateBreaker(
		typeof errorRateCfg?.threshold === 'number' ? errorRateCfg.threshold : undefined,
		typeof errorRateCfg?.windowSize === 'number' ? errorRateCfg.windowSize : undefined,
	));

	const timeBudgetCfg = breakerMap.get('timeBudget');
	breakers.push(TimeBudgetBreaker(typeof timeBudgetCfg?.timeBudgetMs === 'number' ? timeBudgetCfg.timeBudgetMs : undefined));

	return new CircuitBreakerChain(breakers, disabled);
}
