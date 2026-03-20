import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BearingsLevel } from './types';

const RALPH_DIR = '.ralph';
const CACHE_FILE = 'verification.json';

const DIRTY_TRACKED_FILES = [
	'package.json',
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'tsconfig.json',
	'vite.config.ts',
	'vitest.config.ts',
	'vitest.config.js',
];

export interface VerificationCacheEntry {
	timestamp: number;
	branch: string;
	treeHash: string;
	level: BearingsLevel;
	healthy: boolean;
	fileHashes: Record<string, string>;
}

export class VerificationCache {
	load(workspaceRoot: string): VerificationCacheEntry | null {
		const filePath = path.join(workspaceRoot, RALPH_DIR, CACHE_FILE);
		if (!fs.existsSync(filePath)) {
			return null;
		}
		try {
			return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as VerificationCacheEntry;
		} catch {
			return null;
		}
	}

	save(workspaceRoot: string, entry: VerificationCacheEntry): void {
		const dir = path.join(workspaceRoot, RALPH_DIR);
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, CACHE_FILE);
		const tmp = target + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
		fs.renameSync(tmp, target);
	}

	clear(workspaceRoot: string): void {
		const filePath = path.join(workspaceRoot, RALPH_DIR, CACHE_FILE);
		try {
			fs.unlinkSync(filePath);
		} catch {
			// already gone
		}
	}

	isValid(
		workspaceRoot: string,
		branch: string,
		treeHash: string,
		level: BearingsLevel,
		currentFileHashes: Record<string, string>,
	): boolean {
		const cached = this.load(workspaceRoot);
		if (!cached) {
			return false;
		}
		if (!cached.healthy) {
			return false;
		}
		if (cached.branch !== branch || cached.treeHash !== treeHash) {
			return false;
		}
		if (cached.level !== level) {
			return false;
		}
		const cachedKeys = Object.keys(cached.fileHashes).sort();
		const currentKeys = Object.keys(currentFileHashes).sort();
		if (cachedKeys.join(',') !== currentKeys.join(',')) {
			return false;
		}
		for (const key of cachedKeys) {
			if (cached.fileHashes[key] !== currentFileHashes[key]) {
				return false;
			}
		}
		return true;
	}

	static computeFileHashes(workspaceRoot: string, files: string[] = DIRTY_TRACKED_FILES): Record<string, string> {
		const hashes: Record<string, string> = {};
		for (const file of files) {
			const filePath = path.join(workspaceRoot, file);
			if (fs.existsSync(filePath)) {
				const content = fs.readFileSync(filePath, 'utf-8');
				hashes[file] = crypto.createHash('sha256').update(content).digest('hex');
			}
		}
		return hashes;
	}

	static get trackedFiles(): string[] {
		return [...DIRTY_TRACKED_FILES];
	}

	static getGitBranch(workspaceRoot: string): string {
		try {
			return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
		} catch {
			return 'unknown';
		}
	}

	static getGitTreeHash(workspaceRoot: string): string {
		try {
			return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
		} catch {
			return 'unknown';
		}
	}
}
