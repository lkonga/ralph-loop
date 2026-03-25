import { describe, expect, it } from 'vitest';
import { formatRunConfigForPrompt } from '../src/preFlightWizard';
import type { PreFlightMode } from '../src/preFlightWizard';
import type { RunConfig } from '../src/runConfig';
import { DEFAULT_CONFIG } from '../src/types';

describe('preFlightWizard', () => {
	describe('formatRunConfigForPrompt', () => {
		it('includes all config fields', () => {
			const config: RunConfig = {
				runner: 'vitest',
				buildCommand: 'npx tsc --noEmit',
				testCommand: 'npx vitest run',
				mode: 'tdd-strict',
				scope: 'full-prd',
				lastUpdated: '2026-03-25',
			};
			const result = formatRunConfigForPrompt(config);
			expect(result).toContain('Runner: vitest');
			expect(result).toContain('Build: npx tsc --noEmit');
			expect(result).toContain('Test: npx vitest run');
			expect(result).toContain('Mode: tdd-strict');
			expect(result).toContain('Scope: full-prd');
			expect(result).toContain('RUN CONFIGURATION');
		});

		it('omits build/test when not set', () => {
			const config: RunConfig = {
				runner: 'none',
				mode: 'skip-tests',
				scope: 'single-task',
				lastUpdated: '',
			};
			const result = formatRunConfigForPrompt(config);
			expect(result).toContain('Runner: none');
			expect(result).not.toContain('Build:');
			expect(result).not.toContain('Test:');
		});
	});

	describe('DEFAULT_CONFIG integration', () => {
		it('has preFlightWizard default as countdown', () => {
			expect(DEFAULT_CONFIG.preFlightWizard).toBe('countdown');
		});

		it('has preFlightCountdownSeconds default as 15', () => {
			expect(DEFAULT_CONFIG.preFlightCountdownSeconds).toBe(15);
		});
	});

	describe('PreFlightMode type', () => {
		it('accepts all valid modes', () => {
			const modes: PreFlightMode[] = ['always', 'countdown', 'never'];
			expect(modes).toHaveLength(3);
		});
	});
});
