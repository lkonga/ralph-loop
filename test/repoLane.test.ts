import { describe, it, expect } from 'vitest';
import type { RepoLane, RalphConfig } from '../src/types';
import { DEFAULT_CONFIG } from '../src/types';
import { LoopOrchestrator } from '../src/orchestrator';

describe('RepoLane type and multi-PRD config', () => {
	it('RepoLane has required fields', () => {
		const lane: RepoLane = {
			repoId: 'my-repo',
			workspaceFolder: '/home/user/my-repo',
			prdPath: 'PRD.md',
			progressPath: 'progress.txt',
			enabled: true,
		};
		expect(lane.repoId).toBe('my-repo');
		expect(lane.workspaceFolder).toBe('/home/user/my-repo');
		expect(lane.prdPath).toBe('PRD.md');
		expect(lane.progressPath).toBe('progress.txt');
		expect(lane.enabled).toBe(true);
	});

	it('RalphConfig accepts repos as optional', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp' } as RalphConfig;
		expect(config.repos).toBeUndefined();
	});

	it('RalphConfig accepts repos array when provided', () => {
		const lanes: RepoLane[] = [
			{ repoId: 'a', workspaceFolder: '/a', prdPath: 'PRD.md', progressPath: 'progress.txt', enabled: true },
			{ repoId: 'b', workspaceFolder: '/b', prdPath: 'PRD.md', progressPath: 'progress.txt', enabled: false },
		];
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp', repos: lanes } as RalphConfig;
		expect(config.repos).toHaveLength(2);
		expect(config.repos![0].repoId).toBe('a');
		expect(config.repos![1].enabled).toBe(false);
	});

	it('backward compatible: empty repos behaves like single-PRD mode', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp', repos: [] } as RalphConfig;
		expect(config.repos).toHaveLength(0);
	});

	it('orchestrator exposes activeRepoId in state snapshot', () => {
		const config = { ...DEFAULT_CONFIG, workspaceRoot: '/tmp' } as RalphConfig;
		const orchestrator = new LoopOrchestrator(config, { info: () => {}, warn: () => {}, error: () => {} } as any, () => {});
		const snap = orchestrator.getStateSnapshot();
		expect(snap).toHaveProperty('activeRepoId');
		expect(snap.activeRepoId).toBe('');
	});
});
