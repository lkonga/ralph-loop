import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureVscodeTasks, getRalphTasks } from '../src/vscodeTasks';
import type { RunConfig } from '../src/runConfig';

describe('vscodeTasks', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-tasks-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('ensureVscodeTasks', () => {
		it('creates .vscode/tasks.json with build and test tasks', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const tasksPath = path.join(tmpDir, '.vscode', 'tasks.json');
			expect(fs.existsSync(tasksPath)).toBe(true);
			const content = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
			expect(content.version).toBe('2.0.0');
			expect(content.tasks).toHaveLength(2);
			expect(content.tasks[0].label).toBe('ralph:build');
			expect(content.tasks[0].command).toBe('npx tsc --noEmit');
			expect(content.tasks[1].label).toBe('ralph:test');
			expect(content.tasks[1].command).toBe('npx vitest run');
		});

		it('creates only test task when no buildCommand', () => {
			const config: RunConfig = {
				runner: 'pytest',
				testCommand: 'pytest',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.vscode', 'tasks.json'), 'utf-8'));
			expect(content.tasks).toHaveLength(1);
			expect(content.tasks[0].label).toBe('ralph:test');
			expect(content.tasks[0].command).toBe('pytest');
		});

		it('creates no tasks when no commands', () => {
			const config: RunConfig = {
				runner: 'none',
				mode: 'skip-tests',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.vscode', 'tasks.json'), 'utf-8'));
			expect(content.tasks).toHaveLength(0);
		});

		it('preserves non-ralph tasks in existing tasks.json', () => {
			const dir = path.join(tmpDir, '.vscode');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
				version: '2.0.0',
				tasks: [{ label: 'my-custom-task', type: 'shell', command: 'echo hello' }],
			}), 'utf-8');

			const config: RunConfig = {
				runner: 'vitest',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const content = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf-8'));
			expect(content.tasks).toHaveLength(2);
			expect(content.tasks[0].label).toBe('my-custom-task');
			expect(content.tasks[1].label).toBe('ralph:test');
		});

		it('replaces existing ralph tasks on re-run', () => {
			const config1: RunConfig = {
				runner: 'jest',
				testCommand: 'npx jest',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config1);

			const config2: RunConfig = {
				runner: 'vitest',
				testCommand: 'npx vitest run',
				buildCommand: 'npx tsc --noEmit',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config2);
			const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.vscode', 'tasks.json'), 'utf-8'));
			expect(content.tasks).toHaveLength(2);
			expect(content.tasks[0].label).toBe('ralph:build');
			expect(content.tasks[1].label).toBe('ralph:test');
			expect(content.tasks[1].command).toBe('npx vitest run');
		});

		it('sets $tsc problem matcher for TypeScript build', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.vscode', 'tasks.json'), 'utf-8'));
			expect(content.tasks[0].problemMatcher).toContain('$tsc');
		});

		it('sets $rustc problem matcher for cargo', () => {
			const config: RunConfig = {
				runner: 'cargo',
				buildCommand: 'cargo check',
				testCommand: 'cargo test',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.vscode', 'tasks.json'), 'utf-8'));
			expect(content.tasks[0].problemMatcher).toContain('$rustc');
		});
	});

	describe('getRalphTasks', () => {
		it('returns ralph tasks from tasks.json', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			ensureVscodeTasks(tmpDir, config);
			const tasks = getRalphTasks(tmpDir);
			expect(tasks).toHaveLength(2);
			expect(tasks[0].label).toBe('ralph:build');
			expect(tasks[1].label).toBe('ralph:test');
		});

		it('returns empty array when no tasks.json', () => {
			expect(getRalphTasks(tmpDir)).toEqual([]);
		});

		it('filters out non-ralph tasks', () => {
			const dir = path.join(tmpDir, '.vscode');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
				version: '2.0.0',
				tasks: [
					{ label: 'my-task', type: 'shell', command: 'echo' },
					{ label: 'ralph:test', type: 'shell', command: 'npx vitest run' },
				],
			}), 'utf-8');
			const tasks = getRalphTasks(tmpDir);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].label).toBe('ralph:test');
		});
	});
});
