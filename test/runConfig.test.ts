import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_RUN_CONFIG,
	detectRunner,
	loadOrDetectRunConfig,
	loadRunConfig,
	resolveRunConfig,
	saveRunConfig,
} from '../src/runConfig';
import type { RunConfig } from '../src/runConfig';

describe('runConfig', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-runconfig-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('detectRunner', () => {
		it('detects vitest from vitest.config.ts', () => {
			fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('vitest');
			expect(result.testCommand).toBe('npx vitest run');
		});

		it('detects vitest from vite.config.ts', () => {
			fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('vitest');
			expect(result.testCommand).toBe('npx vitest run');
		});

		it('detects jest from jest.config.js', () => {
			fs.writeFileSync(path.join(tmpDir, 'jest.config.js'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('jest');
			expect(result.testCommand).toBe('npx jest');
		});

		it('detects cargo from Cargo.toml', () => {
			fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('cargo');
			expect(result.buildCommand).toBe('cargo check');
			expect(result.testCommand).toBe('cargo test');
		});

		it('detects go from go.mod', () => {
			fs.writeFileSync(path.join(tmpDir, 'go.mod'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('go');
			expect(result.buildCommand).toBe('go build ./...');
			expect(result.testCommand).toBe('go test ./...');
		});

		it('detects pytest from pyproject.toml', () => {
			fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('pytest');
			expect(result.testCommand).toBe('pytest');
		});

		it('returns none when no runner config found', () => {
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('none');
			expect(result.testCommand).toBeUndefined();
		});

		it('adds tsc buildCommand when tsconfig.json exists alongside vitest', () => {
			fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), '', 'utf-8');
			fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('vitest');
			expect(result.buildCommand).toBe('npx tsc --noEmit');
		});

		it('vitest without tsconfig has no buildCommand', () => {
			fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), '', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.runner).toBe('vitest');
			expect(result.buildCommand).toBeUndefined();
		});

		it('cargo keeps its own buildCommand regardless of tsconfig', () => {
			fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '', 'utf-8');
			fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
			const result = detectRunner(tmpDir);
			expect(result.buildCommand).toBe('cargo check');
		});
	});

	describe('resolveRunConfig', () => {
		it('resolves auto runner to detected runner', () => {
			fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), '', 'utf-8');
			const config: RunConfig = { ...DEFAULT_RUN_CONFIG, runner: 'auto' };
			const resolved = resolveRunConfig(config, tmpDir);
			expect(resolved.runner).toBe('vitest');
			expect(resolved.testCommand).toBe('npx vitest run');
		});

		it('keeps explicit runner as-is', () => {
			const config: RunConfig = { ...DEFAULT_RUN_CONFIG, runner: 'jest', testCommand: 'npx jest --ci' };
			const resolved = resolveRunConfig(config, tmpDir);
			expect(resolved.runner).toBe('jest');
			expect(resolved.testCommand).toBe('npx jest --ci');
		});
	});

	describe('saveRunConfig / loadRunConfig', () => {
		it('saves and loads config', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			saveRunConfig(tmpDir, config);
			const loaded = loadRunConfig(tmpDir);
			expect(loaded).not.toBeNull();
			expect(loaded!.runner).toBe('vitest');
			expect(loaded!.testCommand).toBe('npx vitest run');
			expect(loaded!.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('creates .ralph directory if missing', () => {
			saveRunConfig(tmpDir, DEFAULT_RUN_CONFIG);
			expect(fs.existsSync(path.join(tmpDir, '.ralph'))).toBe(true);
		});

		it('returns null when config file does not exist', () => {
			expect(loadRunConfig(tmpDir)).toBeNull();
		});
	});

	describe('loadOrDetectRunConfig', () => {
		it('returns saved config when available', () => {
			const config: RunConfig = {
				runner: 'jest',
				testCommand: 'npx jest --ci',
				mode: 'verify-after',
				scope: 'single-task',
				lastUpdated: '2026-03-25',
			};
			saveRunConfig(tmpDir, config);
			const result = loadOrDetectRunConfig(tmpDir);
			expect(result.runner).toBe('jest');
			expect(result.mode).toBe('verify-after');
		});

		it('auto-detects when no saved config', () => {
			fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), '', 'utf-8');
			fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
			const result = loadOrDetectRunConfig(tmpDir);
			expect(result.runner).toBe('vitest');
			expect(result.buildCommand).toBe('npx tsc --noEmit');
			expect(result.testCommand).toBe('npx vitest run');
			expect(result.mode).toBe('tdd-strict');
		});

		it('returns none runner when nothing detectable and no saved config', () => {
			const result = loadOrDetectRunConfig(tmpDir);
			expect(result.runner).toBe('none');
		});
	});

	describe('DEFAULT_RUN_CONFIG', () => {
		it('has sensible defaults', () => {
			expect(DEFAULT_RUN_CONFIG.runner).toBe('auto');
			expect(DEFAULT_RUN_CONFIG.mode).toBe('tdd-strict');
			expect(DEFAULT_RUN_CONFIG.scope).toBe('full-prd');
		});
	});
});
