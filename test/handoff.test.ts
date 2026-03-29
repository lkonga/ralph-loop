import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { executeHandoff, buildHandoffPrompt, getTranscriptPath } from '../src/handoff';
import type { ILogger } from '../src/types';

describe('handoff', () => {
	let executedCommands: { command: string; args: unknown[] }[];
	const logger: ILogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

	beforeEach(() => {
		executedCommands = [];
		vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command: string, ...args: unknown[]) => {
			executedCommands.push({ command, args });
			return undefined;
		});
		vi.mocked(logger.log).mockClear();
		vi.mocked(logger.warn).mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getTranscriptPath', () => {
		it('returns path under HOME/.local/share/chat-handoffs', () => {
			const p = getTranscriptPath();
			expect(p).toContain('.local/share/chat-handoffs/latest-transcript.jsonl');
		});
	});

	describe('buildHandoffPrompt', () => {
		it('includes transcript file path', () => {
			const prompt = buildHandoffPrompt();
			expect(prompt).toContain('latest-transcript.jsonl');
		});

		it('instructs to read only last 100 lines first', () => {
			const prompt = buildHandoffPrompt();
			expect(prompt).toContain('last 100 lines');
			expect(prompt).toContain('tail');
		});
	});

	describe('executeHandoff', () => {
		it('shows warning and returns false when transcript does not exist', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockRejectedValue(new Error('ENOENT'));
			const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

			const result = await executeHandoff(logger);

			expect(result).toBe(false);
			expect(warnSpy).toHaveBeenCalledWith('No handoff transcript found. Run /handoff first.');
			expect(executedCommands).toHaveLength(0);
		});

		it('creates new session, focuses, types prompt, and submits when transcript exists', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			const result = await executeHandoff(logger);

			expect(result).toBe(true);
			expect(executedCommands).toHaveLength(2);
			expect(executedCommands[0].command).toBe('workbench.action.chat.newEditSession');
			expect(executedCommands[1].command).toBe('workbench.action.chat.openEditSession');
			expect(executedCommands[1].args[0]).toBe(buildHandoffPrompt());
		});

		it('logs success after sending prompt', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger);

			expect(logger.log).toHaveBeenCalledWith('Handoff: reset session and sent transcript prompt');
		});

		it('executes commands in correct order: newSession → focus → type → submit', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger);

			const commands = executedCommands.map(c => c.command);
			expect(commands).toEqual([
				'workbench.action.chat.newEditSession',
				'workbench.action.chat.openEditSession',
			]);
		});
	});
});
