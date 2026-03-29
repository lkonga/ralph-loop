import * as vscode from 'vscode';
import type { ILogger } from './types';

const HANDOFF_DIR = '.local/share/chat-handoffs';
const TRANSCRIPT_NAME = 'latest-transcript.jsonl';

export function getTranscriptPath(): string {
	return `${process.env.HOME}/${HANDOFF_DIR}/${TRANSCRIPT_NAME}`;
}

export async function checkTranscriptExists(transcriptPath: string): Promise<boolean> {
	return vscode.workspace.fs.stat(vscode.Uri.file(transcriptPath)).then(() => true, () => false);
}

export function buildHandoffPrompt(): string {
	return `You are continuing from a previous session rotated for performance. The transcript is at ~/${HANDOFF_DIR}/${TRANSCRIPT_NAME} — read only the last 100 lines first (tail), then drill into earlier parts only when needed. What was I working on?`;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
type Strategy = (prompt: string) => Promise<void>;

const strategies: Record<number, Strategy> = {
	1: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await vscode.commands.executeCommand("workbench.action.chat.openEditSession", prompt);
	},
	2: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await delay(500);
		await vscode.commands.executeCommand("type", { text: prompt });
		await vscode.commands.executeCommand("workbench.action.chat.submit");
	},
	3: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
	},
	4: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.openEditSession", prompt);
	},
	5: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await delay(1000);
		await vscode.commands.executeCommand("workbench.panel.chat.view.copilot.focus");
		await delay(200);
		await vscode.commands.executeCommand("type", { text: prompt });
		await vscode.commands.executeCommand("workbench.action.chat.submit");
	},
	6: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await vscode.commands.executeCommand("workbench.action.chat.toggleAgentMode", { modeId: "agent" });
		await delay(300);
		await vscode.commands.executeCommand("type", { text: prompt });
		await vscode.commands.executeCommand("workbench.action.chat.submit");
	},
	7: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newChat");
		await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
	},
	8: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await delay(2000);
		await vscode.commands.executeCommand("type", { text: prompt });
		await vscode.commands.executeCommand("workbench.action.chat.submit");
	},
	9: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await delay(300);
		await vscode.commands.executeCommand("workbench.action.chat.sendRequest", prompt);
	},
	10: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await vscode.commands.executeCommand("workbench.action.chat.openEditSession", { prompt });
	},
	// ralph-loop orchestrator pattern: newEditSession → toggleAgentMode → openEditSession
	11: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await vscode.commands.executeCommand("workbench.action.chat.toggleAgentMode", { modeId: "agent" });
		await vscode.commands.executeCommand("workbench.action.chat.openEditSession", prompt);
	},
	// same as 11 but with delay after toggle
	12: async (prompt) => {
		await vscode.commands.executeCommand("workbench.action.chat.newEditSession");
		await vscode.commands.executeCommand("workbench.action.chat.toggleAgentMode", { modeId: "agent" });
		await delay(300);
		await vscode.commands.executeCommand("workbench.action.chat.openEditSession", prompt);
	},
};

export async function executeHandoff(logger: ILogger, variant?: number): Promise<boolean> {
	const transcriptPath = getTranscriptPath();
	const exists = await checkTranscriptExists(transcriptPath);
	if (!exists) {
		vscode.window.showWarningMessage("No handoff transcript found. Run /handoff first.");
		return false;
	}
	const prompt = buildHandoffPrompt();
	const v = variant ?? 1;
	const strategy = strategies[v] ?? strategies[1];
	await strategy(prompt);
	logger.log(`Handoff: executed strategy ${v}`);
	return true;
}
