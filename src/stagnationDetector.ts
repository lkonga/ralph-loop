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

export class AutoDecomposer {
    shouldDecompose(taskId: string, failCount: number, threshold: number = 3): boolean {
        return failCount >= threshold;
    }

    decomposeTask(task: { description: string; lineNumber: number }, prdContent: string): string {
        const parts = this.splitAtBoundaries(task.description);
        const subTasks = parts.slice(0, 3).map(p => `  - [ ] Sub-task: ${p.trim()}`);

        const lines = prdContent.split('\n');
        const taskLineIdx = lines.findIndex(line => {
            const unchecked = /^(\s*)-\s*\[\s*\]\s+(.+)$/.exec(line);
            if (unchecked && unchecked[2].trim() === task.description.trim()) { return true; }
            return false;
        });

        if (taskLineIdx >= 0) {
            lines[taskLineIdx] = lines[taskLineIdx].replace(
                /^(\s*-\s*\[\s*\]\s+)/,
                '$1[DECOMPOSED] ',
            );
            lines.splice(taskLineIdx + 1, 0, ...subTasks);
        }

        return lines.join('\n');
    }

    private splitAtBoundaries(description: string): string[] {
        // Try numbered steps: (1) ... (2) ... (3) ...
        const numberedParts = description.split(/\(\d+\)\s*/).filter(s => s.trim().length > 0);
        if (numberedParts.length >= 2) { return numberedParts.slice(0, 3); }

        // Try semicolons
        const semiParts = description.split(/;\s*/).filter(s => s.trim().length > 0);
        if (semiParts.length >= 2) { return semiParts.slice(0, 3); }

        // Try sentence boundaries
        const sentenceParts = description.split(/\.\s+/).filter(s => s.trim().length > 0);
        if (sentenceParts.length >= 2) { return sentenceParts.slice(0, 3); }

        // Fallback: split in half
        const mid = Math.ceil(description.length / 2);
        const spaceNearMid = description.indexOf(' ', mid);
        if (spaceNearMid > 0) {
            return [description.slice(0, spaceNearMid), description.slice(spaceNearMid + 1)];
        }
        return [description];
    }
}
