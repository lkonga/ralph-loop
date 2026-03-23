import { describe, it, expect } from 'vitest';
import type { StateSnapshot, PrdSnapshot } from '../src/types';
import {
	formatLaneText,
	buildLaneTooltipLines,
	formatLaneSummaryTable,
	buildStatusOutput,
	type LaneProgress,
} from '../src/statusBar';

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
	return { state: 'running', taskId: 'Task-3', taskDescription: 'Do stuff', iterationCount: 1, nudgeCount: 0, ...overrides };
}

describe('formatLaneText', () => {
	it('shows repoId, state, and task progress when lane is active', () => {
		const result = formatLaneText(makeSnapshot({ activeRepoId: 'repo-a' }), [
			{ repoId: 'repo-a', completed: 3, total: 5, allDone: false },
		]);
		expect(result).toContain('repo-a');
		expect(result).toContain('running');
		expect(result).toContain('3/5');
	});

	it('falls back to basic format when no activeRepoId', () => {
		const result = formatLaneText(makeSnapshot(), []);
		expect(result).toContain('Ralph');
	});

	it('includes ralph prefix', () => {
		const result = formatLaneText(makeSnapshot({ activeRepoId: 'repo-a' }), [
			{ repoId: 'repo-a', completed: 2, total: 10, allDone: false },
		]);
		expect(result).toMatch(/ralph/i);
	});
});

describe('buildLaneTooltipLines', () => {
	it('shows per-lane progress', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-a', completed: 3, total: 5, allDone: false },
			{ repoId: 'repo-b', completed: 7, total: 12, allDone: false },
		];
		const lines = buildLaneTooltipLines(lanes);
		const text = lines.join('\n');
		expect(text).toContain('repo-a: 3/5 done');
		expect(text).toContain('repo-b: 7/12 done');
	});

	it('shows checkmark when lane is all done', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-a', completed: 5, total: 5, allDone: true },
		];
		const lines = buildLaneTooltipLines(lanes);
		const text = lines.join('\n');
		expect(text).toContain('✓');
		expect(text).toContain('repo-a');
	});

	it('shows idle for lane with no tasks', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-c', completed: 0, total: 0, allDone: false },
		];
		const lines = buildLaneTooltipLines(lanes);
		const text = lines.join('\n');
		expect(text).toContain('repo-c');
		expect(text).toContain('idle');
	});

	it('handles mixed lane states', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-a', completed: 3, total: 5, allDone: false },
			{ repoId: 'repo-b', completed: 7, total: 12, allDone: false },
			{ repoId: 'repo-c', completed: 0, total: 0, allDone: false },
		];
		const lines = buildLaneTooltipLines(lanes);
		const text = lines.join('\n');
		expect(text).toContain('repo-a: 3/5 done');
		expect(text).toContain('repo-b: 7/12 done');
		expect(text).toContain('repo-c: idle');
	});
});

describe('computeLaneProgress', () => {
	it('is re-exported and computes from PrdSnapshot map', async () => {
		const { computeLaneProgress } = await import('../src/statusBar');
		const snapshots = new Map<string, PrdSnapshot>();
		snapshots.set('repo-a', { tasks: [], total: 5, completed: 3, remaining: 2 });
		snapshots.set('repo-b', { tasks: [], total: 12, completed: 12, remaining: 0 });
		const result = computeLaneProgress(snapshots);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ repoId: 'repo-a', completed: 3, total: 5, allDone: false });
		expect(result[1]).toEqual({ repoId: 'repo-b', completed: 12, total: 12, allDone: true });
	});
});

describe('formatLaneSummaryTable', () => {
	it('produces a table with headers and lane rows', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-a', completed: 3, total: 5, allDone: false },
			{ repoId: 'repo-b', completed: 7, total: 12, allDone: false },
		];
		const table = formatLaneSummaryTable(lanes);
		expect(table).toContain('Repo');
		expect(table).toContain('Progress');
		expect(table).toContain('repo-a');
		expect(table).toContain('3/5');
		expect(table).toContain('repo-b');
		expect(table).toContain('7/12');
	});

	it('shows checkmark for completed lanes', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-a', completed: 5, total: 5, allDone: true },
		];
		const table = formatLaneSummaryTable(lanes);
		expect(table).toContain('✓');
	});

	it('shows idle for zero-task lanes', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-c', completed: 0, total: 0, allDone: false },
		];
		const table = formatLaneSummaryTable(lanes);
		expect(table).toContain('idle');
	});

	it('returns empty string when no lanes', () => {
		expect(formatLaneSummaryTable([])).toBe('');
	});
});

describe('buildStatusOutput', () => {
	it('includes state in output', () => {
		const output = buildStatusOutput('running', []);
		expect(output).toContain('running');
	});

	it('includes per-lane summary table when lanes are present', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'repo-a', completed: 3, total: 5, allDone: false },
			{ repoId: 'repo-b', completed: 7, total: 12, allDone: false },
		];
		const output = buildStatusOutput('running', lanes);
		expect(output).toContain('repo-a');
		expect(output).toContain('3/5');
		expect(output).toContain('repo-b');
		expect(output).toContain('7/12');
	});

	it('omits lane table when no lanes', () => {
		const output = buildStatusOutput('idle', []);
		expect(output).toContain('idle');
		expect(output).not.toContain('Repo');
	});

	it('shows checkmark for completed lanes', () => {
		const lanes: LaneProgress[] = [
			{ repoId: 'done-repo', completed: 5, total: 5, allDone: true },
		];
		const output = buildStatusOutput('running', lanes);
		expect(output).toContain('✓');
	});
});
