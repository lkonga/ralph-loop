import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoLane } from '../src/types';

vi.mock('vscode', () => ({
	workspace: {
		workspaceFolders: undefined as any,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(() => undefined),
			update: vi.fn(() => Promise.resolve()),
		})),
	},
	window: {
		showQuickPick: vi.fn(),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, scheme: 'file' }),
	},
	ConfigurationTarget: { Workspace: 2 },
}));

import * as vscode from 'vscode';

// Must import after mock
import { discoverPrdRepos, showRepoQuickPick, applyRepoSelections } from '../src/extension';

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('discoverPrdRepos', () => {
	it('returns empty array when no workspace folders', () => {
		(vscode.workspace as any).workspaceFolders = undefined;
		const result = discoverPrdRepos([]);
		expect(result).toEqual([]);
	});

	it('discovers repos from workspace folders that have PRD.md', () => {
		const folders = [
			{ uri: { fsPath: '/home/user/project-a' }, name: 'project-a', index: 0 },
			{ uri: { fsPath: '/home/user/project-b' }, name: 'project-b', index: 1 },
		];
		const existingFiles = ['/home/user/project-a/PRD.md', '/home/user/project-b/PRD.md'];
		const result = discoverPrdRepos(folders as any, (p: string) => existingFiles.includes(p));
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			repoId: 'project-a',
			workspaceFolder: '/home/user/project-a',
			prdPath: '/home/user/project-a/PRD.md',
			progressPath: '/home/user/project-a/progress.txt',
			enabled: true,
		});
		expect(result[1].repoId).toBe('project-b');
	});

	it('skips folders without PRD.md', () => {
		const folders = [
			{ uri: { fsPath: '/a' }, name: 'has-prd', index: 0 },
			{ uri: { fsPath: '/b' }, name: 'no-prd', index: 1 },
		];
		const result = discoverPrdRepos(folders as any, (p: string) => p === '/a/PRD.md');
		expect(result).toHaveLength(1);
		expect(result[0].repoId).toBe('has-prd');
	});

	it('uses folder name as repoId', () => {
		const folders = [
			{ uri: { fsPath: '/home/user/my-cool-project' }, name: 'my-cool-project', index: 0 },
		];
		const result = discoverPrdRepos(folders as any, () => true);
		expect(result[0].repoId).toBe('my-cool-project');
	});

	it('sets all fields correctly', () => {
		const folders = [
			{ uri: { fsPath: '/workspace/repo' }, name: 'repo', index: 0 },
		];
		const result = discoverPrdRepos(folders as any, () => true);
		const lane = result[0];
		expect(lane.repoId).toBe('repo');
		expect(lane.workspaceFolder).toBe('/workspace/repo');
		expect(lane.prdPath).toBe('/workspace/repo/PRD.md');
		expect(lane.progressPath).toBe('/workspace/repo/progress.txt');
		expect(lane.enabled).toBe(true);
	});
});

describe('showRepoQuickPick', () => {
	it('returns selected repos when user picks items', async () => {
		const repos: RepoLane[] = [
			{ repoId: 'a', workspaceFolder: '/a', prdPath: '/a/PRD.md', progressPath: '/a/progress.txt', enabled: true },
			{ repoId: 'b', workspaceFolder: '/b', prdPath: '/b/PRD.md', progressPath: '/b/progress.txt', enabled: true },
		];
		const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
		mockShowQuickPick.mockResolvedValue([
			{ label: 'a', description: '/a', picked: true, repoLane: repos[0] },
		] as any);

		const result = await showRepoQuickPick(repos);
		expect(result).toHaveLength(1);
		expect(result![0].repoId).toBe('a');
	});

	it('returns undefined when user cancels', async () => {
		const repos: RepoLane[] = [
			{ repoId: 'a', workspaceFolder: '/a', prdPath: '/a/PRD.md', progressPath: '/a/progress.txt', enabled: true },
		];
		const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
		mockShowQuickPick.mockResolvedValue(undefined);

		const result = await showRepoQuickPick(repos);
		expect(result).toBeUndefined();
	});

	it('returns empty array when user deselects all', async () => {
		const repos: RepoLane[] = [
			{ repoId: 'a', workspaceFolder: '/a', prdPath: '/a/PRD.md', progressPath: '/a/progress.txt', enabled: true },
		];
		const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
		mockShowQuickPick.mockResolvedValue([] as any);

		const result = await showRepoQuickPick(repos);
		expect(result).toHaveLength(0);
	});

	it('pre-selects previously enabled repos', async () => {
		const repos: RepoLane[] = [
			{ repoId: 'a', workspaceFolder: '/a', prdPath: '/a/PRD.md', progressPath: '/a/progress.txt', enabled: true },
			{ repoId: 'b', workspaceFolder: '/b', prdPath: '/b/PRD.md', progressPath: '/b/progress.txt', enabled: false },
		];
		const mockShowQuickPick = vi.mocked(vscode.window.showQuickPick);
		mockShowQuickPick.mockResolvedValue([
			{ label: 'a', description: '/a', picked: true, repoLane: repos[0] },
		] as any);

		await showRepoQuickPick(repos);
		const callArgs = mockShowQuickPick.mock.calls[0][0] as any[];
		expect(callArgs[0].picked).toBe(true);
		expect(callArgs[1].picked).toBe(false);
	});
});

describe('applyRepoSelections', () => {
	it('stores selected repoIds in workspace settings', async () => {
		const mockUpdate = vi.fn(() => Promise.resolve());
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn(),
			update: mockUpdate,
		} as any);

		const selected: RepoLane[] = [
			{ repoId: 'a', workspaceFolder: '/a', prdPath: '/a/PRD.md', progressPath: '/a/progress.txt', enabled: true },
		];
		const all: RepoLane[] = [
			...selected,
			{ repoId: 'b', workspaceFolder: '/b', prdPath: '/b/PRD.md', progressPath: '/b/progress.txt', enabled: true },
		];

		await applyRepoSelections(all, selected);

		expect(mockUpdate).toHaveBeenCalledWith(
			'repos',
			expect.any(Array),
			vscode.ConfigurationTarget.Workspace,
		);
		const storedRepos = mockUpdate.mock.calls[0][1] as RepoLane[];
		expect(storedRepos).toHaveLength(2);
		const repoA = storedRepos.find((r: RepoLane) => r.repoId === 'a');
		const repoB = storedRepos.find((r: RepoLane) => r.repoId === 'b');
		expect(repoA!.enabled).toBe(true);
		expect(repoB!.enabled).toBe(false);
	});
});
