import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus, PrdSnapshot, PrdValidationError, PrdValidationResult } from './types';

const CHECKBOX_UNCHECKED = /^(\s*)-\s*\[\s*\]\s+(.+)$/;
const CHECKBOX_CHECKED = /^(\s*)-\s*\[x\]\s+(.+)$/i;
const DEPENDS_ANNOTATION = /depends:\s*([\w,\s-]+)/i;
const MISSING_DEP_PATTERN = /MISSING_DEP:\s*(\S+)/i;
const AGENT_ANNOTATION = /\[AGENT:(\w+)\]/g;

function parseTaskId(description: string): string {
	const match = /^\*\*([^*]+)\*\*/.exec(description);
	if (match) { return match[1].trim(); }
	return `task-${description.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`;
}

function parseAgentAnnotation(text: string): string | undefined {
	const matches = [...text.matchAll(AGENT_ANNOTATION)];
	if (matches.length > 1) {
		throw new Error(`Multiple [AGENT:...] annotations found in task: "${text}". Only one is allowed.`);
	}
	if (matches.length === 1) {
		return matches[0][1];
	}
	return undefined;
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
	let currentPhaseAgent: string | undefined;

	// First pass: collect tasks with indentation info
	const taskEntries: Array<{ task: Task; indent: number; rawDescription: string }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Detect phase headers (### level) and extract agent annotation
		if (/^#{1,6}\s/.test(line)) {
			const headerAgent = parseAgentAnnotation(line);
			currentPhaseAgent = headerAgent;
			continue;
		}

		// Skip DECOMPOSED tasks (non-actionable) — anchored to annotation position only
		if (/^-\s*\[[ x]\]\s*\[DECOMPOSED\]/i.test(line)) { continue; }
		const isCheckpoint = /^-\s*\[[ x]\]\s*\[CHECKPOINT\]/i.test(line);
		const unchecked = CHECKBOX_UNCHECKED.exec(line);
		if (unchecked) {
			const indent = unchecked[1].length;
			const taskAgent = parseAgentAnnotation(unchecked[2]);
			const agent = taskAgent ?? currentPhaseAgent;
			const description = unchecked[2].replace(/\[CHECKPOINT\]\s*/g, '').replace(AGENT_ANNOTATION, '').trim();
			const dependsOn = parseDependsOn(description);
			taskEntries.push({
				task: { id: id++, taskId: '', description, status: TaskStatus.Pending, lineNumber: i + 1, dependsOn, checkpoint: isCheckpoint || undefined, agent, readOnly: isReadOnlyAgent(agent) || undefined },
				indent,
				rawDescription: description,
			});
			continue;
		}
		const checked = CHECKBOX_CHECKED.exec(line);
		if (checked) {
			const indent = checked[1].length;
			const taskAgent = parseAgentAnnotation(checked[2]);
			const agent = taskAgent ?? currentPhaseAgent;
			const description = checked[2].replace(/\[CHECKPOINT\]\s*/g, '').replace(AGENT_ANNOTATION, '').trim();
			const dependsOn = parseDependsOn(description);
			taskEntries.push({
				task: { id: id++, taskId: '', description, status: TaskStatus.Complete, lineNumber: i + 1, dependsOn, checkpoint: isCheckpoint || undefined, agent, readOnly: isReadOnlyAgent(agent) || undefined },
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

export function validatePrd(snapshot: PrdSnapshot): PrdValidationResult {
	const errors: PrdValidationError[] = [];

	if (snapshot.total === 0) {
		errors.push({ level: 'error', message: 'PRD contains no tasks' });
		return { valid: false, errors };
	}

	// Duplicate descriptions (case-insensitive, among pending tasks with same status)
	const descMap = new Map<string, Task[]>();
	for (const task of snapshot.tasks) {
		const key = task.description.toLowerCase().trim();
		const existing = descMap.get(key) ?? [];
		existing.push(task);
		descMap.set(key, existing);
	}
	for (const [, tasks] of descMap) {
		if (tasks.length > 1) {
			const pending = tasks.filter(t => t.status === TaskStatus.Pending);
			if (pending.length > 1) {
				errors.push({
					level: 'error',
					message: `Duplicate pending task: "${pending[0].description}" (lines ${pending.map(t => t.lineNumber).join(', ')})`,
					line: pending[1].lineNumber,
				});
			}
		}
	}

	// Dangling dependency references
	const knownTaskIds = new Set(snapshot.tasks.map(t => parseTaskId(t.description)));
	for (const task of snapshot.tasks) {
		if (!task.dependsOn) { continue; }
		for (const dep of task.dependsOn) {
			if (!knownTaskIds.has(dep)) {
				errors.push({
					level: 'warning',
					message: `Task "${task.description}" depends on unknown task "${dep}"`,
					line: task.lineNumber,
				});
			}
		}
	}

	// Circular dependency detection (DFS)
	const taskByParsedId = new Map<string, Task>();
	for (const task of snapshot.tasks) {
		taskByParsedId.set(parseTaskId(task.description), task);
	}
	const visited = new Set<string>();
	const inStack = new Set<string>();
	function hasCycle(taskId: string): boolean {
		if (inStack.has(taskId)) { return true; }
		if (visited.has(taskId)) { return false; }
		visited.add(taskId);
		inStack.add(taskId);
		const t = taskByParsedId.get(taskId);
		if (t?.dependsOn) {
			for (const dep of t.dependsOn) {
				if (hasCycle(dep)) { return true; }
			}
		}
		inStack.delete(taskId);
		return false;
	}
	for (const taskId of taskByParsedId.keys()) {
		if (hasCycle(taskId)) {
			errors.push({ level: 'error', message: `Circular dependency detected involving task "${taskId}"` });
			break;
		}
	}

	const hasErrors = errors.some(e => e.level === 'error');
	return { valid: !hasErrors, errors };
}

export function readPrdFile(prdPath: string): string {
	return fs.readFileSync(prdPath, 'utf-8');
}

export function readPrdSnapshot(prdPath: string): PrdSnapshot {
	const content = readPrdFile(prdPath);
	return parsePrd(content);
}

export function pickNextTask(snapshot: PrdSnapshot): Task | undefined {
	return pickReadyTasks(snapshot, 1)[0];
}

const READ_ONLY_AGENTS = new Set(['explore', 'research']);

export function isReadOnlyAgent(agentName: string | undefined): boolean {
	if (!agentName) { return false; }
	return READ_ONLY_AGENTS.has(agentName);
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

	// Parallel safety: if batch has >1 task and any uses a write agent, fall back to sequential
	if (ready.length > 1 && !ready.every(t => isReadOnlyAgent(t.agent))) {
		return [ready[0]];
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

export async function analyzeMissingDependency(task: Task, failureContext: string, prdPath: string): Promise<string | null> {
	const match = MISSING_DEP_PATTERN.exec(failureContext);
	if (!match) { return null; }

	const depTaskId = match[1];
	const snapshot = readPrdSnapshot(prdPath);
	const depTask = snapshot.tasks.find(t => t.taskId === depTaskId);
	if (!depTask) { return null; }
	if (depTask.status === TaskStatus.Complete) { return null; }

	return depTaskId;
}

export function addDependsAnnotation(prdPath: string, task: Task, depTaskId: string): void {
	const content = fs.readFileSync(prdPath, 'utf-8');
	const lines = content.split('\n');
	const lineIdx = task.lineNumber - 1;
	if (lineIdx >= 0 && lineIdx < lines.length) {
		lines[lineIdx] = lines[lineIdx].trimEnd() + ` depends: ${depTaskId}`;
		fs.writeFileSync(prdPath, lines.join('\n'), 'utf-8');
	}
}

const CHECKBOX_LINE = /^(\s*-\s*\[)[ x](\]\s*)(.*)$/i;
const PHASE_HEADER = /^(#{1,6}\s+.*)$/;
const DEPENDS_SUFFIX = /\s*depends:\s*[\w,\s-]+$/i;

function stripCheckboxState(line: string): string {
	return line.replace(/^(\s*-\s*\[)[ x](\])/, '$1 $2');
}

function stripDecomposedPrefix(line: string): string {
	return line.replace(/^(\s*-\s*\[[ x]\]\s*)\[DECOMPOSED\]\s*/i, '$1');
}

function stripDependsAnnotation(line: string): string {
	return line.replace(DEPENDS_SUFFIX, '');
}

function normalizeForComparison(line: string): string {
	return stripDependsAnnotation(stripDecomposedPrefix(stripCheckboxState(line)));
}

export function validatePrdEdit(before: string, after: string): { allowed: boolean; reason?: string } {
	if (before === after) { return { allowed: true }; }

	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');

	// Build a map of before lines for matching
	const beforeNonEmpty = beforeLines.filter(l => l.trim().length > 0);
	const afterNonEmpty = afterLines.filter(l => l.trim().length > 0);

	// Check for deleted lines: every before non-empty line must appear in after (by normalized content)
	let afterIdx = 0;
	for (let i = 0; i < beforeNonEmpty.length; i++) {
		const bLine = beforeNonEmpty[i];
		let found = false;
		for (let j = afterIdx; j < afterNonEmpty.length; j++) {
			if (linesMatch(bLine, afterNonEmpty[j])) {
				afterIdx = j + 1;
				found = true;
				break;
			}
		}
		if (!found) {
			// Check if the line was reordered (exists anywhere after current position)
			const existsAnywhere = afterNonEmpty.some((aLine, idx) => idx >= afterIdx && linesMatch(bLine, aLine));
			if (existsAnywhere) {
				return { allowed: false, reason: `PRD structure change detected: lines were reordered` };
			}
			return { allowed: false, reason: `PRD line removed or altered: "${bLine.trim()}"` };
		}
	}

	return { allowed: true };
}

function linesMatch(beforeLine: string, afterLine: string): boolean {
	if (beforeLine === afterLine) { return true; }

	const bTrimmed = beforeLine.trim();
	const aTrimmed = afterLine.trim();

	// Phase headers must be identical
	if (PHASE_HEADER.test(bTrimmed)) {
		return bTrimmed === aTrimmed;
	}

	// Checkbox lines: allow checkbox toggle, DECOMPOSED prefix, depends annotation
	if (CHECKBOX_LINE.test(bTrimmed) || CHECKBOX_LINE.test(aTrimmed)) {
		return normalizeForComparison(bTrimmed) === normalizeForComparison(aTrimmed);
	}

	// Non-task lines must be identical
	return bTrimmed === aTrimmed;
}
