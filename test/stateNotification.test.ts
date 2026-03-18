import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoopEventKind, LoopState } from '../src/types';
import * as vscode from 'vscode';
import { fireStateChangeNotification } from '../src/stateNotification';

describe('State Change Notification Command', () => {
	let executeCommandMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		executeCommandMock = vi.fn().mockResolvedValue(undefined);
		(vscode.commands as any).executeCommand = executeCommandMock;
	});

	it('fires notification on TaskStarted with task ID', async () => {
        await fireStateChangeNotification(LoopState.Running, 'Task-42');
        expect(executeCommandMock).toHaveBeenCalledWith(
            'ralph-loop.onStateChange',
            { state: 'running', taskId: 'Task-42' },
        );
    });

    it('fires notification on TaskCompleted', async () => {
        await fireStateChangeNotification(LoopState.Running, 'Task-5');
        expect(executeCommandMock).toHaveBeenCalledWith(
            'ralph-loop.onStateChange',
            { state: 'running', taskId: 'Task-5' },
        );
    });

    it('fires notification on stop', async () => {
        await fireStateChangeNotification(LoopState.Idle, '');
        expect(executeCommandMock).toHaveBeenCalledWith(
            'ralph-loop.onStateChange',
            { state: 'idle', taskId: '' },
        );
    });

    it('taskId is empty string when idle', async () => {
        await fireStateChangeNotification(LoopState.Idle, '');
        const call = executeCommandMock.mock.calls[0];
        expect(call[1].taskId).toBe('');
    });

    it('silently ignores rejected promise when command not registered', async () => {
        executeCommandMock.mockRejectedValue(new Error('command not found'));
        // Should not throw
        await expect(fireStateChangeNotification(LoopState.Running, 'Task-1')).resolves.toBeUndefined();
    });

    it('StateNotified event kind exists', () => {
        expect(LoopEventKind.StateNotified).toBe('state_notified');
    });
});
