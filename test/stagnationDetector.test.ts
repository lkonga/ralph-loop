import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StagnationDetector, AutoDecomposer } from '../src/stagnationDetector';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

vi.mock('fs');

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

describe('StagnationDetector', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('reports no stagnation when files change between snapshots', () => {
        const detector = new StagnationDetector(['progress.txt', 'PRD.md'], 2);

        // First snapshot
        vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
            if (String(filePath).endsWith('progress.txt')) { return 'initial progress'; }
            if (String(filePath).endsWith('PRD.md')) { return 'initial prd'; }
            throw new Error('not found');
        });
        detector.snapshot('/workspace');

        // Evaluate first time — no previous, should not stagnate
        const result1 = detector.evaluate();
        expect(result1.stagnating).toBe(false);
        expect(result1.staleIterations).toBe(0);

        // Second snapshot with changed files
        vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
            if (String(filePath).endsWith('progress.txt')) { return 'updated progress'; }
            if (String(filePath).endsWith('PRD.md')) { return 'updated prd'; }
            throw new Error('not found');
        });
        detector.snapshot('/workspace');

        const result2 = detector.evaluate();
        expect(result2.stagnating).toBe(false);
        expect(result2.staleIterations).toBe(0);
        expect(result2.filesUnchanged).toEqual([]);
    });

    it('detects stagnation after maxStaleIterations unchanged', () => {
        const detector = new StagnationDetector(['progress.txt', 'PRD.md'], 2);

        vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
            if (String(filePath).endsWith('progress.txt')) { return 'same content'; }
            if (String(filePath).endsWith('PRD.md')) { return 'same prd'; }
            throw new Error('not found');
        });

        // Iteration 1: first snapshot + evaluate (no previous → staleCount stays 0)
        detector.snapshot('/workspace');
        const r1 = detector.evaluate();
        expect(r1.stagnating).toBe(false);
        expect(r1.staleIterations).toBe(0);

        // Iteration 2: same content → staleCount = 1
        detector.snapshot('/workspace');
        const r2 = detector.evaluate();
        expect(r2.stagnating).toBe(false);
        expect(r2.staleIterations).toBe(1);

        // Iteration 3: same content → staleCount = 2 >= maxStaleIterations
        detector.snapshot('/workspace');
        const r3 = detector.evaluate();
        expect(r3.stagnating).toBe(true);
        expect(r3.staleIterations).toBe(2);
        expect(r3.filesUnchanged).toContain('progress.txt');
        expect(r3.filesUnchanged).toContain('PRD.md');
    });

    it('resets stale counter when any file changes', () => {
        const detector = new StagnationDetector(['progress.txt', 'PRD.md'], 2);
        let progressContent = 'v1';

        vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
            if (String(filePath).endsWith('progress.txt')) { return progressContent; }
            if (String(filePath).endsWith('PRD.md')) { return 'same prd'; }
            throw new Error('not found');
        });

        // First snapshot + evaluate
        detector.snapshot('/workspace');
        detector.evaluate();

        // Same content → staleCount = 1
        detector.snapshot('/workspace');
        const r2 = detector.evaluate();
        expect(r2.staleIterations).toBe(1);

        // Change progress.txt → staleCount resets to 0
        progressContent = 'v2';
        detector.snapshot('/workspace');
        const r3 = detector.evaluate();
        expect(r3.stagnating).toBe(false);
        expect(r3.staleIterations).toBe(0);
    });

    it('handles missing files without crashing', () => {
        const detector = new StagnationDetector(['missing.txt', 'also-missing.md'], 2);

        vi.mocked(fs.readFileSync).mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory');
        });

        expect(() => detector.snapshot('/workspace')).not.toThrow();

        const result = detector.evaluate();
        expect(result.stagnating).toBe(false);
    });

    it('reset() clears all state', () => {
        const detector = new StagnationDetector(['progress.txt'], 1);

        vi.mocked(fs.readFileSync).mockReturnValue('same content');

        detector.snapshot('/workspace');
        detector.evaluate();

        // Same content → staleCount = 1 >= maxStaleIterations (1)
        detector.snapshot('/workspace');
        const r2 = detector.evaluate();
        expect(r2.stagnating).toBe(true);

        // Reset and verify clean state
        detector.reset();

        detector.snapshot('/workspace');
        const r3 = detector.evaluate();
        expect(r3.stagnating).toBe(false);
        expect(r3.staleIterations).toBe(0);
    });

    it('uses default constructor values', () => {
        const detector = new StagnationDetector();

        vi.mocked(fs.readFileSync).mockReturnValue('content');

        // Should work with defaults (progress.txt, PRD.md, maxStaleIterations=2)
        expect(() => detector.snapshot('/workspace')).not.toThrow();
        const result = detector.evaluate();
        expect(result.stagnating).toBe(false);
    });

    it('reports only unchanged files in filesUnchanged', () => {
        const detector = new StagnationDetector(['a.txt', 'b.txt'], 2);
        let aContent = 'a1';

        vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
            if (String(filePath).endsWith('a.txt')) { return aContent; }
            if (String(filePath).endsWith('b.txt')) { return 'same b'; }
            throw new Error('not found');
        });

        detector.snapshot('/workspace');
        detector.evaluate();

        // Change a.txt only → not all unchanged → staleCount resets
        aContent = 'a2';
        detector.snapshot('/workspace');
        const r2 = detector.evaluate();
        expect(r2.staleIterations).toBe(0);
        expect(r2.filesUnchanged).toContain('b.txt');
        expect(r2.filesUnchanged).not.toContain('a.txt');
    });
});

