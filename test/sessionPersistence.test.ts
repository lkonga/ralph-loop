import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SerializedLoopState,
	SessionPersistence,
} from "../src/sessionPersistence";

describe("SessionPersistence", () => {
	let tmpDir: string;
	let persistence: SessionPersistence;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-session-test-"));
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
		circuitBreakerState: "active",
		timestamp: Date.now(),
		version: 1,
	};

	it("save creates .ralph/session.json file", () => {
		persistence.save(tmpDir, sampleState);
		const filePath = path.join(tmpDir, ".ralph", "session.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(content.currentTaskIndex).toBe(3);
		expect(content.iterationCount).toBe(7);
		expect(content.nudgeCount).toBe(2);
		expect(content.retryCount).toBe(1);
		expect(content.circuitBreakerState).toBe("active");
		expect(content.version).toBe(1);
		expect(content.timestamp).toBeTypeOf("number");
	});

	it("load reads back saved state", () => {
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

	it("load returns null when file is missing", () => {
		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
	});

	it("load returns null on version mismatch", () => {
		const dir = path.join(tmpDir, ".ralph");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "session.json"),
			JSON.stringify({ ...sampleState, version: 99 }),
			"utf-8",
		);
		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
	});

	it("clear deletes session.json", () => {
		persistence.save(tmpDir, sampleState);
		const filePath = path.join(tmpDir, ".ralph", "session.json");
		expect(fs.existsSync(filePath)).toBe(true);
		persistence.clear(tmpDir);
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it("clear does not throw when file is missing", () => {
		expect(() => persistence.clear(tmpDir)).not.toThrow();
	});

	it("hasIncompleteSession returns true when session is fresh", () => {
		persistence.save(tmpDir, { ...sampleState, timestamp: Date.now() });
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(true);
	});

	it("hasIncompleteSession returns false when session is expired", () => {
		const expired = {
			...sampleState,
			timestamp: Date.now() - 25 * 60 * 60 * 1000,
		}; // 25 hours ago
		persistence.save(tmpDir, expired);
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(false);
	});

	it("hasIncompleteSession returns false when file is missing", () => {
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(false);
	});

	it("hasIncompleteSession respects custom expireAfterMs", () => {
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
		persistence.save(tmpDir, { ...sampleState, timestamp: twoHoursAgo });
		// With default 24h expiry, should still be valid
		expect(persistence.hasIncompleteSession(tmpDir)).toBe(true);
		// With 1h expiry, should be expired
		const shortPersistence = new SessionPersistence(3600000);
		expect(shortPersistence.hasIncompleteSession(tmpDir)).toBe(false);
	});

	it("save uses atomic write — crash mid-write preserves previous data", () => {
		// Save initial state
		persistence.save(tmpDir, sampleState);
		const sessionDir = path.join(tmpDir, ".ralph");
		const filePath = path.join(sessionDir, "session.json");

		// Save updated data
		persistence.save(tmpDir, { ...sampleState, currentTaskIndex: 99 });

		// Verify: no .tmp file left behind (atomic rename cleaned it up)
		const leftoverTmp = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".tmp"));
		expect(leftoverTmp).toHaveLength(0);

		// Verify: file has updated data
		const updated = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(updated.currentTaskIndex).toBe(99);
	});

	it("save does not corrupt original file if tmp write would fail", () => {
		// Save initial good state
		persistence.save(tmpDir, sampleState);
		const sessionDir = path.join(tmpDir, ".ralph");
		const filePath = path.join(sessionDir, "session.json");
		const originalContent = fs.readFileSync(filePath, "utf-8");

		// Make the .tmp file path unwritable by creating a directory with the same name
		const tmpPath = filePath + ".tmp";
		fs.mkdirSync(tmpPath);

		// Attempting save should fail (can't write to a directory path)
		expect(() =>
			persistence.save(tmpDir, { ...sampleState, currentTaskIndex: 999 }),
		).toThrow();

		// Original file must be untouched — this is the crash-safety guarantee
		const afterCrash = fs.readFileSync(filePath, "utf-8");
		expect(afterCrash).toBe(originalContent);

		// Cleanup the blocking directory
		fs.rmdirSync(tmpPath);
	});

	// === Task 68 — Session ID & Isolation ===

	it("save persists sessionId, pid, and workspacePath", () => {
		const state: SerializedLoopState = {
			...sampleState,
			sessionId: "test-uuid-1234",
			pid: 12345,
			workspacePath: tmpDir,
		};
		persistence.save(tmpDir, state);
		const filePath = path.join(tmpDir, ".ralph", "session.json");
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(content.sessionId).toBe("test-uuid-1234");
		expect(content.pid).toBe(12345);
		expect(content.workspacePath).toBe(tmpDir);
	});

	it("load returns null when workspacePath does not match", () => {
		const state: SerializedLoopState = {
			...sampleState,
			sessionId: "test-uuid-ws",
			pid: 1, // use PID 1 (init) — always alive, but workspace check comes first
			workspacePath: "/some/other/workspace",
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
	});

	it("load returns state when PID is dead (safe to resume)", () => {
		const deadPid = 999999999; // extremely unlikely to be running
		const state: SerializedLoopState = {
			...sampleState,
			sessionId: "test-uuid-dead",
			pid: deadPid,
			workspacePath: tmpDir,
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.sessionId).toBe("test-uuid-dead");
	});

	it("load returns null when PID is still alive", () => {
		const state: SerializedLoopState = {
			...sampleState,
			sessionId: "test-uuid-alive",
			pid: process.pid, // current process — definitely alive
			workspacePath: tmpDir,
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
	});

	it("load returns null when PID exists but is owned by another user (EPERM)", () => {
		const state: SerializedLoopState = {
			...sampleState,
			sessionId: "test-uuid-eperm",
			pid: 42,
			workspacePath: tmpDir,
		};
		persistence.save(tmpDir, state);

		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((_pid, _signal?) => {
				const err = new Error("EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			});

		const loaded = persistence.load(tmpDir);
		expect(loaded).toBeNull();
		killSpy.mockRestore();
	});

	it("load tolerates missing isolation fields in legacy sessions", () => {
		// Legacy format without sessionId/pid/workspacePath should still load
		const dir = path.join(tmpDir, ".ralph");
		fs.mkdirSync(dir, { recursive: true });
		const legacyState = {
			currentTaskIndex: 1,
			iterationCount: 1,
			nudgeCount: 0,
			retryCount: 0,
			circuitBreakerState: "active",
			timestamp: Date.now(),
			version: 1,
		};
		fs.writeFileSync(
			path.join(dir, "session.json"),
			JSON.stringify(legacyState),
			"utf-8",
		);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.currentTaskIndex).toBe(1);
	});

	// === Task 124 — Persist Branch in Session State ===

	it("save persists branchName when provided", () => {
		const state: SerializedLoopState = {
			...sampleState,
			branchName: "ralph/my-feature",
		};
		persistence.save(tmpDir, state);
		const filePath = path.join(tmpDir, ".ralph", "session.json");
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(content.branchName).toBe("ralph/my-feature");
	});

	it("load returns stored branchName", () => {
		const state: SerializedLoopState = {
			...sampleState,
			branchName: "ralph/my-feature",
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.branchName).toBe("ralph/my-feature");
	});

	// === Task 133 — Persist originalBranch in Session State ===

	it("save persists originalBranch alongside branchName", () => {
		const state: SerializedLoopState = {
			...sampleState,
			branchName: "ralph/my-feature-abc123",
			originalBranch: "main",
		};
		persistence.save(tmpDir, state);
		const filePath = path.join(tmpDir, ".ralph", "session.json");
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(content.originalBranch).toBe("main");
		expect(content.branchName).toBe("ralph/my-feature-abc123");
	});

	it("load returns stored originalBranch", () => {
		const state: SerializedLoopState = {
			...sampleState,
			branchName: "ralph/my-feature-abc123",
			originalBranch: "develop",
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.originalBranch).toBe("develop");
		expect(loaded!.branchName).toBe("ralph/my-feature-abc123");
	});

	it("load handles missing originalBranch gracefully (legacy session)", () => {
		const state: SerializedLoopState = {
			...sampleState,
			branchName: "ralph/my-feature",
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.originalBranch).toBeUndefined();
	});

	it("load does not set branchMismatch (flag removed)", () => {
		const state: SerializedLoopState = {
			...sampleState,
			branchName: "ralph/my-feature",
			originalBranch: "main",
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect("branchMismatch" in loaded!).toBe(false);
	});

	// === Task 160 — Per-Lane originalBranch in Session State ===

	it("save persists laneBranches alongside top-level fields", () => {
		const state: SerializedLoopState = {
			...sampleState,
			laneBranches: {
				"repo-a": { originalBranch: "main", activeBranch: "ralph/a-abc" },
				"repo-b": { originalBranch: "develop", activeBranch: "ralph/b-def" },
			},
		};
		persistence.save(tmpDir, state);
		const filePath = path.join(tmpDir, ".ralph", "session.json");
		const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(content.laneBranches).toBeDefined();
		expect(content.laneBranches["repo-a"].originalBranch).toBe("main");
		expect(content.laneBranches["repo-b"].originalBranch).toBe("develop");
	});

	it("load returns stored laneBranches", () => {
		const state: SerializedLoopState = {
			...sampleState,
			laneBranches: {
				"repo-a": { originalBranch: "main", activeBranch: "ralph/a-abc" },
			},
		};
		persistence.save(tmpDir, state);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.laneBranches).toBeDefined();
		expect(loaded!.laneBranches!["repo-a"].originalBranch).toBe("main");
		expect(loaded!.laneBranches!["repo-a"].activeBranch).toBe("ralph/a-abc");
	});

	it("load handles missing laneBranches gracefully (legacy session)", () => {
		persistence.save(tmpDir, sampleState);
		const loaded = persistence.load(tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.laneBranches).toBeUndefined();
	});
});
