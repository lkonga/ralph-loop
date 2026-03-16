import { ErrorHashTracker } from './circuitBreaker';

const ERROR_PATTERN = /error:|failed:|exception:|typeerror|syntaxerror/i;

export interface ConvergenceSnapshot {
    errorCount: number;
    testPassCount: number;
    uniqueErrorCount: number;
    filesEdited: string[];
}

export type BackpressureClassification = 'productive' | 'stagnant' | 'thrashing';

export interface BackpressureClassifierConfig {
    historySize?: number;
    thrashingDetector?: ThrashingDetector;
}

export class BackpressureClassifier {
    private history: ConvergenceSnapshot[] = [];
    private readonly historySize: number;
    private readonly thrashingDetector?: ThrashingDetector;

    constructor(config?: BackpressureClassifierConfig) {
        this.historySize = config?.historySize ?? 3;
        this.thrashingDetector = config?.thrashingDetector;
    }

    update(snapshot: ConvergenceSnapshot): void {
        this.history.push(snapshot);
        if (this.history.length > this.historySize) {
            this.history.shift();
        }
    }

    classify(): BackpressureClassification {
        // Thrashing takes priority — delegate to ThrashingDetector
        if (this.thrashingDetector?.isThrashing().thrashing) {
            return 'thrashing';
        }

        if (this.history.length < 2) {
            return 'productive';
        }

        // Check productive: error count decreasing over snapshots
        let errorsDecreasing = true;
        for (let i = 1; i < this.history.length; i++) {
            if (this.history[i].errorCount >= this.history[i - 1].errorCount) {
                errorsDecreasing = false;
                break;
            }
        }
        if (errorsDecreasing) {
            return 'productive';
        }

        // Check productive: test pass count increasing
        let testsIncreasing = true;
        for (let i = 1; i < this.history.length; i++) {
            if (this.history[i].testPassCount <= this.history[i - 1].testPassCount) {
                testsIncreasing = false;
                break;
            }
        }
        if (testsIncreasing) {
            return 'productive';
        }

        // Check stagnant: errors flat AND low unique/total ratio
        const latest = this.history[this.history.length - 1];
        let errorsFlat = true;
        for (let i = 1; i < this.history.length; i++) {
            if (this.history[i].errorCount !== this.history[i - 1].errorCount) {
                errorsFlat = false;
                break;
            }
        }
        const uniqueRatio = latest.errorCount > 0
            ? latest.uniqueErrorCount / latest.errorCount
            : 1;
        if (errorsFlat && uniqueRatio < 0.3) {
            return 'stagnant';
        }

        // Default: not clearly productive or stagnant
        return 'stagnant';
    }

    reset(): void {
        this.history = [];
    }
}

export interface ThrashingConfig {
    regionRepetitionThreshold: number;
    windowSize: number;
}

export class ThrashingDetector {
    readonly config: ThrashingConfig;
    private window: { file: string; regionHash: string }[] = [];

    constructor(config?: Partial<ThrashingConfig>) {
        this.config = {
            regionRepetitionThreshold: config?.regionRepetitionThreshold ?? 3,
            windowSize: config?.windowSize ?? 10,
        };
    }

    recordEdit(file: string, regionHash: string): void {
        this.window.push({ file, regionHash });
        if (this.window.length > this.config.windowSize) {
            this.window.shift();
        }
    }

    isThrashing(): { thrashing: boolean; file?: string; editCount?: number } {
        const counts = new Map<string, { file: string; count: number }>();
        for (const entry of this.window) {
            const key = `${entry.file}:${entry.regionHash}`;
            const existing = counts.get(key);
            if (existing) {
                existing.count++;
            } else {
                counts.set(key, { file: entry.file, count: 1 });
            }
        }
        for (const [, value] of counts) {
            if (value.count >= this.config.regionRepetitionThreshold) {
                return { thrashing: true, file: value.file, editCount: value.count };
            }
        }
        return { thrashing: false };
    }

    reset(): void {
        this.window = [];
    }
}

export interface StruggleDetectorConfig {
    noProgressThreshold?: number;
    shortIterationThreshold?: number;
    shortIterationMs?: number;
}

export class StruggleDetector {
    private noProgressCount = 0;
    private shortIterationCount = 0;
    private errorTracker = new ErrorHashTracker();
    private thrashingDetector: ThrashingDetector;

    private readonly noProgressThreshold: number;
    private readonly shortIterationThreshold: number;
    private readonly shortIterationMs: number;

    constructor(config?: StruggleDetectorConfig, thrashingConfig?: Partial<ThrashingConfig>) {
        this.noProgressThreshold = config?.noProgressThreshold ?? 3;
        this.shortIterationThreshold = config?.shortIterationThreshold ?? 3;
        this.shortIterationMs = config?.shortIterationMs ?? 30000;
        this.thrashingDetector = new ThrashingDetector(thrashingConfig);
    }

    recordEdit(file: string, regionHash: string): void {
        this.thrashingDetector.recordEdit(file, regionHash);
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
        // Thrashing: same region edited repeatedly
        if (this.thrashingDetector.isThrashing().thrashing) {
            signals.push('thrashing');
        }

        return { struggling: signals.length > 0, signals };
    }

    reset(): void {
        this.noProgressCount = 0;
        this.shortIterationCount = 0;
        this.errorTracker.reset();
        this.thrashingDetector.reset();
    }
}
