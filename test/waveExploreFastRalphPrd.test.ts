import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const PROMPT_PATH = resolve(__dirname, '../../vscode-config-files/prompts.source/wave-explore-fast.prompt.md');

describe('wave-explore-fast --ralph-prd (Task 31)', () => {
    let content: string;

    beforeAll(() => {
        expect(existsSync(PROMPT_PATH)).toBe(true);
        content = readFileSync(PROMPT_PATH, 'utf-8');
    });

    describe('argument-hint', () => {
        it('should include --ralph-prd in the argument-hint', () => {
            const fm = content.match(/^---\n([\s\S]*?)\n---/);
            expect(fm).not.toBeNull();
            expect(fm![1]).toContain('--ralph-prd');
        });
    });

    describe('delegation logic', () => {
        it('should contain instructions to delegate to wave-orchestrator --ralph-prd mode', () => {
            expect(content).toMatch(/--ralph-prd/);
            expect(content).toMatch(/wave-orchestrator/i);
        });

        it('should indicate --ralph-prd bypasses the standard explore flow', () => {
            expect(content).toMatch(/delegate|bypass|instead of.*standard|skip.*explore/i);
        });

        it('should pass through to wave-orchestrator --ralph-prd mode', () => {
            expect(content).toMatch(/wave-orchestrator.*--ralph-prd|--ralph-prd.*wave-orchestrator/i);
        });
    });
});
