import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('vscode', () => ({
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: () => ({ get: () => undefined }),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}));

import * as vscode from 'vscode';

const mockShowInfo = vi.mocked(vscode.window.showInformationMessage);

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('extension resume flow', () => {
	it('exports resumeIncompleteSession as a function', async () => {
		const { resumeIncompleteSession } = await import('../src/extension');
		expect(typeof resumeIncompleteSession).toBe('function');
	});

	it('auto-resumes without showing Resume/Discard dialog', async () => {
		const { resumeIncompleteSession } = await import('../src/extension');

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-resume-test-'));
		const sessionDir = path.join(tmpDir, '.ralph');
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
			currentTaskIndex: 0,
			iterationCount: 1,
			nudgeCount: 0,
			retryCount: 0,
			circuitBreakerState: 'closed',
			timestamp: Date.now(),
			version: 1,
			branchName: 'ralph/test-branch',
		}));

		// Create minimal PRD.md so loadConfig doesn't throw
		fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '- [ ] **Task 1 — Test**: Do something\n');

		const onResume = vi.fn();
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		resumeIncompleteSession(tmpDir, logger, onResume);

		// Should have auto-resumed
		expect(onResume).toHaveBeenCalledOnce();
		// Should NOT have shown the old Resume/Discard dialog
		expect(mockShowInfo).not.toHaveBeenCalledWith(
			expect.stringContaining('incomplete session'),
			'Resume', 'Discard',
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('does nothing when no incomplete session exists', async () => {
		const { resumeIncompleteSession } = await import('../src/extension');

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-resume-test-'));

		const onResume = vi.fn();
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		resumeIncompleteSession(tmpDir, logger, onResume);

		expect(onResume).not.toHaveBeenCalled();

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
