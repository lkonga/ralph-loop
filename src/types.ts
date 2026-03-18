import type * as vscode from 'vscode';

// --- Loop states ---
export const enum LoopState {
	Idle = 'idle',
	Running = 'running',
	Paused = 'paused',
}

// --- Task ---
export const enum TaskStatus {
	Pending = 'pending',
	InProgress = 'in_progress',
	Complete = 'complete',
	TimedOut = 'timed_out',
	Failed = 'failed',
	Skipped = 'skipped',
}

export interface Task {
	readonly id: number;
	readonly taskId: string;
	readonly description: string;
	status: TaskStatus;
	readonly lineNumber: number;
	readonly dependsOn?: string[];
	readonly checkpoint?: boolean;
	readonly agent?: string;
	readonly readOnly?: boolean;
	readonly noDiff?: boolean;
}

export interface PrdSnapshot {
	readonly tasks: readonly Task[];
	readonly total: number;
	readonly completed: number;
	readonly remaining: number;
}

export interface PrdValidationError {
	readonly level: 'error' | 'warning';
	readonly message: string;
	readonly line?: number;
}

export interface PrdValidationResult {
	readonly valid: boolean;
	readonly errors: readonly PrdValidationError[];
}

// --- Copilot result ---
export type CopilotMethod = 'agent' | 'chat' | 'clipboard';

// --- Loop events (async generator yields these) ---
export const enum LoopEventKind {
	TaskStarted = 'task_started',
	CopilotTriggered = 'copilot_triggered',
	WaitingForCompletion = 'waiting_for_completion',
	TaskCompleted = 'task_completed',
	TaskTimedOut = 'task_timed_out',
	TaskNudged = 'task_nudged',
	TaskRetried = 'task_retried',
	Countdown = 'countdown',
	AllDone = 'all_done',
	MaxIterations = 'max_iterations',
	IterationLimitExpanded = 'iteration_limit_expanded',
	YieldRequested = 'yield_requested',
	TasksParallelized = 'tasks_parallelized',
	SessionChanged = 'session_changed',
	CircuitBreakerTripped = 'circuit_breaker_tripped',
	DiffValidationFailed = 'diff_validation_failed',
	HumanCheckpointRequested = 'human_checkpoint_requested',
	TaskReviewed = 'task_reviewed',
	MonitorAlert = 'monitor_alert',
	TaskCommitted = 'task_committed',
	StagnationDetected = 'stagnation_detected',
	TaskDecomposed = 'task_decomposed',
	ConsistencyCheckPassed = 'consistency_check_passed',
	ConsistencyCheckFailed = 'consistency_check_failed',
	ContextInjected = 'context_injected',
	StruggleDetected = 'struggle_detected',
	CommandBlocked = 'command_blocked',
	BearingsChecked = 'bearings_checked',
	BearingsFailed = 'bearings_failed',
	PlanRegenerated = 'plan_regenerated',
	ConfidenceScored = 'confidence_scored',
	ContextHandoff = 'context_handoff',
	PrdValidationFailed = 'prd_validation_failed',
	Stopped = 'stopped',
	Error = 'error',
}

