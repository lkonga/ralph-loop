import * as fs from 'fs';
import * as path from 'path';
import { loadOrDetectRunConfig } from './runConfig';

export interface VerifyScriptResult {
	resultKind: 'success' | 'error' | 'warning';
	stopReason?: string;
	output?: unknown;
}

/**
 * Generate a standalone Node.js verify script that:
 * 1. Reads .ralph/run-config.json for runner commands
 * 2. Runs buildCommand and testCommand
 * 3. Returns VS Code hook contract JSON on stdout
 * 4. Exit 0 = success, Exit 2 = blocking error
 */
export function generateVerifyScript(workspaceRoot: string): string {
	return `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = ${JSON.stringify(workspaceRoot)};
const CONFIG_PATH = path.join(WORKSPACE, '.ralph', 'run-config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function runCommand(cmd, cwd) {
  try {
    const stdout = execSync(cmd, { cwd, stdio: 'pipe', timeout: 120000 }).toString().trim();
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim()
    };
  }
}

function main() {
  const config = loadConfig();
  if (!config || config.mode === 'skip-tests') {
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
    return;
  }

  const failures = [];

  if (config.buildCommand) {
    const build = runCommand(config.buildCommand, WORKSPACE);
    if (!build.ok) {
      failures.push('Build failed: ' + (build.stdout || build.stderr || 'see output'));
    }
  }

  if (config.testCommand) {
    const test = runCommand(config.testCommand, WORKSPACE);
    if (!test.ok) {
      failures.push('Tests failed: ' + (test.stdout || test.stderr || 'see output'));
    }
  }

  if (failures.length === 0) {
    process.stdout.write(JSON.stringify({ resultKind: 'success' }));
  } else {
    process.stdout.write(JSON.stringify({
      resultKind: 'error',
      stopReason: failures.join('; ')
    }));
    process.exitCode = 2;
  }
}

main();
`;
}

/**
 * Write the verify script to .ralph/verify.js if it doesn't exist.
 */
export function ensureVerifyScript(workspaceRoot: string): string {
	const scriptPath = path.join(workspaceRoot, '.ralph', 'verify.js');
	const dir = path.dirname(scriptPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	// Always regenerate — script is derived from workspace root
	fs.writeFileSync(scriptPath, generateVerifyScript(workspaceRoot), { mode: 0o755 });
	return scriptPath;
}

/**
 * Run verification inline (for use in bearings/orchestrator without hooks).
 * Returns structured result matching the hook contract.
 */
export function runVerification(workspaceRoot: string, execFn?: (cmd: string, cwd: string) => { ok: boolean; stdout: string; stderr: string }): VerifyScriptResult {
	const config = loadOrDetectRunConfig(workspaceRoot);

	if (config.mode === 'skip-tests') {
		return { resultKind: 'success' };
	}

	const exec = execFn ?? defaultExec;
	const failures: string[] = [];

	if (config.buildCommand) {
		const build = exec(config.buildCommand, workspaceRoot);
		if (!build.ok) {
			failures.push('Build failed: ' + (build.stdout || build.stderr || 'see output'));
		}
	}

	if (config.testCommand) {
		const test = exec(config.testCommand, workspaceRoot);
		if (!test.ok) {
			failures.push('Tests failed: ' + (test.stdout || test.stderr || 'see output'));
		}
	}

	if (failures.length === 0) {
		return { resultKind: 'success' };
	}
	return { resultKind: 'error', stopReason: failures.join('; ') };
}

function defaultExec(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const { execSync } = require('child_process');
	try {
		const stdout = execSync(cmd, { cwd, stdio: 'pipe', timeout: 120000 }).toString().trim();
		return { ok: true, stdout, stderr: '' };
	} catch (err: any) {
		return {
			ok: false,
			stdout: (err.stdout || '').toString().trim(),
			stderr: (err.stderr || '').toString().trim(),
		};
	}
}
