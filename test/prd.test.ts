import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePrd, pickNextTask, pickReadyTasks, isReadOnlyAgent, analyzeMissingDependency, addDependsAnnotation, validatePrd, validatePrdEdit, parseLineAnnotations, parsePrdTitle, deriveBranchName, markTaskComplete } from '../src/prd';

describe('parsePrd', () => {
	it('parses unchecked tasks', () => {
		const content = `# PRD\n\n- [ ] Task one\n- [ ] Task two\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(2);
		expect(snapshot.completed).toBe(0);
		expect(snapshot.remaining).toBe(2);
		expect(snapshot.tasks[0].description).toBe('Task one');
		expect(snapshot.tasks[0].status).toBe('pending');
		expect(snapshot.tasks[1].description).toBe('Task two');
	});

	it('parses checked tasks', () => {
		const content = `- [x] Done task\n- [ ] Pending task\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(2);
		expect(snapshot.completed).toBe(1);
		expect(snapshot.remaining).toBe(1);
		expect(snapshot.tasks[0].status).toBe('complete');
		expect(snapshot.tasks[1].status).toBe('pending');
	});

	it('handles uppercase X', () => {
		const content = `- [X] Done with uppercase\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.completed).toBe(1);
		expect(snapshot.tasks[0].status).toBe('complete');
	});

	it('ignores non-checkbox lines', () => {
		const content = `# Title\nSome text\n- regular list item\n- [ ] Real task\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(1);
		expect(snapshot.tasks[0].description).toBe('Real task');
	});

	it('returns empty snapshot for empty content', () => {
		const snapshot = parsePrd('');
		expect(snapshot.total).toBe(0);
		expect(snapshot.tasks).toEqual([]);
	});

	it('tracks line numbers correctly', () => {
		const content = `# PRD\n\n- [ ] Task on line 3\n\n- [ ] Task on line 5\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].lineNumber).toBe(3);
		expect(snapshot.tasks[1].lineNumber).toBe(5);
	});

	it('assigns sequential ids', () => {
		const content = `- [x] Done\n- [ ] Pending\n- [ ] Another\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.map(t => t.id)).toEqual([0, 1, 2]);
	});

	it('assigns sequential zero-padded taskId strings', () => {
		const content = `- [x] Done\n- [ ] Pending\n- [ ] Another\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.map(t => t.taskId)).toEqual(['Task-001', 'Task-002', 'Task-003']);
	});

	it('taskIds are consistent across multiple parses', () => {
		const content = `- [ ] Alpha\n- [ ] Beta\n- [x] Gamma\n`;
		const first = parsePrd(content);
		const second = parsePrd(content);
		expect(first.tasks.map(t => t.taskId)).toEqual(second.tasks.map(t => t.taskId));
	});

	it('zero-pads taskId to 3 digits', () => {
		const content = `- [ ] Only task\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].taskId).toBe('Task-001');
	});

	it('DOES NOT skip task when [DECOMPOSED] is in description text (Task 106)', () => {
		const content = `- [ ] **Task 106 — Verify [DECOMPOSED] in description**:\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(1);
		expect(snapshot.tasks[0].description).toContain('[DECOMPOSED]');
	});
});

describe('pickNextTask', () => {
	it('picks first pending task', () => {
		const content = `- [x] Done\n- [ ] Next\n- [ ] Later\n`;
		const snapshot = parsePrd(content);
		const task = pickNextTask(snapshot);
		expect(task?.description).toBe('Next');
	});

	it('returns undefined when all complete', () => {
		const content = `- [x] Done one\n- [x] Done two\n`;
		const snapshot = parsePrd(content);
		expect(pickNextTask(snapshot)).toBeUndefined();
	});

	it('returns undefined for empty PRD', () => {
		const snapshot = parsePrd('');
		expect(pickNextTask(snapshot)).toBeUndefined();
	});

	it('skips task with unmet dependency', () => {
		const content = `- [ ] **Task A** First task depends: Task B\n- [ ] **Task B** Second task\n`;
		const snapshot = parsePrd(content);
		const task = pickNextTask(snapshot);
		expect(task?.description).toContain('**Task B**');
	});

	it('picks task with met dependency', () => {
		const content = `- [x] **Task A** First task\n- [ ] **Task B** Second task depends: Task A\n`;
		const snapshot = parsePrd(content);
		const task = pickNextTask(snapshot);
		expect(task?.description).toContain('**Task B**');
	});

	it('picks task with no deps as before', () => {
		const content = `- [x] Done\n- [ ] No deps here\n- [ ] Also pending\n`;
		const snapshot = parsePrd(content);
		const task = pickNextTask(snapshot);
		expect(task?.description).toBe('No deps here');
	});
});

describe('parsePrd skips DECOMPOSED lines', () => {
	it('skips unchecked tasks with [DECOMPOSED] marker', () => {
		const content = `- [ ] [DECOMPOSED] Original task\n- [ ] Sub-task: part one\n- [ ] Sub-task: part two\n`;
		const snapshot = parsePrd(content);
		// DECOMPOSED line should be skipped entirely
		expect(snapshot.tasks.every(t => !t.description.includes('[DECOMPOSED]'))).toBe(true);
		expect(snapshot.tasks.length).toBe(2);
		expect(snapshot.tasks[0].description).toBe('Sub-task: part one');
		expect(snapshot.tasks[1].description).toBe('Sub-task: part two');
	});

	it('skips checked tasks with [DECOMPOSED] marker', () => {
		const content = `- [x] [DECOMPOSED] Original task\n- [ ] Sub-task: part one\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.every(t => !t.description.includes('[DECOMPOSED]'))).toBe(true);
		expect(snapshot.tasks.length).toBe(1);
		expect(snapshot.tasks[0].description).toBe('Sub-task: part one');
	});

	it('does not affect normal tasks', () => {
		const content = `- [ ] Normal task\n- [x] Completed task\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(2);
	});

	it('does NOT skip tasks that mention [DECOMPOSED] in description text', () => {
		const content = `- [ ] **Task N — Fix the [DECOMPOSED] detection**:\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(1);
		expect(snapshot.tasks[0].status).toBe('pending');
	});
});