export type LoopEvent =
	| { kind: LoopEventKind.TaskStarted; task: Task; iteration: number; taskInvocationId: string }
	| { kind: LoopEventKind.CopilotTriggered; method: CopilotMethod; taskInvocationId?: string }
	| { kind: LoopEventKind.WaitingForCompletion; task: Task; taskInvocationId: string }
	| { kind: LoopEventKind.TaskCompleted; task: Task; durationMs: number; taskInvocationId: string }
	| { kind: LoopEventKind.TaskTimedOut; task: Task; durationMs: number; taskInvocationId: string }
	| { kind: LoopEventKind.TaskNudged; task: Task; nudgeCount: number; taskInvocationId: string }
	| { kind: LoopEventKind.TaskRetried; task: Task; retryCount: number; taskInvocationId: string }
	| { kind: LoopEventKind.Countdown; secondsLeft: number }
	| { kind: LoopEventKind.AllDone; total: number }
	| { kind: LoopEventKind.MaxIterations; limit: number }
	| { kind: LoopEventKind.IterationLimitExpanded; oldLimit: number; newLimit: number }
	| { kind: LoopEventKind.TasksParallelized; tasks: Task[] }
	| { kind: LoopEventKind.YieldRequested }
	| { kind: LoopEventKind.SessionChanged; oldSessionId: string; newSessionId: string }
	| { kind: LoopEventKind.CircuitBreakerTripped; breakerName: string; reason: string; action: string; taskInvocationId: string }
	| { kind: LoopEventKind.DiffValidationFailed; task: Task; nudge: string; attempt: number; taskInvocationId: string }
	| { kind: LoopEventKind.HumanCheckpointRequested; task: Task; reason: string; failCount: number; taskInvocationId: string }
	| { kind: LoopEventKind.TaskReviewed; task: Task; verdict: ReviewVerdict; taskInvocationId: string }
	| { kind: LoopEventKind.MonitorAlert; alert: string; taskId: string }
	| { kind: LoopEventKind.TaskCommitted; task: Task; commitHash: string; taskInvocationId: string }
	| { kind: LoopEventKind.StagnationDetected; task: Task; staleIterations: number; filesUnchanged: string[] }
	| { kind: LoopEventKind.TaskDecomposed; originalTask: Task; subTasks: string[] }
	| { kind: LoopEventKind.ConsistencyCheckPassed; phase: string; checks: ConsistencyCheckDetail[] }
	| { kind: LoopEventKind.ConsistencyCheckFailed; phase: string; checks: ConsistencyCheckDetail[]; failureReason?: string }
	| { kind: LoopEventKind.ContextInjected; text: string }
	| { kind: LoopEventKind.StruggleDetected; signals: string[]; taskId: string }
	| { kind: LoopEventKind.CommandBlocked; command: string; reason: string; taskId: string }
	| { kind: LoopEventKind.BearingsChecked; healthy: boolean; issues: string[] }
	| { kind: LoopEventKind.BearingsFailed; issues: string[] }
	| { kind: LoopEventKind.PlanRegenerated; taskId: string; regenerationCount: number }
	| { kind: LoopEventKind.ConfidenceScored; score: number; threshold: number; breakdown: Record<string, number>; taskId: string }
	| { kind: LoopEventKind.ContextHandoff; estimatedTokens: number; maxTokens: number; pct: number }
	| { kind: LoopEventKind.PrdValidationFailed; errors: readonly PrdValidationError[] }
	| { kind: LoopEventKind.Stopped }
	| { kind: LoopEventKind.Error; message: string };

// --- Per-task tracking ---
export interface TaskState {
	taskInvocationId: string;
	nudgeCount: number;
	retryCount: number;
	taskCompletedLatch: boolean;
}

// --- Task execution strategy ---
export interface ExecutionOptions {
	prdPath: string;
	workspaceRoot: string;
	inactivityTimeoutMs: number;
	useAutopilotMode: boolean;
	shouldStop: () => boolean;
	signal?: AbortSignal;
	agentMode?: string;
}

export interface ExecutionResult {
	completed: boolean;
	method: CopilotMethod;
	hadFileChanges: boolean;
}

export interface ITaskExecutionStrategy {
	execute(task: Task, prompt: string, options: ExecutionOptions): Promise<ExecutionResult>;
}

// --- Feature flags ---
export interface RalphFeatures {
	useHookBridge: boolean;
	useSessionTracking: boolean;
	useAutopilotMode: boolean;
	useParallelTasks: boolean;
	useLlmConsistencyCheck: boolean;
}

export const DEFAULT_FEATURES: RalphFeatures = {
	useHookBridge: false,
	useSessionTracking: false,
	useAutopilotMode: false,
	useParallelTasks: false,
	useLlmConsistencyCheck: false,
};

