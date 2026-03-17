import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SETTINGS_PATH = path.join(
	os.homedir(),
	'.config',
	'Code - Insiders',
	'User',
	'settings.json'
);

function readSettings(): string {
	return fs.readFileSync(SETTINGS_PATH, 'utf-8');
}

describe('VS Code User settings.json migration', () => {
	it('settings.json should exist', () => {
		expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
	});

	it('should have no llm-rules references', () => {
		expect(readSettings()).not.toContain('llm-rules');
	});

	it('chat.modeFilesLocations should reference vscode-config-files/agents', () => {
		expect(readSettings()).toMatch(/chat\.modeFilesLocations[\s\S]*?vscode-config-files\/agents/);
	});

	it('chat.modeFilesLocations should not have deprecated chatmodes entry', () => {
		expect(readSettings()).not.toMatch(/chat\.modeFilesLocations[\s\S]*?chatmodes/);
	});

	it('chat.promptFilesLocations should reference vscode-config-files/prompts', () => {
		expect(readSettings()).toMatch(/chat\.promptFilesLocations[\s\S]*?vscode-config-files\/prompts/);
	});

	it('chat.instructionsFilesLocations should reference vscode-config-files/instructions', () => {
		expect(readSettings()).toMatch(/chat\.instructionsFilesLocations[\s\S]*?vscode-config-files\/instructions/);
	});

	it('chat.agentFilesLocations should reference vscode-config-files/agents', () => {
		expect(readSettings()).toMatch(/chat\.agentFilesLocations[\s\S]*?vscode-config-files\/agents/);
	});

	it('chat.agentSkillsLocations should reference vscode-config-files/skills', () => {
		expect(readSettings()).toMatch(/chat\.agentSkillsLocations[\s\S]*?vscode-config-files\/skills/);
	});

	it('chat.hookFilesLocations should reference vscode-config-files/hooks', () => {
		expect(readSettings()).toMatch(/chat\.hookFilesLocations[\s\S]*?vscode-config-files\/hooks/);
	});
});
