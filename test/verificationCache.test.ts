import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VerificationCache, VerificationCacheEntry } from '../src/verificationCache';

describe('VerificationCache', () => {
	let tmpDir: string;
	let cache: VerificationCache;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-vcache-'));
		cache = new VerificationCache();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns null when no cache file exists', () => {
		const entry = cache.load(tmpDir);
		expect(entry).toBeNull();
	});

	it('saves and loads cache entry round-trip', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'hash1', 'tsconfig.json': 'hash2' },
		};
		cache.save(tmpDir, entry);
		const loaded = cache.load(tmpDir);
		expect(loaded).toEqual(entry);
	});

	it('cache hit skips rerun when inputs unchanged', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'hash1' },
		};
		cache.save(tmpDir, entry);
		const hit = cache.isValid(tmpDir, 'main', 'abc123', 'tsc', { 'package.json': 'hash1' });
		expect(hit).toBe(true);
	});

	it('cache miss reruns when relevant files/config change', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'hash1' },
		};
		cache.save(tmpDir, entry);
		const hit = cache.isValid(tmpDir, 'main', 'abc123', 'tsc', { 'package.json': 'hash-changed' });
		expect(hit).toBe(false);
	});

	it('cache invalidates on branch/tree change', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'hash1' },
		};
		cache.save(tmpDir, entry);
		const hit = cache.isValid(tmpDir, 'feature-branch', 'abc123', 'tsc', { 'package.json': 'hash1' });
		expect(hit).toBe(false);
	});

	it('cache invalidates on tree hash change', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'hash1' },
		};
		cache.save(tmpDir, entry);
		const hit = cache.isValid(tmpDir, 'main', 'def456', 'tsc', { 'package.json': 'hash1' });
		expect(hit).toBe(false);
	});

	it('cache invalidates when level changes', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: { 'package.json': 'hash1' },
		};
		cache.save(tmpDir, entry);
		const hit = cache.isValid(tmpDir, 'main', 'abc123', 'full', { 'package.json': 'hash1' });
		expect(hit).toBe(false);
	});

	it('cache invalidates when unhealthy result is cached', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: false,
			fileHashes: { 'package.json': 'hash1' },
		};
		cache.save(tmpDir, entry);
		const hit = cache.isValid(tmpDir, 'main', 'abc123', 'tsc', { 'package.json': 'hash1' });
		expect(hit).toBe(false);
	});

	it('returns null on corrupt cache file', () => {
		const dir = path.join(tmpDir, '.ralph');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'verification.json'), 'not json', 'utf-8');
		const entry = cache.load(tmpDir);
		expect(entry).toBeNull();
	});

	it('clear removes the cache file', () => {
		const entry: VerificationCacheEntry = {
			timestamp: Date.now(),
			branch: 'main',
			treeHash: 'abc123',
			level: 'tsc',
			healthy: true,
			fileHashes: {},
		};
		cache.save(tmpDir, entry);
		cache.clear(tmpDir);
		expect(cache.load(tmpDir)).toBeNull();
	});

	it('computeFileHashes produces consistent hashes for same content', () => {
		const srcFile = path.join(tmpDir, 'package.json');
		fs.writeFileSync(srcFile, '{"name":"test"}', 'utf-8');
		const hashes1 = VerificationCache.computeFileHashes(tmpDir, ['package.json']);
		const hashes2 = VerificationCache.computeFileHashes(tmpDir, ['package.json']);
		expect(hashes1).toEqual(hashes2);
	});

	it('computeFileHashes changes when file content changes', () => {
		const srcFile = path.join(tmpDir, 'package.json');
		fs.writeFileSync(srcFile, '{"name":"test"}', 'utf-8');
		const hashes1 = VerificationCache.computeFileHashes(tmpDir, ['package.json']);
		fs.writeFileSync(srcFile, '{"name":"changed"}', 'utf-8');
		const hashes2 = VerificationCache.computeFileHashes(tmpDir, ['package.json']);
		expect(hashes1['package.json']).not.toBe(hashes2['package.json']);
	});

	it('computeFileHashes skips missing files', () => {
		const hashes = VerificationCache.computeFileHashes(tmpDir, ['nonexistent.json']);
		expect(hashes).toEqual({});
	});
});