describe('parsePrd handles CHECKPOINT annotation', () => {
	it('marks unchecked tasks with [CHECKPOINT] as checkpoint', () => {
		const content = `- [ ] [CHECKPOINT] Review auth before payments\n- [ ] Implement payments\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(2);
		expect(snapshot.tasks[0].checkpoint).toBe(true);
		expect(snapshot.tasks[0].description).toBe('Review auth before payments');
		expect(snapshot.tasks[1].checkpoint).toBeUndefined();
	});

	it('strips [CHECKPOINT] from description of checked tasks', () => {
		const content = `- [x] [CHECKPOINT] Review auth before payments\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].checkpoint).toBe(true);
		expect(snapshot.tasks[0].description).toBe('Review auth before payments');
		expect(snapshot.tasks[0].status).toBe('complete');
	});

	it('does not set checkpoint on normal tasks', () => {
		const content = `- [ ] Normal task\n- [ ] Another task\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.every(t => t.checkpoint === undefined)).toBe(true);
	});

	it('checkpoint tasks are not skipped like DECOMPOSED', () => {
		const content = `- [ ] [CHECKPOINT] Gate task\n- [ ] [DECOMPOSED] Old task\n- [ ] Real task\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(2);
		expect(snapshot.tasks[0].checkpoint).toBe(true);
		expect(snapshot.tasks[0].description).toBe('Gate task');
		expect(snapshot.tasks[1].description).toBe('Real task');
	});

	it('does NOT flag checkpoint when [CHECKPOINT] is in description text', () => {
		const content = `- [ ] **Task N — Fix the [CHECKPOINT] detection**:\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(1);
		expect(snapshot.tasks[0].checkpoint).toBeUndefined();
	});
});

describe('parsePrd handles AGENT annotation', () => {
	it('parses [AGENT:explore] and strips it from description', () => {
		const content = `- [ ] [AGENT:explore] Research the codebase\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(1);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[0].description).toBe('Research the codebase');
		expect(snapshot.tasks[0].description).not.toContain('[AGENT:');
	});

	it('parses [AGENT:implement] annotation', () => {
		const content = `- [ ] [AGENT:implement] Build the feature\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('implement');
		expect(snapshot.tasks[0].description).toBe('Build the feature');
	});

	it('parses [AGENT:research] annotation', () => {
		const content = `- [ ] [AGENT:research] Find best practices online\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('research');
		expect(snapshot.tasks[0].description).toBe('Find best practices online');
	});

	it('agent defaults to undefined when no annotation', () => {
		const content = `- [ ] Normal task without agent\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBeUndefined();
	});

	it('works on checked tasks too', () => {
		const content = `- [x] [AGENT:explore] Already done research\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[0].description).toBe('Already done research');
		expect(snapshot.tasks[0].status).toBe('complete');
	});

	it('rejects multiple [AGENT:...] annotations in same task', () => {
		const content = `- [ ] [AGENT:explore] [AGENT:implement] Conflicting agents\n`;
		expect(() => parsePrd(content)).toThrow(/multiple.*agent/i);
	});

	it('coexists with [CHECKPOINT] annotation', () => {
		const content = `- [ ] [CHECKPOINT] [AGENT:explore] Review before proceeding\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].checkpoint).toBe(true);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[0].description).toBe('Review before proceeding');
	});

	it('agent annotation is case-sensitive for the tag but preserves name', () => {
		const content = `- [ ] [AGENT:Explore] Mixed case agent\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('Explore');
	});
});

