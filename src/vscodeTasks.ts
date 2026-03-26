import * as fs from 'fs';
import * as path from 'path';
import type { RunConfig } from './runConfig';

interface VscodeTask {
	label: string;
	type: string;
	command: string;
	group?: string;
	problemMatcher?: string[];
	presentation?: { reveal: string; panel: string };
}

interface VscodeTasksFile {
	version: string;
	tasks: VscodeTask[];
}

/**
 * Generate ralph:build and ralph:test VS Code task definitions from RunConfig.
 * Merges with existing tasks.json — preserves non-ralph tasks.
 */
export function ensureVscodeTasks(workspaceRoot: string, config: RunConfig): void {
	const tasksPath = path.join(workspaceRoot, '.vscode', 'tasks.json');
	const dir = path.dirname(tasksPath);

	let existing: VscodeTasksFile = { version: '2.0.0', tasks: [] };
	if (fs.existsSync(tasksPath)) {
		try {
			existing = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
		} catch {
			// Invalid JSON — start fresh
		}
	}

	// Remove existing ralph tasks
	const nonRalphTasks = (existing.tasks || []).filter(t => !t.label.startsWith('ralph:'));

	const ralphTasks: VscodeTask[] = [];

	if (config.buildCommand) {
		ralphTasks.push({
			label: 'ralph:build',
			type: 'shell',
			command: config.buildCommand,
			group: 'build',
			problemMatcher: getProblemMatcher(config.runner, 'build'),
			presentation: { reveal: 'silent', panel: 'shared' },
		});
	}

	if (config.testCommand) {
		ralphTasks.push({
			label: 'ralph:test',
			type: 'shell',
			command: config.testCommand,
			group: 'test',
			problemMatcher: getProblemMatcher(config.runner, 'test'),
			presentation: { reveal: 'silent', panel: 'shared' },
		});
	}

	const merged: VscodeTasksFile = {
		version: '2.0.0',
		tasks: [...nonRalphTasks, ...ralphTasks],
	};

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(tasksPath, JSON.stringify(merged, null, '\t') + '\n', 'utf-8');
}

function getProblemMatcher(runner: string, kind: 'build' | 'test'): string[] {
	if (kind === 'build') {
		if (runner === 'cargo') return ['$rustc'];
		if (runner === 'go') return ['$go'];
		return ['$tsc'];
	}
	// test matchers
	if (runner === 'cargo') return ['$rustc'];
	if (runner === 'go') return ['$go'];
	return [];
}

/**
 * Read ralph task definitions from .vscode/tasks.json.
 */
export function getRalphTasks(workspaceRoot: string): VscodeTask[] {
	const tasksPath = path.join(workspaceRoot, '.vscode', 'tasks.json');
	try {
		const content = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) as VscodeTasksFile;
		return (content.tasks || []).filter(t => t.label.startsWith('ralph:'));
	} catch {
		return [];
	}
}
