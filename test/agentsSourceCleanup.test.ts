import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

const AGENTS_SOURCE_PATH = resolve(__dirname, '../../vscode-config-files/AGENTS.source.md');

describe('Task 89.1 — AGENTS.source.md cleanup', () => {
	let content: string;

	beforeAll(() => {
		content = readFileSync(AGENTS_SOURCE_PATH, 'utf-8');
	});

	it('should NOT contain "## Wave Pipeline Agents" section header', () => {
		expect(content).not.toMatch(/^## Wave Pipeline Agents/m);
	});

	it('should NOT contain wave-context-grounder agent entry', () => {
		expect(content).not.toMatch(/wave-context-grounder/);
	});

	it('should NOT contain any .agent.md file references', () => {
		const agentMdRefs = content.match(/\.agent\.md/g);
		expect(agentMdRefs).toBeNull();
	});

	it('should still contain skills sections (not over-deleted)', () => {
		expect(content).toMatch(/^## Available Skills/m);
		expect(content).toMatch(/^## Usage Guidelines/m);
	});

	it('should still contain System Safety Guardrails section', () => {
		expect(content).toMatch(/System Safety Guardrails/);
	});
});
