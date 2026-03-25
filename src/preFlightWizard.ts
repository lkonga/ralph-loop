import * as vscode from 'vscode';
import type { RunConfig } from './runConfig';
import { loadOrDetectRunConfig, saveRunConfig } from './runConfig';
import type { RunnerType, VerificationMode, RunScope } from './runConfig';

export type PreFlightMode = 'always' | 'countdown' | 'never';

export interface PreFlightResult {
	config: RunConfig;
	skipped: boolean;
}

const RUNNER_OPTIONS: { label: string; value: RunnerType; description: string }[] = [
	{ label: 'auto-detect', value: 'auto', description: 'Detect from project files' },
	{ label: 'vitest', value: 'vitest', description: 'npx vitest run' },
	{ label: 'jest', value: 'jest', description: 'npx jest' },
	{ label: 'cargo', value: 'cargo', description: 'cargo test' },
	{ label: 'go', value: 'go', description: 'go test ./...' },
	{ label: 'pytest', value: 'pytest', description: 'pytest' },
	{ label: 'none', value: 'none', description: 'Skip test verification' },
];

const MODE_OPTIONS: { label: string; value: VerificationMode; description: string }[] = [
	{ label: 'TDD strict', value: 'tdd-strict', description: 'Red-green-refactor cycle enforced' },
	{ label: 'Verify after', value: 'verify-after', description: 'Run tests after implementation' },
	{ label: 'Skip tests', value: 'skip-tests', description: 'No test verification' },
];

const SCOPE_OPTIONS: { label: string; value: RunScope; description: string }[] = [
	{ label: 'Full PRD', value: 'full-prd', description: 'Process all pending tasks' },
	{ label: 'Single task', value: 'single-task', description: 'Complete one task only' },
	{ label: 'Checkpoint only', value: 'checkpoint-only', description: 'Run until next checkpoint' },
];

export async function showPreFlightWizard(
	workspaceRoot: string,
	mode: PreFlightMode,
	countdownSeconds: number,
): Promise<PreFlightResult> {
	const defaults = loadOrDetectRunConfig(workspaceRoot);

	if (mode === 'never') {
		return { config: defaults, skipped: true };
	}

	if (mode === 'countdown') {
		const userInteracted = await showCountdown(defaults, countdownSeconds);
		if (!userInteracted) {
			return { config: defaults, skipped: false };
		}
	}

	// Full wizard
	const config = await showFullWizard(defaults);
	if (config) {
		saveRunConfig(workspaceRoot, config);
		return { config, skipped: false };
	}
	// User cancelled — use defaults
	return { config: defaults, skipped: false };
}

async function showCountdown(defaults: RunConfig, seconds: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const runnerLabel = defaults.runner === 'none' ? 'no tests' : defaults.runner;

		vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, cancellable: true, title: 'Ralph Loop' },
			async (progress, token) => {
				for (let i = seconds; i > 0; i--) {
					if (token.isCancellationRequested) {
						resolve(true);
						return;
					}
					progress.report({
						message: `Starting in ${i}s — ${runnerLabel} / ${defaults.mode} — Click cancel to configure`,
					});
					await new Promise(r => setTimeout(r, 1000));
				}
				resolve(false);
			},
		);
	});
}

async function showFullWizard(defaults: RunConfig): Promise<RunConfig | null> {
	const runnerPick = await vscode.window.showQuickPick(
		RUNNER_OPTIONS.map(o => ({
			label: o.label,
			description: o.description,
			picked: o.value === defaults.runner,
		})),
		{ title: 'Ralph Loop — Test Runner', placeHolder: `Current: ${defaults.runner}` },
	);
	if (!runnerPick) return null;
	const runner = RUNNER_OPTIONS.find(o => o.label === runnerPick.label)?.value ?? defaults.runner;

	const modePick = await vscode.window.showQuickPick(
		MODE_OPTIONS.map(o => ({
			label: o.label,
			description: o.description,
			picked: o.value === defaults.mode,
		})),
		{ title: 'Ralph Loop — Verification Mode', placeHolder: `Current: ${defaults.mode}` },
	);
	if (!modePick) return null;
	const verificationMode = MODE_OPTIONS.find(o => o.label === modePick.label)?.value ?? defaults.mode;

	const scopePick = await vscode.window.showQuickPick(
		SCOPE_OPTIONS.map(o => ({
			label: o.label,
			description: o.description,
			picked: o.value === defaults.scope,
		})),
		{ title: 'Ralph Loop — Run Scope', placeHolder: `Current: ${defaults.scope}` },
	);
	if (!scopePick) return null;
	const scope = SCOPE_OPTIONS.find(o => o.label === scopePick.label)?.value ?? defaults.scope;

	return {
		...defaults,
		runner,
		mode: verificationMode,
		scope,
	};
}

export function formatRunConfigForPrompt(config: RunConfig): string {
	const lines: string[] = [
		'===================================================================',
		'                    RUN CONFIGURATION',
		'===================================================================',
		'',
		`Runner: ${config.runner}`,
	];
	if (config.buildCommand) lines.push(`Build: ${config.buildCommand}`);
	if (config.testCommand) lines.push(`Test: ${config.testCommand}`);
	lines.push(`Mode: ${config.mode}`);
	lines.push(`Scope: ${config.scope}`);
	lines.push('');
	return lines.join('\n');
}
