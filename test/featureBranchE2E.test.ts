import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LoopOrchestrator } from '../src/orchestrator';
import { parsePrdTitle, deriveBranchName } from '../src/prd';
import { getCurrentBranch, atomicCommit, branchExists, getShortHash } from '../src/gitOps';
import { SessionPersistence } from '../src/sessionPersistence';
import {
    DEFAULT_CONFIG,
    DEFAULT_BEARINGS_CONFIG,
    LoopEventKind,
} from '../src/types';

/**
 * Task 125 — CHECKPOINT: Feature Branch Enforcement E2E
 *
 * End-to-end tests using real git repos in temp dirs to verify
 * the full feature branch lifecycle:
 * (1) Start on main → creates ralph/<slug>, commits land there
 * (2) Stop and resume → session restores branch context
 * (3) Branch contains full commit history reviewable via git log
 * (4) featureBranch.enabled: false → backward compatible
 * (5) No regressions — clean compile, full vitest green
 */

const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initGitRepo(dir: string): void {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@test.com']);
    git(dir, ['config', 'user.name', 'Test']);
    // Create initial commit on main
    fs.writeFileSync(path.join(dir, 'README.md'), '# initial');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'initial commit']);
    // Ensure we're on main
    try {
        git(dir, ['branch', '-M', 'main']);
    } catch {
        // already on main
    }
}

