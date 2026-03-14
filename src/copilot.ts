import * as vscode from 'vscode';
import { CopilotMethod, ILogger, DEFAULT_REVIEW_PROMPT_TEMPLATE, ReviewVerdict } from './types';
export { buildPrompt, buildFinalNudgePrompt, buildReviewPrompt, PromptCapabilities } from './prompt';
import { buildReviewPrompt } from './prompt';

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

export function parseReviewVerdict(reviewOutput: string): ReviewVerdict {
	const verdictMatch = reviewOutput.match(/\*\*Verdict\*\*:\s*(APPROVED|NEEDS-RETRY)/i);
	if (!verdictMatch) {
		return { outcome: 'approved', summary: reviewOutput };
	}

	const outcome = verdictMatch[1].toLowerCase() === 'approved' ? 'approved' : 'needs-retry';

	const issues: string[] = [];
	const issuesHeaderMatch = reviewOutput.match(/###\s*Issues Found/i);
	if (issuesHeaderMatch) {
		const afterHeader = reviewOutput.slice(issuesHeaderMatch.index! + issuesHeaderMatch[0].length);
		const nextSectionMatch = afterHeader.match(/^###\s/m);
		const issuesBlock = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;
		const itemMatches = issuesBlock.matchAll(/^\d+\.\s+(.+)$/gm);
		for (const m of itemMatches) {
			issues.push(m[1].trim());
		}
	}

	return {
		outcome,
		summary: reviewOutput,
		issues: issues.length > 0 ? issues : undefined,
	};
}

export async function sendReviewPrompt(
	taskDescription: string,
	mode: 'same-session' | 'new-session',
	reviewPromptTemplate: string | undefined,
	logger: ILogger,
	taskId?: string,
): Promise<string> {
	let prompt: string;
	if (taskId) {
		prompt = buildReviewPrompt(taskDescription, taskId);
	} else {
		const template = reviewPromptTemplate ?? DEFAULT_REVIEW_PROMPT_TEMPLATE;
		prompt = template.replace('[TASK]', taskDescription);
	}

	if (mode === 'new-session') {
		await startFreshChatSession(logger);
	}

	const method = await openCopilotWithPrompt(prompt, logger);
	logger.log(`Review prompt sent via ${method} (mode: ${mode})`);
	return prompt;
}

