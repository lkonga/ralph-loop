import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { executeHandoff, buildHandoffPrompt, getTranscriptPath, buildTranscriptSummary } from '../src/handoff';
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

		it('instructs to read transcript via tail command', () => {
			const prompt = buildHandoffPrompt();
			expect(prompt).toContain('tail -100');
			expect(prompt).toContain('latest-transcript.jsonl');
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

			expect(logger.log).toHaveBeenCalledWith('Handoff: executed strategy 1');
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

		it('strategy 7: executes newChat then chat.open with query', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, 7);

			const commands = executedCommands.map(c => c.command);
			expect(commands).toEqual([
				'workbench.action.chat.newChat',
				'workbench.action.chat.open',
			]);
			expect(executedCommands[1].args[0]).toEqual({ query: buildHandoffPrompt() });
			expect(logger.log).toHaveBeenCalledWith('Handoff: executed strategy 7');
		});

		it('falls back to strategy 1 for unknown variant', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, 99);

			const commands = executedCommands.map(c => c.command);
			expect(commands).toEqual([
				'workbench.action.chat.newEditSession',
				'workbench.action.chat.openEditSession',
			]);
		});

		it('uses specified variant when in range 1-12', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, 3);

			const commands = executedCommands.map(c => c.command);
			expect(commands[0]).toBe('workbench.action.chat.newEditSession');
			expect(commands[1]).toBe('workbench.action.chat.open');
			expect(logger.log).toHaveBeenCalledWith('Handoff: executed strategy 3');
		});

		it('strategy 13: uses previousRequests and modelSelector', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, { variant: 13, model: 'claude-sonnet-4' });

			const commands = executedCommands.map(c => c.command);
			expect(commands).toEqual(['workbench.action.chat.newChat', 'workbench.action.chat.open']);
			const openArgs = executedCommands[1].args[0] as Record<string, unknown>;
			expect(openArgs.modelSelector).toEqual({ id: 'claude-sonnet-4' });
			expect(openArgs.previousRequests).toBeDefined();
			expect(openArgs.mode).toBe('agent');
		});

		it('strategy 14: injects summary and keeps transcript prompt', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, { variant: 14 });

			const commands = executedCommands.map(c => c.command);
			expect(commands).toEqual(['workbench.action.chat.newChat', 'workbench.action.chat.open']);
			const openArgs = executedCommands[1].args[0] as Record<string, unknown>;
			expect(openArgs.previousRequests).toBeDefined();
			expect((openArgs.query as string)).toContain('tail -100');
		});

		it('strategy 15: pure context injection without transcript read', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, { variant: 15 });

			const openArgs = executedCommands[1].args[0] as Record<string, unknown>;
			expect((openArgs.query as string)).toContain('rotated the session');
			expect(openArgs.previousRequests).toBeDefined();
		});

		it('accepts number for backward compatibility', async () => {
			vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 } as any);

			await executeHandoff(logger, 7);

			expect(executedCommands[0].command).toBe('workbench.action.chat.newChat');
		});
	});
});