// --- PreComplete hook config ---
export interface PreCompleteHookConfig {
	name: string;
	type: 'builtin' | 'shell' | 'custom';
	command?: string;
	enabled: boolean;
}

export const DEFAULT_PRE_COMPLETE_HOOKS: PreCompleteHookConfig[] = [
	{ name: 'prd-checkbox-check', type: 'builtin', enabled: true },
	{ name: 'progress-updated', type: 'builtin', enabled: true },
];

// --- Review after execute config ---
export interface ReviewVerdict {
	outcome: 'approved' | 'needs-retry';
	summary: string;
	issues?: string[];
}

export interface ReviewAfterExecuteConfig {
	enabled: boolean;
	mode: 'same-session' | 'new-session';
	reviewPromptTemplate?: string;
}

export const DEFAULT_REVIEW_AFTER_EXECUTE: ReviewAfterExecuteConfig = {
	enabled: false,
	mode: 'same-session',
};

export const DEFAULT_REVIEW_PROMPT_TEMPLATE = 'Review the changes just made for the following task: [TASK]. Check for: correctness, code quality, potential bugs, security issues. Provide a structured verdict: APPROVED or NEEDS-RETRY with critical issues.';

// --- Diff validation config ---
export interface DiffValidationConfig {
	enabled: boolean;
	requireChanges: boolean;
	maxDiffLines?: number;
	generateSummary: boolean;
}

export const DEFAULT_DIFF_VALIDATION: DiffValidationConfig = {
	enabled: true,
	requireChanges: true,
	generateSummary: true,
};

export interface DiffValidationResult {
	filesChanged: string[];
	linesAdded: number;
	linesRemoved: number;
	hasDiff: boolean;
	summary: string;
	nudge?: string;
}

// --- Parallel monitor config ---
export interface ParallelMonitorConfig {
	enabled: boolean;
	intervalMs: number;
	stuckThreshold: number;
}

export const DEFAULT_PARALLEL_MONITOR: ParallelMonitorConfig = {
	enabled: false,
	intervalMs: 10000,
	stuckThreshold: 3,
};

// --- Stagnation detection config ---
export interface StagnationDetectionConfig {
	enabled: boolean;
	maxStaleIterations: number;
	hashFiles: string[];
}

export const DEFAULT_STAGNATION_DETECTION: StagnationDetectionConfig = {
	enabled: true,
	maxStaleIterations: 2,
	hashFiles: ['progress.txt', 'PRD.md'],
};

// --- PreCompact behavior ---
export interface PreCompactBehavior {
	enabled: boolean;
	summaryMaxLines: number;
	injectGitDiff: boolean;
	injectProgressSummary: boolean;
}

export const DEFAULT_PRE_COMPACT_BEHAVIOR: PreCompactBehavior = {
	enabled: true,
	summaryMaxLines: 50,
	injectGitDiff: true,
	injectProgressSummary: true,
};

// --- Auto-decompose config ---
export interface AutoDecomposeConfig {
	enabled: boolean;
	failThreshold: number;
}

export const DEFAULT_AUTO_DECOMPOSE: AutoDecomposeConfig = {
	enabled: true,
	failThreshold: 3,
};

// --- Struggle detection config ---
export interface StruggleDetectionConfig {
	enabled: boolean;
	noProgressThreshold: number;
	shortIterationThreshold: number;
	shortIterationMs: number;
	thrashingThreshold: number;
	thrashingWindowSize: number;
}

// --- Bearings (pre-flight health check) ---
export interface BearingsConfig {
	enabled: boolean;
	runTsc: boolean;
	runTests: boolean;
}

export const DEFAULT_BEARINGS_CONFIG: BearingsConfig = {
	enabled: true,
	runTsc: true,
	runTests: true,
};

export interface BearingsResult {
	healthy: boolean;
	issues: string[];
	fixTask?: string;
}

