import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parsePrd } from '../src/prd';
import { verifyTaskCompletion, allChecksPassed, isAllDone, progressSummary } from '../src/verify';

function tmpPrd(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-test-'));
	const p = path.join(dir, 'PRD.md');
	fs.writeFileSync(p, content, 'utf-8');
	return p;
}

describe('verifyTaskCompletion', () => {
	const logger = { log: () => {}, warn: () => {}, error: () => {} };

	it('passes when task is checked', () => {
		const prdPath = tmpPrd('- [x] Build auth\n- [ ] Deploy\n');
		const snapshot = parsePrd('- [ ] Build auth\n- [ ] Deploy\n');
		const task = snapshot.tasks[0]; // Was pending when assigned
		const checks = verifyTaskCompletion(prdPath, task, logger);
		expect(allChecksPassed(checks)).toBe(true);
	});

	it('fails when task is still unchecked', () => {
		const prdPath = tmpPrd('- [ ] Build auth\n- [ ] Deploy\n');
		const snapshot = parsePrd('- [ ] Build auth\n- [ ] Deploy\n');
		const task = snapshot.tasks[0];
		const checks = verifyTaskCompletion(prdPath, task, logger);
		expect(allChecksPassed(checks)).toBe(false);
	});
});

describe('isAllDone', () => {
	it('returns true when all checked', () => {
		const prdPath = tmpPrd('- [x] A\n- [x] B\n');
		expect(isAllDone(prdPath)).toBe(true);
	});

	it('returns false when some unchecked', () => {
		const prdPath = tmpPrd('- [x] A\n- [ ] B\n');
		expect(isAllDone(prdPath)).toBe(false);
	});

	it('returns false for empty PRD', () => {
		const prdPath = tmpPrd('# Empty PRD\n');
		expect(isAllDone(prdPath)).toBe(false);
	});
});

describe('progressSummary', () => {
	it('returns correct counts', () => {
		const prdPath = tmpPrd('- [x] Done\n- [ ] Pending\n- [ ] Also pending\n');
		const summary = progressSummary(prdPath);
		expect(summary.total).toBe(3);
		expect(summary.completed).toBe(1);
		expect(summary.remaining).toBe(2);
	});
});