describe('analyzeMissingDependency', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-dep-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns depTaskId when MISSING_DEP found and task is incomplete', async () => {
		const prdContent = '- [ ] **Task A**: Do something\n- [ ] **Task B**: Do another thing\n';
		const prdPath = path.join(tmpDir, 'PRD.md');
		fs.writeFileSync(prdPath, prdContent, 'utf-8');
		const snapshot = parsePrd(prdContent);
		const task = snapshot.tasks[1]; // Task B
		const failureContext = 'Some error output\nMISSING_DEP: Task-001\nMore output';
		const result = await analyzeMissingDependency(task, failureContext, prdPath);
		expect(result).toBe('Task-001');
	});

	it('returns null when taskId does not exist in PRD', async () => {
		const prdContent = '- [ ] **Task A**: Do something\n';
		const prdPath = path.join(tmpDir, 'PRD.md');
		fs.writeFileSync(prdPath, prdContent, 'utf-8');
		const snapshot = parsePrd(prdContent);
		const task = snapshot.tasks[0];
		const failureContext = 'MISSING_DEP: Task-999';
		const result = await analyzeMissingDependency(task, failureContext, prdPath);
		expect(result).toBeNull();
	});

	it('returns null when referenced task is already complete', async () => {
		const prdContent = '- [x] **Task A**: Done\n- [ ] **Task B**: Pending\n';
		const prdPath = path.join(tmpDir, 'PRD.md');
		fs.writeFileSync(prdPath, prdContent, 'utf-8');
		const snapshot = parsePrd(prdContent);
		const task = snapshot.tasks[1]; // Task B
		const failureContext = 'MISSING_DEP: Task-001';
		const result = await analyzeMissingDependency(task, failureContext, prdPath);
		expect(result).toBeNull();
	});

	it('returns null when no MISSING_DEP in context', async () => {
		const prdContent = '- [ ] **Task A**: Do something\n';
		const prdPath = path.join(tmpDir, 'PRD.md');
		fs.writeFileSync(prdPath, prdContent, 'utf-8');
		const snapshot = parsePrd(prdContent);
		const task = snapshot.tasks[0];
		const failureContext = 'Just a regular error with no dependency info';
		const result = await analyzeMissingDependency(task, failureContext, prdPath);
		expect(result).toBeNull();
	});
});

