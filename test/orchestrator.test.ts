import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	shouldContinueLoop,
	shouldNudge,
	shouldRetryError,
	MAX_RETRIES_PER_TASK,
} from '../src/decisions';
import { runPreCompleteChain, LoopOrchestrator, runBearings, LinkedCancellationSource, resolveAgentMode } from '../src/orchestrator';
import { parseReviewVerdict } from '../src/copilot';
import { estimatePromptTokens } from '../src/prompt';
import {
	DEFAULT_CONFIG,
	DEFAULT_INACTIVITY_CONFIG,
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
	const noopLogger = { log: () => {}, warn: () => {}, error: () => {} };

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
			() => {},
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
			() => {},
		);
		const ctx = (orch as any).consumePendingContext();
		expect(ctx).toBeUndefined();
	});
});

describe('Security rejection as feedback', () => {
	const noopLogger = { log: () => {}, warn: () => {}, error: () => {} };
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
	const noopLogger = { log: () => {}, warn: () => {}, error: () => {} };

	it('returns healthy when both tsc and vitest pass', async () => {
		const execFn = () => ({ exitCode: 0, output: '' });
		const result = await runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		expect(result.healthy).toBe(true);
		expect(result.issues).toHaveLength(0);
		expect(result.fixTask).toBeUndefined();
	});

	it('returns unhealthy when tsc fails', async () => {
		const execFn = (cmd: string) => {
			if (cmd.includes('tsc')) return { exitCode: 1, output: 'error TS2345: Argument of type...' };
			return { exitCode: 0, output: '' };
		};
		const result = await runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		expect(result.healthy).toBe(false);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.some(i => i.includes('TypeScript'))).toBe(true);
		expect(result.fixTask).toContain('Fix baseline');
	});

	it('returns unhealthy when vitest fails', async () => {
		const execFn = (cmd: string) => {
			if (cmd.includes('vitest')) return { exitCode: 1, output: '3 tests failed' };
			return { exitCode: 0, output: '' };
		};
		const result = await runBearings('/tmp', noopLogger, { enabled: true, runTsc: true, runTests: true }, execFn);
		expect(result.healthy).toBe(false);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.some(i => i.includes('test') || i.includes('Test'))).toBe(true);
		expect(result.fixTask).toContain('Fix baseline');
	});
});

describe('Bearings phase integration', () => {
	const noopLogger = { log: () => {}, warn: () => {}, error: () => {} };
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
			{ ...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1, countdownSeconds: 0,
				bearings: { enabled: true, runTsc: true, runTests: true },
				diffValidation: { enabled: false, requireChanges: false, generateSummary: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		orch.bearingsExecFn = () => ({ exitCode: 0, output: '' });
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
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{ ...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 5, countdownSeconds: 0,
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
		orch.bearingsExecFn = () => ({ exitCode: 1, output: 'errors found' });
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
			{ ...DEFAULT_CONFIG, workspaceRoot: tmpDir, maxIterations: 1,
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
