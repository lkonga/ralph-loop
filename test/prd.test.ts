import { describe, it, expect } from 'vitest';
import { parsePrd, pickNextTask } from '../src/prd';

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
});
