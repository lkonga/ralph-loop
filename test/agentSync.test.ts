import { describe, it, expect } from 'vitest';
import { readdirSync, lstatSync, readlinkSync, existsSync, realpathSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

const RALPH_AGENTS_DIR = resolve(__dirname, '../agents');
const CONFIG_AGENTS_DIR = resolve(__dirname, '../../vscode-config-files/agents');
const SCRIPTS_DIR = resolve(__dirname, '../scripts');
const DOCS_DIR = resolve(__dirname, '../docs/conventions');

describe('Task 92 — Agent Sync via Symlinks', () => {
    describe('all ralph-loop/agents/*.agent.md are symlinks', () => {
        it('agents directory exists', () => {
            expect(existsSync(RALPH_AGENTS_DIR)).toBe(true);
        });

        it('every .agent.md file is a symbolic link, not a regular file', () => {
            const files = readdirSync(RALPH_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
            expect(files.length).toBeGreaterThan(0);
            const regularFiles: string[] = [];
            for (const f of files) {
                const stat = lstatSync(join(RALPH_AGENTS_DIR, f));
                if (!stat.isSymbolicLink()) {
                    regularFiles.push(f);
                }
            }
            expect(regularFiles).toEqual([]);
        });

        it('ralph-executor.agent.md is a symlink', () => {
            const stat = lstatSync(join(RALPH_AGENTS_DIR, 'ralph-executor.agent.md'));
            expect(stat.isSymbolicLink()).toBe(true);
        });

        it('ralph-explore.agent.md is a symlink', () => {
            const stat = lstatSync(join(RALPH_AGENTS_DIR, 'ralph-explore.agent.md'));
            expect(stat.isSymbolicLink()).toBe(true);
        });

        it('ralph-research.agent.md is a symlink', () => {
            const stat = lstatSync(join(RALPH_AGENTS_DIR, 'ralph-research.agent.md'));
            expect(stat.isSymbolicLink()).toBe(true);
        });
    });

    describe('all symlinks resolve to vscode-config-files/agents/', () => {
        it('every symlink target resolves to an existing file', () => {
            const files = readdirSync(RALPH_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
            const broken: string[] = [];
            for (const f of files) {
                const fullPath = join(RALPH_AGENTS_DIR, f);
                try {
                    const resolved = realpathSync(fullPath);
                    if (!existsSync(resolved)) {
                        broken.push(f);
                    }
                } catch {
                    broken.push(f);
                }
            }
            expect(broken).toEqual([]);
        });

        it('every symlink points into vscode-config-files/agents/', () => {
            const files = readdirSync(RALPH_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
            const wrongTarget: string[] = [];
            for (const f of files) {
                const resolved = realpathSync(join(RALPH_AGENTS_DIR, f));
                const normalizedConfigDir = realpathSync(CONFIG_AGENTS_DIR);
                if (!resolved.startsWith(normalizedConfigDir)) {
                    wrongTarget.push(`${f} -> ${resolved}`);
                }
            }
            expect(wrongTarget).toEqual([]);
        });

        it('symlink count equals total .agent.md file count', () => {
            const files = readdirSync(RALPH_AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
            const symlinks = files.filter(f => lstatSync(join(RALPH_AGENTS_DIR, f)).isSymbolicLink());
            expect(symlinks.length).toBe(files.length);
        });
    });

    describe('wave agents from earlier tasks are correctly symlinked', () => {
        const waveAgents = [
            'wave-context-grounder.agent.md',
            'wave-spec-generator.agent.md',
            'wave-prd-generator.agent.md',
            'wave-orchestrator.agent.md',
        ];

        for (const agent of waveAgents) {
            it(`${agent} is a symlink resolving to vscode-config-files`, () => {
                const fullPath = join(RALPH_AGENTS_DIR, agent);
                expect(existsSync(fullPath)).toBe(true);
                const stat = lstatSync(fullPath);
                expect(stat.isSymbolicLink()).toBe(true);
                const resolved = realpathSync(fullPath);
                expect(resolved).toContain('vscode-config-files/agents');
            });
        }
    });

    describe('canonical files in vscode-config-files/agents/ are regular files', () => {
        const canonicalAgents = [
            'ralph-executor.agent.md',
            'ralph-explore.agent.md',
            'ralph-research.agent.md',
        ];

        for (const agent of canonicalAgents) {
            it(`${agent} in vscode-config-files is a regular file (not a symlink)`, () => {
                const fullPath = join(CONFIG_AGENTS_DIR, agent);
                expect(existsSync(fullPath)).toBe(true);
                const stat = lstatSync(fullPath);
                expect(stat.isSymbolicLink()).toBe(false);
                expect(stat.isFile()).toBe(true);
            });
        }
    });

    describe('validation script exists', () => {
        it('scripts/check-agent-sync.sh exists', () => {
            expect(existsSync(join(SCRIPTS_DIR, 'check-agent-sync.sh'))).toBe(true);
        });

        it('scripts/check-agent-sync.sh is executable', () => {
            const stat = lstatSync(join(SCRIPTS_DIR, 'check-agent-sync.sh'));
            // Check user execute bit (0o100)
            expect(stat.mode & 0o111).toBeGreaterThan(0);
        });

        it('script detects broken symlinks concept present in content', () => {
            const content = readFileSync(join(SCRIPTS_DIR, 'check-agent-sync.sh'), 'utf-8');
            expect(content).toContain('symlink');
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
