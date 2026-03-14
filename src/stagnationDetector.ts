import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

export interface StagnationEvaluation {
    stagnating: boolean;
    staleIterations: number;
    filesUnchanged: string[];
}

export class StagnationDetector {
    private previousHashes = new Map<string, string>();
    private currentHashes = new Map<string, string>();
    private staleCount = 0;
    private readonly hashFiles: string[];
    private readonly maxStaleIterations: number;
    private hasPrevious = false;

    constructor(
        hashFiles: string[] = ['progress.txt', 'PRD.md'],
        maxStaleIterations: number = 2,
    ) {
        this.hashFiles = hashFiles;
        this.maxStaleIterations = maxStaleIterations;
    }

    snapshot(workspaceRoot: string): void {
        this.currentHashes = new Map();
        for (const file of this.hashFiles) {
            const fullPath = path.join(workspaceRoot, file);
            let content = '';
            try {
                content = fs.readFileSync(fullPath, 'utf-8');
            } catch {
                // Missing file → hash empty string
            }
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            this.currentHashes.set(file, hash);
        }
    }

    evaluate(): StagnationEvaluation {
        const filesUnchanged: string[] = [];

        if (this.hasPrevious) {
            let allUnchanged = true;
            for (const file of this.hashFiles) {
                const prev = this.previousHashes.get(file);
                const curr = this.currentHashes.get(file);
                if (prev === curr) {
                    filesUnchanged.push(file);
                } else {
                    allUnchanged = false;
                }
            }

            if (allUnchanged) {
                this.staleCount++;
            } else {
                this.staleCount = 0;
            }
        }

        const stagnating = this.staleCount >= this.maxStaleIterations;

        // Copy current to previous
        this.previousHashes = new Map(this.currentHashes);
        this.hasPrevious = true;

        return {
            stagnating,
            staleIterations: this.staleCount,
            filesUnchanged,
        };
    }

    reset(): void {
        this.previousHashes.clear();
        this.currentHashes.clear();
        this.staleCount = 0;
        this.hasPrevious = false;
    }
}
