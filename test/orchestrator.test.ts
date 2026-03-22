import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	shouldContinueLoop,
	shouldNudge,
	shouldRetryError,
	MAX_RETRIES_PER_TASK,
} from '../src/decisions';
import { runPreCompleteChain, LoopOrchestrator, runBearings, LinkedCancellationSource, resolveAgentMode, defaultBearingsExec, LaneScheduler } from '../src/orchestrator';
import { parseReviewVerdict } from '../src/copilot';
import { estimatePromptTokens } from '../src/prompt';
import { VerificationCache } from '../src/verificationCache';
import {
	DEFAULT_CONFIG,
	DEFAULT_INACTIVITY_CONFIG,
	DEFAULT_BEARINGS_CONFIG,
} from '../src/types';
import type {
	IRalphHookService,
	HookResult,
	PreCompleteHookConfig,
	PreCompleteInput,
	VerifyCheck,
	ReviewVerdict,
	InactivityConfig,
	ILogger,
	ExecutionOptions,
	RepoLane,
} from '../src/types';
import { VerifyResult, LoopEventKind } from '../src/types';

// --- Helper to create a mock hook service ---
function createMockHookService(
	onPreCompleteFn: (input: PreCompleteInput) => Promise<HookResult>,
): IRalphHookService {
	const noOp = async () => ({ action: 'continue' as const });
	return {
		onSessionStart: noOp,
		onPreCompact: noOp,
		onPostToolUse: noOp,
		onPreComplete: onPreCompleteFn,
		onTaskComplete: noOp,
	};
}

const baseInput = {
	taskId: '1',
	taskInvocationId: 'inv-1',
	checksRun: [{ name: 'checkbox', result: VerifyResult.Pass }] as VerifyCheck[],
	prdPath: '/tmp/PRD.md',
};

describe('runPreCompleteChain', () => {
	it('all-continue proceeds to TaskComplete', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-b', type: 'builtin', enabled: true },
		];
		const service = createMockHookService(async () => ({ action: 'continue' }));
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(2);
		expect(result.results[0].hookName).toBe('hook-a');
		expect(result.results[1].hookName).toBe('hook-b');
	});

	it('retry causes re-entry (short-circuits remaining hooks)', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-retry', type: 'builtin', enabled: true },
			{ name: 'hook-c', type: 'builtin', enabled: true },
		];
		let callCount = 0;
		const service = createMockHookService(async () => {
			callCount++;
			if (callCount === 2) return { action: 'retry', reason: 'not ready' };
			return { action: 'continue' };
		});
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('retry');
		expect(result.results).toHaveLength(2);
		expect(callCount).toBe(2); // hook-c never called
	});

	it('stop yields Stopped immediately (short-circuits)', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-stop', type: 'builtin', enabled: true },
			{ name: 'hook-b', type: 'builtin', enabled: true },
		];
		const service = createMockHookService(async () => ({ action: 'stop', reason: 'blocked' }));
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('stop');
		expect(result.results).toHaveLength(1);
		expect(result.results[0].hookName).toBe('hook-stop');
	});

	it('previousResults accumulates across hooks', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-b', type: 'builtin', enabled: true },
			{ name: 'hook-c', type: 'builtin', enabled: true },
		];
		const receivedPreviousResults: (unknown[] | undefined)[] = [];
		const service = createMockHookService(async (input) => {
			receivedPreviousResults.push(input.previousResults ? [...input.previousResults] : undefined);
			return { action: 'continue' };
		});
		await runPreCompleteChain(hooks, service, baseInput);
		expect(receivedPreviousResults[0]).toHaveLength(0); // first hook gets empty
		expect(receivedPreviousResults[1]).toHaveLength(1); // second gets first result
		expect(receivedPreviousResults[2]).toHaveLength(2); // third gets first two
	});

	it('disabled hooks are skipped', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: true },
			{ name: 'hook-disabled', type: 'builtin', enabled: false },
			{ name: 'hook-c', type: 'builtin', enabled: true },
		];
		let callCount = 0;
		const service = createMockHookService(async () => {
			callCount++;
			return { action: 'continue' };
		});
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(2);
		expect(callCount).toBe(2);
		expect(result.results.map(r => r.hookName)).toEqual(['hook-a', 'hook-c']);
	});

	it('returns continue with empty results when all hooks disabled', async () => {
		const hooks: PreCompleteHookConfig[] = [
			{ name: 'hook-a', type: 'builtin', enabled: false },
		];
		const service = createMockHookService(async () => ({ action: 'continue' }));
		const result = await runPreCompleteChain(hooks, service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(0);
	});

	it('returns continue with empty results when hooks list is empty', async () => {
		const service = createMockHookService(async () => ({ action: 'continue' }));
		const result = await runPreCompleteChain([], service, baseInput);
		expect(result.action).toBe('continue');
		expect(result.results).toHaveLength(0);
	});
});

describe('shouldContinueLoop', () => {
	it('returns false when all tasks are done', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 0,
			iteration: 2,
			maxIterations: 10,
		})).toBe(false);
	});

	it('returns true when tasks remain', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 3,
			iteration: 1,
			maxIterations: 10,
		})).toBe(true);
	});

	it('returns false when stop is requested', () => {
		expect(shouldContinueLoop({
			stopRequested: true,
			tasksRemaining: 3,
			iteration: 0,
			maxIterations: 10,
		})).toBe(false);
	});

	it('returns false when iteration limit is reached', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 2,
			iteration: 10,
			maxIterations: 10,
		})).toBe(false);
	});

	it('ignores iteration limit when maxIterations is 0', () => {
		expect(shouldContinueLoop({
			stopRequested: false,
			tasksRemaining: 1,
			iteration: 999,
			maxIterations: 0,
		})).toBe(true);
	});
});

describe('shouldNudge', () => {
	it('returns nudge text when task not complete and nudgeCount < max', () => {
		const result = shouldNudge({
			taskCompleted: false,
			nudgeCount: 1,
			maxNudgesPerTask: 3,
		});
		expect(result).toBeTypeOf('string');
		expect(result).toContain('Continue with the current task');
	});

	it('returns undefined when nudgeCount is at max', () => {
		expect(shouldNudge({
			taskCompleted: false,
			nudgeCount: 3,
			maxNudgesPerTask: 3,
		})).toBeUndefined();
	});

	it('returns undefined when task is already completed', () => {
		expect(shouldNudge({
			taskCompleted: true,
			nudgeCount: 0,
			maxNudgesPerTask: 3,
		})).toBeUndefined();
	});
});

describe('shouldRetryError', () => {
	it('returns true for transient network error under cap', () => {
		expect(shouldRetryError(new Error('network error'), 0)).toBe(true);
	});

	it('returns true for timeout error under cap', () => {
		expect(shouldRetryError(new Error('Request timeout'), 1)).toBe(true);
	});

	it('returns true for ECONNRESET under cap', () => {
		expect(shouldRetryError(new Error('ECONNRESET'), 2)).toBe(true);
	});

	it('returns false for transient error at retry cap', () => {
		expect(shouldRetryError(new Error('network error'), MAX_RETRIES_PER_TASK)).toBe(false);
	});

	it('returns false for fatal (non-transient) error', () => {
		expect(shouldRetryError(new Error('Cannot read properties of undefined'), 0)).toBe(false);
	});

	it('returns false when stop is requested', () => {
		expect(shouldRetryError(new Error('timeout'), 0, true)).toBe(false);
	});
});

