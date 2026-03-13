import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus, PrdSnapshot } from './types';

const CHECKBOX_UNCHECKED = /^(\s*)-\s*\[\s*\]\s+(.+)$/;
const CHECKBOX_CHECKED = /^(\s*)-\s*\[x\]\s+(.+)$/i;

export function parsePrd(content: string): PrdSnapshot {
	const lines = content.split('\n');
	const tasks: Task[] = [];
	let id = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const unchecked = CHECKBOX_UNCHECKED.exec(line);
		if (unchecked) {
			tasks.push({
				id: id++,
				description: unchecked[2].trim(),
				status: TaskStatus.Pending,
				lineNumber: i + 1,
			});
			continue;
		}
		const checked = CHECKBOX_CHECKED.exec(line);
		if (checked) {
			tasks.push({
				id: id++,
				description: checked[2].trim(),
				status: TaskStatus.Complete,
				lineNumber: i + 1,
			});
		}
	}

	const completed = tasks.filter(t => t.status === TaskStatus.Complete).length;
	return {
		tasks,
		total: tasks.length,
		completed,
		remaining: tasks.length - completed,
	};
}

export function readPrdFile(prdPath: string): string {
	return fs.readFileSync(prdPath, 'utf-8');
}

export function readPrdSnapshot(prdPath: string): PrdSnapshot {
	const content = readPrdFile(prdPath);
	return parsePrd(content);
}

export function pickNextTask(snapshot: PrdSnapshot): Task | undefined {
	return snapshot.tasks.find(t => t.status === TaskStatus.Pending);
}

export function markTaskComplete(prdPath: string, task: Task): void {
	const content = fs.readFileSync(prdPath, 'utf-8');
	const lines = content.split('\n');
	const lineIdx = task.lineNumber - 1;

	if (lineIdx >= 0 && lineIdx < lines.length) {
		lines[lineIdx] = lines[lineIdx].replace(/\[\s*\]/, '[x]');
		fs.writeFileSync(prdPath, lines.join('\n'), 'utf-8');
	}
}

export function appendProgress(progressPath: string, message: string): void {
	const timestamp = new Date().toISOString();
	const entry = `[${timestamp}] ${message}\n`;
	fs.appendFileSync(progressPath, entry, 'utf-8');
}

export function resolvePrdPath(workspaceRoot: string, prdRelative: string): string {
	return path.resolve(workspaceRoot, prdRelative);
}

export function resolveProgressPath(workspaceRoot: string, progressRelative: string): string {
	return path.resolve(workspaceRoot, progressRelative);
}
