import * as fs from 'fs';
import * as path from 'path';

export type RunnerType = 'auto' | 'vitest' | 'jest' | 'cargo' | 'go' | 'pytest' | 'none';
export type VerificationMode = 'tdd-strict' | 'verify-after' | 'skip-tests';
export type RunScope = 'full-prd' | 'single-task' | 'checkpoint-only';

export interface RunConfig {
	runner: RunnerType;
	buildCommand?: string;
	testCommand?: string;
	mode: VerificationMode;
	scope: RunScope;
	lastUpdated: string;
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
	runner: 'auto',
	mode: 'tdd-strict',
	scope: 'full-prd',
	lastUpdated: '',
};

const RUNNER_DETECTION: { file: string; runner: RunnerType; buildCommand?: string; testCommand: string }[] = [
	{ file: 'vitest.config.ts', runner: 'vitest', testCommand: 'npx vitest run' },
	{ file: 'vitest.config.js', runner: 'vitest', testCommand: 'npx vitest run' },
	{ file: 'vitest.config.mts', runner: 'vitest', testCommand: 'npx vitest run' },
	{ file: 'vite.config.ts', runner: 'vitest', testCommand: 'npx vitest run' },
	{ file: 'vite.config.js', runner: 'vitest', testCommand: 'npx vitest run' },
	{ file: 'jest.config.js', runner: 'jest', testCommand: 'npx jest' },
	{ file: 'jest.config.ts', runner: 'jest', testCommand: 'npx jest' },
	{ file: 'jest.config.mjs', runner: 'jest', testCommand: 'npx jest' },
	{ file: 'Cargo.toml', runner: 'cargo', buildCommand: 'cargo check', testCommand: 'cargo test' },
	{ file: 'go.mod', runner: 'go', buildCommand: 'go build ./...', testCommand: 'go test ./...' },
	{ file: 'pyproject.toml', runner: 'pytest', testCommand: 'pytest' },
	{ file: 'pytest.ini', runner: 'pytest', testCommand: 'pytest' },
	{ file: 'setup.cfg', runner: 'pytest', testCommand: 'pytest' },
];

const TSC_DETECTION = ['tsconfig.json'];

export function detectRunner(workspaceRoot: string): { runner: RunnerType; buildCommand?: string; testCommand?: string } {
	for (const entry of RUNNER_DETECTION) {
		if (fs.existsSync(path.join(workspaceRoot, entry.file))) {
			let buildCommand = entry.buildCommand;
			if (!buildCommand) {
				for (const tscFile of TSC_DETECTION) {
					if (fs.existsSync(path.join(workspaceRoot, tscFile))) {
						buildCommand = 'npx tsc --noEmit';
						break;
					}
				}
			}
			return { runner: entry.runner, buildCommand, testCommand: entry.testCommand };
		}
	}
	return { runner: 'none' };
}

export function resolveRunConfig(config: RunConfig, workspaceRoot: string): RunConfig {
	if (config.runner !== 'auto') return config;
	const detected = detectRunner(workspaceRoot);
	return {
		...config,
		runner: detected.runner,
		buildCommand: config.buildCommand ?? detected.buildCommand,
		testCommand: config.testCommand ?? detected.testCommand,
	};
}

const RUN_CONFIG_PATH = '.ralph/run-config.json';

export function loadRunConfig(workspaceRoot: string): RunConfig | null {
	const configPath = path.join(workspaceRoot, RUN_CONFIG_PATH);
	try {
		const raw = fs.readFileSync(configPath, 'utf-8');
		return JSON.parse(raw) as RunConfig;
	} catch {
		return null;
	}
}

export function saveRunConfig(workspaceRoot: string, config: RunConfig): void {
	const configPath = path.join(workspaceRoot, RUN_CONFIG_PATH);
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const toSave = { ...config, lastUpdated: new Date().toISOString().slice(0, 10) };
	fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2) + '\n', 'utf-8');
}

export function loadOrDetectRunConfig(workspaceRoot: string): RunConfig {
	const saved = loadRunConfig(workspaceRoot);
	if (saved) return resolveRunConfig(saved, workspaceRoot);
	const detected = detectRunner(workspaceRoot);
	return {
		...DEFAULT_RUN_CONFIG,
		runner: detected.runner,
		buildCommand: detected.buildCommand,
		testCommand: detected.testCommand,
	};
}
