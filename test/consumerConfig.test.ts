import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

describe('consumer project config references', () => {
	it('should not reference llm-rules in .vscode/settings.json', () => {
		const settingsPath = path.join(WORKSPACE_ROOT, '.vscode', 'settings.json');
		if (fs.existsSync(settingsPath)) {
			const content = fs.readFileSync(settingsPath, 'utf-8');
			expect(content).not.toContain('llm-rules');
		}
	});

	it('.vscode/skills symlink should point to vscode-config-files', () => {
		const skillsPath = path.join(WORKSPACE_ROOT, '.vscode', 'skills');
		if (fs.lstatSync(skillsPath).isSymbolicLink()) {
			const target = fs.readlinkSync(skillsPath);
			expect(target).toContain('vscode-config-files');
			expect(target).not.toContain('llm-rules');
		}
	});

	it('AGENTS.md symlink should point to vscode-config-files', () => {
		const agentsPath = path.join(WORKSPACE_ROOT, 'AGENTS.md');
		if (fs.lstatSync(agentsPath).isSymbolicLink()) {
			const target = fs.readlinkSync(agentsPath);
			expect(target).toContain('vscode-config-files');
			expect(target).not.toContain('llm-rules');
		}
	});
});
