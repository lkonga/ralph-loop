import * as fs from 'fs';
import * as path from 'path';

export interface PhaseState {
	waveId: string;
	phase: number;
	inputs: Record<string, unknown>;
	outputs: Record<string, unknown>;
	userSteering: string | null;
	timestamp: number;
}

const WAVE_DIR = path.join('research', '_wave');

function phaseFileName(phase: number): string {
	return `phase-${phase}-state.json`;
}

export class CheckpointStore {
	private readonly root: string;

	constructor(workspaceRoot: string) {
		this.root = workspaceRoot;
	}

	private waveDir(waveId: string): string {
		return path.join(this.root, WAVE_DIR, waveId);
	}

	private phaseFilePath(waveId: string, phase: number): string {
		return path.join(this.waveDir(waveId), phaseFileName(phase));
	}

	savePhase(waveId: string, phase: number, state: Omit<PhaseState, 'timestamp'>): void {
		const dir = this.waveDir(waveId);
		fs.mkdirSync(dir, { recursive: true });

		const full: PhaseState = { ...state, timestamp: Date.now() };
		const target = this.phaseFilePath(waveId, phase);
		const tmp = target + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf-8');
		fs.renameSync(tmp, target);
	}

	loadPhase(waveId: string, phase: number): PhaseState | null {
		const filePath = this.phaseFilePath(waveId, phase);
		if (!fs.existsSync(filePath)) {
			return null;
		}
		try {
			return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PhaseState;
		} catch {
			return null;
		}
	}

	listPhases(waveId: string): number[] {
		const dir = this.waveDir(waveId);
		if (!fs.existsSync(dir)) {
			return [];
		}
		const pattern = /^phase-(\d+)-state\.json$/;
		return fs.readdirSync(dir)
			.map(f => pattern.exec(f))
			.filter((m): m is RegExpExecArray => m !== null)
			.map(m => parseInt(m[1], 10))
			.sort((a, b) => a - b);
	}

	goBack(waveId: string, phase: number, feedback: string): PhaseState | null {
		const state = this.loadPhase(waveId, phase);
		if (!state) {
			return null;
		}

		// Clear all phases after the target
		const allPhases = this.listPhases(waveId);
		for (const p of allPhases) {
			if (p > phase) {
				try {
					fs.unlinkSync(this.phaseFilePath(waveId, p));
				} catch {
					// already removed
				}
			}
		}

		// Update the target phase with user steering
		const updated: PhaseState = { ...state, userSteering: feedback };
		const target = this.phaseFilePath(waveId, phase);
		const tmp = target + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
		fs.renameSync(tmp, target);

		return updated;
	}

	clearWave(waveId: string): void {
		const dir = this.waveDir(waveId);
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// directory may not exist
		}
	}
}