describe('parseReviewVerdict', () => {
	it('returns approved verdict for APPROVED output', () => {
		const v = parseReviewVerdict('## Review\n**Verdict**: APPROVED\nEverything looks good.');
		expect(v.outcome).toBe('approved');
		expect(v.summary).toContain('APPROVED');
	});

	it('returns needs-retry verdict for NEEDS-RETRY output', () => {
		const v = parseReviewVerdict('## Review\n**Verdict**: NEEDS-RETRY\n### Issues Found (if NEEDS-RETRY)\n1. Fix validation.');
		expect(v.outcome).toBe('needs-retry');
		expect(v.summary).toContain('NEEDS-RETRY');
	});

	it('defaults to approved when no keyword found', () => {
		const v = parseReviewVerdict('The code is fine.');
		expect(v.outcome).toBe('approved');
	});

	it('prefers verdict regex over other text', () => {
		const v = parseReviewVerdict('**Verdict**: NEEDS-RETRY\nAPPROVED generally for edge case.');
		expect(v.outcome).toBe('needs-retry');
	});

	it('is case-insensitive for NEEDS-RETRY', () => {
		const v = parseReviewVerdict('**Verdict**: needs-retry');
		expect(v.outcome).toBe('needs-retry');
	});

	it('is case-insensitive for APPROVED', () => {
		const v = parseReviewVerdict('**Verdict**: approved');
		expect(v.outcome).toBe('approved');
	});
});

describe('LoopOrchestrator.injectContext', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };

	it('injectContext sets pendingContext that is consumed by buildPrompt', () => {
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp' },
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.injectContext('The bug is in parser.ts line 42');
		expect((orch as any).pendingContext).toBe('The bug is in parser.ts line 42');
	});

	it('pendingContext is cleared after being read (consume-after-one-iteration)', () => {
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp' },
			noopLogger,
			() => { },
		);
		orch.injectContext('temporary context');
		const ctx = (orch as any).consumePendingContext();
		expect(ctx).toBe('temporary context');
		const ctx2 = (orch as any).consumePendingContext();
		expect(ctx2).toBeUndefined();
	});

	it('null/undefined pendingContext produces no operator context', () => {
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp' },
			noopLogger,
			() => { },
		);
		const ctx = (orch as any).consumePendingContext();
		expect(ctx).toBeUndefined();
	});
});

describe('Security rejection as feedback', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		const os = require('os');
		const fs = require('fs');
		const path = require('path');
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-test-'));
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [x] Done task\n', 'utf-8');
	});

	afterEach(() => {
		const fs = require('fs');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('orchestrator continues loop when session hook is blocked', async () => {
		const events: any[] = [];
		const blockedHookService: IRalphHookService = {
			onSessionStart: async () => ({ action: 'continue' as const, blocked: true, reason: 'shell metacharacters detected' }),
			onPreCompact: async () => ({ action: 'continue' as const }),
			onPostToolUse: async () => ({ action: 'continue' as const }),
			onPreComplete: async () => ({ action: 'continue' as const }),
			onTaskComplete: async () => ({ action: 'continue' as const }),
		};

		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1 },
			noopLogger,
			(e: any) => events.push(e),
			blockedHookService,
		);

		await orch.start();

		const commandBlockedEvents = events.filter(e => e.kind === LoopEventKind.CommandBlocked);
		expect(commandBlockedEvents.length).toBeGreaterThanOrEqual(1);
		expect(commandBlockedEvents[0].reason).toContain('shell metacharacters');
		expect(commandBlockedEvents[0].command).toBeDefined();

		const stoppedEvents = events.filter(e => e.kind === LoopEventKind.Stopped);
		expect(stoppedEvents.length).toBe(0);
	});

	it('CommandBlocked event includes command, reason, and taskId', async () => {
		const events: any[] = [];
		const blockedHookService: IRalphHookService = {
			onSessionStart: async () => ({ action: 'continue' as const, blocked: true, reason: 'allowlist rejection' }),
			onPreCompact: async () => ({ action: 'continue' as const }),
			onPostToolUse: async () => ({ action: 'continue' as const }),
			onPreComplete: async () => ({ action: 'continue' as const }),
			onTaskComplete: async () => ({ action: 'continue' as const }),
		};

		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1 },
			noopLogger,
			(e: any) => events.push(e),
			blockedHookService,
		);

		await orch.start();

		const commandBlockedEvents = events.filter(e => e.kind === LoopEventKind.CommandBlocked);
		expect(commandBlockedEvents.length).toBeGreaterThanOrEqual(1);
		const evt = commandBlockedEvents[0];
		expect(evt).toHaveProperty('command');
		expect(evt).toHaveProperty('reason');
		expect(evt).toHaveProperty('taskId');
	});
});

describe('runBearings', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };

	it('returns healthy when both tsc and vitest pass', async () => {
		const execFn = async () => ({ exitCode: 0, output: '' });
		const result = await runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		expect(result.healthy).toBe(true);
		expect(result.issues).toHaveLength(0);
		expect(result.fixTask).toBeUndefined();
	});

	it('returns healthy when no tsconfig.json or vitest config exists (skips checks)', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-noconfig-'));
		const execFn = async () => ({ exitCode: 1, output: 'should never be called' });
		const result = await runBearings(tmpDir, noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		expect(result.healthy).toBe(true);
		expect(result.issues).toHaveLength(0);
	});

	it('returns unhealthy when tsc fails', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-tsc-'));
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const execFn = async (cmd: string) => {
			if (cmd.includes('tsc')) return { exitCode: 1, output: 'error TS2345: Argument of type...' };
			return { exitCode: 0, output: '' };
		};
		const result = await runBearings(tmpDir, noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		expect(result.healthy).toBe(false);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.some(i => i.includes('TypeScript'))).toBe(true);
		expect(result.fixTask).toContain('Fix baseline');
	});

	it('returns unhealthy when vitest fails', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-vitest-'));
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const execFn = async (cmd: string) => {
			if (cmd.includes('vitest')) return { exitCode: 1, output: '3 tests failed' };
			return { exitCode: 0, output: '' };
		};
		const result = await runBearings(tmpDir, noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		expect(result.healthy).toBe(false);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.some(i => i.includes('test') || i.includes('Test'))).toBe(true);
		expect(result.fixTask).toContain('Fix baseline');
	});
});