describe('addDependsAnnotation', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-dep-annot-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('adds depends annotation to the task line in PRD', () => {
		const prdContent = '- [ ] **Task A**: Do something\n- [ ] **Task B**: Do another thing\n';
		const prdPath = path.join(tmpDir, 'PRD.md');
		fs.writeFileSync(prdPath, prdContent, 'utf-8');
		const snapshot = parsePrd(prdContent);
		const task = snapshot.tasks[1]; // Task B at line 2
		addDependsAnnotation(prdPath, task, 'Task-001');
		const updated = fs.readFileSync(prdPath, 'utf-8');
		expect(updated).toContain('depends: Task-001');
		const lines = updated.split('\n');
		expect(lines[1]).toContain('depends: Task-001');
	});
});

describe('isReadOnlyAgent', () => {
	it('returns true for explore agent', () => {
		expect(isReadOnlyAgent('explore')).toBe(true);
	});

	it('returns true for research agent', () => {
		expect(isReadOnlyAgent('research')).toBe(true);
	});

	it('returns false for implement agent', () => {
		expect(isReadOnlyAgent('implement')).toBe(false);
	});

	it('returns false for executor agent', () => {
		expect(isReadOnlyAgent('executor')).toBe(false);
	});

	it('returns false for undefined/empty agent', () => {
		expect(isReadOnlyAgent('')).toBe(false);
		expect(isReadOnlyAgent(undefined as unknown as string)).toBe(false);
	});

	it('returns false for unknown agent names', () => {
		expect(isReadOnlyAgent('custom-agent')).toBe(false);
	});
});

describe('pickReadyTasks parallel safety', () => {
	it('all-explore batch runs parallel (returns multiple tasks)', () => {
		const content = `- [ ] [AGENT:explore] Research A\n- [ ] [AGENT:explore] Research B\n- [ ] [AGENT:explore] Research C\n`;
		const snapshot = parsePrd(content);
		const ready = pickReadyTasks(snapshot, 3);
		expect(ready.length).toBe(3);
		expect(ready.every(t => isReadOnlyAgent(t.agent ?? ''))).toBe(true);
	});

	it('mixed batch falls back to sequential (returns single task)', () => {
		const content = `- [ ] [AGENT:explore] Research A\n- [ ] [AGENT:implement] Build B\n- [ ] [AGENT:explore] Research C\n`;
		const snapshot = parsePrd(content);
		const ready = pickReadyTasks(snapshot, 3);
		// When batch contains non-read-only agents, should return only 1 task
		expect(ready.length).toBe(1);
	});

	it('all-research batch runs parallel', () => {
		const content = `- [ ] [AGENT:research] Web search A\n- [ ] [AGENT:research] Web search B\n`;
		const snapshot = parsePrd(content);
		const ready = pickReadyTasks(snapshot, 2);
		expect(ready.length).toBe(2);
	});

	it('single task always returned regardless of agent type', () => {
		const content = `- [ ] [AGENT:implement] Build feature\n`;
		const snapshot = parsePrd(content);
		const ready = pickReadyTasks(snapshot, 1);
		expect(ready.length).toBe(1);
	});

	it('tasks without agent annotation treated as non-read-only', () => {
		const content = `- [ ] No agent task A\n- [ ] No agent task B\n`;
		const snapshot = parsePrd(content);
		const ready = pickReadyTasks(snapshot, 2);
		// No agent = default (executor) = not read-only, so sequential
		expect(ready.length).toBe(1);
	});
});

