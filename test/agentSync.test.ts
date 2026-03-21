import { describe, it, expect } from 'vitest';
import { readdirSync, lstatSync, existsSync, realpathSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

const RALPH_AGENTS_DIR = resolve(__dirname, '../agents.source');
const CONFIG_AGENTS_DIR = resolve(__dirname, '../../vscode-config-files/agents.source');
const DOCS_DIR = resolve(__dirname, '../docs/conventions');

describe('Task 92 — Agent Sync via Symlinks', () => {
    // After ownership inversion: ralph-* agents are real files in ralph-loop,
    // wave agents live only in vscode-config-files (no symlinks in ralph-loop).

    describe('ralph-loop/agents.source/ contains ralph-owned agents as real files', () => {
        it('agents.source directory exists', () => {
            expect(existsSync(RALPH_AGENTS_DIR)).toBe(true);
        });

        const ralphAgents = [
            'ralph-executor.agent.md',
            'ralph-explore.agent.md',
            'ralph-research.agent.md',
        ];

        for (const agent of ralphAgents) {
            it(`${agent} is a regular file (source of truth)`, () => {
                const fullPath = join(RALPH_AGENTS_DIR, agent);
                expect(existsSync(fullPath)).toBe(true);
                const stat = lstatSync(fullPath);
                expect(stat.isSymbolicLink()).toBe(false);
                expect(stat.isFile()).toBe(true);
            });
        }

        it('only ralph-* agents exist in ralph-loop/agents.source/', () => {
            const files = readdirSync(RALPH_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
            const nonRalph = files.filter(f => !f.startsWith('ralph-'));
            expect(nonRalph).toEqual([]);
        });
    });

    describe('ralph-* agents are symlinked into vscode-config-files/agents.source/', () => {
        const ralphAgents = [
            'ralph-executor.agent.md',
            'ralph-explore.agent.md',
            'ralph-research.agent.md',
        ];

        for (const agent of ralphAgents) {
            it(`${agent} in vscode-config-files is a symlink pointing to ralph-loop`, () => {
                const fullPath = join(CONFIG_AGENTS_DIR, agent);
                expect(existsSync(fullPath)).toBe(true);
                const stat = lstatSync(fullPath);
                expect(stat.isSymbolicLink()).toBe(true);
                const resolved = realpathSync(fullPath);
                expect(resolved).toContain('ralph-loop/agents.source');
            });
        }
    });

    describe('wave agents are canonical files in vscode-config-files/agents.source/', () => {
        const waveAgents = [
            'wave-context-grounder.agent.md',
            'wave-spec-generator.agent.md',
            'wave-prd-generator.agent.md',
            'wave-orchestrator.agent.md',
        ];

        for (const agent of waveAgents) {
            it(`${agent} exists as a regular file in vscode-config-files`, () => {
                const fullPath = join(CONFIG_AGENTS_DIR, agent);
                expect(existsSync(fullPath)).toBe(true);
                const stat = lstatSync(fullPath);
                expect(stat.isSymbolicLink()).toBe(false);
                expect(stat.isFile()).toBe(true);
            });
        }
    });

    describe('all files in vscode-config-files/agents.source/ resolve without breakage', () => {
        it('no broken symlinks in vscode-config-files/agents.source/', () => {
            const files = readdirSync(CONFIG_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
            const broken: string[] = [];
            for (const f of files) {
                try {
                    const resolved = realpathSync(join(CONFIG_AGENTS_DIR, f));
                    if (!existsSync(resolved)) {
                        broken.push(f);
                    }
                } catch {
                    broken.push(f);
                }
            }
            expect(broken).toEqual([]);
        });
    });

    describe('documentation exists', () => {
        it('docs/conventions/agent-ownership.md exists', () => {
            expect(existsSync(join(DOCS_DIR, 'agent-ownership.md'))).toBe(true);
        });

        it('documents the centralized convention', () => {
            const content = readFileSync(join(DOCS_DIR, 'agent-ownership.md'), 'utf-8');
            expect(content).toContain('vscode-config-files');
            expect(content).toContain('symlink');
        });
    });
});
