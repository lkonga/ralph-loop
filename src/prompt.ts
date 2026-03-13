function filterPrdContent(prdContent: string): string {
	const lines = prdContent.split('\n');
	const checkedCount = lines.filter(l => l.match(/- \[x\]/i)).length;
	const uncheckedLines = lines.filter(l => l.match(/- \[ \]/));
	const totalTasks = checkedCount + uncheckedLines.length;
	const header = `Progress: ${checkedCount}/${totalTasks} tasks completed`;
	return [header, '', ...uncheckedLines].join('\n');
}

const PROMPT_BLOCKS: Record<string, string> = {
	security: 'Be aware of OWASP Top 10 vulnerabilities. Validate all inputs and never hardcode secrets, tokens, or credentials in source code.',
	safety: 'Prefer reversible actions. Confirm before destructive operations like deleting files or dropping data. Do not delete files unless the PRD explicitly instructs it.',
	discipline: 'Make minimal, surgical changes — only what the task requires. No over-engineering, no unsolicited refactoring, no adding features beyond scope.',
	brevity: 'Keep output concise. Do not add verbose explanations in code comments. Communicate results briefly.',
};

function renderPromptBlocks(blocks?: string[]): string[] {
	if (!blocks || blocks.length === 0) { return []; }
	const lines: string[] = [];
	for (const key of blocks) {
		const text = PROMPT_BLOCKS[key];
		if (text) { lines.push(text, ''); }
	}
	return lines;
}

export interface PromptCapabilities {
	hooksEnabled?: boolean;
	hookScript?: string;
	promptBlocks?: string[];
	modelHint?: string;
}

const MODEL_HINTS: Record<string, string> = {
	claude: 'You appear to be a Claude model. For long code outputs, use artifacts to keep responses structured. Prefer concise explanations with detailed code.',
	gpt: 'You appear to be a GPT model. Use code blocks for all code output. Be precise and direct in explanations.',
};

function renderModelHints(modelHint?: string): string[] {
	if (!modelHint) { return []; }
	const key = Object.keys(MODEL_HINTS).find(k => modelHint.toLowerCase().includes(k));
	if (!key) { return []; }
	return [
		'===================================================================',
		'                       MODEL OPTIMIZATION',
		'===================================================================',
		'',
		MODEL_HINTS[key],
		'',
	];
}

function renderCapabilities(caps?: PromptCapabilities): string[] {
	if (!caps) { return []; }
	const items: string[] = [];
	if (caps.hooksEnabled) {
		items.push('- Quality hooks are active — your work will be validated after each tool use.');
	}
	if (caps.hookScript) {
		items.push(`- External validator: ${caps.hookScript} will run on task completion.`);
	}
	if (caps.promptBlocks && caps.promptBlocks.length > 0) {
		const active = caps.promptBlocks.filter(b => PROMPT_BLOCKS[b]);
		if (active.length > 0) {
			items.push(`- Active prompt guidelines: ${active.join(', ')}.`);
		}
	}
	if (items.length === 0) { return []; }
	return [
		'===================================================================',
		'                    AVAILABLE CAPABILITIES',
		'===================================================================',
		'',
		...items,
		'',
	];
}

export function buildFinalNudgePrompt(task: string, nudgeCount: number, maxNudges: number): string | undefined {
	if (nudgeCount < maxNudges - 1) { return undefined; }
	return `Your remaining time is almost up. Produce your final result NOW: commit any partial work, update progress.txt, and mark the checkbox. If tests fail, document the failure and mark done anyway.`;
}

export function buildPrompt(taskDescription: string, prdContent: string, progressContent: string, maxProgressLines: number = 20, promptBlocks?: string[], capabilities?: PromptCapabilities): string {
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
		'                       ROLE & BEHAVIOR',
		'===================================================================',
		'',
		'You are an autonomous coding agent. Complete the task below by editing files directly. If you encounter errors, debug and fix them — do not stop. If tests fail, fix the tests or the code. When done, mark the checkbox in PRD.md and append what you did to progress.txt. Do not ask questions — act.',
		'',
		'DO NOT STOP if: you encounter an error (debug and fix it), tests fail (fix them), you have remaining steps (complete them first), you have open questions (make a decision and proceed).',
		'',
		'When done: FIRST append what you did to progress.txt, THEN mark the checkbox in PRD.md. Both updates are required.',
		'',
		'Continue working until the task is fully complete. It\'s YOUR RESPONSIBILITY to finish. Do not hand back to the user.',
		'',
		...renderPromptBlocks(promptBlocks),
		...renderModelHints(capabilities?.modelHint),
		...renderCapabilities(capabilities),
		'===================================================================',
		'    MANDATORY: UPDATE PRD.md AND progress.txt WHEN DONE',
		'===================================================================',
		'',
		'After completing the task:',
		'',
		`1. Git commit your code changes atomically: \`git add -A && git commit -m "feat: <short description>"\``,
		`2. In PRD.md, change:  - [ ] ${sanitized}`,
		`   To:                 - [x] ${sanitized}`,
		'',
		'3. Append to progress.txt what you did.',
		`4. Git commit the PRD.md + progress.txt update: \`git add PRD.md progress.txt && git commit -m "chore: mark task done"\``,
		'',
		'Commit OFTEN — after each meaningful change, not just at the end.',
		'All updates are required for the loop to continue!',
		'',
		'===================================================================',
		'                       PROJECT CONTEXT',
		'===================================================================',
		'',
		'## PRD.md:',
		'```markdown',
		filterPrdContent(prdContent),
		'```',
		'',
	];

	if (progressContent.trim()) {
		const lines = progressContent.split('\n');
		let displayContent: string;
		if (lines.length > maxProgressLines) {
			const omitted = lines.length - maxProgressLines;
			const kept = lines.slice(-maxProgressLines);
			displayContent = `[...${omitted} earlier entries omitted]\n${kept.join('\n')}`;
		} else {
			displayContent = progressContent;
		}
		parts.push('## progress.txt:');
		parts.push('```');
		parts.push(displayContent);
		parts.push('```');
		parts.push('');
	}

	return parts.join('\n');
}
