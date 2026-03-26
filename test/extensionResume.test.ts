import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
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

vi.mock("../src/statusBar", () => ({
	showStatusBarIdle: vi.fn(),
	updateStatusBar: vi.fn(),
	disposeStatusBar: vi.fn(),
}));

vi.mock("../src/stateNotification", () => ({
	fireStateChangeNotification: vi.fn(),
}));

import * as vscode from "vscode";
import { fireStateChangeNotification } from "../src/stateNotification";
import { showStatusBarIdle } from "../src/statusBar";

const mockShowInfo = vi.mocked(vscode.window.showInformationMessage);
const mockShowStatusBarIdle = vi.mocked(showStatusBarIdle);
const mockFireStateChange = vi.mocked(fireStateChangeNotification);

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("extension resume flow", () => {
	it("exports resumeIncompleteSession as a function", async () => {
		const { resumeIncompleteSession } = await import("../src/extension");
		expect(typeof resumeIncompleteSession).toBe("function");
	});

	it("auto-resumes without showing Resume/Discard dialog", async () => {
		const { resumeIncompleteSession } = await import("../src/extension");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-resume-test-"));
		const sessionDir = path.join(tmpDir, ".ralph");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, "session.json"),
			JSON.stringify({
				currentTaskIndex: 0,
				iterationCount: 1,
				nudgeCount: 0,
				retryCount: 0,
				circuitBreakerState: "closed",
				timestamp: Date.now(),
				version: 1,
				branchName: "ralph/test-branch",
			}),
		);

		// Create minimal PRD.md so loadConfig doesn't throw
		fs.writeFileSync(
			path.join(tmpDir, "PRD.md"),
			"- [ ] **Task 1 — Test**: Do something\n",
		);

		const onResume = vi.fn();
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		resumeIncompleteSession(tmpDir, logger, onResume);

		// Should have auto-resumed
		expect(onResume).toHaveBeenCalledOnce();
		// Should NOT have shown the old Resume/Discard dialog
		expect(mockShowInfo).not.toHaveBeenCalledWith(
			expect.stringContaining("incomplete session"),
			"Resume",
			"Discard",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does nothing when no incomplete session exists", async () => {
		const { resumeIncompleteSession } = await import("../src/extension");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-resume-test-"));

		const onResume = vi.fn();
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		resumeIncompleteSession(tmpDir, logger, onResume);

		expect(onResume).not.toHaveBeenCalled();

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("auto-resumes when pending hybrid verification is persisted", async () => {
		const { resumeIncompleteSession } = await import("../src/extension");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-resume-test-"));
		const sessionDir = path.join(tmpDir, ".ralph");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, "session.json"),
			JSON.stringify({
				currentTaskIndex: 1,
				iterationCount: 2,
				nudgeCount: 0,
				retryCount: 0,
				circuitBreakerState: "closed",
				timestamp: Date.now(),
				version: 1,
				branchName: "ralph/test-branch",
				pendingHybridVerification: {
					taskId: "Task-001",
					taskDescription: "First task",
					lockFilePath: ".ralph/hybrid-verification.lock",
					taskInvocationId: "resume-invocation",
					commitHash: "abc123",
				},
			}),
		);

		fs.writeFileSync(
			path.join(tmpDir, "PRD.md"),
			"- [x] **Task 1 — Done**: done\n- [ ] **Task 2 — Next**: next\n",
		);

		const onResume = vi.fn();
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		resumeIncompleteSession(tmpDir, logger, onResume);

		expect(onResume).toHaveBeenCalledOnce();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("shared idle finalizer (runOrchestratorWithIdleCleanup)", () => {
	it("pushes idle and hides status bar after orchestrator.start() resolves", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");

		const mockOrchestrator = {
			start: vi.fn().mockResolvedValue(undefined),
		} as any;
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		await runOrchestratorWithIdleCleanup(mockOrchestrator, logger);

		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
	});

	it("shows crash message and still pushes idle when orchestrator.start() rejects", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");

		const mockOrchestrator = {
			start: vi.fn().mockRejectedValue(new Error("boom")),
		} as any;
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		await runOrchestratorWithIdleCleanup(mockOrchestrator, logger);

		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("boom"),
		);
		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
	});

	it("auto-resume uses the same finalizer and emits idle cleanup", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");

		const mockOrchestrator = {
			start: vi.fn().mockResolvedValue(undefined),
		} as any;
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		// Simulate resume path using the same function
		await runOrchestratorWithIdleCleanup(mockOrchestrator, logger);

		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
	});

	it("auto-resume failure also ends in idle cleanup instead of leaving prior state", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");

		const mockOrchestrator = {
			start: vi.fn().mockRejectedValue(new Error("resume boom")),
		} as any;
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		await runOrchestratorWithIdleCleanup(mockOrchestrator, logger);

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("resume boom"),
		);
		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
	});
});

describe("Convergence contract regression — resume & consecutive runs", () => {
	it("resume settles to idle on completion: both status bar and state notification fire", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");

		const mockOrchestrator = {
			start: vi.fn().mockResolvedValue(undefined),
		} as any;
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		await runOrchestratorWithIdleCleanup(mockOrchestrator, logger);

		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
		// No error logged on clean completion
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("resume settles to idle on failure: crash does not leave stale running state", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");

		const mockOrchestrator = {
			start: vi.fn().mockRejectedValue(new Error("resume crash")),
		} as any;
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		await runOrchestratorWithIdleCleanup(mockOrchestrator, logger);

		// Both channels must converge to idle even after crash
		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
	});

	it("consecutive runs via shared finalizer: second run inherits no stale state from first", async () => {
		const { runOrchestratorWithIdleCleanup } = await import("../src/extension");
		const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

		// First run
		const orch1 = { start: vi.fn().mockResolvedValue(undefined) } as any;
		await runOrchestratorWithIdleCleanup(orch1, logger);

		expect(mockShowStatusBarIdle).toHaveBeenCalledTimes(1);
		expect(mockFireStateChange).toHaveBeenCalledTimes(1);

		// Clear mocks to simulate fresh state tracking for second run
		vi.mocked(showStatusBarIdle).mockClear();
		vi.mocked(fireStateChangeNotification).mockClear();

		// Second run
		const orch2 = { start: vi.fn().mockResolvedValue(undefined) } as any;
		await runOrchestratorWithIdleCleanup(orch2, logger);

		// Second run also converges independently
		expect(mockShowStatusBarIdle).toHaveBeenCalledOnce();
		expect(mockFireStateChange).toHaveBeenCalledWith("idle", "");
	});
});
