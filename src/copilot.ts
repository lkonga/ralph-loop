import * as vscode from 'vscode';
import { CopilotMethod, ILogger } from './types';

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
	const ok = await tryCommand('workbench.action.chat.newEditSession');
	if (ok) {
		logger.log('Started fresh chat session');
	}
	return ok;
}

export async function openCopilotWithPrompt(prompt: string, logger: ILogger): Promise<CopilotMethod> {
	// Level 1: Agent mode (edit session)
	const agentOk = await tryCommand('workbench.action.chat.openEditSession', prompt);
	if (agentOk) {
		logger.log('Opened Copilot Agent Mode');
		return 'agent';
	}

	// Level 2: Chat panel
	const chatOk = await tryCommand('workbench.action.chat.open', { query: prompt });
	if (chatOk) {
		logger.log('Opened Copilot Chat');
		return 'chat';
	}

	// Level 3: Clipboard fallback
	await vscode.env.clipboard.writeText(prompt);
	logger.warn('Copilot commands unavailable — prompt copied to clipboard');
	return 'clipboard';
}

export function buildPrompt(taskDescription: string, prdContent: string, progressContent: string): string {
	const MAX_LEN = 5000;
	const sanitized = taskDescription.trim().slice(0, MAX_LEN);

	const parts: string[] = [
		'===================================================================',
		'                       YOUR TASK TO IMPLEMENT',
		'===================================================================',
		'',
		sanitized,
		'',
		'===================================================================',
		'    MANDATORY: UPDATE PRD.md AND progress.txt WHEN DONE',
		'===================================================================',
		'',
		'After completing the task:',
		'',
		`1. In PRD.md, change:  - [ ] ${sanitized}`,
		`   To:                 - [x] ${sanitized}`,
		'',
		'2. Append to progress.txt what you did.',
		'',
		'Both updates are required for the loop to continue!',
		'',
		'===================================================================',
		'                       PROJECT CONTEXT',
		'===================================================================',
		'',
		'## PRD.md:',
		'```markdown',
		prdContent,
		'```',
		'',
	];

	if (progressContent.trim()) {
		parts.push('## progress.txt:');
		parts.push('```');
		parts.push(progressContent);
		parts.push('```');
		parts.push('');
	}

	return parts.join('\n');
}
