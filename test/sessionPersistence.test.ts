import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionPersistence, SerializedLoopState } from '../src/sessionPersistence';

describe('SessionPersistence', () => {
	let tmpDir: string;
	let persistence: SessionPersistence;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-session-test-'));
		persistence = new SessionPersistence();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const sampleState: SerializedLoopState = {
		currentTaskIndex: 3,
		iterationCount: 7,
		nudgeCount: 2,
		retryCount: 1,
		circuitBreakerState: 'active',
		timestamp: Date.now(),
		version: 1,
	};

	it('save creates .ralph/session.json file', () => {
		persistence.save(tmpDir, sampleState);
		const filePath = path.join(tmpDir, '.ralph', 'session.json');
		expect(fs.existsSync(filePath)).toBe(true);
		const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		expect(content.currentTaskIndex).toBe(3);
		expect(content.iterationCount).toBe(7);
		expect(content.nudgeCount).toBe(2);
		expect(content.retryCount).toBe(1);
		expect(content.circuitBreakerState).toBe('active');
		expect(content.version).toBe(1);
		expect(content.timestamp).toBeTypeOf('number');
	});

	it('load reads back saved state', () => {
		persistence.save(tmpDir, sampleState);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.currentTaskIndex).toBe(sampleState.currentTaskIndex);
		expect(loaded!.iterationCount).toBe(sampleState.iterationCount);
		expect(loaded!.nudgeCount).toBe(sampleState.nudgeCount);
		expect(loaded!.retryCount).toBe(sampleState.retryCount);
		expect(loaded!.circuitBreakerState).toBe(sampleState.circuitBreakerState);
		expect(loaded!.version).toBe(1);
	});

	it('load returns null when file is missing', () => {
		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
	});

	it('load returns null on version mismatch', () => {
		const dir = path.join(tmpDir, '.ralph');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ ...sampleState, version: 99 }), 'utf-8');
		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
	});

	it('clear deletes session.json', () => {
		persistence.save(tmpDir, sampleState);
		const filePath = path.join(tmpDir, '.ralph', 'session.json');
		expect(fs.existsSync(filePath)).toBe(true);
		persistence.clear(tmpDir);
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('clear does not throw when file is missing', () => {
		expect(() => persistence.clear(tmpDir)).not.toThrow();
	});

	it('hasIncompleteSession returns true when session is fresh', () => {
		persistence.save(tmpDir, { ...sampleState, timestamp: Date.now() });
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(true);
	});

	it('hasIncompleteSession returns false when session is expired', () => {
		const expired = { ...sampleState, timestamp: Date.now() - 25 * 60 * 60 * 1000 }; // 25 hours ago
		persistence.save(tmpDir, expired);
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(false);
	});

	it('hasIncompleteSession returns false when file is missing', () => {
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(false);
	});

	it('hasIncompleteSession respects custom expireAfterMs', () => {
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
		persistence.save(tmpDir, { ...sampleState, timestamp: twoHoursAgo });
		// With default 24h expiry, should still be valid
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(true);
		// With 1h expiry, should be expired
		const shortPersistence = new SessionPersistence(3600000);
		expect(shortPersistence.hasIncompleteSession(tmpDir)).toBe(false);
	});
});