describe('AutoDecomposer', () => {
    it('shouldDecompose returns false below threshold', () => {
        const decomposer = new AutoDecomposer();
        expect(decomposer.shouldDecompose('task-1', 1, 3)).toBe(false);
        expect(decomposer.shouldDecompose('task-1', 2, 3)).toBe(false);
    });

    it('shouldDecompose returns true at threshold', () => {
        const decomposer = new AutoDecomposer();
        expect(decomposer.shouldDecompose('task-1', 3, 3)).toBe(true);
        expect(decomposer.shouldDecompose('task-1', 5, 3)).toBe(true);
    });

    it('shouldDecompose uses default threshold of 3', () => {
        const decomposer = new AutoDecomposer();
        expect(decomposer.shouldDecompose('task-1', 2)).toBe(false);
        expect(decomposer.shouldDecompose('task-1', 3)).toBe(true);
    });

    it('decomposeTask generates valid checkbox lines for sentence boundaries', () => {
        const decomposer = new AutoDecomposer();
        const task = { id: 0, taskId: 'Task-001', description: 'First thing to do. Second thing to do. Third thing to do.', status: 'pending', lineNumber: 5 };
        const prdContent = '- [ ] First thing to do. Second thing to do. Third thing to do.\n- [ ] Another task\n';
        const result = decomposer.decomposeTask(task, prdContent);

        // Should contain [DECOMPOSED] marker on parent
        expect(result).toContain('[DECOMPOSED]');
        // Should contain sub-task checkbox lines
        const lines = result.split('\n');
        const subTaskLines = lines.filter((l: string) => l.match(/^\s*- \[ \] Sub-task:/));
        expect(subTaskLines.length).toBeGreaterThanOrEqual(2);
        expect(subTaskLines.length).toBeLessThanOrEqual(3);
        // Sub-tasks should be below the parent line
        const decomposedIdx = lines.findIndex((l: string) => l.includes('[DECOMPOSED]'));
        const firstSubIdx = lines.findIndex((l: string) => l.includes('Sub-task:'));
        expect(firstSubIdx).toBeGreaterThan(decomposedIdx);
    });

    it('decomposeTask generates valid checkbox lines for semicolons', () => {
        const decomposer = new AutoDecomposer();
        const task = { id: 0, taskId: 'Task-001', description: 'Do A; Do B; Do C', status: 'pending', lineNumber: 1 };
        const prdContent = '- [ ] Do A; Do B; Do C\n';
        const result = decomposer.decomposeTask(task, prdContent);

        const lines = result.split('\n');
        const subTaskLines = lines.filter((l: string) => l.match(/^\s*- \[ \] Sub-task:/));
        expect(subTaskLines.length).toBeGreaterThanOrEqual(2);
        expect(subTaskLines.length).toBeLessThanOrEqual(3);
    });

    it('decomposeTask generates valid checkbox lines for numbered steps', () => {
        const decomposer = new AutoDecomposer();
        const task = { id: 0, taskId: 'Task-001', description: '(1) Do X (2) Do Y (3) Do Z', status: 'pending', lineNumber: 1 };
        const prdContent = '- [ ] (1) Do X (2) Do Y (3) Do Z\n';
        const result = decomposer.decomposeTask(task, prdContent);

        const lines = result.split('\n');
        const subTaskLines = lines.filter((l: string) => l.match(/^\s*- \[ \] Sub-task:/));
        expect(subTaskLines.length).toBeGreaterThanOrEqual(2);
        expect(subTaskLines.length).toBeLessThanOrEqual(3);
    });

    it('decomposeTask preserves other PRD lines', () => {
        const decomposer = new AutoDecomposer();
        const task = { id: 0, taskId: 'Task-001', description: 'First step. Second step.', status: 'pending', lineNumber: 2 };
        const prdContent = '# My PRD\n- [ ] First step. Second step.\n- [ ] Another task\n';
        const result = decomposer.decomposeTask(task, prdContent);

        expect(result).toContain('# My PRD');
        expect(result).toContain('- [ ] Another task');
    });
});
