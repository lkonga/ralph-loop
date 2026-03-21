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

            // After loop completes, orchestrator switches back to original branch
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('main');

            // Ralph branch should still exist
            const ralphBranchExists = await branchExists(tmpDir, expectedBranch);
            expect(ralphBranchExists).toBe(true);

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

            // After loop completes, orchestrator switches back to main
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('main');

            // New ralph branch was created (and still exists)
            const newBranchExists = await branchExists(tmpDir, expectedBranch);
            expect(newBranchExists).toBe(true);

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

    // --- (6) Switch back to original branch on loop completion ---

    describe('(6) Switch back to original branch on completion', () => {
        it('switches back to main after loop completes (AllDone)', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Switch Back Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

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
            expect(branch).toBe('main');

            const switchBack = events.find(e => e.kind === LoopEventKind.BranchSwitchedBack);
            expect(switchBack).toBeDefined();
            expect(switchBack.to).toBe('main');
        });

        it('ralph branch still exists after switch-back', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Branch Exists Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('Branch Exists Test', shortHash);

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

            const exists = await branchExists(tmpDir, expectedBranch);
            expect(exists).toBe(true);
        });
    });
});

/**
 * Task 137 — CHECKPOINT: Linear Branch Model E2E
 *
 * Comprehensive verification of the linear branch model:
 * (1) main → ralph/<slug>-<hash>, main untouched
 * (2) bisect/v0.39-lean → ralph/<slug>-<hash>, original untouched
 * (3) arbitrary branch → same behavior
 * (4) dirty working tree → WIP commit on ralph/ branch, original clean
 * (5) loop completes → switches back to original branch
 * (6) resume after stop → session persists originalBranch
 * (7) featureBranch.enabled: false → backward compatible
 * (8) no protectedBranches config needed
 * (9) no regressions
 */
