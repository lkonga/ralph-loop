import { spawn } from 'child_process';
import {
	IRalphHookService,
	SessionStartInput,
	PreCompactInput,
	PostToolUseInput,
	PreCompleteInput,
	TaskCompleteInput,
	HookResult,
	RalphHookType,
	ILogger,
} from './types';

const SHELL_HOOK_TIMEOUT_MS = 30_000;

export class ShellHookProvider implements IRalphHookService {
	constructor(
		private readonly scriptPath: string,
		private readonly logger: ILogger,
	) {}

	async onSessionStart(input: SessionStartInput): Promise<HookResult> {
		return this.executeHook('SessionStart', input);
	}

	async onPreCompact(input: PreCompactInput): Promise<HookResult> {
		return this.executeHook('PreCompact', input);
	}

	async onPostToolUse(input: PostToolUseInput): Promise<HookResult> {
		return this.executeHook('PostToolUse', input);
	}

	async onPreComplete(input: PreCompleteInput): Promise<HookResult> {
		return this.executeHook('PreComplete', input);
	}

	async onTaskComplete(input: TaskCompleteInput): Promise<HookResult> {
		return this.executeHook('TaskComplete', input);
	}

	private executeHook(hookType: RalphHookType, input: unknown): Promise<HookResult> {
		return new Promise<HookResult>((resolve) => {
			const child = spawn(this.scriptPath, [hookType], {
				stdio: ['pipe', 'pipe', 'pipe'],
				timeout: SHELL_HOOK_TIMEOUT_MS,
			});

			let stdout = '';
			let stderr = '';

			child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
			child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

			child.on('error', (err: Error) => {
				this.logger.error(`Shell hook error (${hookType}): ${err.message}`);
				resolve({ action: 'continue', reason: `Hook script error: ${err.message}` });
			});

			child.on('close', (code: number | null) => {
				if (code === null) {
					// Killed by timeout
					this.logger.warn(`Shell hook timed out (${hookType}) after ${SHELL_HOOK_TIMEOUT_MS}ms`);
					resolve({ action: 'continue', reason: 'Hook script timed out' });
					return;
				}

				if (code === 0) {
					// Exit 0: success/continue — parse stdout as HookResult if available
					if (stdout.trim()) {
						try {
							const parsed = JSON.parse(stdout.trim()) as HookResult;
							resolve(parsed);
							return;
						} catch {
							this.logger.warn(`Shell hook (${hookType}): stdout is not valid JSON, treating as continue`);
						}
					}
					resolve({ action: 'continue' });
				} else if (code === 1) {
					// Exit 1: warning — log and continue
					const reason = stderr.trim() || 'Hook script returned warning (exit 1)';
					this.logger.warn(`Shell hook warning (${hookType}): ${reason}`);
					resolve({ action: 'continue', reason });
				} else if (code === 2) {
					// Exit 2: block/stop — halt with stderr as reason
					const reason = stderr.trim() || 'Hook script blocked execution (exit 2)';
					this.logger.error(`Shell hook blocked (${hookType}): ${reason}`);
					resolve({ action: 'stop', reason });
				} else {
					this.logger.warn(`Shell hook (${hookType}): unexpected exit code ${code}`);
					resolve({ action: 'continue', reason: `Hook script exited with code ${code}` });
				}
			});

			// Write hook input as JSON to stdin
			child.stdin.write(JSON.stringify(input));
			child.stdin.end();
		});
	}
}
