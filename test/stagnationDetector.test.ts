import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StagnationDetector } from '../src/stagnationDetector';
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
