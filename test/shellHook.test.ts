import { describe, it, expect } from 'vitest';
import { containsDangerousChars, DANGEROUS_PATTERNS } from '../src/shellHookProvider';

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