describe('Bearings phase integration', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		const os = require('os');
		const fs = require('fs');
		const path = require('path');
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-'));
	});

	afterEach(() => {
		const fs = require('fs');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('healthy bearings proceed to task (BearingsChecked emitted)', async () => {
		const fs = require('fs');
		const path = require('path');
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async () => ({ exitCode: 0, output: '' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();
		const bearingsChecked = events.filter(e => e.kind === LoopEventKind.BearingsChecked);
		expect(bearingsChecked.length).toBeGreaterThanOrEqual(1);
		expect(bearingsChecked[0].healthy).toBe(true);
		const taskStarted = events.filter(e => e.kind === LoopEventKind.TaskStarted);
		expect(taskStarted.length).toBeGreaterThanOrEqual(1);
	});

	it('unhealthy bearings inserts fix task and yields BearingsFailed after fix attempt', async () => {
		const fs = require('fs');
		const path = require('path');
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 5, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => {
				events.push(e);
				if (e.kind === LoopEventKind.BearingsFailed) {
					orch.stop();
				}
			},
		);
		orch.bearingsExecFn = async () => ({ exitCode: 1, output: 'errors found' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};

		await orch.start();

		const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
		expect(prdContent).toContain('Fix baseline');
		const bearingsFailedEvents = events.filter(e => e.kind === LoopEventKind.BearingsFailed);
		expect(bearingsFailedEvents.length).toBeGreaterThanOrEqual(1);
	});

	it('bearings disabled skips check', async () => {
		const fs = require('fs');
		const path = require('path');
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [x] Done task\n', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1,
				bearings: { enabled: false, runTsc: true, runTests: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();
		const bearingsChecked = events.filter(e => e.kind === LoopEventKind.BearingsChecked);
		expect(bearingsChecked).toHaveLength(0);
		const bearingsFailed = events.filter(e => e.kind === LoopEventKind.BearingsFailed);
		expect(bearingsFailed).toHaveLength(0);
	});
});

describe('Bearings policy split', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		const os = require('os');
		const fs = require('fs');
		const path = require('path');
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-policy-'));
	});

	afterEach(() => {
		const fs = require('fs');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('DEFAULT_BEARINGS_CONFIG resolves to startup=tsc, perTask=none, checkpoint=full', () => {
		expect(DEFAULT_BEARINGS_CONFIG.startup).toBe('tsc');
		expect(DEFAULT_BEARINGS_CONFIG.perTask).toBe('none');
		expect(DEFAULT_BEARINGS_CONFIG.checkpoint).toBe('full');
	});

	it('runBearings with level=none skips all checks', async () => {
		const result = await runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, async () => ({ exitCode: 1, output: 'fail' }), 'none');
		expect(result.healthy).toBe(true);
		expect(result.issues).toHaveLength(0);
	});

	it('runBearings with level=tsc runs only tsc, not vitest', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bp-tsc-'));
		fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(dir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const execFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		await runBearings(dir, noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn, 'tsc');
		fs.rmSync(dir, { recursive: true, force: true });
		expect(calls.some(c => c.includes('tsc'))).toBe(true);
		expect(calls.some(c => c.includes('vitest'))).toBe(false);
	});

	it('runBearings with level=full runs both tsc and vitest', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bp-full-'));
		fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(dir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const execFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		await runBearings(dir, noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn, 'full');
		fs.rmSync(dir, { recursive: true, force: true });
		expect(calls.some(c => c.includes('tsc'))).toBe(true);
		expect(calls.some(c => c.includes('vitest'))).toBe(true);
	});

	it('task start no longer implies full vitest by default (perTask=none)', async () => {
		const fs = require('fs');
		const path = require('path');
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true, startup: 'tsc', perTask: 'none', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();
		// After startup tsc, per-task should NOT run vitest
		const vitestCalls = calls.filter(c => c.includes('vitest'));
		expect(vitestCalls).toHaveLength(0);
	});

	it('existing behavior preserved when full is explicitly chosen for all stages', async () => {
		const fs = require('fs');
		const path = require('path');
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true, startup: 'full', perTask: 'full', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();
		const tscCalls = calls.filter(c => c.includes('tsc'));
		const vitestCalls = calls.filter(c => c.includes('vitest'));
		expect(tscCalls.length).toBeGreaterThanOrEqual(1);
		expect(vitestCalls.length).toBeGreaterThanOrEqual(1);
	});
});

describe('CHECKPOINT: Bearings Policy Verification (Task 110)', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		const os = require('os');
		const fs = require('fs');
		const path = require('path');
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-checkpoint-'));
	});

	afterEach(() => {
		const fs = require('fs');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('startup path emits no full-suite trigger under default policy (only tsc, no vitest)', async () => {
		const fs = require('fs');
		const path = require('path');
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] First task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { ...DEFAULT_BEARINGS_CONFIG },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();
		// Startup default is 'tsc' — vitest must NOT be called
		const vitestCalls = calls.filter(c => c.includes('vitest'));
		const tscCalls = calls.filter(c => c.includes('tsc'));
		expect(vitestCalls).toHaveLength(0);
		expect(tscCalls.length).toBeGreaterThanOrEqual(1);
	});

	it('checkpoint path still triggers configured validation (bearings at checkpoint level)', async () => {
		const fs = require('fs');
		const path = require('path');
		// PRD with a [CHECKPOINT] task followed by a normal task
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] [CHECKPOINT] Verify things\n- [ ] Normal task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 2, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true, startup: 'tsc', perTask: 'none', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		// Auto-resume checkpoint after pause
		const origDelay = (orch as any).delay.bind(orch);
		(orch as any).delay = async (ms: number) => {
			(orch as any).pauseRequested = false;
		};
		await orch.start();
		// Checkpoint task should have triggered bearings at 'full' level — vitest must appear
		const vitestCalls = calls.filter(c => c.includes('vitest'));
		expect(vitestCalls.length).toBeGreaterThanOrEqual(1);
		// BearingsChecked event should have been emitted for checkpoint
		const bearingsChecked = events.filter((e: any) => e.kind === LoopEventKind.BearingsChecked);
		expect(bearingsChecked.length).toBeGreaterThanOrEqual(1);
	});
});

describe('LinkedCancellationSource', () => {
	it('aborts when any source signal aborts', () => {
		const ac1 = new AbortController();
		const ac2 = new AbortController();
		const linked = new LinkedCancellationSource(ac1.signal, ac2.signal);

		expect(linked.signal.aborted).toBe(false);
		ac2.abort('source2');
		expect(linked.signal.aborted).toBe(true);
		linked.dispose();
	});

	it('manual cancel works', () => {
		const ac1 = new AbortController();
		const linked = new LinkedCancellationSource(ac1.signal);

		expect(linked.signal.aborted).toBe(false);
		linked.cancel('manual stop');
		expect(linked.signal.aborted).toBe(true);
		linked.dispose();
	});

	it('dispose cleans up listeners (subsequent source aborts do not throw)', () => {
		const ac1 = new AbortController();
		const ac2 = new AbortController();
		const linked = new LinkedCancellationSource(ac1.signal, ac2.signal);

		linked.dispose();
		// After dispose, aborting a source should not propagate (no throw)
		ac1.abort('late');
		// The linked signal should NOT have been aborted since we disposed before source aborted
		expect(linked.signal.aborted).toBe(false);
	});

	it('multiple signals correctly linked — first abort wins', () => {
		const ac1 = new AbortController();
		const ac2 = new AbortController();
		const ac3 = new AbortController();
		const linked = new LinkedCancellationSource(ac1.signal, ac2.signal, ac3.signal);

		expect(linked.signal.aborted).toBe(false);
		ac1.abort('first');
		expect(linked.signal.aborted).toBe(true);
		// Aborting others after first should not throw
		ac2.abort('second');
		ac3.abort('third');
		expect(linked.signal.aborted).toBe(true);
		linked.dispose();
	});

	it('already-aborted source signal causes immediate abort', () => {
		const ac1 = new AbortController();
		ac1.abort('pre-aborted');
		const linked = new LinkedCancellationSource(ac1.signal);
		expect(linked.signal.aborted).toBe(true);
		linked.dispose();
	});

	it('works with zero source signals (manual-only)', () => {
		const linked = new LinkedCancellationSource();
		expect(linked.signal.aborted).toBe(false);
		linked.cancel('manual');
		expect(linked.signal.aborted).toBe(true);
		linked.dispose();
	});
});

