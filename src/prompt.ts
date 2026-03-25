export interface PromptVariables {
	task: string;
	prd: string;
	progress: string;
	learnings: string;
	workspace: string;
	taskId: string;
	iterationNumber: number;
}

export const DEFAULT_PROMPT_TEMPLATE = '## Task: {{taskId}}\n{{task}}\n\n## Current PRD State\n{{prd}}\n\n## Recent Progress\n{{progress}}';

export function renderTemplate(template: string, variables: PromptVariables): string {
	const known: Record<string, string> = {
		task: variables.task,
		prd: variables.prd,
		progress: variables.progress,
		learnings: variables.learnings,
		workspace: variables.workspace,
		taskId: variables.taskId,
		iterationNumber: String(variables.iterationNumber),
	};
	return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		return key in known ? known[key] : match;
	});
}

export function sanitizeTaskDescription(text: string): string {
	// Strip ASCII control chars (0-31) except newline (0x0A) and tab (0x09)
	let result = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
	// Strip <prompt> and </prompt> XML-style tags (prompt injection defense)
	result = result.replace(/<\/?prompt>/gi, '');
	// Escape triple backticks to prevent code fence injection
	result = result.replace(/```/g, '\\`\\`\\`');
	// Enforce 5000 character limit
	if (result.length > 5000) {
		result = result.slice(0, 5000) + '... [truncated]';
	}
	return result;
}

export function estimatePromptTokens(prompt: string): number {
	if (prompt.length === 0) { return 0; }
	return Math.ceil(prompt.length / 3.5);
}

export function annotateBudget(prompt: string, config: ContextBudgetConfig): string {
	if (config.mode !== 'annotate') { return prompt; }
	const tokens = estimatePromptTokens(prompt);
	const pct = (tokens / config.maxEstimatedTokens) * 100;
	if (pct < config.warningThresholdPct) { return prompt; }
	return `[Context budget: ~${Math.round(pct)}% utilized — be concise, avoid verbose output]\n${prompt}`;
}

import { DEFAULT_CONTEXT_TRIMMING, type ContextTrimmingConfig, type ContextBudgetConfig, type ResearchFrontmatter, type SpecFrontmatter } from './types';
import * as fs from 'fs';
import * as path from 'path';

export function parseFrontmatter(content: string): Record<string, unknown> | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) { return null; }
	const yaml = match[1];
	const result: Record<string, unknown> = {};
	for (const line of yaml.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) { continue; }
		if (trimmed.startsWith('- ')) { continue; }
		const colonIdx = trimmed.indexOf(':');
		if (colonIdx < 0) { continue; }
		const key = trimmed.slice(0, colonIdx).trim();
		const rawVal = trimmed.slice(colonIdx + 1).trim();
		if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
			result[key] = rawVal.slice(1, -1).split(',').map(s => {
				const v = s.trim();
				const num = Number(v);
				return Number.isNaN(num) ? v : num;
			});
		} else {
			const num = Number(rawVal);
			result[key] = Number.isNaN(num) ? rawVal : num;
		}
	}
	// Parse list items under their parent key
	let currentKey: string | null = null;
	for (const line of yaml.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('- ') && trimmed.includes(':')) {
			const colonIdx = trimmed.indexOf(':');
			const key = trimmed.slice(0, colonIdx).trim();
			const val = trimmed.slice(colonIdx + 1).trim();
			if (!val) { currentKey = key; continue; }
			currentKey = null;
		} else if (trimmed.startsWith('- ') && currentKey) {
			const item = trimmed.slice(2).trim();
			if (!Array.isArray(result[currentKey])) { result[currentKey] = []; }
			(result[currentKey] as unknown[]).push(item);
		} else {
			currentKey = null;
		}
	}
	return result;
}

export interface BlockquoteMetadata {
	sources: string[];
	date?: string;
	session?: string;
}

export function extractBlockquoteMetadata(content: string): BlockquoteMetadata {
	const meta: BlockquoteMetadata = { sources: [] };
	const lines = content.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('>')) { continue; }
		const text = trimmed.slice(1).trim();
		const sourceMatch = text.match(/^Source:\s*(.+)/);
		if (sourceMatch) {
			meta.sources.push(sourceMatch[1].trim());
			continue;
		}
		const dateMatch = text.match(/^Date:\s*(\d{4}-\d{2}-\d{2})/);
		if (dateMatch) {
			meta.date = dateMatch[1];
			continue;
		}
		const sessionMatch = text.match(/^Session:\s*`?([^`]+)`?/);
		if (sessionMatch) {
			meta.session = sessionMatch[1].trim();
			continue;
		}
	}
	return meta;
}

export function normalizeResearchFile(content: string, filename: string): string {
	if (parseFrontmatter(content) !== null) { return content; }
	const idMatch = filename.match(/^(\d+)/);
	const id = idMatch ? parseInt(idMatch[1], 10) : 0;
	const meta = extractBlockquoteMetadata(content);
	const fmLines: string[] = ['---', 'type: research', `id: ${id}`];
	if (meta.date) { fmLines.push(`date: ${meta.date}`); }
	if (meta.sources.length > 0) {
		fmLines.push('sources:');
		for (const s of meta.sources) { fmLines.push(`  - ${s}`); }
	}
	if (meta.session) { fmLines.push(`session: ${meta.session}`); }
	fmLines.push('---');
	return fmLines.join('\n') + '\n' + content;
}

export function extractSpecReference(taskDescription: string): { filePath: string; startLine: number; endLine: number } | null {
	const match = taskDescription.match(/→\s*Spec:\s*`?([^`\s]+)`?\s+L(\d+)-L(\d+)/);
	if (!match) { return null; }
	return { filePath: match[1], startLine: parseInt(match[2], 10), endLine: parseInt(match[3], 10) };
}

