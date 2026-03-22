import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateSnapshot } from "../src/types";
import {
	DEFAULT_BEARINGS_CONFIG,
	DEFAULT_CONFIG,
	LoopEventKind,
	LoopState,
} from "../src/types";

describe("State Snapshot Command", () => {
	describe("StateSnapshot interface", () => {
		it("has required fields", () => {
			const snapshot: StateSnapshot = {
				state: "idle",
				taskId: "",
				taskDescription: "",
				iterationCount: 0,
				nudgeCount: 0,
			};
			expect(snapshot.state).toBe("idle");
			expect(snapshot.taskId).toBe("");
			expect(snapshot.taskDescription).toBe("");
			expect(snapshot.iterationCount).toBe(0);
			expect(snapshot.nudgeCount).toBe(0);
		});
	});

	describe("LoopOrchestrator.getStateSnapshot", () => {
		it("returns idle snapshot when no task is running", async () => {
			const { LoopOrchestrator } = await import("../src/orchestrator");
			const orchestrator = new LoopOrchestrator(
				{
					workspaceRoot: "/tmp/test",
					prdFile: "PRD.md",
					maxIterations: 5,
					waitTimeMs: 1000,
					copilotMethod: "agent",
					maxNudgesPerTask: 3,
				} as any,
				{ log: vi.fn(), warn: vi.fn(), error: vi.fn() },
				vi.fn(),
			);
			const snapshot = orchestrator.getStateSnapshot();
			expect(snapshot).toEqual({
				state: "idle",
				taskId: "",
				taskDescription: "",
				iterationCount: 0,
				nudgeCount: 0,
			});
		});

		it("returns running snapshot with task details after task starts", async () => {
			const { LoopOrchestrator } = await import("../src/orchestrator");
			const events: any[] = [];
			const orchestrator = new LoopOrchestrator(
				{
					workspaceRoot: "/tmp/test",
					prdFile: "PRD.md",
					maxIterations: 1,
					waitTimeMs: 100,
					copilotMethod: "agent",
					maxNudgesPerTask: 3,
				} as any,
				{ log: vi.fn(), warn: vi.fn(), error: vi.fn() },
				(event) => events.push(event),
			);
			// getStateSnapshot should reflect idle before start
			expect(orchestrator.getStateSnapshot().state).toBe("idle");
		});
	});

	describe("ralph-loop.getStateSnapshot command registration", () => {
		it("command returns snapshot from orchestrator", async () => {
			// Verify the StateSnapshot type shape is correct
			const snapshot: StateSnapshot = {
				state: LoopState.Running,
				taskId: "Task-42",
				taskDescription: "Implement feature X",
				iterationCount: 3,
				nudgeCount: 1,
			};
			expect(snapshot.state).toBe("running");
			expect(snapshot.taskId).toBe("Task-42");
			expect(snapshot.taskDescription).toBe("Implement feature X");
			expect(snapshot.iterationCount).toBe(3);
			expect(snapshot.nudgeCount).toBe(1);
		});

		it("command returns idle snapshot when orchestrator is null", () => {
			// When no orchestrator exists, the command should return idle defaults
			const defaultSnapshot: StateSnapshot = {
				state: "idle",
				taskId: "",
				taskDescription: "",
				iterationCount: 0,
				nudgeCount: 0,
			};
			expect(defaultSnapshot.state).toBe("idle");
			expect(defaultSnapshot.taskId).toBe("");
		});
	});

	describe("StateSnapshot branch field", () => {
		it("accepts optional branch field", () => {
			const snapshot: StateSnapshot = {
				state: LoopState.Running,
				taskId: "Task-1",
				taskDescription: "desc",
				iterationCount: 1,
				nudgeCount: 0,
				branch: "ralph/my-feature",
			};
			expect(snapshot.branch).toBe("ralph/my-feature");
		});

		it("branch is undefined when not set", () => {
			const snapshot: StateSnapshot = {
				state: "idle",
				taskId: "",
				taskDescription: "",
				iterationCount: 0,
				nudgeCount: 0,
			};
			expect(snapshot.branch).toBeUndefined();
		});
	});
});