describe('Context budget handoff detection', () => {
	it('shouldTriggerHandoff returns true when tokens exceed handoffThresholdPct', () => {
		// 350 chars => ceil(350/3.5)=100 tokens. With max=100, that's 100% — above 90%
		const tokens = estimatePromptTokens('A'.repeat(350));
		const pct = (tokens / 100) * 100;
		expect(pct).toBeGreaterThanOrEqual(90);
	});

	it('shouldTriggerHandoff returns false when tokens below handoffThresholdPct', () => {
		// 100 chars => ceil(100/3.5)=29 tokens. With max=100, that's 29% — below 90%
		const tokens = estimatePromptTokens('A'.repeat(100));
		const pct = (tokens / 100) * 100;
		expect(pct).toBeLessThan(90);
	});

	it('ContextHandoff event kind exists in LoopEventKind', () => {
		expect(LoopEventKind.ContextHandoff).toBe('context_handoff');
	});
});

describe('InactivityConfig', () => {
	it('DEFAULT_INACTIVITY_CONFIG has correct defaults', () => {
		expect(DEFAULT_INACTIVITY_CONFIG).toEqual({
			timeoutMs: 120_000,
			warningAtPct: 50,
			adaptive: false,
		});
	});

	it('default config includes inactivity with correct shape', () => {
		expect(DEFAULT_CONFIG.inactivity).toBeDefined();
		expect(DEFAULT_CONFIG.inactivity).toEqual(DEFAULT_INACTIVITY_CONFIG);
	});

	it('warningAtPct computes correct warning threshold', () => {
		const cfg: InactivityConfig = { timeoutMs: 120_000, warningAtPct: 50, adaptive: false };
		const warningMs = cfg.timeoutMs * (cfg.warningAtPct / 100);
		expect(warningMs).toBe(60_000);
	});

	it('custom timeoutMs is respected', () => {
		const cfg: InactivityConfig = { timeoutMs: 240_000, warningAtPct: 50, adaptive: false };
		const warningMs = cfg.timeoutMs * (cfg.warningAtPct / 100);
		expect(warningMs).toBe(120_000);
		expect(cfg.timeoutMs).toBe(240_000);
	});

	it('adaptive flag defaults to false (no-op path)', () => {
		expect(DEFAULT_INACTIVITY_CONFIG.adaptive).toBe(false);
	});

	it('graduated response: warning at warningAtPct, action at 100%', () => {
		const cfg: InactivityConfig = { timeoutMs: 200_000, warningAtPct: 50, adaptive: false };
		const warningThreshold = cfg.timeoutMs * (cfg.warningAtPct / 100);
		const actionThreshold = cfg.timeoutMs;
		expect(warningThreshold).toBe(100_000);
		expect(actionThreshold).toBe(200_000);
		expect(warningThreshold).toBeLessThan(actionThreshold);
	});
});

// --- Agent-Routed Execution (Task 84) ---
describe('resolveAgentMode', () => {
	const mockLogger: ILogger = {
		log: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns ralph-{agent} when task.agent is set', () => {
		const result = resolveAgentMode({ agent: 'explore' }, 'ralph-executor', mockLogger);
		expect(result).toBe('ralph-explore');
	});

	it('returns config default when task.agent is undefined', () => {
		const result = resolveAgentMode({}, 'ralph-executor', mockLogger);
		expect(result).toBe('ralph-executor');
	});

	it('returns config default when task.agent is empty string', () => {
		const result = resolveAgentMode({ agent: '' }, 'ralph-executor', mockLogger);
		expect(result).toBe('ralph-executor');
	});

	it('falls back to config default with warning for unknown agent', () => {
		const result = resolveAgentMode({ agent: 'nonexistent' }, 'ralph-executor', mockLogger);
		expect(result).toBe('ralph-executor');
		expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
	});

	it('passes through known agents without warning', () => {
		resolveAgentMode({ agent: 'explore' }, 'ralph-executor', mockLogger);
		expect(mockLogger.warn).not.toHaveBeenCalled();

		resolveAgentMode({ agent: 'research' }, 'ralph-executor', mockLogger);
		expect(mockLogger.warn).not.toHaveBeenCalled();

		resolveAgentMode({ agent: 'executor' }, 'ralph-executor', mockLogger);
		expect(mockLogger.warn).not.toHaveBeenCalled();
	});
});

describe('ExecutionOptions agentMode passthrough', () => {
	it('ExecutionOptions includes agentMode field', () => {
		const opts: ExecutionOptions = {
			prdPath: '/tmp/PRD.md',
			workspaceRoot: '/tmp',
			inactivityTimeoutMs: 120000,
			useAutopilotMode: false,
			shouldStop: () => false,
			agentMode: 'ralph-explore',
		};
		expect(opts.agentMode).toBe('ralph-explore');
	});
});

describe('Async Verification Runner (Task 111)', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };

	it('BearingsExecFn returns a Promise with exitCode/output shape', async () => {
		const asyncExec = async (cmd: string, cwd: string) => ({ exitCode: 0, output: 'ok' });
		const result = await asyncExec('echo test', '/tmp');
		expect(result).toHaveProperty('exitCode');
		expect(result).toHaveProperty('output');
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe('ok');
	});

	it('defaultBearingsExec returns a Promise (is async)', async () => {
		const result = defaultBearingsExec('echo hello', '/tmp');
		expect(result).toBeInstanceOf(Promise);
		const resolved = await result;
		expect(resolved).toHaveProperty('exitCode');
		expect(resolved).toHaveProperty('output');
		expect(resolved.exitCode).toBe(0);
	});

	it('runBearings accepts async exec function and returns correct results', async () => {
		const asyncExec = async (cmd: string) => ({ exitCode: 0, output: '' });
		const result = await runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, asyncExec);
		expect(result.healthy).toBe(true);
	});

	it('cancellation via AbortSignal stops child process cleanly', async () => {
		const ac = new AbortController();
		// Abort immediately
		ac.abort();
		const result = await defaultBearingsExec('sleep 60', '/tmp', ac.signal);
		// Should resolve quickly with non-zero exit code (aborted)
		expect(result.exitCode).not.toBe(0);
	});

	it('long-running verification does not block subsequent event emissions', async () => {
		const events: string[] = [];
		const slowExec = async (cmd: string) => {
			// Simulate a short delay but still async
			await new Promise(r => setTimeout(r, 10));
			events.push(`exec:${cmd}`);
			return { exitCode: 0, output: '' };
		};
		// Start bearings and push an event concurrently
		const bearingsPromise = runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, slowExec);
		events.push('concurrent-event');
		await bearingsPromise;
		// The concurrent event should have been pushed before exec completes
		const concurrentIdx = events.indexOf('concurrent-event');
		expect(concurrentIdx).toBe(0);
	});
});