export const DEFAULT_STRUGGLE_DETECTION: StruggleDetectionConfig = {
	enabled: true,
	noProgressThreshold: 3,
	shortIterationThreshold: 3,
	shortIterationMs: 30000,
	thrashingThreshold: 3,
	thrashingWindowSize: 10,
};

// --- Context trimming config ---
export interface ContextTrimmingConfig {
	fullUntil: number;
	abbreviatedUntil: number;
}

export const DEFAULT_CONTEXT_TRIMMING: ContextTrimmingConfig = {
	fullUntil: 3,
	abbreviatedUntil: 8,
};

// --- Backpressure classification config ---
export interface BackpressureConfig {
	enabled: boolean;
	historySize: number;
}

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
	enabled: true,
	historySize: 3,
};

// --- Inactivity config ---
export interface InactivityConfig {
	timeoutMs: number;
	warningAtPct: number;
	adaptive: boolean;
}

export const DEFAULT_INACTIVITY_CONFIG: InactivityConfig = {
	timeoutMs: 120_000,
	warningAtPct: 50,
	adaptive: false,
};

// --- Context budget config ---
export interface ContextBudgetConfig {
	mode: 'annotate' | 'handoff';
	maxEstimatedTokens: number;
	warningThresholdPct: number;
	handoffThresholdPct: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
	mode: 'annotate',
	maxEstimatedTokens: 150_000,
	warningThresholdPct: 70,
	handoffThresholdPct: 90,
};

// --- Knowledge config ---
export type KnowledgeCategory = 'pattern' | 'fix' | 'context' | 'gap';

export interface KnowledgeEntry {
	content: string;
	category: KnowledgeCategory;
	timestamp: string;
	taskId: string;
	hash: string;
}

export type HarvestStageName = 'extract' | 'dedup' | 'categorize' | 'score' | 'persist';

export interface HarvestConfig {
	stages: HarvestStageName[];
}

export const DEFAULT_HARVEST_CONFIG: HarvestConfig = {
	stages: ['extract', 'dedup', 'categorize', 'persist'],
};

export interface KnowledgeConfig {
	enabled: boolean;
	path: string;
	maxInjectLines: number;
	harvest?: HarvestConfig;
}

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
	enabled: true,
	path: 'knowledge.md',
	maxInjectLines: 15,
	harvest: { ...DEFAULT_HARVEST_CONFIG },
};

// --- Knowledge GC ---
export interface GCPolicy {
	triggerEveryNRuns: number;
	maxEntries: number;
	stalenessThreshold: number;
}

export const DEFAULT_GC_POLICY: GCPolicy = {
	triggerEveryNRuns: 10,
	maxEntries: 200,
	stalenessThreshold: 20,
};

