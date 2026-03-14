import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { containsDangerousChars, DANGEROUS_PATTERNS, killProcessTree, ShellHookProvider } from '../src/shellHookProvider';

describe('DANGEROUS_PATTERNS regex', () => {
	it('is a RegExp', () => {
		expect(DANGEROUS_PATTERNS).toBeInstanceOf(RegExp);
	});
});

describe('containsDangerousChars', () => {
	it('blocks && (command chaining)', () => {
		expect(containsDangerousChars('echo hello && rm -rf /')).toBe(true);
	});

	it('blocks || (OR chaining)', () => {
		expect(containsDangerousChars('false || echo pwned')).toBe(true);
	});

	it('blocks pipe |', () => {
		expect(containsDangerousChars('cat /etc/passwd | grep root')).toBe(true);
	});

	it('blocks redirect >', () => {
		expect(containsDangerousChars('echo bad > /etc/hosts')).toBe(true);
	});

	it('blocks redirect <', () => {
		expect(containsDangerousChars('cmd < input.txt')).toBe(true);
	});

	it('blocks backtick', () => {
		expect(containsDangerousChars('echo `whoami`')).toBe(true);
	});

	it('blocks $() subshell', () => {
		expect(containsDangerousChars('echo $(whoami)')).toBe(true);
	});

	it('blocks ${} variable expansion', () => {
		expect(containsDangerousChars('echo ${HOME}')).toBe(true);
	});

	it('blocks semicolon ;', () => {
		expect(containsDangerousChars('echo hello; rm -rf /')).toBe(true);
	});

	it('allows clean commands', () => {
		expect(containsDangerousChars('npx vitest run')).toBe(false);
	});

	it('allows clean command with flags', () => {
		expect(containsDangerousChars('npx tsc --noEmit')).toBe(false);
	});

	it('allows simple git commands', () => {
		expect(containsDangerousChars('git add -A')).toBe(false);
	});

	it('allows commands with quotes', () => {
		expect(containsDangerousChars('git commit -m "feat: add feature"')).toBe(false);
	});
});

describe('killProcessTree', () => {
	let killFn: ReturnType<typeof vi.fn>;
	let execFn: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		killFn = vi.fn().mockReturnValue(true);
		execFn = vi.fn().mockReturnValue(Buffer.from(''));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends SIGTERM first', () => {
		killProcessTree(12345, 'linux', { kill: killFn as never, exec: execFn as never });
		expect(killFn).toHaveBeenCalledWith(12345, 'SIGTERM');
	});

	it('sends SIGKILL after 1-second delay', () => {
		killProcessTree(12345, 'linux', { kill: killFn as never, exec: execFn as never });
		expect(killFn).not.toHaveBeenCalledWith(12345, 'SIGKILL');
		vi.advanceTimersByTime(1000);
		expect(killFn).toHaveBeenCalledWith(12345, 'SIGKILL');
	});

	it('handles ESRCH error on SIGTERM gracefully', () => {
		const esrchError = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
		killFn.mockImplementation(() => { throw esrchError; });
		expect(() => killProcessTree(12345, 'linux', { kill: killFn as never, exec: execFn as never })).not.toThrow();
	});

	it('handles ESRCH error on SIGKILL gracefully', () => {
		killFn.mockImplementationOnce(() => true);
		const esrchError = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
		killFn.mockImplementationOnce(() => { throw esrchError; });
		killProcessTree(12345, 'linux', { kill: killFn as never, exec: execFn as never });
		expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
	});

	it('uses taskkill on Windows', () => {
		killProcessTree(12345, 'win32', { kill: killFn as never, exec: execFn as never });
		expect(execFn).toHaveBeenCalledWith('taskkill /PID 12345 /T /F');
		expect(killFn).not.toHaveBeenCalled();
	});
});

describe('ShellHookProvider blocked command feedback', () => {
	it('returns blocked: true with reason when script contains dangerous chars', async () => {
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const provider = new ShellHookProvider('echo hello && rm -rf /', logger);
		const result = await provider.onSessionStart({ prdPath: '/tmp/PRD.md' });
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('shell metacharacters');
		expect(result.action).toBe('continue');
	});

	it('blocked result includes reason string usable as feedback', async () => {
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const provider = new ShellHookProvider('cat /etc/passwd | grep root', logger);
		const result = await provider.onPostToolUse({ toolName: 'test', output: '' });
		expect(result.blocked).toBe(true);
		expect(typeof result.reason).toBe('string');
		expect(result.reason!.length).toBeGreaterThan(0);
	});
});
