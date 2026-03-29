import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import type { ILogger } from './types';

const HANDOFF_DIR = '.local/share/chat-handoffs';
const TRANSCRIPT_NAME = 'latest-transcript.jsonl';

export function getTranscriptPath(): string {
	return `${process.env.HOME}/${HANDOFF_DIR}/${TRANSCRIPT_NAME}`;
}

export async function checkTranscriptExists(transcriptPath: string): Promise<boolean> {
	return vscode.workspace.fs.stat(vscode.Uri.file(transcriptPath)).then(() => true, () => false);
}

function extractTopicHint(): string {
	const absPath = getTranscriptPath();
	try {
		const raw = readFileSync(absPath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		const hints: string[] = [];
		for (const line of lines) {
			if (hints.length >= 3) break;
			try {
				const obj = JSON.parse(line);
				if (obj.type === "user.message" && obj.data?.content) {
					hints.push(String(obj.data.content).slice(0, 120));
				}
			} catch { /* skip */ }
		}
		return hints.length > 0 ? hints.join(" | ") : "";
	} catch {
		return "";
	}
}

export function buildHandoffPrompt(): string {
	const absPath = getTranscriptPath();
	const topic = extractTopicHint();
	const intro = topic
		? `Resuming work on: ${topic}`
		: `Resuming previous session`;
	return `${intro}

Dispatch the transcript-summarizer subagent with this prompt: "Analyze the full transcript at ${absPath} and return a PD index." Use the returned index to understand context and continue where we left off.`;
}

export function buildTranscriptSummary(): string {
	const absPath = getTranscriptPath();
	try {
		const raw = readFileSync(absPath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		const last50 = lines.slice(-50);
		const entries: string[] = [];
		for (const line of last50) {
			try {
				const obj = JSON.parse(line);
				if (obj.type === "user.message" && obj.data?.content) {
					entries.push(`User: ${String(obj.data.content).slice(0, 300)}`);
				} else if (obj.type === "assistant.text_chunk" && obj.data?.text) {
					entries.push(`Assistant: ${String(obj.data.text).slice(0, 300)}`);
				} else if (obj.type === "assistant.turn_complete" && obj.data?.text) {
					entries.push(`Assistant: ${String(obj.data.text).slice(0, 300)}`);
				} else if (obj.type === "tool.call" && obj.data?.toolName) {
					entries.push(`Tool: ${obj.data.toolName}(${String(obj.data.input ?? "").slice(0, 100)})`);
				}
			} catch { /* skip malformed lines */ }
		}
		return entries.length > 0
			? entries.join("\n")
			: `[Transcript at ${absPath} — ${lines.length} lines, could not parse entries]`;
	} catch {
		return `[Could not read transcript at ${absPath}]`;
	}
}

export interface HandoffOptions {
	variant?: number;
	model?: string;
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
		// Toggle mode twice to force-reset to default Copilot agent (clears custom agent selection)
		await vscode.commands.executeCommand("workbench.action.chat.toggleAgentMode", { modeId: "ask" });
		await vscode.commands.executeCommand("workbench.action.chat.toggleAgentMode", { modeId: "agent" });
		await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt, mode: "agent" });
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

function buildChatOpenOptions(prompt: string, opts: HandoffOptions, summary?: string): Record<string, unknown> {
	const options: Record<string, unknown> = { query: prompt, mode: "agent" };
	if (opts.model) {
		options.modelSelector = { id: opts.model };
	}
	if (summary) {
		options.previousRequests = [
			{ request: "Session context from previous conversation", response: summary },
		];
	}
	return options;
}

const advancedStrategies: Record<number, (prompt: string, opts: HandoffOptions) => Promise<void>> = {
	// Strategy 13: previousRequests summary injection + modelSelector (no transcript reading needed)
	13: async (prompt, opts) => {
		const summary = buildTranscriptSummary();
		await vscode.commands.executeCommand("workbench.action.chat.newChat");
		await vscode.commands.executeCommand("workbench.action.chat.open",
			buildChatOpenOptions("Continue from where we left off. What was I working on?", opts, summary));
	},
	// Strategy 14: same as 13 but keeps the original prompt (transcript read instruction as fallback)
	14: async (prompt, opts) => {
		const summary = buildTranscriptSummary();
		await vscode.commands.executeCommand("workbench.action.chat.newChat");
		await vscode.commands.executeCommand("workbench.action.chat.open",
			buildChatOpenOptions(prompt, opts, summary));
	},
	// Strategy 15: previousRequests only, no query prompt — pure context injection
	15: async (_prompt, opts) => {
		const summary = buildTranscriptSummary();
		await vscode.commands.executeCommand("workbench.action.chat.newChat");
		await vscode.commands.executeCommand("workbench.action.chat.open",
			buildChatOpenOptions("I just rotated the session for performance. The previous conversation context is already loaded above. Pick up where we left off.", opts, summary));
	},
};

export async function executeHandoff(logger: ILogger, opts?: HandoffOptions | number): Promise<boolean> {
	const options: HandoffOptions = typeof opts === "number" ? { variant: opts } : (opts ?? {});
	const transcriptPath = getTranscriptPath();
	const exists = await checkTranscriptExists(transcriptPath);
	if (!exists) {
		vscode.window.showWarningMessage("No handoff transcript found. Run /handoff first.");
		return false;
	}
	const prompt = buildHandoffPrompt();
	const v = options.variant ?? 1;

	if (advancedStrategies[v]) {
		await advancedStrategies[v](prompt, options);
	} else {
		const strategy = strategies[v] ?? strategies[1];
		await strategy(prompt);
	}
	logger.log(`Handoff: executed strategy ${v}${options.model ? ` (model: ${options.model})` : ""}`);
	return true;
}
