import { DEFAULT_CONFIG, RalphConfig, RalphPreset, PresetName } from './types';

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
	};
}