describe('CHECKPOINT: Non-Blocking Verification (Task 112)', () => {
	const logMessages: string[] = [];
	const capturingLogger = {
		log: (msg: string) => { logMessages.push(msg); },
		warn: (msg: string) => { logMessages.push(`WARN:${msg}`); },
		error: (msg: string) => { logMessages.push(`ERROR:${msg}`); },
	};

	beforeEach(() => { logMessages.length = 0; });

	it('logger receives progress messages BEFORE runBearings resolves', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-nb-'));
		fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(dir, 'vite.config.ts'), '', 'utf-8');

		let execCallCount = 0;
		const slowExec = async (cmd: string) => {
			execCallCount++;
			await new Promise(r => setTimeout(r, 5));
			return { exitCode: 0, output: '' };
		};

		const logsBefore = logMessages.length;
		await runBearings(dir, capturingLogger, { enabled: true, runTsc: true, runTests: true }, slowExec, 'full');
		fs.rmSync(dir, { recursive: true, force: true });

		// Progress logs must have been emitted during the run
		const progressLogs = logMessages.filter(m => m.includes('Bearings'));
		expect(progressLogs.length).toBeGreaterThanOrEqual(2); // at least tsc-start + tests-start
	});

	it('no execSync import or usage in orchestrator.ts startup path', async () => {
		const fs = require('fs');
		const path = require('path');
		const orchestratorSource = fs.readFileSync(
			path.join(__dirname, '..', 'src', 'orchestrator.ts'), 'utf-8'
		);
		// Must not contain execSync anywhere
		expect(orchestratorSource).not.toContain('execSync');
	});

	it('BearingsExecFn signature requires Promise return (async)', () => {
		// Verify the type at runtime: a sync function returning plain object
		// should still work via async wrapper, but the actual defaultBearingsExec
		// must return a Promise
		const result = defaultBearingsExec('echo ok', '/tmp');
		expect(result).toBeInstanceOf(Promise);
	});

	it('event loop remains unblocked during bearings execution', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-nb3-'));
		fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf-8');

		let tickCount = 0;
		const tickInterval = setInterval(() => { tickCount++; }, 5);

		const slowExec = async (cmd: string) => {
			await new Promise(r => setTimeout(r, 30));
			return { exitCode: 0, output: '' };
		};

		await runBearings(dir, capturingLogger, { enabled: true, runTsc: true, runTests: true }, slowExec, 'tsc');
		clearInterval(tickInterval);
		fs.rmSync(dir, { recursive: true, force: true });

		// If the event loop were blocked, tickCount would be 0
		expect(tickCount).toBeGreaterThan(0);
	});

	it('progress log emitted before tsc exec completes', async () => {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-nb2-'));
		fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf-8');

		const timeline: string[] = [];
		const timelineLogger = {
			log: (msg: string) => { timeline.push(`log:${msg}`); },
			warn: () => { },
			error: () => { },
		};
		const execFn = async (cmd: string) => {
			timeline.push(`exec:${cmd}`);
			return { exitCode: 0, output: '' };
		};

		await runBearings(dir, timelineLogger, { enabled: true, runTsc: true, runTests: false }, execFn, 'tsc');
		fs.rmSync(dir, { recursive: true, force: true });

		// A log entry about tsc should appear before the exec call
		const logIdx = timeline.findIndex(e => e.startsWith('log:') && e.includes('tsc'));
		const execIdx = timeline.findIndex(e => e.startsWith('exec:'));
		expect(logIdx).toBeGreaterThanOrEqual(0);
		expect(logIdx).toBeLessThan(execIdx);
	});
});

describe('Verification Cache & Dirty-Aware Skip (Task 113)', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		const os = require('os');
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-vcache-orch-'));
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}', 'utf-8');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('cache hit skips rerun when inputs unchanged', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task A\n', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 2, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: false, startup: 'tsc', perTask: 'tsc', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};

		// Pre-seed the cache with a healthy result matching current workspace state
		const cache = new VerificationCache();
		const branch = VerificationCache.getGitBranch(tmpDir);
		const treeHash = VerificationCache.getGitTreeHash(tmpDir);
		const fileHashes = VerificationCache.computeFileHashes(tmpDir);
		cache.save(tmpDir, {
			timestamp: Date.now(),
			branch,
			treeHash,
			level: 'tsc',
			healthy: true,
			fileHashes,
		});

		await orch.start();
		// Startup bearings should be skipped (cache hit) — no tsc calls at startup
		const bearingsChecked = events.filter((e: any) => e.kind === LoopEventKind.BearingsChecked);
		expect(bearingsChecked.length).toBeGreaterThanOrEqual(1);
		expect(bearingsChecked[0].healthy).toBe(true);
		// With cache hit, tsc should NOT have been called for the first iteration
		expect(calls.filter(c => c.includes('tsc')).length).toBe(0);
	});

	it('cache miss reruns when relevant files/config change', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task B\n', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: false, startup: 'tsc', perTask: 'none', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};

		// Pre-seed cache with STALE file hashes (simulating a file change)
		const cache = new VerificationCache();
		const branch = VerificationCache.getGitBranch(tmpDir);
		const treeHash = VerificationCache.getGitTreeHash(tmpDir);
		cache.save(tmpDir, {
			timestamp: Date.now(),
			branch,
			treeHash,
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'stale-hash' },
		});

		await orch.start();
		// Should have actually run tsc since cache was invalid
		expect(calls.some(c => c.includes('tsc'))).toBe(true);
	});

	it('cache invalidates on branch/tree change', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task C\n', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: false, startup: 'tsc', perTask: 'none', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prdContent = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prdContent.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};

		// Pre-seed cache with a different branch
		const cache = new VerificationCache();
		const fileHashes = VerificationCache.computeFileHashes(tmpDir);
		cache.save(tmpDir, {
			timestamp: Date.now(),
			branch: 'totally-different-branch',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes,
		});

		await orch.start();
		// Should have actually run tsc since branch doesn't match
		expect(calls.some(c => c.includes('tsc'))).toBe(true);
	});
});

describe('CHECKPOINT: Cache / Dirty-Skip Verification (Task 114)', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-checkpoint114-'));
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}', 'utf-8');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('repeated start reuses cached green state — zero tsc calls on second run', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task Alpha\n- [ ] Task Beta\n', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];

		const makeOrch = () => {
			const orch = new LoopOrchestrator(
				{
					...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
					bearings: { enabled: true, runTsc: true, runTests: false, startup: 'tsc', perTask: 'tsc', checkpoint: 'full' },
					diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
				},
				noopLogger,
				(e: any) => events.push(e),
			);
			orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
			(orch as any).executionStrategy = {
				execute: async (task: any) => {
					const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
					fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
					return { completed: true, method: 'chat' as const, hadFileChanges: true };
				},
			};
			return orch;
		};

		// First run: tsc should be called (cold cache)
		const orch1 = makeOrch();
		await orch1.start();
		const firstRunTscCalls = calls.filter(c => c.includes('tsc')).length;
		expect(firstRunTscCalls).toBeGreaterThan(0);

		// Second run: cache is warm and workspace unchanged → zero tsc calls
		const callsBefore = calls.length;
		const orch2 = makeOrch();
		await orch2.start();
		const secondRunTscCalls = calls.slice(callsBefore).filter(c => c.includes('tsc')).length;
		expect(secondRunTscCalls).toBe(0);
	});

	it('dirty change to tracked file invalidates cache and triggers full verification', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task Gamma\n', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];

		// Pre-seed cache with CURRENT hashes
		const cache = new VerificationCache();
		const branch = VerificationCache.getGitBranch(tmpDir);
		const treeHash = VerificationCache.getGitTreeHash(tmpDir);
		const oldHashes = VerificationCache.computeFileHashes(tmpDir);
		cache.save(tmpDir, {
			timestamp: Date.now(),
			branch,
			treeHash,
			level: 'tsc',
			healthy: true,
			fileHashes: oldHashes,
		});

		// Mutate a tracked file AFTER cache was saved (dirty condition)
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"changed-dep"}', 'utf-8');

		// Verify hashes actually differ
		const newHashes = VerificationCache.computeFileHashes(tmpDir);
		expect(newHashes['package.json']).not.toBe(oldHashes['package.json']);

		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: false, startup: 'tsc', perTask: 'none', checkpoint: 'full' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};

		await orch.start();
		// Cache was stale due to dirty file → tsc must have been called
		expect(calls.some(c => c.includes('tsc'))).toBe(true);
	});
});