describe('Task 137 — Linear Branch Model E2E', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-branch-e2e-'));
        initGitRepo(tmpDir);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // --- (2) Start on bisect/v0.39-lean → creates ralph/<slug>-<hash> from that HEAD ---

    describe('(2) Start on bisect/v0.39-lean', () => {
        it('creates ralph/<slug>-<hash> from bisect branch HEAD, original untouched', async () => {
            // Create bisect branch with commits
            git(tmpDir, ['checkout', '-b', 'bisect/v0.39-lean']);
            fs.writeFileSync(path.join(tmpDir, 'bisect-file.txt'), 'bisect content');
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'bisect commit']);

            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Bisect Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'add PRD']);
            // Capture HEAD after all commits on bisect branch
            const bisectHead = git(tmpDir, ['rev-parse', 'HEAD']);

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('Bisect Test', shortHash);

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

            // After completion, should switch back to bisect/v0.39-lean
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('bisect/v0.39-lean');

            // Ralph branch should exist
            const ralphExists = await branchExists(tmpDir, expectedBranch);
            expect(ralphExists).toBe(true);

            // bisect/v0.39-lean HEAD should be the same as before
            const bisectHeadAfter = git(tmpDir, ['rev-parse', 'bisect/v0.39-lean']);
            // Ralph branch was created from bisect HEAD, so bisect HEAD shouldn't have moved
            // (it should still be the same commit as before the orchestrator created a branch)
            expect(bisectHeadAfter).toBe(bisectHead);

            // BranchCreated and BranchSwitchedBack events
            const created = events.find(e => e.kind === LoopEventKind.BranchCreated);
            expect(created).toBeDefined();
            expect(created.branchName).toBe(expectedBranch);

            const switchBack = events.find(e => e.kind === LoopEventKind.BranchSwitchedBack);
            expect(switchBack).toBeDefined();
            expect(switchBack.to).toBe('bisect/v0.39-lean');
        });
    });

    // --- (3) Start on any arbitrary branch → same behavior ---

    describe('(3) Start on arbitrary branch', () => {
        it('creates ralph/<slug>-<hash> from feature/my-work branch', async () => {
            git(tmpDir, ['checkout', '-b', 'feature/my-work']);
            fs.writeFileSync(path.join(tmpDir, 'work.txt'), 'in progress');
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'work in progress']);

            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Arbitrary Branch\n\n- [x] **Task 1 — Done**: done\n',
            );
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'add PRD']);

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('Arbitrary Branch', shortHash);

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

            // Switches back to original
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('feature/my-work');

            // Ralph branch exists
            expect(await branchExists(tmpDir, expectedBranch)).toBe(true);

            // Events fired
            expect(events.find(e => e.kind === LoopEventKind.BranchCreated)).toBeDefined();
            expect(events.find(e => e.kind === LoopEventKind.BranchSwitchedBack)?.to).toBe('feature/my-work');
        });
    });

    // --- (4) Dirty working tree → WIP commit on ralph/ branch, original clean ---

    describe('(4) Dirty working tree handling', () => {
        it('dirty state is committed as WIP on ralph/ branch, original branch stays clean', async () => {
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Dirty Test\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'add prd']);

            const mainHeadBefore = git(tmpDir, ['rev-parse', 'HEAD']);

            // Create dirty state (unstaged file)
            fs.writeFileSync(path.join(tmpDir, 'dirty-file.txt'), 'uncommitted');

            const shortHash = await getShortHash(tmpDir);
            const expectedBranch = deriveBranchName('Dirty Test', shortHash);

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

            // Switched back to main
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('main');

            // main HEAD unchanged (dirty file was NOT committed on main)
            const mainHeadAfter = git(tmpDir, ['rev-parse', 'HEAD']);
            expect(mainHeadAfter).toBe(mainHeadBefore);

            // dirty-file should NOT exist on main
            expect(fs.existsSync(path.join(tmpDir, 'dirty-file.txt'))).toBe(false);

            // Ralph branch should have the WIP commit with the dirty file
            const ralphLog = git(tmpDir, ['log', '--oneline', expectedBranch]);
            expect(ralphLog.toLowerCase()).toContain('wip');

            // dirty-file should exist on ralph branch
            const ralphTreeFiles = git(tmpDir, ['ls-tree', '--name-only', expectedBranch]);
            expect(ralphTreeFiles).toContain('dirty-file.txt');
        });
    });

    // --- (5) Loop completes → switches back to original branch (non-main) ---

    describe('(5) Switches back to non-main original branch', () => {
        it('switches back to bisect/v0.39-lean after completion', async () => {
            git(tmpDir, ['checkout', '-b', 'bisect/v0.39-lean']);
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# SB Non Main\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'setup']);

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
            expect(branch).toBe('bisect/v0.39-lean');

            const switchBack = events.find(e => e.kind === LoopEventKind.BranchSwitchedBack);
            expect(switchBack).toBeDefined();
            expect(switchBack.from).toMatch(/^ralph\//);
            expect(switchBack.to).toBe('bisect/v0.39-lean');
        });
    });

    // --- (6) Resume after stop → session persists originalBranch ---

    describe('(6) Resume after stop uses persisted originalBranch', () => {
        it('session persistence saves and restores originalBranch', () => {
            const persistence = new SessionPersistence();
            persistence.save(tmpDir, {
                currentTaskIndex: 2,
                iterationCount: 5,
                nudgeCount: 1,
                retryCount: 0,
                circuitBreakerState: 'active',
                timestamp: Date.now(),
                version: 1,
                branchName: 'ralph/my-project-abc1234',
                originalBranch: 'bisect/v0.39-lean',
            });

            const loaded = persistence.load(tmpDir);
            expect(loaded).not.toBeNull();
            expect(loaded!.branchName).toBe('ralph/my-project-abc1234');
            expect(loaded!.originalBranch).toBe('bisect/v0.39-lean');
        });

        it('session persistence handles missing originalBranch gracefully', () => {
            const persistence = new SessionPersistence();
            persistence.save(tmpDir, {
                currentTaskIndex: 0,
                iterationCount: 1,
                nudgeCount: 0,
                retryCount: 0,
                circuitBreakerState: 'active',
                timestamp: Date.now(),
                version: 1,
                branchName: 'ralph/test',
            });

            const loaded = persistence.load(tmpDir);
            expect(loaded).not.toBeNull();
            expect(loaded!.originalBranch).toBeUndefined();
        });

        it('orchestrator state snapshot includes originalBranch after branch gate', async () => {
            git(tmpDir, ['checkout', '-b', 'develop']);
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Resume Snapshot\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'setup']);

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
            expect(snapshot.originalBranch).toBe('develop');
            expect(snapshot.branch).toMatch(/^ralph\//);
        });
    });

    // --- (7) featureBranch.enabled: false → backward compatible ---

    describe('(7) Disabled feature branch is backward compatible', () => {
        it('no branch operations when disabled, stays on arbitrary branch', async () => {
            git(tmpDir, ['checkout', '-b', 'my-custom-branch']);
            fs.writeFileSync(
                path.join(tmpDir, 'PRD.md'),
                '# Disabled Custom\n\n- [x] **Task 1 — Done**: done\n',
            );
            fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');
            git(tmpDir, ['add', '-A']);
            git(tmpDir, ['commit', '-m', 'setup']);

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

            // Should remain on original branch
            const branch = await getCurrentBranch(tmpDir);
            expect(branch).toBe('my-custom-branch');

            // No branch events
            expect(events.find(e => e.kind === LoopEventKind.BranchCreated)).toBeUndefined();
            expect(events.find(e => e.kind === LoopEventKind.BranchSwitchedBack)).toBeUndefined();
        });
    });

    // --- (8) No protectedBranches config needed ---

    describe('(8) No protectedBranches config', () => {
        it('DEFAULT_CONFIG.featureBranch has no protectedBranches field', () => {
            const fb = DEFAULT_CONFIG.featureBranch;
            expect(fb).toBeDefined();
            expect(fb).toEqual({ enabled: false });
            expect((fb as any).protectedBranches).toBeUndefined();
        });

        it('featureBranch config type only has enabled field', () => {
            // Verify the config shape: { enabled: boolean } — no extra fields
            const config = { enabled: true };
            const orch = new LoopOrchestrator(
                {
                    ...DEFAULT_CONFIG,
                    workspaceRoot: tmpDir,
                    bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
                    featureBranch: config,
                },
                noopLogger,
                () => { },
            );
            // Construction succeeds — no protectedBranches required
            expect(orch).toBeDefined();
        });
    });

    // --- (9) No regressions — verified by running full test suite ---
    // This is implicitly verified by the full `npx vitest run` execution.
});
