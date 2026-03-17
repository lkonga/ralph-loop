import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	CheckpointStore,
	PhaseState,
} from '../src/checkpointRetry';

describe('CheckpointStore', () => {
	let tmpDir: string;
	let store: CheckpointStore;
	const waveId = '2026-03-15-auth-patterns';

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-checkpoint-test-'));
		store = new CheckpointStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const sampleState: Omit<PhaseState, 'timestamp'> = {
		waveId: '2026-03-15-auth-patterns',
		phase: 1,
		inputs: { topic: 'auth patterns', n: 6 },
		outputs: { reportPath: 'research/_wave/2026-03-15-auth-patterns/FINAL-REPORT.md' },
		userSteering: null,
	};

	describe('savePhase', () => {
		it('writes phase-{N}-state.json to the wave directory', () => {
			store.savePhase(waveId, 1, sampleState);
			const filePath = path.join(
				tmpDir, 'research', '_wave', waveId, 'phase-1-state.json'
			);
			expect(fs.existsSync(filePath)).toBe(true);
		});

		it('includes a timestamp in the saved state', () => {
			const before = Date.now();
			store.savePhase(waveId, 1, sampleState);
			const after = Date.now();
			const filePath = path.join(
				tmpDir, 'research', '_wave', waveId, 'phase-1-state.json'
			);
			const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PhaseState;
			expect(saved.timestamp).toBeGreaterThanOrEqual(before);
			expect(saved.timestamp).toBeLessThanOrEqual(after);
		});

		it('preserves all fields in the saved state', () => {
			store.savePhase(waveId, 1, sampleState);
			const filePath = path.join(
				tmpDir, 'research', '_wave', waveId, 'phase-1-state.json'
			);
			const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PhaseState;
			expect(saved.waveId).toBe(sampleState.waveId);
			expect(saved.phase).toBe(sampleState.phase);
			expect(saved.inputs).toEqual(sampleState.inputs);
			expect(saved.outputs).toEqual(sampleState.outputs);
			expect(saved.userSteering).toBeNull();
		});

		it('uses atomic write (tmp + rename)', () => {
			store.savePhase(waveId, 2, sampleState);
			const dir = path.join(tmpDir, 'research', '_wave', waveId);
			const files = fs.readdirSync(dir);
			// No leftover .tmp files
			expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]);
			expect(files).toContain('phase-2-state.json');
		});
	});

	describe('loadPhase', () => {
		it('returns null when no state file exists', () => {
			expect(store.loadPhase(waveId, 5)).toBeNull();
		});

		it('loads a previously saved state', () => {
			store.savePhase(waveId, 1, sampleState);
			const loaded = store.loadPhase(waveId, 1);
			expect(loaded).not.toBeNull();
			expect(loaded!.phase).toBe(1);
			expect(loaded!.inputs).toEqual(sampleState.inputs);
			expect(loaded!.outputs).toEqual(sampleState.outputs);
		});

		it('returns null on corrupt JSON', () => {
			const dir = path.join(tmpDir, 'research', '_wave', waveId);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'phase-1-state.json'), '{bad json', 'utf-8');
			expect(store.loadPhase(waveId, 1)).toBeNull();
		});
	});

	describe('listPhases', () => {
		it('returns empty array when no states exist', () => {
			expect(store.listPhases(waveId)).toEqual([]);
		});

		it('returns sorted phase numbers', () => {
			store.savePhase(waveId, 3, { ...sampleState, phase: 3 });
			store.savePhase(waveId, 1, sampleState);
			store.savePhase(waveId, 0, { ...sampleState, phase: 0 });
			expect(store.listPhases(waveId)).toEqual([0, 1, 3]);
		});
	});

	describe('goBack (checkpoint retry)', () => {
		it('reloads phase N state with appended user feedback', () => {
			store.savePhase(waveId, 1, sampleState);
			const retryState = store.goBack(waveId, 1, 'Focus more on OAuth2 patterns');
			expect(retryState).not.toBeNull();
			expect(retryState!.inputs).toEqual(sampleState.inputs);
			expect(retryState!.userSteering).toBe('Focus more on OAuth2 patterns');
		});

		it('returns null when target phase has no saved state', () => {
			expect(store.goBack(waveId, 99, 'feedback')).toBeNull();
		});

		it('clears states after phase N', () => {
			store.savePhase(waveId, 0, { ...sampleState, phase: 0 });
			store.savePhase(waveId, 1, sampleState);
			store.savePhase(waveId, 2, { ...sampleState, phase: 2 });
			store.savePhase(waveId, 3, { ...sampleState, phase: 3 });

			store.goBack(waveId, 1, 'redo');
			expect(store.listPhases(waveId)).toEqual([0, 1]);
		});

		it('updates the phase state file with user steering', () => {
			store.savePhase(waveId, 1, sampleState);
			store.goBack(waveId, 1, 'Add security analysis');

			const reloaded = store.loadPhase(waveId, 1);
			expect(reloaded!.userSteering).toBe('Add security analysis');
		});
	});

	describe('clearWave', () => {
		it('removes the entire wave directory', () => {
			store.savePhase(waveId, 0, { ...sampleState, phase: 0 });
			store.savePhase(waveId, 1, sampleState);
			store.clearWave(waveId);
			expect(store.listPhases(waveId)).toEqual([]);
		});

		it('does not throw when wave directory does not exist', () => {
			expect(() => store.clearWave('nonexistent-wave')).not.toThrow();
		});
	});
});