export function buildSpecContextLine(workspaceRoot: string, taskDescription: string): string | null {
	const ref = extractSpecReference(taskDescription);
	if (!ref) { return null; }
	try {
		const fullPath = path.resolve(workspaceRoot, ref.filePath);
		const content = fs.readFileSync(fullPath, 'utf-8');
		const fm = parseFrontmatter(content);
		if (!fm) { return null; }
		const parts: string[] = [];
		if (fm.phase !== undefined) { parts.push(`Phase ${fm.phase}`); }
		if (Array.isArray(fm.principles) && fm.principles.length > 0) {
			parts.push(`principles: ${(fm.principles as string[]).join(', ')}`);
		}
		if (Array.isArray(fm.verification) && fm.verification.length > 0) {
			const cmds = (fm.verification as string[]).map(v => {
				const base = v.split(' ').slice(1, 3).join(' ');
				return base || v;
			});
			parts.push(`verify: ${cmds.join('+')}`);
		}
		if (fm.research !== undefined) { parts.push(`research: ${fm.research}`); }
		if (parts.length === 0) { return null; }
		return `[Spec context: ${parts.join(' | ')}]`;
	} catch {
		return null;
	}
}

function filterPrdContent(prdContent: string, currentTask?: string): string {
	const lines = prdContent.split('\n');
	const checkedCount = lines.filter(l => l.match(/- \[x\]/i)).length;
	const uncheckedLines = lines.filter(l => l.match(/- \[ \]/));
	const totalTasks = checkedCount + uncheckedLines.length;
	const header = `Progress: ${checkedCount}/${totalTasks} tasks completed`;
	if (currentTask) {
		const currentLine = uncheckedLines.find(l => l.includes(currentTask));
		return [header, '', ...(currentLine ? [currentLine] : [])].join('\n');
	}
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

function renderLearnings(learnings?: string[]): string[] {
	if (!learnings || learnings.length === 0) { return []; }
	return [
		'===================================================================',
		'                       PRIOR LEARNINGS',
		'===================================================================',
		'',
		...learnings.map(l => `- ${l}`),
		'',
	];
}

function renderOperatorContext(operatorContext?: string): string[] {
	if (!operatorContext) { return []; }
	return [
		'===================================================================',
		'                 OPERATOR CONTEXT (injected mid-loop)',
		'===================================================================',
		'',
		operatorContext,
		'',
	];
}

export function buildFinalNudgePrompt(task: string, nudgeCount: number, maxNudges: number): string | undefined {
	if (nudgeCount < maxNudges - 1) { return undefined; }
	return `Your remaining time is almost up. Produce your final result NOW: commit any partial work, update progress.txt, and mark the checkbox. If tests fail, document the failure and mark done anyway.`;
}

export function buildPrompt(taskDescription: string, prdContent: string, progressContent: string, maxProgressLines: number = 20, promptBlocks?: string[], capabilities?: PromptCapabilities, learnings?: string[], iterationNumber: number = 1, contextTrimming?: ContextTrimmingConfig, operatorContext?: string, taskId?: string, promptTemplate?: string, workspaceRoot?: string): string {
	const sanitized = sanitizeTaskDescription(taskDescription.trim());
	const ct = contextTrimming ?? DEFAULT_CONTEXT_TRIMMING;

	let effectiveMaxProgressLines = maxProgressLines;
	let effectiveLearnings = learnings;
	let prdCurrentTaskOnly: string | undefined;
	const trimmingNotes: string[] = [];

	if (iterationNumber > ct.abbreviatedUntil) {
		// Minimal tier
		effectiveMaxProgressLines = 5;
		effectiveLearnings = undefined;
		prdCurrentTaskOnly = taskDescription.trim();
		trimmingNotes.push('[minimal context mode — focus on current task only]');
	} else if (iterationNumber > ct.fullUntil) {
		// Abbreviated tier
		effectiveMaxProgressLines = 10;
		if (effectiveLearnings && effectiveLearnings.length > 8) {
			effectiveLearnings = effectiveLearnings.slice(0, 8);
		}
		trimmingNotes.push('[context trimmed for iteration efficiency]');
	}
	// else: Full tier — no changes

	const parts: string[] = [
		'===================================================================',
		`                       YOUR TASK TO IMPLEMENT${taskId ? ` \u2014 ${taskId}` : ''}`,
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
		'===================================================================',
		'                       TDD GATE \u2014 MANDATORY',
		'===================================================================',
		'',
		'Every task MUST follow the TDD cycle: (1) Write a failing test FIRST that covers the acceptance criteria, (2) Run npx vitest run \u2014 confirm the new test FAILS (red), (3) Implement the minimum code to make the test pass, (4) Run npx vitest run \u2014 confirm ALL tests PASS (green), (5) Refactor if needed \u2014 run tests again to confirm still green, (6) Run npx tsc --noEmit \u2014 must exit 0 with zero errors, (7) ONLY THEN mark the checkbox in PRD.md. If ANY test is red or tsc reports errors, you are NOT done \u2014 fix them before proceeding. This is not optional. No checkbox may be marked while tests are failing.',
		'',
		'===================================================================',
		'              SEARCH-BEFORE-IMPLEMENT GATE',
		'===================================================================',
		'',
		'Before writing ANY new code, you MUST search the codebase for existing implementations that already solve the problem or provide reusable utilities. Use grep, semantic search, or file search to look for: (1) Functions, classes, or modules with similar names or purposes, (2) Existing patterns that can be extended rather than duplicated, (3) Shared utilities or helpers that already handle part of the task. Only after confirming no suitable existing code exists should you write new implementations. If you find existing code, integrate with or extend it instead of creating duplicates. This prevents the #1 agent mistake: accidental duplication.',
		'',
		'===================================================================',
		'                 SPEC REFERENCE GATE',
		'===================================================================',
		'',
		'If the task description references a spec file (\u2192 Spec: path LN-LN), you MUST read that file at the specified line range BEFORE writing any code. The task summary is intentionally brief \u2014 the spec contains required interfaces, config fields, test expectations, and design decisions. Do not skip this step.',
		'',
	];

	// Inject spec context from frontmatter if available
	if (workspaceRoot) {
		const specContext = buildSpecContextLine(workspaceRoot, taskDescription);
		if (specContext) {
			parts.push(specContext, '');
		}
	}

	parts.push(
		'When done: FIRST append what you did to progress.txt, THEN mark the checkbox in PRD.md. Both updates are required.',
		'',
		'Continue working until the task is fully complete. It\'s YOUR RESPONSIBILITY to finish. Do not hand back to the user.',
		'',
		...renderPromptBlocks(promptBlocks),
		...renderModelHints(capabilities?.modelHint),
		...renderCapabilities(capabilities),
		...renderLearnings(effectiveLearnings),
		...renderOperatorContext(operatorContext),
		...(trimmingNotes.length > 0 ? [...trimmingNotes, ''] : []),
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
	);

	if (promptTemplate) {
		const filteredPrd = filterPrdContent(prdContent, prdCurrentTaskOnly);
		const vars: PromptVariables = {
			task: sanitized,
			prd: filteredPrd,
			progress: progressContent.trim(),
			learnings: (effectiveLearnings ?? []).join('\n'),
			workspace: '',
			taskId: taskId ?? '',
			iterationNumber: iterationNumber,
		};
		parts.push(renderTemplate(promptTemplate, vars));
		parts.push('');
		return parts.join('\n');
	}

	parts.push(
		'===================================================================',
		'                       PROJECT CONTEXT',
		'===================================================================',
		'',
		'## PRD.md:',
		'```markdown',
		filterPrdContent(prdContent, prdCurrentTaskOnly),
		'```',
		'',
	);

	if (progressContent.trim()) {
		const lines = progressContent.split('\n');
		let displayContent: string;
		if (lines.length > effectiveMaxProgressLines) {
			const omitted = lines.length - effectiveMaxProgressLines;
			const kept = lines.slice(-effectiveMaxProgressLines);
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

export function buildReviewPrompt(taskDescription: string, taskId: string): string {
	const format = [
		'## Review: Task-{id} — {title}',
		'**Verdict**: APPROVED | NEEDS-RETRY',
		'### Acceptance Criteria Check',
		'- [x/fail] Criterion — reason',
		'### Issues Found (if NEEDS-RETRY)',
		'1. **[Critical/Minor]**: issue with file:line',
		'### Fix Instructions',
		'1. Specific actionable fix',
	].join('\n');

	return [
		'You are a code reviewer. Verify, don\'t fix. Output ONLY the structured review format above. Check: correctness, code quality, test coverage, no dead code, no unused imports. Your verdict must be exactly APPROVED or NEEDS-RETRY.',
		'',
		`Task ID: ${taskId}`,
		`Task: ${taskDescription}`,
		'',
		'Output format:',
		format,
	].join('\n');
}