// --- Consistency checker ---
export interface ConsistencyCheckDetail {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface ConsistencyCheckInput {
	prdPath: string;
	progressPath: string;
	workspaceRoot: string;
	expectedPhase: string;
	taskDescription: string;
}

export interface ConsistencyCheckResult {
	passed: boolean;
	checks: ConsistencyCheckDetail[];
	failureReason?: string;
}

export interface IConsistencyChecker {
	runDeterministic(input: ConsistencyCheckInput): Promise<ConsistencyCheckResult>;
	runLlmVerification(input: ConsistencyCheckInput): Promise<ConsistencyCheckResult>;
}

// --- Presets ---
export type PresetName = 'general' | 'feature' | 'bugfix' | 'refactor';

export interface RalphPreset {
	name: string;
	description: string;
	overrides: Partial<RalphConfig>;
}

// --- Config ---
export interface CircuitBreakerConfig {
	name: string;
	enabled: boolean;
	[key: string]: unknown;
}

export interface RalphConfig {
	prdPath: string;
	progressPath: string;
	maxIterations: number;
	hardMaxIterations: number;
	countdownSeconds: number;
	inactivityTimeoutMs: number;
	maxNudgesPerTask: number;
	executionStrategy: 'command' | 'api';
	hookScript?: string;
	promptBlocks?: string[];
	modelHint?: string;
	features: RalphFeatures;
	useHookBridge: boolean;
	useSessionTracking: boolean;
	useAutopilotMode: boolean;
	maxParallelTasks: number;
	workspaceRoot: string;
	verifiers?: VerifierConfig[];
	verificationTemplates?: VerificationTemplate[];
	autoClassifyTasks?: boolean;
	circuitBreakers?: CircuitBreakerConfig[];
	preCompleteHooks?: PreCompleteHookConfig[];
	diffValidation?: DiffValidationConfig;
	maxDiffValidationRetries: number;
	reviewAfterExecute?: ReviewAfterExecuteConfig;
	maxConcurrencyPerStage: number;
	parallelMonitor?: ParallelMonitorConfig;
	preCompactBehavior?: PreCompactBehavior;
	stagnationDetection?: StagnationDetectionConfig;
	autoDecompose?: AutoDecomposeConfig;
	knowledge?: KnowledgeConfig;
	contextTrimming?: ContextTrimmingConfig;
	struggleDetection?: StruggleDetectionConfig;
	bearings?: BearingsConfig;
	backpressure?: BackpressureConfig;
	confidenceThreshold?: number;
	promptTemplate?: string;
	sessionPersistence?: { enabled: boolean; expireAfterMs: number };
	contextBudget?: ContextBudgetConfig;
	inactivity?: InactivityConfig;
	cooldownShowDialog?: boolean;
	agentMode?: string;
}

export const DEFAULT_CONFIG: Omit<RalphConfig, 'workspaceRoot'> = {
	prdPath: 'PRD.md',
	progressPath: 'progress.txt',
	maxIterations: 50,
	hardMaxIterations: 50,
	countdownSeconds: 12,
	inactivityTimeoutMs: 300_000,
	maxNudgesPerTask: 3,
	executionStrategy: 'command',
	hookScript: undefined,
	promptBlocks: ['safety', 'discipline'],
	modelHint: undefined,
	features: { ...DEFAULT_FEATURES },
	useHookBridge: false,
	useSessionTracking: false,
	useAutopilotMode: false,
	maxParallelTasks: 1,
	autoClassifyTasks: false,
	preCompleteHooks: [...DEFAULT_PRE_COMPLETE_HOOKS],
	diffValidation: { ...DEFAULT_DIFF_VALIDATION },
	maxDiffValidationRetries: 3,
	reviewAfterExecute: { ...DEFAULT_REVIEW_AFTER_EXECUTE },
	maxConcurrencyPerStage: 1,
	parallelMonitor: { ...DEFAULT_PARALLEL_MONITOR },
	preCompactBehavior: { ...DEFAULT_PRE_COMPACT_BEHAVIOR },
	stagnationDetection: { ...DEFAULT_STAGNATION_DETECTION },
	autoDecompose: { ...DEFAULT_AUTO_DECOMPOSE },
	knowledge: { ...DEFAULT_KNOWLEDGE_CONFIG },
	contextTrimming: { ...DEFAULT_CONTEXT_TRIMMING },
	struggleDetection: { ...DEFAULT_STRUGGLE_DETECTION },
	bearings: { ...DEFAULT_BEARINGS_CONFIG },
	backpressure: { ...DEFAULT_BACKPRESSURE_CONFIG },
	sessionPersistence: { enabled: true, expireAfterMs: 86400000 },
	contextBudget: { ...DEFAULT_CONTEXT_BUDGET },
	inactivity: { ...DEFAULT_INACTIVITY_CONFIG },
	cooldownShowDialog: true,
	agentMode: 'ralph-executor',
};

// --- Verification ---
export const enum VerifyResult {
	Pass = 'pass',
	Fail = 'fail',
	Skip = 'skip',
}

export interface VerifyCheck {
	readonly name: string;
	readonly result: VerifyResult;
	readonly detail?: string;
}

export type VerifierFn = (task: Task, workspaceRoot: string, args?: Record<string, string>) => Promise<VerifyCheck>;

export interface VerifierConfig {
	type: string;
	args?: Record<string, string>;
	stages?: string[];
}

export interface VerificationTemplate {
	name: string;
	verifiers: VerifierConfig[];
}

// --- Hook system ---
export type RalphHookType = 'SessionStart' | 'PreCompact' | 'PostToolUse' | 'PreComplete' | 'TaskComplete';

export interface SessionStartInput {
	prdPath: string;
}

export interface PreCompactInput {
	tokenCount: number;
	taskId: string;
}

export interface PostToolUseInput {
	toolName: string;
	taskId: string;
	taskInvocationId?: string;
}

export interface TaskCompleteInput {
	taskId: string;
	result: 'success' | 'failure';
	taskInvocationId?: string;
}

// --- Chat send request (extension command: ralph-loop.chatSend) ---
export interface ChatSendRequest {
	query: string;
	mode?: 'agent' | 'ask' | 'edit';
	isPartialQuery?: boolean;
	sessionId?: string;
}

export interface HookResult {
	action: 'continue' | 'retry' | 'skip' | 'stop';
	reason?: string;
	additionalContext?: string;
	chatSend?: ChatSendRequest;
	blocked?: boolean;
}

export interface PreCompleteInput {
	taskId: string;
	taskInvocationId: string;
	checksRun: VerifyCheck[];
	prdPath: string;
	previousResults?: PreCompleteHookResult[];
}

export interface PreCompleteHookResult extends HookResult {
	hookName: string;
}

export interface IRalphHookService {
	onSessionStart(input: SessionStartInput): Promise<HookResult>;
	onPreCompact(input: PreCompactInput): Promise<HookResult>;
	onPostToolUse(input: PostToolUseInput): Promise<HookResult>;
	onPreComplete(input: PreCompleteInput): Promise<HookResult>;
	onTaskComplete(input: TaskCompleteInput): Promise<HookResult>;
}

// --- Logger interface ---
export interface ILogger {
	log(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

function timestamp(): string {
	return new Date().toISOString().slice(11, 23);
}

// VS Code LogOutputChannel logger — provides colored, timestamped output
export function createOutputLogger(channel: vscode.LogOutputChannel): ILogger {
	return {
		log: (msg: string) => channel.info(`${msg}`),
		warn: (msg: string) => channel.warn(`${msg}`),
		error: (msg: string) => channel.error(`${msg}`),
	};
}

// Console logger for CLI with ANSI colors
export function createConsoleLogger(): ILogger {
	const reset = '\x1b[0m';
	const cyan = '\x1b[36m';
	const yellow = '\x1b[33m';
	const red = '\x1b[31m';
	const dim = '\x1b[2m';
	return {
		log: (msg: string) => console.log(`${dim}${timestamp()}${reset} ${cyan}[ralph]${reset} ${msg}`),
		warn: (msg: string) => console.warn(`${dim}${timestamp()}${reset} ${yellow}[ralph WARN]${reset} ${msg}`),
		error: (msg: string) => console.error(`${dim}${timestamp()}${reset} ${red}[ralph ERROR]${reset} ${msg}`),
	};
}

// --- Research/Spec frontmatter ---
export interface ResearchFrontmatter {
	type: 'research';
	id: number;
	phase?: number;
	date?: string;
	sources?: string[];
	methodology?: string;
	derived_specs?: number[];
	tags?: string[];
}

export interface SpecFrontmatter {
	type: 'spec';
	id: number;
	phase: number;
	tasks: number[];
	research?: number;
	principles?: string[];
	verification?: string[];
	completion_steps?: string[];
}

export interface StalePointer {
	file: string;
	line: number;
	reason: 'file_missing' | 'line_range_out_of_bounds';
	startLine?: number;
	endLine?: number;
}
