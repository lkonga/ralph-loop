import * as vscode from 'vscode';

export type CooldownDialogResult = 'continue' | 'pause' | 'stop' | 'edit';

export async function showCooldownDialog(
	nextTask: string,
	timeoutMs: number,
): Promise<CooldownDialogResult> {
	const truncated = nextTask.length > 80 ? nextTask.slice(0, 80) + '...' : nextTask;
	const userChoice = vscode.window.showInformationMessage(
		`Next: ${truncated}`,
		'Pause',
		'Stop',
		'Edit Next Task',
	);
	const autoAccept = new Promise<undefined>(resolve =>
		setTimeout(() => resolve(undefined), timeoutMs),
	);
	const result = await Promise.race([userChoice, autoAccept]);

	if (result === undefined) {
		return 'continue';
	}
	if (result === 'Pause') {
		return 'pause';
	}
	if (result === 'Stop') {
		return 'stop';
	}
	if (result === 'Edit Next Task') {
		return 'edit';
	}
	return 'continue';
}
