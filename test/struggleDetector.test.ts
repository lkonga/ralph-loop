import { describe, it, expect } from 'vitest';
import { StruggleDetector } from '../src/struggleDetector';

describe('StruggleDetector', () => {
	// --- No-progress signal ---
	describe('no-progress signal', () => {
		it('increments noProgressCount when filesChanged is 0', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(60000, 0, []);
			sd.recordIteration(60000, 0, []);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(false);
			// 2 consecutive, threshold is 3
		});

		it('triggers at threshold (3 consecutive no-progress)', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(60000, 0, []);
			sd.recordIteration(60000, 0, []);
			sd.recordIteration(60000, 0, []);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(true);
			expect(result.signals).toContain('no-progress');
		});

		it('resets noProgressCount when files change', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(60000, 0, []);
			sd.recordIteration(60000, 0, []);
			sd.recordIteration(60000, 3, []); // files changed — reset
			const result = sd.isStruggling();
			expect(result.struggling).toBe(false);
			expect(result.signals).not.toContain('no-progress');
		});
	});

	// --- Short-iteration signal ---
	describe('short-iteration signal', () => {
		it('increments shortIterationCount when duration < 30000ms', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(false);
		});

		it('triggers at threshold (3 consecutive short iterations)', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(true);
			expect(result.signals).toContain('short-iteration');
		});

		it('resets shortIterationCount on normal-length iteration', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(60000, 1, []); // normal length — reset
			const result = sd.isStruggling();
			expect(result.struggling).toBe(false);
			expect(result.signals).not.toContain('short-iteration');
		});
	});

	// --- Repeated-error signal ---
	describe('repeated-error signal', () => {
		it('triggers when any error hash appears >= 2x', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(60000, 1, ['Error: something broke']);
			sd.recordIteration(60000, 1, ['Error: something broke']);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(true);
			expect(result.signals).toContain('repeated-error');
		});

		it('resets all error counts when zero errors in an iteration', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(60000, 1, ['Error: something broke']);
			sd.recordIteration(60000, 1, []); // zero errors — reset all
			sd.recordIteration(60000, 1, ['Error: something broke']);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(false);
			expect(result.signals).not.toContain('repeated-error');
		});
	});

	// --- Combined / reset ---
	describe('combined behavior', () => {
		it('single good iteration resets no-progress and short-iteration counters', () => {
			const sd = new StruggleDetector();
			// Build up counters
			sd.recordIteration(10000, 0, ['Error: fail']);
			sd.recordIteration(10000, 0, ['Error: fail']);
			// Good iteration: long, files changed, no errors
			sd.recordIteration(60000, 5, []);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(false);
			expect(result.signals).toEqual([]);
		});

		it('isStruggling returns multiple active signals', () => {
			const sd = new StruggleDetector();
			// 3 iterations: short, no progress, repeated errors
			sd.recordIteration(10000, 0, ['Error: same']);
			sd.recordIteration(10000, 0, ['Error: same']);
			sd.recordIteration(10000, 0, ['Error: same']);
			const result = sd.isStruggling();
			expect(result.struggling).toBe(true);
			expect(result.signals).toContain('no-progress');
			expect(result.signals).toContain('short-iteration');
			expect(result.signals).toContain('repeated-error');
		});
	});

	// --- reset() ---
	describe('reset()', () => {
		it('resets all counters', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(10000, 0, ['Error: x']);
			sd.recordIteration(10000, 0, ['Error: x']);
			sd.recordIteration(10000, 0, ['Error: x']);
			expect(sd.isStruggling().struggling).toBe(true);
			sd.reset();
			expect(sd.isStruggling().struggling).toBe(false);
			expect(sd.isStruggling().signals).toEqual([]);
		});
	});

	// --- Custom thresholds ---
	describe('custom thresholds', () => {
		it('respects custom noProgressThreshold', () => {
			const sd = new StruggleDetector({ noProgressThreshold: 2 });
			sd.recordIteration(60000, 0, []);
			sd.recordIteration(60000, 0, []);
			expect(sd.isStruggling().struggling).toBe(true);
			expect(sd.isStruggling().signals).toContain('no-progress');
		});

		it('respects custom shortIterationThreshold', () => {
			const sd = new StruggleDetector({ shortIterationThreshold: 2 });
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			expect(sd.isStruggling().struggling).toBe(true);
			expect(sd.isStruggling().signals).toContain('short-iteration');
		});

		it('respects custom shortIterationMs', () => {
			const sd = new StruggleDetector({ shortIterationMs: 5000 });
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			sd.recordIteration(10000, 1, []);
			// 10000 > 5000, so no short-iteration signal
			expect(sd.isStruggling().signals).not.toContain('short-iteration');
		});
	});

	// --- Error extraction via regex ---
	describe('error extraction', () => {
		it('extracts errors from output lines matching the pattern', () => {
			const sd = new StruggleDetector();
			const errors = [
				'Some normal output',
				'Error: TypeScript compilation failed',
				'SyntaxError: Unexpected token',
				'All good here',
				'Failed: test xyz',
			];
			sd.recordIteration(60000, 1, errors);
			// 3 error lines extracted ≥ 2 threshold doesn't apply per-line:
			// Each error line gets its own hash. Need same error twice for repeated-error signal.
			const result = sd.isStruggling();
			// Only one occurrence of each error, so repeated-error should NOT trigger
			expect(result.signals).not.toContain('repeated-error');
		});

		it('filters non-error lines before tracking', () => {
			const sd = new StruggleDetector();
			sd.recordIteration(60000, 1, ['normal output line']);
			sd.recordIteration(60000, 1, ['normal output line']);
			// Non-error lines should not contribute to repeated-error signal
			const result = sd.isStruggling();
			expect(result.signals).not.toContain('repeated-error');
		});
	});
});
