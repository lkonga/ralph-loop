import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureVerifyScript, generateVerifyScript, runVerification } from '../src/verifyScript';
import { saveRunConfig } from '../src/runConfig';
import type { RunConfig } from '../src/runConfig';

describe('verifyScript', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-verify-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('generateVerifyScript', () => {
		it('generates a valid Node.js script', () => {
			const script = generateVerifyScript(tmpDir);
			expect(script).toContain('#!/usr/bin/env node');
			expect(script).toContain('resultKind');
			expect(script).toContain('run-config.json');
		});

		it('embeds workspace root path', () => {
			const script = generateVerifyScript('/my/workspace');
			expect(script).toContain('/my/workspace');
		});

		it('returns success when mode is skip-tests', () => {
			const script = generateVerifyScript(tmpDir);
			expect(script).toContain("config.mode === 'skip-tests'");
			expect(script).toContain("resultKind: 'success'");
		});

		it('sets exit code 2 on failure', () => {
			const script = generateVerifyScript(tmpDir);
			expect(script).toContain('process.exitCode = 2');
		});
	});

	describe('ensureVerifyScript', () => {
		it('creates .ralph/verify.js', () => {
			const scriptPath = ensureVerifyScript(tmpDir);
			expect(fs.existsSync(scriptPath)).toBe(true);
			expect(scriptPath).toContain('verify.js');
		});

		it('creates .ralph directory if missing', () => {
			ensureVerifyScript(tmpDir);
			expect(fs.existsSync(path.join(tmpDir, '.ralph'))).toBe(true);
		});

		it('overwrites existing script', () => {
			const dir = path.join(tmpDir, '.ralph');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'verify.js'), 'old content', 'utf-8');
			ensureVerifyScript(tmpDir);
			const content = fs.readFileSync(path.join(dir, 'verify.js'), 'utf-8');
			expect(content).toContain('#!/usr/bin/env node');
		});
	});

	describe('runVerification', () => {
		it('returns success when no config and no runner detected', () => {
			const result = runVerification(tmpDir);
			expect(result.resultKind).toBe('success');
		});

		it('returns success when mode is skip-tests', () => {
			const config: RunConfig = {
				runner: 'vitest',
				testCommand: 'npx vitest run',
				mode: 'skip-tests',
				scope: 'full-prd',
				lastUpdated: '',
			};
			saveRunConfig(tmpDir, config);
			const result = runVerification(tmpDir);
			expect(result.resultKind).toBe('success');
		});

		it('runs build and test commands via execFn', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			saveRunConfig(tmpDir, config);
			const calls: string[] = [];
			const execFn = (cmd: string, cwd: string) => {
				calls.push(cmd);
				return { ok: true, stdout: 'ok', stderr: '' };
			};
			const result = runVerification(tmpDir, execFn);
			expect(result.resultKind).toBe('success');
			expect(calls).toContain('npx tsc --noEmit');
			expect(calls).toContain('npx vitest run');
		});

		it('returns error when build fails', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			saveRunConfig(tmpDir, config);
			const execFn = (cmd: string) => {
				if (cmd.includes('tsc')) return { ok: false, stdout: 'error TS2345', stderr: '' };
				return { ok: true, stdout: '', stderr: '' };
			};
			const result = runVerification(tmpDir, execFn);
			expect(result.resultKind).toBe('error');
			expect(result.stopReason).toContain('Build failed');
			expect(result.stopReason).toContain('TS2345');
		});

		it('returns error when tests fail', () => {
			const config: RunConfig = {
				runner: 'vitest',
				testCommand: 'npx vitest run',
				mode: 'verify-after',
				scope: 'full-prd',
				lastUpdated: '',
			};
			saveRunConfig(tmpDir, config);
			const execFn = (cmd: string) => {
				if (cmd.includes('vitest')) return { ok: false, stdout: '3 tests failed', stderr: '' };
				return { ok: true, stdout: '', stderr: '' };
			};
			const result = runVerification(tmpDir, execFn);
			expect(result.resultKind).toBe('error');
			expect(result.stopReason).toContain('Tests failed');
		});

		it('reports both build and test failures', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '',
			};
			saveRunConfig(tmpDir, config);
			const execFn = () => ({ ok: false, stdout: 'fail', stderr: '' });
			const result = runVerification(tmpDir, execFn);
			expect(result.resultKind).toBe('error');
			expect(result.stopReason).toContain('Build failed');
			expect(result.stopReason).toContain('Tests failed');
		});
	});
});