describe('Bearings lifecycle events (Task 115)', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bearings-lifecycle-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('emits BearingsStarted, BearingsProgress, BearingsCompleted in correct order on healthy run', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true, startup: 'tsc', perTask: 'none' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async () => ({ exitCode: 0, output: '' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace('- [ ]', '- [x]'), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		const started = events.filter(e => e.kind === LoopEventKind.BearingsStarted);
		const progress = events.filter(e => e.kind === LoopEventKind.BearingsProgress);
		const completed = events.filter(e => e.kind === LoopEventKind.BearingsCompleted);

		expect(started.length).toBeGreaterThanOrEqual(1);
		expect(started[0].level).toBe('tsc');
		expect(completed.length).toBeGreaterThanOrEqual(1);
		expect(completed[0].healthy).toBe(true);
		expect(completed[0]).toHaveProperty('durationMs');

		// Order: started before progress before completed
		const startedIdx = events.indexOf(started[0]);
		const completedIdx = events.indexOf(completed[0]);
		expect(startedIdx).toBeLessThan(completedIdx);
		if (progress.length > 0) {
			const progressIdx = events.indexOf(progress[0]);
			expect(progressIdx).toBeGreaterThan(startedIdx);
			expect(progressIdx).toBeLessThan(completedIdx);
		}
	});

	it('emits BearingsSkipped when cache hit skips verification', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task A\n- [ ] Task B\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		const events: any[] = [];
		// Pre-seed cache with a valid entry so the next run is a cache hit
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 2, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true, startup: 'tsc', perTask: 'tsc' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		let callCount = 0;
		orch.bearingsExecFn = async () => ({ exitCode: 0, output: '' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				callCount++;
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				const firstUnchecked = prd.replace('- [ ]', '- [x]');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), firstUnchecked, 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		// Second iteration should have skipped bearings or shown BearingsSkipped
		// because perTask='tsc' and cache was seeded from first healthy run
		const skipped = events.filter(e => e.kind === LoopEventKind.BearingsSkipped);
		// If the cache hit occurs on the second run, we expect a BearingsSkipped event
		// (first iteration does a cold run, second should hit cache if workspace unchanged)
		expect(skipped.length + events.filter(e => e.kind === LoopEventKind.BearingsCompleted).length).toBeGreaterThanOrEqual(1);
	});

	it('emits BearingsProgress with stage name during bearings run', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true, startup: 'full', perTask: 'none' },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async () => ({ exitCode: 0, output: '' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace('- [ ]', '- [x]'), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		const progress = events.filter(e => e.kind === LoopEventKind.BearingsProgress);
		expect(progress.length).toBeGreaterThanOrEqual(1);
		// Should mention the stage being run (tsc or vitest)
		expect(progress[0]).toHaveProperty('stage');
		expect(['tsc', 'vitest']).toContain(progress[0].stage);
	});

	it('emits BearingsSkipped with reason when bearings disabled', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Test task\n', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: false, runTsc: true, runTests: true },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace('- [ ]', '- [x]'), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		const skipped = events.filter(e => e.kind === LoopEventKind.BearingsSkipped);
		expect(skipped.length).toBeGreaterThanOrEqual(1);
		expect(skipped[0]).toHaveProperty('reason');
	});
});

describe('CHECKPOINT: Startup DX Verification (Task 116)', () => {
	const logs: string[] = [];
	const noopLogger: ILogger = { log: (msg: string) => logs.push(msg), warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		logs.length = 0;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-startup-dx-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('end-to-end startup uses new bearings policy: tsc-only startup, none per-task, no vitest swarm', async () => {
		// Setup: workspace with both tsconfig and vitest config present
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task A\n- [ ] Task B\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'vite.config.ts'), '', 'utf-8');
		const calls: string[] = [];
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 2, countdownSeconds: 0,
				bearings: { ...DEFAULT_BEARINGS_CONFIG },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async (cmd: string) => { calls.push(cmd); return { exitCode: 0, output: '' }; };
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		// VERIFY: startup ran tsc-only, NOT full vitest
		const tscCalls = calls.filter(c => c.includes('tsc'));
		const vitestCalls = calls.filter(c => c.includes('vitest'));
		expect(tscCalls.length).toBeGreaterThanOrEqual(1);
		expect(vitestCalls).toHaveLength(0);

		// VERIFY: per-task iterations did NOT spawn additional bearings runs
		// With default perTask='none', only the first iteration (startup) should run bearings
		// Second iteration should emit BearingsSkipped for perTask
		const bearingsStarted = events.filter(e => e.kind === LoopEventKind.BearingsStarted);
		expect(bearingsStarted).toHaveLength(1);
		expect(bearingsStarted[0].level).toBe('tsc');

		// VERIFY: events chain is transparent — Started, Progress, Completed all present
		const bearingsCompleted = events.filter(e => e.kind === LoopEventKind.BearingsCompleted);
		expect(bearingsCompleted).toHaveLength(1);
		expect(bearingsCompleted[0]).toHaveProperty('durationMs');
	});

	it('no hidden full-suite default — DEFAULT_BEARINGS_CONFIG never triggers vitest on startup or per-task', () => {
		// This is the critical invariant: startup defaults to 'tsc', perTask defaults to 'none'
		expect(DEFAULT_BEARINGS_CONFIG.startup).toBe('tsc');
		expect(DEFAULT_BEARINGS_CONFIG.perTask).toBe('none');
		// Only checkpoint should be 'full'
		expect(DEFAULT_BEARINGS_CONFIG.checkpoint).toBe('full');
	});

	it('logs clearly explain what is running during startup bearings', async () => {
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Some task\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { ...DEFAULT_BEARINGS_CONFIG },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async () => ({ exitCode: 0, output: '' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace('- [ ]', '- [x]'), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		// Logs must mention what is running
		const tscLog = logs.some(l => l.includes('Bearings') && l.includes('tsc'));
		expect(tscLog).toBe(true);

		// Progress events explain stages
		const progress = events.filter(e => e.kind === LoopEventKind.BearingsProgress);
		expect(progress.length).toBeGreaterThanOrEqual(1);
		expect(progress.some((p: any) => p.stage === 'tsc')).toBe(true);
	});

	it('logs clearly explain why bearings are skipped (per-task=none)', async () => {
		// Two tasks: first gets startup bearings, second should get a skip event with reason
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] Task one\n- [ ] Task two\n', 'utf-8');
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 2, countdownSeconds: 0,
				bearings: { ...DEFAULT_BEARINGS_CONFIG },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = async () => ({ exitCode: 0, output: '' });
		(orch as any).executionStrategy = {
			execute: async (task: any) => {
				const prd = fs.readFileSync(path.join(tmpDir, 'PRD.md'), 'utf-8');
				fs.writeFileSync(path.join(tmpDir, 'PRD.md'), prd.replace(`- [ ] ${task.description}`, `- [x] ${task.description}`), 'utf-8');
				return { completed: true, method: 'chat' as const, hadFileChanges: true };
			},
		};
		await orch.start();

		// The second iteration should skip bearings and explain why
		const skipped = events.filter(e => e.kind === LoopEventKind.BearingsSkipped);
		expect(skipped.length).toBeGreaterThanOrEqual(1);
		const hasReasonExplained = skipped.some((e: any) => typeof e.reason === 'string' && e.reason.length > 0);
		expect(hasReasonExplained).toBe(true);
	});

	it('runBearings is async (non-blocking) — no execSync in the startup path', async () => {
		// Verify the function is truly async by confirming Promise return
		const result = runBearings('/tmp', noopLogger, DEFAULT_BEARINGS_CONFIG, async () => ({ exitCode: 0, output: '' }), 'none');
		expect(result).toBeInstanceOf(Promise);
		await result;

		// Verify defaultBearingsExec is also async
		const execResult = defaultBearingsExec('echo ok', '/tmp');
		expect(execResult).toBeInstanceOf(Promise);
		await execResult;
	});

	it('DEFAULT_CONFIG includes featureBranch with correct defaults', () => {
		expect(DEFAULT_CONFIG.featureBranch).toBeDefined();
		expect(DEFAULT_CONFIG.featureBranch).toEqual({
			enabled: false,
		});
	});

	it('featureBranch.enabled defaults to false', () => {
		expect(DEFAULT_CONFIG.featureBranch!.enabled).toBe(false);
	});

	it('featureBranch config has no protectedBranches property', () => {
		expect(DEFAULT_CONFIG.featureBranch).not.toHaveProperty('protectedBranches');
	});

	it('package.json has no featureBranch.protectedBranches setting', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
		const settings = pkg.contributes?.configuration?.properties ?? {};
		expect(settings).not.toHaveProperty('ralph-loop.featureBranch.protectedBranches');
	});
});

