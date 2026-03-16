import { describe, it, expect, vi, beforeEach } from 'vitest';
import { showCooldownDialog, type CooldownDialogResult } from '../src/cooldownDialog';

vi.mock('vscode', () => ({
	window: {
		showInformationMessage: vi.fn(),
		showInputBox: vi.fn(),
	},
}));

import * as vscode from 'vscode';

const mockShowInfo = vi.mocked(vscode.window.showInformationMessage);
const mockShowInput = vi.mocked(vscode.window.showInputBox);

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('showCooldownDialog', () => {
	it('auto-accepts (returns continue) after timeout when user does nothing', async () => {
		mockShowInfo.mockReturnValue(new Promise(() => {})); // never resolves
		const result = await showCooldownDialog('Fix the bug in parser', 50);
		expect(result).toBe('continue');
	});

	it('returns pause when user clicks Pause', async () => {
		mockShowInfo.mockResolvedValue('Pause' as any);
		const result = await showCooldownDialog('Fix the bug in parser', 5000);
		expect(result).toBe('pause');
	});

	it('returns stop when user clicks Stop', async () => {
		mockShowInfo.mockResolvedValue('Stop' as any);
		const result = await showCooldownDialog('Fix the bug in parser', 5000);
		expect(result).toBe('stop');
	});

	it('returns edit when user clicks Edit Next Task', async () => {
		mockShowInfo.mockResolvedValue('Edit Next Task' as any);
		const result = await showCooldownDialog('Fix the bug in parser', 5000);
		expect(result).toBe('edit');
	});

	it('returns continue when dialog is dismissed (undefined)', async () => {
		mockShowInfo.mockResolvedValue(undefined as any);
		const result = await showCooldownDialog('Fix the bug in parser', 5000);
		expect(result).toBe('continue');
	});

	it('truncates long task descriptions in the dialog message', async () => {
		mockShowInfo.mockReturnValue(new Promise(() => {}));
		const longDesc = 'A'.repeat(200);
		await showCooldownDialog(longDesc, 50);
		const msg = mockShowInfo.mock.calls[0][0] as string;
		expect(msg.length).toBeLessThanOrEqual(100);
	});

	it('shows three buttons: Pause, Stop, Edit Next Task', async () => {
		mockShowInfo.mockReturnValue(new Promise(() => {}));
		await showCooldownDialog('some task', 50);
		const args = mockShowInfo.mock.calls[0];
		expect(args).toContain('Pause');
		expect(args).toContain('Stop');
		expect(args).toContain('Edit Next Task');
	});

	it('CooldownDialogResult type covers all valid values', () => {
		const values: CooldownDialogResult[] = ['continue', 'pause', 'stop', 'edit'];
		expect(values).toHaveLength(4);
	});
});
