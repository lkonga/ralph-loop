import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, PresetName, RalphConfig, RalphPreset, VerifierConfig } from './types';

export { PresetName } from './types';

export const PRESETS: Record<PresetName, RalphPreset> = {
	general: {
		name: 'general',
		description: 'Balanced defaults — works for most tasks',
		overrides: {},
	},
	feature: {
		name: 'feature',
		description: 'Higher retry tolerance, strict TDD',
		overrides: {
			maxNudgesPerTask: 5,
			maxIterations: 30,
			contextTrimming: { fullUntil: 5, abbreviatedUntil: 12 },
		},
	},
	bugfix: {
		name: 'bugfix',
		description: 'Aggressive error tracking, lower timeout',
		overrides: {
			inactivityTimeoutMs: 180_000,
			circuitBreakers: [
				{ name: 'repeatedError', enabled: true },
				{ name: 'errorRate', enabled: true },
			],
		},
	},
	refactor: {
		name: 'refactor',
		description: 'Higher stagnation tolerance, conservative',
		overrides: {
			maxNudgesPerTask: 6,
			stagnationDetection: { enabled: true, maxStaleIterations: 4, hashFiles: ['progress.txt', 'PRD.md'] },
		},
	},
};

export function resolveConfig(
	workspaceRoot: string,
	preset?: PresetName,
	overrides?: Partial<RalphConfig>,
): RalphConfig {
	const presetOverrides = preset && preset in PRESETS
		? PRESETS[preset].overrides
		: {};

	return {
		...DEFAULT_CONFIG,
		...presetOverrides,
		...overrides,
		workspaceRoot,
		verifiers: [
			...(DEFAULT_CONFIG.verifiers ?? []),
			...(presetOverrides.verifiers ?? []),
			...(overrides?.verifiers ?? []),
			...autoDiscoverVerifiers(workspaceRoot, { ...DEFAULT_CONFIG, ...presetOverrides, ...overrides }),
		],
	};
}

function autoDiscoverVerifiers(workspaceRoot: string, config: Partial<RalphConfig>): VerifierConfig[] {
	if (config.autoDiscoverVerifiers === false) {
		return [];
	}

	const discovered: VerifierConfig[] = [];

	// 1. Check for verify.sh (the gold standard for zero-friction)
	const verifyShPath = path.join(workspaceRoot, 'verify.sh');
	if (fs.existsSync(verifyShPath)) {
		discovered.push({
			type: 'shell',
			args: { script: './verify.sh' }
		});
	}

	// 2. Check for npm test in package.json
	const pkgPath = path.join(workspaceRoot, 'package.json');
	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
			if (pkg.scripts?.test) {
				// Avoid duplication if verify.sh already exists and likely calls npm test
				if (!discovered.some(v => v.type === 'shell' && v.args?.script === './verify.sh')) {
					discovered.push({
						type: 'npm',
						args: { script: 'test' }
					});
				}
			}
		} catch {
			// Ignore malformed package.json
		}
	}

	return discovered;
}