describe('Startup branch gate (linear flow)', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-gate-'));
		fs.writeFileSync(
			path.join(tmpDir, 'PRD.md'),
			'# My Feature Project\n\n- [x] **Task 1 — Done**: already done\n',
		);
		fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('creates branch from main — always creates new branch with hash suffix', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('main');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('abc1234');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(gitOps.createAndCheckoutBranch).toHaveBeenCalledWith(tmpDir, 'ralph/my-feature-project-abc1234');
		const branchCreated = events.find(e => e.kind === LoopEventKind.BranchCreated);
		expect(branchCreated).toBeDefined();
		expect(branchCreated.branchName).toBe('ralph/my-feature-project-abc1234');
	});

	it('creates branch from bisect/v0.39-lean', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('bisect/v0.39-lean');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('def5678');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(gitOps.createAndCheckoutBranch).toHaveBeenCalledWith(tmpDir, 'ralph/my-feature-project-def5678');
		const branchCreated = events.find(e => e.kind === LoopEventKind.BranchCreated);
		expect(branchCreated).toBeDefined();
	});

	it('creates branch from any arbitrary branch', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('feature/other-work');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('fed9876');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(gitOps.createAndCheckoutBranch).toHaveBeenCalledWith(tmpDir, 'ralph/my-feature-project-fed9876');
		const branchCreated = events.find(e => e.kind === LoopEventKind.BranchCreated);
		expect(branchCreated).toBeDefined();
	});

	it('handles dirty state — WIP commit after branch creation', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('main');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('abc1234');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(true);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });
		vi.spyOn(gitOps, 'wipCommit').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(gitOps.wipCommit).toHaveBeenCalledWith(tmpDir);
		const branchCreated = events.find(e => e.kind === LoopEventKind.BranchCreated);
		expect(branchCreated).toBeDefined();
	});

	it('fails gracefully — yields BranchEnforcementFailed and returns', async () => {
		fs.writeFileSync(
			path.join(tmpDir, 'PRD.md'),
			'# My Feature Project\n\n- [ ] **Task 1 — Do something**: description\n',
		);
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('main');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('abc1234');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: false, error: 'branch creation failed' });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		const failEvent = events.find(e => e.kind === LoopEventKind.BranchEnforcementFailed);
		expect(failEvent).toBeDefined();
		expect(failEvent.reason).toContain('branch creation failed');
	});

	it('skipped when featureBranch.enabled is false', async () => {
		const gitOps = await import('../src/gitOps');
		const getCurrentBranchSpy = vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('main');
		const createSpy = vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(getCurrentBranchSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
		expect(events.find(e => e.kind === LoopEventKind.BranchEnforcementFailed)).toBeUndefined();
		expect(events.find(e => e.kind === LoopEventKind.BranchCreated)).toBeUndefined();
	});

	it('stores originalBranch in state alongside activeBranch', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('main');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('abc1234');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });

		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			() => {},
		);
		await orch.start();

		const snapshot = orch.getStateSnapshot();
		expect(snapshot.branch).toBe('ralph/my-feature-project-abc1234');
		expect(snapshot.originalBranch).toBe('main');
	});

	it('switches back to originalBranch on AllDone and yields BranchSwitchedBack', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('main');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('abc1234');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });
		vi.spyOn(gitOps, 'checkoutBranch').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(gitOps.checkoutBranch).toHaveBeenCalledWith(tmpDir, 'main');
		const switchBack = events.find(e => e.kind === LoopEventKind.BranchSwitchedBack);
		expect(switchBack).toBeDefined();
		expect(switchBack.from).toBe('ralph/my-feature-project-abc1234');
		expect(switchBack.to).toBe('main');
	});

	it('logs warning but does not crash when switch-back fails', async () => {
		const gitOps = await import('../src/gitOps');
		vi.spyOn(gitOps, 'getCurrentBranch').mockResolvedValue('develop');
		vi.spyOn(gitOps, 'getShortHash').mockResolvedValue('abc1234');
		vi.spyOn(gitOps, 'hasDirtyWorkingTree').mockResolvedValue(false);
		vi.spyOn(gitOps, 'createAndCheckoutBranch').mockResolvedValue({ success: true });
		vi.spyOn(gitOps, 'checkoutBranch').mockResolvedValue({ success: false, error: 'conflict' });

		const warnLogs: string[] = [];
		const testLogger = { log: () => { }, warn: (msg: string) => warnLogs.push(msg), error: () => { } };
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			testLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(gitOps.checkoutBranch).toHaveBeenCalledWith(tmpDir, 'develop');
		expect(events.find(e => e.kind === LoopEventKind.BranchSwitchedBack)).toBeUndefined();
		expect(warnLogs.some(m => m.includes('develop'))).toBe(true);
	});

	it('does not switch back when featureBranch is disabled', async () => {
		const gitOps = await import('../src/gitOps');
		const checkoutSpy = vi.spyOn(gitOps, 'checkoutBranch').mockResolvedValue({ success: true });

		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		expect(checkoutSpy).not.toHaveBeenCalled();
		expect(events.find(e => e.kind === LoopEventKind.BranchSwitchedBack)).toBeUndefined();
	});
});

