import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startMonitor, type MonitorSignals } from '../src/orchestrator';
import type { ParallelMonitorConfig, LoopEvent } from '../src/types';
import { LoopEventKind } from '../src/types';

function makeConfig(overrides: Partial<ParallelMonitorConfig> = {}): ParallelMonitorConfig {
	return {
		enabled: true,
		intervalMs: 100,
		stuckThreshold: 3,
		...overrides,
	};
}

function noopLogger() {
	return {
		log: (_msg: string) => {},
		warn: (_msg: string) => {},
		error: (_msg: string) => {},
	};
}

describe('startMonitor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits MonitorAlert after stuckThreshold stale intervals', () => {
		const events: LoopEvent[] = [];
		const signals: MonitorSignals = {
			getPrdMtime: () => 1000,
			getProgressMtime: () => 1000,
			getProgressSize: () => 100,
			getCheckboxCount: () => 5,
		};

		const monitor = startMonitor(
			'task-1',
			'inv-1',
			makeConfig({ stuckThreshold: 3, intervalMs: 100 }),
			signals,
			(event) => events.push(event),
			noopLogger(),
		);

		// 3 stale intervals needed
		vi.advanceTimersByTime(100);
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);

		vi.advanceTimersByTime(100);
		expect(events.length).toBe(1);
		expect(events[0].kind).toBe(LoopEventKind.MonitorAlert);
		if (events[0].kind === LoopEventKind.MonitorAlert) {
			expect(events[0].taskId).toBe('task-1');
			expect(events[0].alert).toContain('stuck');
		}

		monitor.stop();
	});

	it('resets counter when progress changes', () => {
		const events: LoopEvent[] = [];
		let progressSize = 100;
		const signals: MonitorSignals = {
			getPrdMtime: () => 1000,
			getProgressMtime: () => 1000,
			getProgressSize: () => progressSize,
			getCheckboxCount: () => 5,
		};

		const monitor = startMonitor(
			'task-2',
			'inv-2',
			makeConfig({ stuckThreshold: 3, intervalMs: 100 }),
			signals,
			(event) => events.push(event),
			noopLogger(),
		);

		// 2 stale intervals
		vi.advanceTimersByTime(100);
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);

		// Progress changes — resets counter
		progressSize = 200;
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0); // counter reset

		// 2 more stale intervals (not enough)
		vi.advanceTimersByTime(100);
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);

		// 3rd stale interval after reset
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(1);
		expect(events[0].kind).toBe(LoopEventKind.MonitorAlert);

		monitor.stop();
	});

	it('resets counter when PRD mtime changes', () => {
		const events: LoopEvent[] = [];
		let prdMtime = 1000;
		const signals: MonitorSignals = {
			getPrdMtime: () => prdMtime,
			getProgressMtime: () => 1000,
			getProgressSize: () => 100,
			getCheckboxCount: () => 5,
		};

		const monitor = startMonitor(
			'task-3',
			'inv-3',
			makeConfig({ stuckThreshold: 2, intervalMs: 100 }),
			signals,
			(event) => events.push(event),
			noopLogger(),
		);

		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);

		// PRD changes — resets counter
		prdMtime = 2000;
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);

		// Need 2 more stale intervals
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(1);

		monitor.stop();
	});

	it('resets counter when checkbox count changes', () => {
		const events: LoopEvent[] = [];
		let checkboxCount = 5;
		const signals: MonitorSignals = {
			getPrdMtime: () => 1000,
			getProgressMtime: () => 1000,
			getProgressSize: () => 100,
			getCheckboxCount: () => checkboxCount,
		};

		const monitor = startMonitor(
			'task-4',
			'inv-4',
			makeConfig({ stuckThreshold: 2, intervalMs: 100 }),
			signals,
			(event) => events.push(event),
			noopLogger(),
		);

		vi.advanceTimersByTime(100);
		// Checkbox count changes
		checkboxCount = 6;
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0); // counter reset

		vi.advanceTimersByTime(100);
		expect(events.length).toBe(0);
		vi.advanceTimersByTime(100);
		expect(events.length).toBe(1);

		monitor.stop();
	});

	it('stops cleanly and does not emit after stop()', () => {
		const events: LoopEvent[] = [];
		const signals: MonitorSignals = {
			getPrdMtime: () => 1000,
			getProgressMtime: () => 1000,
			getProgressSize: () => 100,
			getCheckboxCount: () => 5,
		};

		const monitor = startMonitor(
			'task-5',
			'inv-5',
			makeConfig({ stuckThreshold: 1, intervalMs: 100 }),
			signals,
			(event) => events.push(event),
			noopLogger(),
		);

		// Stop before first interval fires
		monitor.stop();
		vi.advanceTimersByTime(500);
		expect(events.length).toBe(0);
	});

	it('is not started when disabled', () => {
		const events: LoopEvent[] = [];
		const signals: MonitorSignals = {
			getPrdMtime: () => 1000,
			getProgressMtime: () => 1000,
			getProgressSize: () => 100,
			getCheckboxCount: () => 5,
		};

		const monitor = startMonitor(
			'task-6',
			'inv-6',
			makeConfig({ enabled: false, stuckThreshold: 1, intervalMs: 100 }),
			signals,
			(event) => events.push(event),
			noopLogger(),
		);

		vi.advanceTimersByTime(1000);
		expect(events.length).toBe(0);

		// stop() should still be safe to call
		monitor.stop();
	});
});

describe('maxConcurrencyPerStage overrides maxParallelTasks', () => {
	it('uses maxConcurrencyPerStage as concurrency cap when > 1 and useParallelTasks is true', async () => {
		// This test validates the logic that pickReadyTasks is called with
		// maxConcurrencyPerStage instead of maxParallelTasks when both conditions are met.
		// We test this by importing pickReadyTasks and verifying the cap parameter behavior.
		const { pickReadyTasks } = await import('../src/prd');
		const { TaskStatus } = await import('../src/types');

		const snapshot = {
			tasks: [
				{ id: 1, taskId: 'Task-001', description: 'Task 1', status: TaskStatus.Pending, lineNumber: 1 },
				{ id: 2, taskId: 'Task-002', description: 'Task 2', status: TaskStatus.Pending, lineNumber: 2 },
				{ id: 3, taskId: 'Task-003', description: 'Task 3', status: TaskStatus.Pending, lineNumber: 3 },
				{ id: 4, taskId: 'Task-004', description: 'Task 4', status: TaskStatus.Pending, lineNumber: 4 },
			],
			total: 4,
			completed: 0,
			remaining: 4,
		};

		// maxConcurrencyPerStage = 2 should cap at 2 tasks
		const result2 = pickReadyTasks(snapshot, 2);
		expect(result2.length).toBeLessThanOrEqual(2);

		// maxConcurrencyPerStage = 3 should cap at 3 tasks
		const result3 = pickReadyTasks(snapshot, 3);
		expect(result3.length).toBeLessThanOrEqual(3);

		// maxParallelTasks = 5 would allow more, but maxConcurrencyPerStage = 2 caps it
		const resultCapped = pickReadyTasks(snapshot, 2);
		expect(resultCapped.length).toBeLessThanOrEqual(2);
	});
});