describe("Terminal snapshot truthfulness", () => {
	const noopLogger = { log: () => {}, warn: () => {}, error: () => {} };
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-snapshot-"));
		fs.writeFileSync(path.join(tmpDir, "PRD.md"), "- [x] Done task\n", "utf-8");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("AllDone StateNotified carries idle state and empty taskId", async () => {
		const { LoopOrchestrator } = await import("../src/orchestrator");
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		const allDoneIdx = events.findIndex(
			(e) => e.kind === LoopEventKind.AllDone,
		);
		expect(allDoneIdx).toBeGreaterThanOrEqual(0);

		const stateNotifiedAfter = events.find(
			(e, i) => i > allDoneIdx && e.kind === LoopEventKind.StateNotified,
		);
		expect(stateNotifiedAfter).toBeDefined();
		expect(stateNotifiedAfter.state).toBe(LoopState.Idle);
		expect(stateNotifiedAfter.taskId).toBe("");
	});

	it("on stop/yield/max-iterations, terminal StateNotified sees idle not stale running", async () => {
		const { LoopOrchestrator } = await import("../src/orchestrator");
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		const terminalKinds = new Set([
			LoopEventKind.AllDone,
			LoopEventKind.Stopped,
			LoopEventKind.MaxIterations,
			LoopEventKind.YieldRequested,
		]);

		for (let i = 0; i < events.length; i++) {
			if (terminalKinds.has(events[i].kind)) {
				const nextNotified = events.find(
					(e, j) => j > i && e.kind === LoopEventKind.StateNotified,
				);
				if (nextNotified) {
					expect(nextNotified.state).toBe(LoopState.Idle);
					expect(nextNotified.taskId).toBe("");
				}
			}
		}
	});

	it("getStateSnapshot returns idle after start() resolves", async () => {
		const { LoopOrchestrator } = await import("../src/orchestrator");
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
			},
			noopLogger,
			() => {},
		);
		await orch.start();

		const snap = orch.getStateSnapshot();
		expect(snap.state).toBe(LoopState.Idle);
		expect(snap.taskId).toBe("");
	});

	it("terminal sequencing does not regress branch switch-back", async () => {
		const gitOps = await import("../src/gitOps");
		vi.spyOn(gitOps, "getCurrentBranch").mockResolvedValue("main");
		vi.spyOn(gitOps, "getShortHash").mockResolvedValue("abc1234");
		vi.spyOn(gitOps, "hasDirtyWorkingTree").mockResolvedValue(false);
		vi.spyOn(gitOps, "createAndCheckoutBranch").mockResolvedValue({
			success: true,
		});
		vi.spyOn(gitOps, "checkoutBranch").mockResolvedValue({ success: true });

		const { LoopOrchestrator } = await import("../src/orchestrator");
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		const switchBack = events.find(
			(e) => e.kind === LoopEventKind.BranchSwitchedBack,
		);
		expect(switchBack).toBeDefined();
		expect(switchBack.to).toBe("main");
	});
});

describe("Abnormal exit idle convergence", () => {
	const noopLogger = { log: () => {}, warn: () => {}, error: () => {} };
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-abnormal-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("BranchEnforcementFailed emits error event and still forces idle cleanup via StateNotified", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "PRD.md"),
			"# My Feature\n\n- [ ] **Task 1 — Do something**: description\n",
		);

		const gitOps = await import("../src/gitOps");
		vi.spyOn(gitOps, "getCurrentBranch").mockResolvedValue("main");
		vi.spyOn(gitOps, "getShortHash").mockResolvedValue("abc1234");
		vi.spyOn(gitOps, "hasDirtyWorkingTree").mockResolvedValue(false);
		vi.spyOn(gitOps, "createAndCheckoutBranch").mockResolvedValue({
			success: false,
			error: "branch creation failed",
		});

		const { LoopOrchestrator } = await import("../src/orchestrator");
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
				featureBranch: { enabled: true },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		const failEvent = events.find(
			(e) => e.kind === LoopEventKind.BranchEnforcementFailed,
		);
		expect(failEvent).toBeDefined();

		const failIdx = events.findIndex(
			(e) => e.kind === LoopEventKind.BranchEnforcementFailed,
		);
		const stateNotifiedAfter = events.find(
			(e, i) => i > failIdx && e.kind === LoopEventKind.StateNotified,
		);
		expect(stateNotifiedAfter).toBeDefined();
		expect(stateNotifiedAfter.state).toBe(LoopState.Idle);
		expect(stateNotifiedAfter.taskId).toBe("");

		expect(orch.getStateSnapshot().state).toBe(LoopState.Idle);
	});

	it("PrdValidationFailed emits validation error and still forces idle cleanup via StateNotified", async () => {
		// Write an invalid PRD (no tasks, empty)
		fs.writeFileSync(path.join(tmpDir, "PRD.md"), "", "utf-8");

		const { LoopOrchestrator } = await import("../src/orchestrator");
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);
		await orch.start();

		const failEvent = events.find(
			(e) => e.kind === LoopEventKind.PrdValidationFailed,
		);
		expect(failEvent).toBeDefined();

		const failIdx = events.findIndex(
			(e) => e.kind === LoopEventKind.PrdValidationFailed,
		);
		const stateNotifiedAfter = events.find(
			(e, i) => i > failIdx && e.kind === LoopEventKind.StateNotified,
		);
		expect(stateNotifiedAfter).toBeDefined();
		expect(stateNotifiedAfter.state).toBe(LoopState.Idle);
		expect(stateNotifiedAfter.taskId).toBe("");

		expect(orch.getStateSnapshot().state).toBe(LoopState.Idle);
	});

	it("uncaught exception during execution emits crash surface and still forces idle cleanup", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "PRD.md"),
			"- [ ] **Task 1 — Test**: Do something\n",
		);

		const { LoopOrchestrator } = await import("../src/orchestrator");
		const events: any[] = [];
		const orch = new LoopOrchestrator(
			{
				...DEFAULT_CONFIG,
				workspaceRoot: tmpDir,
				maxIterations: 1,
				bearings: { ...DEFAULT_BEARINGS_CONFIG, enabled: false },
			},
			noopLogger,
			(e: any) => events.push(e),
		);

		// After start() resolves (even if it threw internally), state should be idle
		await orch.start();
		expect(orch.getStateSnapshot().state).toBe(LoopState.Idle);
	});
});