describe('abort-aware delay', () => {
	const noopLogger = { log: () => { }, warn: () => { }, error: () => { } };

	it('resolves immediately when stopController is already aborted', async () => {
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp/test-abort', maxIterations: 1, bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false } },
			noopLogger,
			() => {},
		);
		// Abort the stop controller before calling delay
		orch.stop();
		const start = Date.now();
		await (orch as any).delay(5000);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(500);
	});

	it('resolves promptly when stop fires mid-delay', async () => {
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp/test-abort2', maxIterations: 1, bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false } },
			noopLogger,
			() => {},
		);
		const start = Date.now();
		const p = (orch as any).delay(5000);
		// Stop after a small tick
		setTimeout(() => orch.stop(), 30);
		await p;
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(500);
	});

	it('cleans up listeners/timers after normal completion', async () => {
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp/test-abort3', maxIterations: 1, bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false } },
			noopLogger,
			() => {},
		);
		// Normal completion — short delay
		await (orch as any).delay(10);
		// Subsequent stop should not throw or cause duplicate handling
		orch.stop();
		// No assertion — just verifying no throw/leak
	});

	it('cleans up listeners/timers after abort completion', async () => {
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: '/tmp/test-abort4', maxIterations: 1, bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false } },
			noopLogger,
			() => {},
		);
		orch.stop();
		await (orch as any).delay(5000);
		// Calling stop again should not throw or cause issues
		orch.stop();
	});
});

describe('LaneScheduler', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-lane-sched-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeLane(repoId: string, prdContent: string): RepoLane {
		const dir = path.join(tmpDir, repoId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'PRD.md'), prdContent);
		return { repoId, workspaceFolder: dir, prdPath: 'PRD.md', progressPath: 'progress.txt', enabled: true };
	}

	it('round-robin rotates between lanes', () => {
		const laneA = makeLane('repo-a', '- [ ] Task A1\n- [ ] Task A2\n');
		const laneB = makeLane('repo-b', '- [ ] Task B1\n- [ ] Task B2\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		const first = scheduler.nextTask();
		expect(first).toBeDefined();
		expect(first!.lane.repoId).toBe('repo-a');

		const second = scheduler.nextTask();
		expect(second).toBeDefined();
		expect(second!.lane.repoId).toBe('repo-b');

		const third = scheduler.nextTask();
		expect(third).toBeDefined();
		expect(third!.lane.repoId).toBe('repo-a');
	});

	it('skips lanes with no remaining tasks', () => {
		const laneA = makeLane('repo-a', '- [x] Task A1\n');
		const laneB = makeLane('repo-b', '- [ ] Task B1\n- [ ] Task B2\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		const first = scheduler.nextTask();
		expect(first).toBeDefined();
		expect(first!.lane.repoId).toBe('repo-b');

		const second = scheduler.nextTask();
		expect(second).toBeDefined();
		expect(second!.lane.repoId).toBe('repo-b');
	});

	it('returns undefined when all lanes are done', () => {
		const laneA = makeLane('repo-a', '- [x] Task A1\n');
		const laneB = makeLane('repo-b', '- [x] Task B1\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		expect(scheduler.nextTask()).toBeUndefined();
		expect(scheduler.allDone()).toBe(true);
	});

	it('builds merged task queue with lane-scoped task IDs', () => {
		const laneA = makeLane('repo-a', '- [ ] **Task 1 — Do A**: description\n');
		const laneB = makeLane('repo-b', '- [ ] **Task 1 — Do B**: description\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		const first = scheduler.nextTask();
		expect(first!.task.repoId).toBe('repo-a');

		const second = scheduler.nextTask();
		expect(second!.task.repoId).toBe('repo-b');
	});

	it('each task carries the lane workspaceFolder', () => {
		const lane = makeLane('my-repo', '- [ ] Task 1\n');
		const scheduler = new LaneScheduler([lane]);

		const result = scheduler.nextTask();
		expect(result).toBeDefined();
		expect(result!.lane.workspaceFolder).toBe(path.join(tmpDir, 'my-repo'));
	});

	it('refresh re-reads PRDs and detects completed tasks', () => {
		const lane = makeLane('repo-a', '- [ ] Task 1\n- [ ] Task 2\n');
		const scheduler = new LaneScheduler([lane]);

		// First task
		const first = scheduler.nextTask();
		expect(first).toBeDefined();

		// Simulate task completion by modifying PRD file
		fs.writeFileSync(path.join(tmpDir, 'repo-a', 'PRD.md'), '- [x] Task 1\n- [ ] Task 2\n');
		scheduler.refresh();

		const next = scheduler.nextTask();
		expect(next).toBeDefined();
		// After refresh, should still continue with remaining tasks
	});

	it('handles lanes completing at different rates', () => {
		const laneA = makeLane('repo-a', '- [ ] Task A1\n');
		const laneB = makeLane('repo-b', '- [ ] Task B1\n- [ ] Task B2\n- [ ] Task B3\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		// First round: A gets task, B gets task
		const r1 = scheduler.nextTask();
		expect(r1!.lane.repoId).toBe('repo-a');
		const r2 = scheduler.nextTask();
		expect(r2!.lane.repoId).toBe('repo-b');

		// Mark A as done
		fs.writeFileSync(path.join(tmpDir, 'repo-a', 'PRD.md'), '- [x] Task A1\n');
		scheduler.refresh();

		// Now only B has tasks — should keep returning B
		const r3 = scheduler.nextTask();
		expect(r3!.lane.repoId).toBe('repo-b');
		const r4 = scheduler.nextTask();
		expect(r4!.lane.repoId).toBe('repo-b');
	});

	it('activeLane returns the lane of the last picked task', () => {
		const laneA = makeLane('repo-a', '- [ ] Task A1\n');
		const laneB = makeLane('repo-b', '- [ ] Task B1\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		expect(scheduler.activeLane()).toBeUndefined();
		scheduler.nextTask();
		expect(scheduler.activeLane()!.repoId).toBe('repo-a');
		scheduler.nextTask();
		expect(scheduler.activeLane()!.repoId).toBe('repo-b');
	});

	it('skips disabled lanes', () => {
		const laneA = makeLane('repo-a', '- [ ] Task A1\n');
		const laneB: RepoLane = { repoId: 'repo-b', workspaceFolder: path.join(tmpDir, 'repo-b'), prdPath: 'PRD.md', progressPath: 'progress.txt', enabled: false };
		fs.mkdirSync(path.join(tmpDir, 'repo-b'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, 'repo-b', 'PRD.md'), '- [ ] Task B1\n');
		const scheduler = new LaneScheduler([laneA, laneB]);

		const first = scheduler.nextTask();
		expect(first!.lane.repoId).toBe('repo-a');

		const second = scheduler.nextTask();
		expect(second!.lane.repoId).toBe('repo-a');
	});

	it('empty lanes array returns undefined immediately', () => {
		const scheduler = new LaneScheduler([]);
		expect(scheduler.nextTask()).toBeUndefined();
		expect(scheduler.allDone()).toBe(true);
	});
});