describe('phase-level agent override', () => {
	it('tasks inherit agent from phase header', () => {
		const content = [
			'### 9e — Research Infrastructure [AGENT:explore]',
			'- [ ] Research the codebase',
			'- [ ] Analyze dependencies',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks).toHaveLength(2);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[1].agent).toBe('explore');
	});

	it('task-level agent overrides phase-level agent', () => {
		const content = [
			'### 9e — Research Infrastructure [AGENT:explore]',
			'- [ ] [AGENT:implement] Build the module',
			'- [ ] Analyze dependencies',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('implement');
		expect(snapshot.tasks[1].agent).toBe('explore');
	});

	it('no phase agent leaves task agent as default (undefined)', () => {
		const content = [
			'### 9e — Research Infrastructure',
			'- [ ] Research the codebase',
			'- [ ] Analyze dependencies',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBeUndefined();
		expect(snapshot.tasks[1].agent).toBeUndefined();
	});

	it('phase agent stripped from header text (not leaked into task descriptions)', () => {
		const content = [
			'### 9e — Research Infrastructure [AGENT:explore]',
			'- [ ] Research the codebase',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].description).not.toContain('[AGENT:');
		expect(snapshot.tasks[0].description).not.toContain('explore');
		expect(snapshot.tasks[0].description).toBe('Research the codebase');
	});

	it('different phases can have different agents', () => {
		const content = [
			'### Phase A [AGENT:explore]',
			'- [ ] Task in explore phase',
			'### Phase B [AGENT:implement]',
			'- [ ] Task in implement phase',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[1].agent).toBe('implement');
	});

	it('phase without agent resets inherited agent to undefined', () => {
		const content = [
			'### Phase A [AGENT:explore]',
			'- [ ] Task in explore phase',
			'### Phase B — No agent',
			'- [ ] Task without agent',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[1].agent).toBeUndefined();
	});

	it('phase agent sets readOnly correctly for inherited tasks', () => {
		const content = [
			'### Phase A [AGENT:explore]',
			'- [ ] Task in explore phase',
			'### Phase B [AGENT:implement]',
			'- [ ] Task in implement phase',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].readOnly).toBe(true);
		expect(snapshot.tasks[1].readOnly).toBeUndefined();
	});

	it('works with checked tasks too', () => {
		const content = [
			'### Phase A [AGENT:explore]',
			'- [x] Completed explore task',
			'- [ ] Pending explore task',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.tasks[0].agent).toBe('explore');
		expect(snapshot.tasks[1].agent).toBe('explore');
	});
});

