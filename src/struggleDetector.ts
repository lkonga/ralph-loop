import { ErrorHashTracker } from './circuitBreaker';

const ERROR_PATTERN = /error:|failed:|exception:|typeerror|syntaxerror/i;

export interface StruggleDetectorConfig {
	noProgressThreshold?: number;
	shortIterationThreshold?: number;
	shortIterationMs?: number;
}

export class StruggleDetector {
	private noProgressCount = 0;
	private shortIterationCount = 0;
	private errorTracker = new ErrorHashTracker();

	private readonly noProgressThreshold: number;
	private readonly shortIterationThreshold: number;
	private readonly shortIterationMs: number;

	constructor(config?: StruggleDetectorConfig) {
		this.noProgressThreshold = config?.noProgressThreshold ?? 3;
		this.shortIterationThreshold = config?.shortIterationThreshold ?? 3;
		this.shortIterationMs = config?.shortIterationMs ?? 30000;
	}

	recordIteration(duration: number, filesChanged: number, errors: string[]): void {
		// No-progress signal
		if (filesChanged === 0) {
			this.noProgressCount++;
		} else {
			this.noProgressCount = 0;
		}

		// Short-iteration signal
		if (duration < this.shortIterationMs) {
			this.shortIterationCount++;
		} else {
			this.shortIterationCount = 0;
		}

		// Repeated-error signal: filter lines matching error pattern
		const errorLines = errors.filter(line => ERROR_PATTERN.test(line));
		if (errorLines.length === 0) {
			this.errorTracker.reset();
		} else {
			for (const line of errorLines) {
				this.errorTracker.record(line);
			}
		}
	}

	isStruggling(): { struggling: boolean; signals: string[] } {
		const signals: string[] = [];

		if (this.noProgressCount >= this.noProgressThreshold) {
			signals.push('no-progress');
		}
		if (this.shortIterationCount >= this.shortIterationThreshold) {
			signals.push('short-iteration');
		}
		// Repeated-error: any hash appearing >= 2x triggers
		if (this.errorTracker.getRepeatingEntries(2).length > 0) {
			signals.push('repeated-error');
		}

		return { struggling: signals.length > 0, signals };
	}

	reset(): void {
		this.noProgressCount = 0;
		this.shortIterationCount = 0;
		this.errorTracker.reset();
	}
}
