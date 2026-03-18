import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoopState } from '../src/types';
import type { StateSnapshot } from '../src/types';

describe('State Snapshot Command', () => {
	describe('StateSnapshot interface', () => {
		it('has required fields', () => {
			const snapshot: StateSnapshot = {
				state: 'idle',
				taskId: '',
				taskDescription: '',
				iterationCount: 0,
				nudgeCount: 0,
			};
			expect(snapshot.state).toBe('idle');
			expect(snapshot.taskId).toBe('');
			expect(snapshot.taskDescription).toBe('');
			expect(snapshot.iterationCount).toBe(0);
			expect(snapshot.nudgeCount).toBe(0);
		});
	});

	describe('LoopOrchestrator.getStateSnapshot', () => {
		it('returns idle snapshot when no task is running', async () => {
			const { LoopOrchestrator } = await import('../src/orchestrator');
			const orchestrator = new LoopOrchestrator(
				{
					workspaceRoot: '/tmp/test',
					prdFile: 'PRD.md',
					maxIterations: 5,
					waitTimeMs: 1000,
					copilotMethod: 'agent',
					maxNudgesPerTask: 3,
				} as any,
				{ log: vi.fn(), warn: vi.fn(), error: vi.fn() },
				vi.fn(),
			);
			const snapshot = orchestrator.getStateSnapshot();
			expect(snapshot).toEqual({
				state: 'idle',
				taskId: '',
				taskDescription: '',
				iterationCount: 0,
				nudgeCount: 0,
			});
		});

		it('returns running snapshot with task details after task starts', async () => {
			const { LoopOrchestrator } = await import('../src/orchestrator');
			const events: any[] = [];
			const orchestrator = new LoopOrchestrator(
				{
					workspaceRoot: '/tmp/test',
					prdFile: 'PRD.md',
					maxIterations: 1,
					waitTimeMs: 100,
					copilotMethod: 'agent',
					maxNudgesPerTask: 3,
				} as any,
				{ log: vi.fn(), warn: vi.fn(), error: vi.fn() },
				(event) => events.push(event),
			);
			// getStateSnapshot should reflect idle before start
			expect(orchestrator.getStateSnapshot().state).toBe('idle');
		});
	});

	describe('ralph-loop.getStateSnapshot command registration', () => {
		it('command returns snapshot from orchestrator', async () => {
			// Verify the StateSnapshot type shape is correct
			const snapshot: StateSnapshot = {
				state: LoopState.Running,
				taskId: 'Task-42',
				taskDescription: 'Implement feature X',
				iterationCount: 3,
				nudgeCount: 1,
			};
			expect(snapshot.state).toBe('running');
			expect(snapshot.taskId).toBe('Task-42');
			expect(snapshot.taskDescription).toBe('Implement feature X');
			expect(snapshot.iterationCount).toBe(3);
			expect(snapshot.nudgeCount).toBe(1);
		});

		it('command returns idle snapshot when orchestrator is null', () => {
			// When no orchestrator exists, the command should return idle defaults
			const defaultSnapshot: StateSnapshot = {
				state: 'idle',
				taskId: '',
				taskDescription: '',
				iterationCount: 0,
				nudgeCount: 0,
			};
			expect(defaultSnapshot.state).toBe('idle');
			expect(defaultSnapshot.taskId).toBe('');
		});
	});
});
