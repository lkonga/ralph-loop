import { describe, it, expect } from 'vitest';
import { PRESETS, resolveConfig, PresetName } from '../src/presets';
import { DEFAULT_CONFIG, RalphConfig } from '../src/types';

describe('PRESETS', () => {
	it('has all four named presets', () => {
		expect(Object.keys(PRESETS)).toEqual(
			expect.arrayContaining(['general', 'feature', 'bugfix', 'refactor']),
		);
		expect(Object.keys(PRESETS)).toHaveLength(4);
	});

	it('general preset has empty overrides (uses defaults)', () => {
		expect(PRESETS.general.overrides).toEqual({});
	});

	it('feature preset overrides maxNudgesPerTask', () => {
		expect(PRESETS.feature.overrides.maxNudgesPerTask).toBe(5);
	});

	it('bugfix preset overrides inactivityTimeoutMs', () => {
		expect(PRESETS.bugfix.overrides.inactivityTimeoutMs).toBe(180_000);
	});

	it('refactor preset overrides maxNudgesPerTask', () => {
		expect(PRESETS.refactor.overrides.maxNudgesPerTask).toBe(6);
	});

	it('each preset has name and description', () => {
		for (const [key, preset] of Object.entries(PRESETS)) {
			expect(preset.name).toBe(key);
			expect(preset.description).toBeTruthy();
		}
	});
});

describe('resolveConfig', () => {
	const workspaceRoot = '/test/workspace';

	it('returns DEFAULT_CONFIG values when no preset or overrides', () => {
		const config = resolveConfig(workspaceRoot);
		expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
		expect(config.maxNudgesPerTask).toBe(DEFAULT_CONFIG.maxNudgesPerTask);
		expect(config.workspaceRoot).toBe(workspaceRoot);
	});

	it('general preset returns defaults', () => {
		const config = resolveConfig(workspaceRoot, 'general');
		expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
		expect(config.maxNudgesPerTask).toBe(DEFAULT_CONFIG.maxNudgesPerTask);
	});

	it('feature preset overrides maxNudgesPerTask to 5', () => {
		const config = resolveConfig(workspaceRoot, 'feature');
		expect(config.maxNudgesPerTask).toBe(5);
		expect(config.maxIterations).toBe(30);
	});

	it('bugfix preset overrides inactivityTimeoutMs', () => {
		const config = resolveConfig(workspaceRoot, 'bugfix');
		expect(config.inactivityTimeoutMs).toBe(180_000);
	});

	it('refactor preset overrides stagnation and nudges', () => {
		const config = resolveConfig(workspaceRoot, 'refactor');
		expect(config.maxNudgesPerTask).toBe(6);
		expect(config.stagnationDetection?.maxStaleIterations).toBe(4);
	});

	it('user overrides take priority over preset', () => {
		const config = resolveConfig(workspaceRoot, 'feature', { maxNudgesPerTask: 10 });
		expect(config.maxNudgesPerTask).toBe(10);
	});

	it('user overrides take priority over defaults', () => {
		const config = resolveConfig(workspaceRoot, undefined, { maxIterations: 100 });
		expect(config.maxIterations).toBe(100);
	});

	it('unknown preset name falls back to general', () => {
		const config = resolveConfig(workspaceRoot, 'nonexistent' as PresetName);
		expect(config.maxNudgesPerTask).toBe(DEFAULT_CONFIG.maxNudgesPerTask);
		expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
	});

	it('merges nested overrides shallowly (preset replaces objects)', () => {
		const config = resolveConfig(workspaceRoot, 'refactor');
		expect(config.stagnationDetection?.enabled).toBe(true);
		expect(config.stagnationDetection?.hashFiles).toEqual(['progress.txt', 'PRD.md']);
	});

	it('preserves workspaceRoot in resolved config', () => {
		const config = resolveConfig(workspaceRoot, 'bugfix', { maxIterations: 5 });
		expect(config.workspaceRoot).toBe(workspaceRoot);
	});
});
