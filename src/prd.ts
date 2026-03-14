import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus, PrdSnapshot } from './types';

const CHECKBOX_UNCHECKED = /^(\s*)-\s*\[\s*\]\s+(.+)$/;
const CHECKBOX_CHECKED = /^(\s*)-\s*\[x\]\s+(.+)$/i;
const DEPENDS_ANNOTATION = /depends:\s*([\w,\s-]+)/i;

function parseTaskId(description: string): string {
	const match = /^\*\*([^*]+)\*\*/.exec(description);
	if (match) { return match[1].trim(); }
	return `task-${description.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`;
}

function parseDependsOn(description: string): string[] | undefined {
	const match = DEPENDS_ANNOTATION.exec(description);
	if (match) {
		return match[1].split(',').map(d => d.trim()).filter(Boolean);
	}
	return undefined;
}

export function parsePrd(content: string): PrdSnapshot {
	const lines = content.split('\n');
	const tasks: Task[] = [];
	let id = 0;

	// First pass: collect tasks with indentation info
	const taskEntries: Array<{ task: Task; indent: number; rawDescription: string }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip DECOMPOSED tasks (non-actionable)
		if (line.includes('[DECOMPOSED]')) { continue; }
		const unchecked = CHECKBOX_UNCHECKED.exec(line);
		if (unchecked) {
			const indent = unchecked[1].length;
			const description = unchecked[2].trim();
			const dependsOn = parseDependsOn(description);
			taskEntries.push({
				task: { id: id++, taskId: '', description, status: TaskStatus.Pending, lineNumber: i + 1, dependsOn },
				indent,
				rawDescription: description,
			});
			continue;
		}
		const checked = CHECKBOX_CHECKED.exec(line);
		if (checked) {
			const indent = checked[1].length;
			const description = checked[2].trim();
			const dependsOn = parseDependsOn(description);
			taskEntries.push({
				task: { id: id++, taskId: '', description, status: TaskStatus.Complete, lineNumber: i + 1, dependsOn },
				indent,
				rawDescription: description,
			});
		}
	}

	// Second pass: infer dependencies from indentation (indented tasks depend on the preceding less-indented task)
	const taskIdMap = new Map<number, string>();
	for (const entry of taskEntries) {
		taskIdMap.set(entry.task.id, parseTaskId(entry.rawDescription));
	}

	for (let i = 0; i < taskEntries.length; i++) {
		const entry = taskEntries[i];
		(entry.task as { taskId: string }).taskId = `Task-${String(i + 1).padStart(3, '0')}`;
		if (entry.task.dependsOn) { continue; } // explicit annotation takes priority
		if (entry.indent > 0) {
			// Find the nearest preceding task with less indentation
			for (let j = i - 1; j >= 0; j--) {
				if (taskEntries[j].indent < entry.indent) {
					const parentId = taskIdMap.get(taskEntries[j].task.id)!;
					(entry.task as { dependsOn?: string[] }).dependsOn = [parentId];
					break;
				}
			}
		}
	}

	const allTasks = taskEntries.map(e => e.task);
	const completed = allTasks.filter(t => t.status === TaskStatus.Complete).length;
	return {
		tasks: allTasks,
		total: allTasks.length,
		completed,
		remaining: allTasks.length - completed,
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

export function pickReadyTasks(snapshot: PrdSnapshot, maxTasks: number = 1): Task[] {
	const completedDescriptions = new Set(
		snapshot.tasks.filter(t => t.status === TaskStatus.Complete).map(t => parseTaskId(t.description)),
	);

	const ready: Task[] = [];
	for (const task of snapshot.tasks) {
		if (task.status !== TaskStatus.Pending) { continue; }
		if (ready.length >= maxTasks) { break; }

		const deps = task.dependsOn ?? [];
		const depsmet = deps.every(dep => completedDescriptions.has(dep));
		if (depsmet) {
			ready.push(task);
		}
	}
	return ready;
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