describe('validatePrd', () => {
	it('passes for a valid PRD', () => {
		const snapshot = parsePrd('- [ ] Task A\n- [ ] Task B\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('errors on empty PRD', () => {
		const snapshot = parsePrd('');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toBe('PRD contains no tasks');
	});

	it('errors on duplicate pending tasks', () => {
		const snapshot = parsePrd('- [ ] Do something\n- [ ] Do something\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.message.includes('Duplicate pending task'))).toBe(true);
	});

	it('allows duplicate if one is checked and one is pending', () => {
		const snapshot = parsePrd('- [x] Do something\n- [ ] Do something\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(true);
	});

	it('allows different task descriptions', () => {
		const snapshot = parsePrd('- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('warns on dangling dependency', () => {
		const snapshot = parsePrd('- [ ] **Alpha** My task depends: NonExistent\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(true);
		expect(result.errors.some(e => e.level === 'warning' && e.message.includes('unknown task'))).toBe(true);
	});

	it('no warning when dependency exists', () => {
		const snapshot = parsePrd('- [ ] **Dep** Prerequisite\n- [ ] **Main** My task depends: Dep\n');
		const result = validatePrd(snapshot);
		expect(result.errors).toEqual([]);
	});

	it('errors on circular dependencies', () => {
		const snapshot = parsePrd('- [ ] **A** Task A depends: B\n- [ ] **B** Task B depends: A\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.message.includes('Circular dependency'))).toBe(true);
	});

	it('passes PRD with only completed tasks', () => {
		const snapshot = parsePrd('- [x] Done one\n- [x] Done two\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(true);
	});

	it('detects duplicate pending tasks case-insensitively', () => {
		const snapshot = parsePrd('- [ ] Install packages\n- [ ] install packages\n');
		const result = validatePrd(snapshot);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.message.includes('Duplicate pending task'))).toBe(true);
	});
});

describe('validatePrdEdit', () => {
	it('allows checkbox toggle [ ] → [x]', () => {
		const before = '- [ ] **Task 1 — Setup**: Install deps\n- [ ] **Task 2 — Build**: Run build\n';
		const after = '- [x] **Task 1 — Setup**: Install deps\n- [ ] **Task 2 — Build**: Run build\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('allows DECOMPOSED prefix prepended to a task', () => {
		const before = '- [ ] **Task 1 — Setup**: Install deps\n';
		const after = '- [ ] [DECOMPOSED] **Task 1 — Setup**: Install deps\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('allows adding depends annotation', () => {
		const before = '- [ ] **Task 2 — Build**: Run build\n';
		const after = '- [ ] **Task 2 — Build**: Run build depends: Task 1\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('allows modifying depends annotation', () => {
		const before = '- [ ] **Task 2 — Build**: Run build depends: Task 1\n';
		const after = '- [ ] **Task 2 — Build**: Run build depends: Task 1, Task 3\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('rejects description text change', () => {
		const before = '- [ ] **Task 1 — Setup**: Install deps\n';
		const after = '- [ ] **Task 1 — Setup**: Install simplified deps\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBeDefined();
	});

	it('rejects phase header change', () => {
		const before = '## Phase 1 — Foundation\n- [ ] Task A\n';
		const after = '## Phase 1 — Easy Phase\n- [ ] Task A\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBeDefined();
	});

	it('allows adding new lines (sub-tasks from decomposition)', () => {
		const before = '- [ ] [DECOMPOSED] **Task 1**: Big task\n';
		const after = '- [ ] [DECOMPOSED] **Task 1**: Big task\n- [ ] Sub-task 1a\n- [ ] Sub-task 1b\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('rejects deletion of existing task lines', () => {
		const before = '- [ ] **Task 1**: Setup\n- [ ] **Task 2**: Build\n';
		const after = '- [ ] **Task 1**: Setup\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBeDefined();
	});

	it('allows identical content (no-op)', () => {
		const before = '- [ ] **Task 1**: Setup\n';
		const after = '- [ ] **Task 1**: Setup\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('allows multiple allowed changes together', () => {
		const before = '- [ ] **Task 1**: Setup\n- [ ] **Task 2**: Build\n';
		const after = '- [x] **Task 1**: Setup\n- [ ] **Task 2**: Build depends: Task 1\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(true);
	});

	it('rejects structure change (reordering lines)', () => {
		const before = '- [ ] **Task 1**: Setup\n- [ ] **Task 2**: Build\n';
		const after = '- [ ] **Task 2**: Build\n- [ ] **Task 1**: Setup\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(false);
		expect(result.reason).toBeDefined();
	});

	it('after restore + markTaskComplete, current task checkbox is checked and next task can be picked', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-wp-'));
		const prdPath = path.join(tmpDir, 'PRD.md');
		const before = '- [ ] **Task 84 — GL6**: Handle rate limits\n- [ ] **Task 113 — CHECKPOINT**: Audit verification\n';
		// Agent checked Task 84 but also deleted Task 113
		const after = '- [x] **Task 84 — GL6**: Handle rate limits\n';
		const result = validatePrdEdit(before, after);
		expect(result.allowed).toBe(false);

		// Simulate orchestrator: restore PRD then re-check current task
		fs.writeFileSync(prdPath, before, 'utf-8');
		markTaskComplete(prdPath, { id: 1, lineNumber: 1, description: '**Task 84 — GL6**: Handle rate limits', status: 'pending' as any, taskId: 'Task-084' });
		const restored = fs.readFileSync(prdPath, 'utf-8');
		expect(restored).toContain('- [x] **Task 84');
		expect(restored).toContain('- [ ] **Task 113');

		// Next task should be Task 113, not Task 84 again
		const snapshot = parsePrd(restored);
		const next = pickNextTask(snapshot);
		expect(next).toBeDefined();
		expect(next!.description).toContain('Task 113');

		fs.rmSync(tmpDir, { recursive: true });
	});
});

describe('parseLineAnnotations', () => {
	it('detects [DECOMPOSED] at annotation position (unchecked)', () => {
		const result = parseLineAnnotations('- [ ] [DECOMPOSED] Original task');
		expect(result.decomposed).toBe(true);
		expect(result.checkpoint).toBe(false);
	});

	it('detects [DECOMPOSED] at annotation position (checked)', () => {
		const result = parseLineAnnotations('- [x] [DECOMPOSED] Original task');
		expect(result.decomposed).toBe(true);
	});

	it('detects [CHECKPOINT] at annotation position', () => {
		const result = parseLineAnnotations('- [ ] [CHECKPOINT] Gate task');
		expect(result.checkpoint).toBe(true);
		expect(result.decomposed).toBe(false);
	});

	it('does not flag [DECOMPOSED] in description text', () => {
		const result = parseLineAnnotations('- [ ] **Task N — Fix [DECOMPOSED] detection**: some desc');
		expect(result.decomposed).toBe(false);
	});

	it('does not flag [CHECKPOINT] in description text', () => {
		const result = parseLineAnnotations('- [ ] **Task N — Fix [CHECKPOINT] detection**: some desc');
		expect(result.checkpoint).toBe(false);
	});

	it('returns both false for a normal task line', () => {
		const result = parseLineAnnotations('- [ ] **Task 1 — Build feature**: do stuff');
		expect(result.decomposed).toBe(false);
		expect(result.checkpoint).toBe(false);
	});

	it('returns both false for non-task lines', () => {
		const result = parseLineAnnotations('## Phase 1 — Setup');
		expect(result.decomposed).toBe(false);
		expect(result.checkpoint).toBe(false);
	});

	it('handles extra whitespace between checkbox and annotation', () => {
		const result = parseLineAnnotations('-  [ ]   [DECOMPOSED] task');
		expect(result.decomposed).toBe(true);
	});
});

describe('Task 106 — [DECOMPOSED] in description is not skipped', () => {
	it('parses a task that mentions [DECOMPOSED] in its title as pending', () => {
		const content = `- [ ] **Task N — Verify [DECOMPOSED] in description**:\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(1);
		expect(snapshot.tasks[0].status).toBe('pending');
		expect(snapshot.tasks[0].description).toContain('[DECOMPOSED]');
	});

	it('does not silently drop tasks with [DECOMPOSED] in description text', () => {
		const content = [
			'- [x] **Task A — Setup**: done',
			'- [ ] **Task B — Verify [DECOMPOSED] in description is not skipped**: canary task',
			'- [ ] **Task C — Normal task**: do stuff',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(3);
		const pending = snapshot.tasks.filter(t => t.status === 'pending');
		expect(pending.length).toBe(2);
		expect(pending.some(t => t.description.includes('[DECOMPOSED]'))).toBe(true);
	});

	it('only skips lines with [DECOMPOSED] in annotation position', () => {
		const content = [
			'- [ ] [DECOMPOSED] This parent was decomposed',
			'- [ ] **Task N — mentions [DECOMPOSED] inside**: still actionable',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(1);
		expect(snapshot.tasks[0].description).toContain('[DECOMPOSED]');
		expect(snapshot.tasks[0].status).toBe('pending');
	});
});

describe('Task 108 — [DECOMPOSED] and [CHECKPOINT] coexist in description safely', () => {
	it('parses a task mentioning both [DECOMPOSED] and [CHECKPOINT] in text as normal pending', () => {
		const content = `- [ ] **Task N — mentions [DECOMPOSED] and [CHECKPOINT] in text**:\n`;
		const snapshot = parsePrd(content);
		expect(snapshot.tasks.length).toBe(1);
		expect(snapshot.tasks[0].status).toBe('pending');
		expect(snapshot.tasks[0].checkpoint).toBeFalsy();
	});

	it('does not trigger annotation behavior for either tag in description', () => {
		const content = [
			'- [ ] **Task X — references [DECOMPOSED] and [CHECKPOINT] patterns**: verify both',
			'- [ ] [CHECKPOINT] Actual checkpoint gate',
			'- [ ] [DECOMPOSED] Actually decomposed parent',
		].join('\n');
		const snapshot = parsePrd(content);
		expect(snapshot.total).toBe(2);
		const taskX = snapshot.tasks.find(t => t.description.includes('Task X'));
		expect(taskX).toBeDefined();
		expect(taskX!.status).toBe('pending');
		expect(taskX!.checkpoint).toBeFalsy();
		const gate = snapshot.tasks.find(t => t.description.includes('checkpoint gate'));
		expect(gate).toBeDefined();
		expect(gate!.checkpoint).toBe(true);
	});
});

describe('parsePrdTitle', () => {
	it('extracts H1 heading text', () => {
		const content = '# My Awesome PRD\n\n- [ ] Task one\n';
		expect(parsePrdTitle(content)).toBe('My Awesome PRD');
	});

	it('returns first H1 only', () => {
		const content = '# First Title\n\n# Second Title\n';
		expect(parsePrdTitle(content)).toBe('First Title');
	});

	it('returns undefined when no H1', () => {
		const content = '## Not an H1\n\n- [ ] Task one\n';
		expect(parsePrdTitle(content)).toBeUndefined();
	});

	it('handles H1 with special characters', () => {
		const content = '# Build & Deploy: v2.0 (beta)\n';
		expect(parsePrdTitle(content)).toBe('Build & Deploy: v2.0 (beta)');
	});

	it('ignores lines that are not at start of line', () => {
		const content = '  # Indented heading\n- [ ] Task\n';
		expect(parsePrdTitle(content)).toBeUndefined();
	});
});

describe('deriveBranchName', () => {
	it('slugifies a simple title with ralph/ prefix', () => {
		expect(deriveBranchName('My Awesome PRD')).toBe('ralph/my-awesome-prd');
	});

	it('handles special characters', () => {
		expect(deriveBranchName('Build & Deploy: v2.0 (beta)')).toBe('ralph/build-deploy-v2-0-beta');
	});

	it('collapses consecutive hyphens', () => {
		expect(deriveBranchName('hello---world')).toBe('ralph/hello-world');
	});

	it('trims hyphens from ends', () => {
		expect(deriveBranchName('--leading and trailing--')).toBe('ralph/leading-and-trailing');
	});

	it('truncates to 50 chars total (including ralph/ prefix)', () => {
		const longTitle = 'a'.repeat(100);
		const result = deriveBranchName(longTitle);
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result.startsWith('ralph/')).toBe(true);
	});

	it('always has ralph/ prefix', () => {
		expect(deriveBranchName('test')).toBe('ralph/test');
		expect(deriveBranchName('X')).toBe('ralph/x');
	});

	it('handles empty slug after stripping', () => {
		const result = deriveBranchName('!!!');
		expect(result.startsWith('ralph/')).toBe(true);
	});

	it('appends shortHash when provided', () => {
		expect(deriveBranchName('My PRD', 'abc1234')).toBe('ralph/my-prd-abc1234');
	});

	it('total length stays within 50 with hash', () => {
		const longTitle = 'a'.repeat(100);
		const result = deriveBranchName(longTitle, 'abc1234');
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toContain('-abc1234');
		expect(result.startsWith('ralph/')).toBe(true);
	});

	it('different hashes produce different branch names', () => {
		const a = deriveBranchName('Same Title', 'aaaa111');
		const b = deriveBranchName('Same Title', 'bbbb222');
		expect(a).not.toBe(b);
		expect(a).toBe('ralph/same-title-aaaa111');
		expect(b).toBe('ralph/same-title-bbbb222');
	});
});
