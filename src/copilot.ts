import * as vscode from 'vscode';
import { CopilotMethod, ILogger } from './types';
export { buildPrompt, buildFinalNudgePrompt, PromptCapabilities } from './prompt';

// 3-level fallback: agent mode → chat → clipboard
async function tryCommand(command: string, ...args: unknown[]): Promise<boolean> {
	try {
		await vscode.commands.executeCommand(command, ...args);
		return true;
	} catch {
		return false;
	}
}

export async function startFreshChatSession(logger: ILogger): Promise<boolean> {
	// Try agent mode new session first, then fall back to regular chat new session
	const editOk = await tryCommand('workbench.action.chat.newEditSession');
	if (editOk) {
		logger.log('Started fresh agent edit session');
		return true;
	}

	const chatOk = await tryCommand('workbench.action.chat.newChat');
	if (chatOk) {
		logger.log('Started fresh chat session');
		return true;
	}

	logger.warn('Could not start fresh chat session — no new session command available');
	return false;
}

export interface CopilotRequestOptions {
	useAutopilotMode?: boolean;
}

export async function openCopilotWithPrompt(prompt: string, logger: ILogger, options?: CopilotRequestOptions): Promise<CopilotMethod> {
	const requestArgs: Record<string, unknown> = {};

	// When autopilot mode is enabled, set permissionLevel on the chat request
	if (options?.useAutopilotMode) {
		try {
			// chatParticipantPrivate proposed API — may not be available
			requestArgs['permissionLevel'] = 'autopilot';
			logger.log('Autopilot mode: setting permissionLevel=autopilot on chat request');
		} catch {
			logger.warn('Autopilot mode requested but chatParticipantPrivate API unavailable');
		}
	}

	// Level 1: Agent mode (edit session)
	const agentArgs = options?.useAutopilotMode ? { prompt, ...requestArgs } : prompt;
	const agentOk = await tryCommand('workbench.action.chat.openEditSession', agentArgs);
	if (agentOk) {
		logger.log('Opened Copilot Agent Mode');
		return 'agent';
	}

	// Level 2: Chat panel
	const chatArgs = options?.useAutopilotMode
		? { query: prompt, ...requestArgs }
		: { query: prompt };
	const chatOk = await tryCommand('workbench.action.chat.open', chatArgs);
	if (chatOk) {
		logger.log('Opened Copilot Chat');
		return 'chat';
	}

	// Level 3: Clipboard fallback
	await vscode.env.clipboard.writeText(prompt);
	logger.warn('Copilot commands unavailable — prompt copied to clipboard');
	return 'clipboard';
}


