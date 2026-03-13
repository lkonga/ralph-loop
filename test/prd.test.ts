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
