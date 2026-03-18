import * as vscode from 'vscode';
import type { LoopState } from './types';

export async function fireStateChangeNotification(state: LoopState, taskId: string): Promise<void> {
	try {
		await vscode.commands.executeCommand('ralph-loop.onStateChange', { state, taskId });
	} catch {
		// Fire-and-forget — command may not be registered (copilot fork not installed)
	}
}