describe('Feature Branch Enforcement E2E', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-'));
        initGitRepo(tmpDir);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // --- (1) Start on main → creates ralph/<slug>, commits land there, main untouched ---

    describe('(1) Start on main creates feature branch and commits land there', () => {
        it('orchestrator creates ralph/<slug>-<hash> branch from PRD title when starting on main', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# My Test Project\n\n- [x] **Task 1 — Done**: completed\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('My Test Project', shortHash);

            const events: any[] = [];
            const orch = new LoopOrchestrator(
                {
                    ...DEFAULT_CONFIG,
                    workspaceRoot: tmpDir,
                    maxIterations: 1,
                    bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
                    featureBranch: { enabled: true },
                },
                noopLogger,
                (e: any) => events.push(e),
            );
            await orch.start();

            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe(expectedBranch);

            // Main should be untouched (still exists)
            const mainExists = await branchExists(tmpDir, 'main');
            expect(mainExists).toBe(true);

            // BranchCreated event should have fired
            const created = events.find(e => e.kind === LoopEventKind.BranchCreated);
            expect(created).toBeDefined();
            expect(created.branchName).toBe(expectedBranch);
        });

        it('atomicCommit places commits on feature branch, not main', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Commit Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

            // Create and switch to feature branch
            const expectedBranch = deriveBranchName(parsePrdTitle('# Commit Test')!);
            git(tmpDir, ['checkout', '-b', expectedBranch]);

            // Make a change and commit
            fs.writeFileSync(path.join(tmpDir, 'newfile.txt'), 'content');
            const result = await atomicCommit(
                tmpDir,
                { id: 1, taskId: 'Task 1', title: 'Task 1', description: 'test commit', status: 'pending' as any },
                'inv-1',
            );
            expect(result.success).toBe(true);

            // Verify commit is on feature branch
            const featureLog = git(tmpDir, ['log', '--oneline', expectedBranch]);
            expect(featureLog).toContain('test commit');

            // Verify main does NOT have this commit
            const mainLog = git(tmpDir, ['log', '--oneline', 'main']);
            expect(mainLog).not.toContain('test commit');
        });

    });

    // --- (2) Stop and resume → session correctly restores branch context ---

    describe('(2) Stop and resume restores branch context', () => {
        it('session saves branch name and loads it back', () => {
            const persistence = new SessionPersistence();
            persistence.save(tmpDir, {
                currentTaskIndex: 0,
                iterationCount: 1,
                nudgeCount: 0,
                retryCount: 0,
                circuitBreakerState: 'active',
                timestamp: Date.now(),
                version: 1,
                branchName: 'ralph/my-test-project',
            });

            const loaded = persistence.load(tmpDir);
            expect(loaded).not.toBeNull();
            expect(loaded!.branchName).toBe('ralph/my-test-project');
        });

        it('session detects branch mismatch when current differs from stored', () => {
            const persistence = new SessionPersistence();
            persistence.save(tmpDir, {
                currentTaskIndex: 0,
                iterationCount: 1,
                nudgeCount: 0,
                retryCount: 0,
                circuitBreakerState: 'active',
                timestamp: Date.now(),
                version: 1,
                branchName: 'ralph/my-test-project',
            });

            // Load with different current branch
            const loaded = persistence.load(tmpDir, 'main');
            expect(loaded).not.toBeNull();
            expect(loaded!.branchMismatch).toBe(true);
        });

        it('session does not flag mismatch when branches match', () => {
            const persistence = new SessionPersistence();
            persistence.save(tmpDir, {
                currentTaskIndex: 0,
                iterationCount: 1,
                nudgeCount: 0,
                retryCount: 0,
                circuitBreakerState: 'active',
                timestamp: Date.now(),
                version: 1,
                branchName: 'ralph/my-test-project',
            });

            const loaded = persistence.load(tmpDir, 'ralph/my-test-project');
            expect(loaded).not.toBeNull();
            expect(loaded!.branchMismatch).toBeUndefined();
        });

        it('orchestrator creates new branch from main even when old branch exists', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Resume Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

            // Create an old feature branch and switch back to main
            git(tmpDir, ['checkout', '-b', 'ralph/resume-test']);
            git(tmpDir, ['checkout', 'main']);

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('Resume Test', shortHash);

            // Start orchestrator — new linear flow always creates new branch
            const events: any[] = [];
            const orch = new LoopOrchestrator(
                {
                    ...DEFAULT_CONFIG,
                    workspaceRoot: tmpDir,
                    maxIterations: 1,
                    bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
                    featureBranch: { enabled: true },
                },
                noopLogger,
                (e: any) => events.push(e),
            );
            await orch.start();

            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe(expectedBranch);

            const created = events.find(e => e.kind === LoopEventKind.BranchCreated);
            expect(created).toBeDefined();
            expect(created.branchName).toBe(expectedBranch);
        });
    });

    // --- (3) Branch contains full commit history reviewable via git log ---

    describe('(3) Feature branch contains full commit history', () => {
        it('multiple commits on feature branch are all reviewable via git log', async () => {
            const branchName = 'ralph/history-test';
            git(tmpDir, ['checkout', '-b', branchName]);

            // Simulate 3 task commits
            for (let i = 1; i <= 3; i++) {
                fs.writeFileSync(path.join(tmpDir, `task${i}.txt`), `content ${i}`);
                const result = await atomicCommit(
                    tmpDir,
                    { id: i, taskId: `Task ${i}`, title: `Task ${i}`, description: `implement task ${i}`, status: 'pending' as any },
                    `inv-${i}`,
                );
                expect(result.success).toBe(true);
            }

            // git log on feature branch should show all 3 commits
            const log = git(tmpDir, ['log', '--oneline', branchName]);
            expect(log).toContain('implement task 1');
            expect(log).toContain('implement task 2');
            expect(log).toContain('implement task 3');

            // main should only have the initial commit
            const mainLog = git(tmpDir, ['log', '--oneline', 'main']);
            expect(mainLog).not.toContain('implement task');
        });

        it('feature branch can be merged into main', async () => {
            const branchName = 'ralph/merge-test';
            git(tmpDir, ['checkout', '-b', branchName]);

            fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature content');
            await atomicCommit(
                tmpDir,
                { id: 1, taskId: 'Task 1', title: 'Task 1', description: 'add feature', status: 'pending' as any },
                'inv-1',
            );

            // Switch to main and merge
            git(tmpDir, ['checkout', 'main']);
            git(tmpDir, ['merge', branchName, '--no-ff', '-m', 'merge feature']);

            // Main should now have the feature commit
            const mainLog = git(tmpDir, ['log', '--oneline', 'main']);
            expect(mainLog).toContain('merge feature');

            // Feature file should exist on main
            expect(fs.existsSync(path.join(tmpDir, 'feature.txt'))).toBe(true);
        });

        it('feature branch can be discarded without affecting main', async () => {
            const branchName = 'ralph/discard-test';
            git(tmpDir, ['checkout', '-b', branchName]);

            fs.writeFileSync(path.join(tmpDir, 'discard.txt'), 'content');
            await atomicCommit(
                tmpDir,
                { id: 1, taskId: 'Task 1', title: 'Task 1', description: 'discard me', status: 'pending' as any },
                'inv-1',
            );

            // Switch back to main
            git(tmpDir, ['checkout', 'main']);

            // Main doesn't have the file
            expect(fs.existsSync(path.join(tmpDir, 'discard.txt'))).toBe(false);

            // Delete the branch
            git(tmpDir, ['branch', '-D', branchName]);

            // Branch gone, main intact
            const exists = await branchExists(tmpDir, branchName);
            expect(exists).toBe(false);

            const mainLog = git(tmpDir, ['log', '--oneline', 'main']);
            expect(mainLog).not.toContain('discard me');
        });
    });

    // --- (4) featureBranch.enabled: false → commits go to current branch (backward compatible) ---

    describe('(4) featureBranch disabled is backward compatible', () => {
        it('orchestrator does not create or switch branches when disabled', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Disabled Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

            const events: any[] = [];
            const orch = new LoopOrchestrator(
                {
                    ...DEFAULT_CONFIG,
                    workspaceRoot: tmpDir,
                    maxIterations: 1,
                    bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
                    featureBranch: { enabled: false },
                },
                noopLogger,
                (e: any) => events.push(e),
            );
            await orch.start();

            // Should still be on main
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('main');

            // No branch events
            expect(events.find(e => e.kind === LoopEventKind.BranchCreated)).toBeUndefined();
            expect(events.find(e => e.kind === LoopEventKind.BranchValidated)).toBeUndefined();
            expect(events.find(e => e.kind === LoopEventKind.BranchEnforcementFailed)).toBeUndefined();
        });

        it('commits go to current branch when feature branch is disabled', async () => {
            // Stay on main — without branch guard, commits should succeed on main
            fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
            const result = await atomicCommit(
                tmpDir,
                { id: 1, taskId: 'Task 1', title: 'Task 1', description: 'direct commit', status: 'pending' as any },
                'inv-1',
            );
            expect(result.success).toBe(true);

            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('main');

            const log = git(tmpDir, ['log', '--oneline', 'main']);
            expect(log).toContain('direct commit');
        });
    });

    // --- (5) Cross-component integration: PRD → branch name → orchestrator → gitOps → session ---

    describe('(5) Full pipeline integration', () => {
        it('parsePrdTitle + deriveBranchName produce correct branch for orchestrator', () => {
            const prdContent = '# Ralph Loop V2 — Phase 1 Self-Fix PRD\n\n- [ ] **Task 1**: do something';
            const title = parsePrdTitle(prdContent);
            expect(title).toBe('Ralph Loop V2 — Phase 1 Self-Fix PRD');

            const branch = deriveBranchName(title!);
            expect(branch).toMatch(/^ralph\//);
            expect(branch).toBe('ralph/ralph-loop-v2-phase-1-self-fix-prd');
        });

        it('orchestrator state snapshot includes branch after gate', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Snapshot Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('Snapshot Test', shortHash);

            const orch = new LoopOrchestrator(
                {
                    ...DEFAULT_CONFIG,
                    workspaceRoot: tmpDir,
                    maxIterations: 1,
                    bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
                    featureBranch: { enabled: true },
                },
                noopLogger,
                () => { },
            );
            await orch.start();

            const snapshot = orch.getStateSnapshot();
            expect(snapshot.branch).toBe(expectedBranch);
        });

        it('DEFAULT_CONFIG has feature branch disabled by default', () => {
            expect(DEFAULT_CONFIG.featureBranch).toBeDefined();
            expect(DEFAULT_CONFIG.featureBranch!.enabled).toBe(false);
        });
    });
});
