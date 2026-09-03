import { INBOX_MAX_TITLE_CHARS } from '../inbox/inbox.types.js';
import type { TaskAcceptanceCheck, TaskCheckResult } from '../tasks/task-gates.types.js';
import type { FleetTaskWorkspaceDescriptor, FleetTaskWorkspaceSpec } from './fleet-task-workspace.types.js';

/**
 * Fleet job lease protocol — the wire shapes an enrolled node and the
 * platform exchange so work can actually EXECUTE on a fleet machine.
 *
 * Before this contract, a machine could enroll, heartbeat and appear in
 * the Fleet settings page, and nothing could ever be scheduled onto it.
 * `job-runtime-node` turns that inventory into capacity: its "queue" is
 * the fleet itself — enqueue writes a lease-able row, nodes poll for
 * work, and results come back over the same outbound-only HTTP channel
 * enrollment and heartbeat already use.
 *
 * This package is the zero-dependency storage/wire shape ONLY. The
 * state machine is enforced server-side (`FleetJobService` in
 * `@ever-works/agent/fleet`); the pure predicates below exist so the
 * server, the plugin and the node agree on one definition of "leasable"
 * and "terminal" instead of three.
 *
 * ## Lifecycle
 *
 * ```
 *   queued ──lease──▶ leased ──ack──▶ running ──complete──▶ done
 *      ▲                 │               │                └▶ failed
 *      └── lease expiry ─┴───────────────┘   (attempts < maxAttempts)
 * ```
 *
 * A lease is a time-boxed claim, never a lock: if a node dies mid-job,
 * `leaseExpiresAt` passes and the sweeper returns the row to `queued`
 * (or fails it once `attempts` is exhausted). Nothing depends on the
 * node being reachable to release its claim — the only durable fact is
 * the row.
 *
 * ## Security posture
 *
 * Every node-facing endpoint authenticates with the SAME node secret
 * minted at enrollment (`POST /api/fleet/enroll`), verified with a
 * constant-time compare against the stored sha256 and failing closed to
 * one undifferentiated 401. There is no second credential concept and
 * no inbound port on the node.
 */

/**
 * Lifecycle state of one fleet job row.
 *
 * - `queued`  — eligible for lease by any capability-matching node.
 * - `leased`  — claimed by a node; the claim expires at `leaseExpiresAt`.
 * - `running` — the node acknowledged the claim and started executing
 *               (first job heartbeat). Distinct from `leased` so a node
 *               that leases and dies before starting is visibly
 *               different from one that died mid-execution.
 * - `done`    — terminal, succeeded.
 * - `failed`  — terminal, failed (or out of attempts).
 */
export type FleetJobStatus = 'queued' | 'leased' | 'running' | 'done' | 'failed';

/** Canonical status list — one source of truth for validators and UI. */
export const FLEET_JOB_STATUSES: readonly FleetJobStatus[] = ['queued', 'leased', 'running', 'done', 'failed'];

/** Statuses a node currently holds a claim on (drives "busy" in Fleet). */
export const FLEET_JOB_ACTIVE_STATUSES: readonly FleetJobStatus[] = ['leased', 'running'];

/** Statuses no further transition can leave. */
export const FLEET_JOB_TERMINAL_STATUSES: readonly FleetJobStatus[] = ['done', 'failed'];

/** True when the job has reached a state nothing can transition out of. */
export function isFleetJobTerminal(status: FleetJobStatus): boolean {
	return FLEET_JOB_TERMINAL_STATUSES.includes(status);
}

/** True when a node currently holds a (possibly expired) claim. */
export function isFleetJobActive(status: FleetJobStatus): boolean {
	return FLEET_JOB_ACTIVE_STATUSES.includes(status);
}

/**
 * What a job asks the node to do. Deliberately a string union rather
 * than an open string so an unknown kind is refused at the edge instead
 * of being leased by a node that cannot run it.
 *
 * `acceptance-checks` is the v1 executor: run the Task's dispatch-frozen
 * acceptance checks in a workspace directory and report each exit code.
 * It is self-contained (a command and an exit code), needs no model
 * access or platform credentials on the node, and its verdict rules are
 * already specified by `TaskAcceptanceCheck` / `TaskCheckResult`.
 *
 * `agent-task` is the general one: "execute this platform Task's run on
 * the node". It is what makes an enrolled machine capacity for ORDINARY
 * work rather than for the gate alone — the agent-run dispatch path
 * enqueues it whenever the resolved job runtime for the owner is the
 * fleet. Its payload carries the platform ids plus the ordered commands
 * the node is asked to run, because a fleet node has no model access and
 * no platform credentials: everything it executes has to be expressed as
 * a command and an exit code, exactly like `acceptance-checks`.
 *
 * `browser-check` is the v2 executor: drive a REAL browser binary on the
 * node against a URL and report what it rendered. It exists so the
 * `browser` capability tag a node advertises is backed by work the node
 * can actually perform — a capability nothing ever exercises is a lie
 * the scheduler will eventually act on.
 */
export type FleetJobKind = 'acceptance-checks' | 'agent-task' | 'browser-check';

/** Canonical job-kind list. */
export const FLEET_JOB_KINDS: readonly FleetJobKind[] = ['acceptance-checks', 'agent-task', 'browser-check'];

/**
 * Capability tag a node must advertise to be eligible for
 * `browser-check`. Named here (not in the node) so the enqueue side and
 * the detector cannot drift.
 */
export const FLEET_BROWSER_CAPABILITY = 'browser';

/** Capability tag advertised when a usable GPU was detected on the node. */
export const FLEET_GPU_CAPABILITY = 'gpu';

/** Type guard for a job kind arriving off the wire. */
export function isFleetJobKind(value: unknown): value is FleetJobKind {
	return typeof value === 'string' && (FLEET_JOB_KINDS as readonly string[]).includes(value);
}

/**
 * Default lease TTL. Long enough that a slow build does not lose its
 * claim between job heartbeats, short enough that a dead node's work is
 * reclaimed within a coffee break.
 */
export const FLEET_JOB_DEFAULT_LEASE_TTL_SEC = 300;

/** Floor/ceiling clamps applied to any caller-supplied lease TTL. */
export const FLEET_JOB_MIN_LEASE_TTL_SEC = 30;
export const FLEET_JOB_MAX_LEASE_TTL_SEC = 3600;

/** Default attempt budget before a repeatedly-expiring job is failed. */
export const FLEET_JOB_DEFAULT_MAX_ATTEMPTS = 3;

/** Hard ceiling on the attempt budget. */
export const FLEET_JOB_MAX_ATTEMPTS_CEILING = 10;

/** Most jobs one `lease` call may hand out. */
export const FLEET_JOB_MAX_LEASE_BATCH = 5;

/** Caps mirrored by the API DTOs so an oversized payload never lands. */
export const FLEET_JOB_MAX_PAYLOAD_BYTES = 256 * 1024;
export const FLEET_JOB_MAX_RESULT_BYTES = 256 * 1024;
export const FLEET_JOB_MAX_ERROR_LENGTH = 4096;
export const FLEET_JOB_MAX_REQUIRED_CAPABILITIES = 8;

/**
 * Clamp a caller-supplied lease TTL into the supported range. A missing
 * or nonsense value falls back to the default rather than throwing —
 * enqueue must never fail because of a sizing hint.
 */
export function clampLeaseTtlSec(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return FLEET_JOB_DEFAULT_LEASE_TTL_SEC;
	}
	return Math.min(Math.max(Math.round(value), FLEET_JOB_MIN_LEASE_TTL_SEC), FLEET_JOB_MAX_LEASE_TTL_SEC);
}

/** Clamp a caller-supplied attempt budget into the supported range. */
export function clampMaxAttempts(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return FLEET_JOB_DEFAULT_MAX_ATTEMPTS;
	}
	return Math.min(Math.max(Math.round(value), 1), FLEET_JOB_MAX_ATTEMPTS_CEILING);
}

/**
 * Capability-tag filter: a node may only lease a job whose every
 * required tag is present in the node's own advertised capability set.
 *
 * Fail-closed by construction — an unknown/absent node capability list
 * is an empty set, which matches only jobs that require nothing.
 */
export function nodeSatisfiesCapabilities(
	nodeCapabilities: readonly string[] | null | undefined,
	requiredCapabilities: readonly string[] | null | undefined
): boolean {
	const required = Array.isArray(requiredCapabilities) ? requiredCapabilities : [];
	if (required.length === 0) {
		return true;
	}
	const available = new Set(Array.isArray(nodeCapabilities) ? nodeCapabilities : []);
	return required.every((tag) => available.has(tag));
}

/** Wire view of one fleet job (never carries credentials). */
export interface FleetJobView {
	id: string;
	kind: FleetJobKind;
	status: FleetJobStatus;
	/** Node currently holding (or last holding) the claim. */
	nodeId: string | null;
	/** Node selected at enqueue time, or null when the job is unbound. */
	targetNodeId?: string | null;
	/** Capability tags a node must advertise to be eligible. */
	requiredCapabilities: string[];
	/** Executor input. Shape is per-kind; see `FleetAcceptanceChecksPayload`. */
	payload: Record<string, unknown> | null;
	/** ISO timestamp the current claim expires at, if any. */
	leaseExpiresAt: string | null;
	attempts: number;
	maxAttempts: number;
	createdAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	/**
	 * Why a `queued` job has not started — today only
	 * `waiting-for-runner` (see `QUEUED_REASON_WAITING_FOR_RUNNER`),
	 * stamped at enqueue when no runner could take the job and cleared
	 * by the lease CAS. Null on every other status by construction.
	 *
	 * Optional on the wire so an older API build that does not send it
	 * still satisfies this type on a newer client.
	 */
	queuedReason?: string | null;
	/**
	 * ISO timestamp of an operator cancel request on an ACTIVE job. The
	 * node learns of it through its next job heartbeat being refused
	 * (the same "lease lost" path a dead server produces), aborts, and
	 * reports; the row then settles `failed`. Null / absent otherwise.
	 */
	cancelRequestedAt?: string | null;
}

/** Owner-safe view of one active-Organization Agent-to-node binding. */
export interface FleetAgentNodeAffinityView {
	agentId: string;
	nodeId: string;
	organizationId: string;
	createdAt: string | null;
	updatedAt: string | null;
}

/**
 * Executor input for `acceptance-checks`.
 *
 * `checks` is the dispatch-frozen check set (`TaskAcceptanceCheck[]`)
 * carried verbatim; `workspacePath` is a path ON THE NODE. The node
 * refuses a job whose workspace does not resolve to an existing
 * directory rather than inventing one — a check that runs in the wrong
 * place is worse than a job that fails fast.
 */
export interface FleetAcceptanceChecksPayload {
	/** Optional platform Task the checks belong to (reporting only). */
	taskId?: string;
	/** Optional platform run the checks belong to (reporting only). */
	runId?: string;
	/** Directory on the node the check commands run in. */
	workspacePath: string;
	/** The dispatch-frozen `TaskAcceptanceCheck[]`, carried verbatim. */
	checks: unknown[];
}

/** Upper bound on how many command steps one `agent-task` job may carry. */
export const FLEET_AGENT_TASK_MAX_STEPS = 16;

/**
 * One command the node runs for an `agent-task` job. Deliberately the
 * same shape as a `TaskAcceptanceCheck` so the node executes both kinds
 * through ONE command runner (same env scrub, same timeout policy, same
 * exit-code semantics) instead of growing a second, subtly-different one.
 */
export interface FleetAgentTaskStep {
	/** Stable id echoed back in the result so a caller can correlate. */
	id: string;
	/** Shell command, run in `workspacePath` (or `cwd` beneath it). */
	command: string;
	/** Directory relative to the job's `workspacePath`. */
	cwd?: string;
	/** Wall-clock budget; the node clamps it to its own ceiling. */
	timeoutSec?: number;
	/** `false` means a nonzero exit does not fail the job. Default true. */
	required?: boolean;
	/** Extra env names this step may see; never platform-owned ones. */
	envPassthrough?: string[];
}

/**
 * Executor input for `agent-task`.
 *
 * `taskId` / `runId` are the platform identities the node reports
 * against — they are carried so the result can be correlated back to an
 * `AgentRun` without the node ever holding a platform credential.
 *
 * `steps` is REQUIRED to be non-empty for the job to do anything: a
 * fleet node cannot run a model-driven agent loop, so the platform has
 * to hand it commands. A job that arrives with no steps is failed by the
 * node naming the operator knob that would have supplied them, rather
 * than silently succeeding at nothing.
 */
export interface FleetAgentTaskPayload {
	/** Platform Task this run belongs to. */
	taskId: string;
	/** Platform `AgentRun` id the node's result correlates to. */
	runId?: string;
	/** Agent the run was dispatched for. */
	agentId?: string;
	/** Owner the run was dispatched for (reporting only). */
	userId?: string;
	/**
	 * Directory ON THE NODE the steps run in. Optional: unlike
	 * `acceptance-checks` (whose workspace is the checked-out Task
	 * worktree) an agent task may legitimately run wherever the node
	 * service was installed. When present it must be absolute and exist.
	 */
	workspacePath?: string;
	/**
	 * Repository metadata for a node-provisioned isolated task worktree.
	 * `null` is the legacy wire representation of an absent field and falls
	 * back to `workspacePath` (or the node default) exactly like omission.
	 */
	workspace?: FleetTaskWorkspaceSpec | null;
	/** Ordered commands the node executes for this run. */
	steps?: FleetAgentTaskStep[];
	/**
	 * Model-CLI execution (agent execution v2). When present the node runs
	 * a local agent CLI (Claude Code / Codex) in the provisioned workspace
	 * with `instructions` on stdin, BEFORE any `steps`. `null` is the
	 * legacy wire representation of an absent field.
	 */
	execution?: FleetAgentModelExecution | null;
	/**
	 * Dispatch-frozen acceptance checks, run in the workspace AFTER the
	 * model (and after `steps`). Same shape the cloud gate runner grades,
	 * so the reported verdict is comparable with a cloud run's.
	 */
	acceptanceChecks?: TaskAcceptanceCheck[] | null;
	/**
	 * What the node does with the working tree once the model is done.
	 * Absent = commit + push when a repository workspace was provisioned
	 * (the platform opens the pull request from the pushed branch).
	 */
	git?: FleetAgentTaskGitPolicy | null;
}

// ─── Agent execution v2 — model CLIs on the node ─────────────────────

/** Local model CLIs a fleet node knows how to drive for an `agent-task`. */
export type FleetAgentExecutionProvider = 'claude-code' | 'codex';

export const FLEET_AGENT_EXECUTION_PROVIDERS: readonly FleetAgentExecutionProvider[] = ['claude-code', 'codex'];

export const DEFAULT_FLEET_AGENT_EXECUTION_PROVIDER: FleetAgentExecutionProvider = 'claude-code';

export function isFleetAgentExecutionProvider(value: unknown): value is FleetAgentExecutionProvider {
	return typeof value === 'string' && (FLEET_AGENT_EXECUTION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * How a tenant's fleet executes an `agent-task`:
 *
 *   - `command`   — the legacy path: the node runs the operator's
 *                   `FLEET_NODE_AGENT_TASK_COMMAND` template. Kept as the
 *                   default so every existing install behaves exactly as
 *                   it did before this mode existed.
 *   - `model-cli` — the platform assembles the agent's instructions and
 *                   the node runs a local model CLI on them in an isolated
 *                   worktree, then grades the acceptance checks and pushes
 *                   the task branch.
 */
export type FleetAgentExecutionMode = 'command' | 'model-cli';

export const FLEET_AGENT_EXECUTION_MODES: readonly FleetAgentExecutionMode[] = ['command', 'model-cli'];

export const DEFAULT_FLEET_AGENT_EXECUTION_MODE: FleetAgentExecutionMode = 'command';

export function isFleetAgentExecutionMode(value: unknown): value is FleetAgentExecutionMode {
	return typeof value === 'string' && (FLEET_AGENT_EXECUTION_MODES as readonly string[]).includes(value);
}

/** Claude Code `--effort` levels. Ignored by CLIs that have no such knob. */
export type FleetAgentExecutionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const FLEET_AGENT_EXECUTION_EFFORTS: readonly FleetAgentExecutionEffort[] = [
	'low',
	'medium',
	'high',
	'xhigh',
	'max'
];

export function isFleetAgentExecutionEffort(value: unknown): value is FleetAgentExecutionEffort {
	return typeof value === 'string' && (FLEET_AGENT_EXECUTION_EFFORTS as readonly string[]).includes(value);
}

/**
 * What the CLI may do without asking. Named after Claude Code's
 * `--permission-mode`; the node maps it onto Codex's sandbox policy
 * (`acceptEdits` → `workspace-write`, `plan` → `read-only`).
 */
export type FleetAgentExecutionPermissionMode = 'acceptEdits' | 'dontAsk' | 'plan' | 'default';

export const FLEET_AGENT_EXECUTION_PERMISSION_MODES: readonly FleetAgentExecutionPermissionMode[] = [
	'acceptEdits',
	'dontAsk',
	'plan',
	'default'
];

export const DEFAULT_FLEET_AGENT_EXECUTION_PERMISSION_MODE: FleetAgentExecutionPermissionMode = 'acceptEdits';

export function isFleetAgentExecutionPermissionMode(value: unknown): value is FleetAgentExecutionPermissionMode {
	return typeof value === 'string' && (FLEET_AGENT_EXECUTION_PERMISSION_MODES as readonly string[]).includes(value);
}

/** Wall-clock budget for one model-CLI run when the job names none. */
export const FLEET_AGENT_EXECUTION_DEFAULT_TIMEOUT_SEC = 1200;

/** Floor / ceiling for a model-CLI run. The ceiling matches the node's per-step cap. */
export const FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC = 60;
export const FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC = 1800;

/** Instructions ride inside the job payload, which is itself capped at 256 KB. */
export const FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES = 160 * 1024;

/** Hard ceiling on a per-run dollar budget handed to the CLI. */
export const FLEET_AGENT_EXECUTION_MAX_BUDGET_USD = 500;

/**
 * Model ids are placed on a command line by the node, so anything that
 * is not an opaque identifier is refused rather than escaped.
 */
export const FLEET_AGENT_EXECUTION_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * Executor input for the model-CLI half of an `agent-task`.
 *
 * `instructions` is the ONLY free-form field and it never touches argv:
 * the node writes it to a file and feeds it to the CLI on stdin. Every
 * other field is an enum, a bounded number, or an id validated against
 * {@link FLEET_AGENT_EXECUTION_MODEL_PATTERN} — see
 * {@link normalizeFleetAgentModelExecution}.
 */
export interface FleetAgentModelExecution {
	provider: FleetAgentExecutionProvider;
	/** Full prompt for the CLI (system + task body), UTF-8. */
	instructions: string;
	/** Provider model id, e.g. `claude-opus-5`. Absent = the CLI's default. */
	model?: string;
	effort?: FleetAgentExecutionEffort;
	permissionMode?: FleetAgentExecutionPermissionMode;
	/**
	 * Tenant-authorised escape hatch: `--dangerously-skip-permissions` /
	 * `--dangerously-bypass-approvals-and-sandbox`. Recorded on the job
	 * so a node can refuse what the tenant did not authorise.
	 */
	skipPermissions?: boolean;
	/** Wall-clock budget; the node clamps it to its own ceiling. */
	timeoutSec?: number;
	/** Dollar cap handed to the CLI (Claude Code `--max-budget-usd`). */
	maxBudgetUsd?: number;
	/**
	 * Env var NAMES the CLI may read from the node's own environment
	 * (its credential), same semantics as `FleetAgentTaskStep.envPassthrough`.
	 */
	envPassthrough?: string[];
}

/** What the node does with the working tree after the model ran. */
export interface FleetAgentTaskGitPolicy {
	/** Stage + commit whatever the run left behind. Default true. */
	commit?: boolean;
	/** Push the task branch to the remote. Default true. */
	push?: boolean;
	/** Commit subject; the node supplies a default naming the Task. */
	commitMessage?: string;
}

export class FleetAgentExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FleetAgentExecutionError';
	}
}

/**
 * Validate a model-CLI execution block arriving off the wire.
 *
 * REFUSES rather than coerces: a job the node cannot honour exactly as
 * written must fail naming the field, because a silently-adjusted
 * budget or model is a verdict the operator never asked for.
 */
export function normalizeFleetAgentModelExecution(raw: unknown): FleetAgentModelExecution {
	if (!raw || typeof raw !== 'object') {
		throw new FleetAgentExecutionError('Fleet agent execution block is missing');
	}
	const input = raw as Record<string, unknown>;
	if (!isFleetAgentExecutionProvider(input.provider)) {
		throw new FleetAgentExecutionError(
			`Fleet agent execution provider must be one of ${FLEET_AGENT_EXECUTION_PROVIDERS.join(', ')}`
		);
	}
	const instructions = typeof input.instructions === 'string' ? input.instructions : '';
	if (!instructions.trim()) {
		throw new FleetAgentExecutionError('Fleet agent execution instructions must not be empty');
	}
	if (byteLength(instructions) > FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES) {
		throw new FleetAgentExecutionError(
			`Fleet agent execution instructions exceed ${FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES} bytes`
		);
	}
	const out: FleetAgentModelExecution = { provider: input.provider, instructions };

	if (input.model !== undefined && input.model !== null) {
		if (typeof input.model !== 'string' || !FLEET_AGENT_EXECUTION_MODEL_PATTERN.test(input.model)) {
			throw new FleetAgentExecutionError('Fleet agent execution model id is not an opaque identifier');
		}
		out.model = input.model;
	}
	if (input.effort !== undefined && input.effort !== null) {
		if (!isFleetAgentExecutionEffort(input.effort)) {
			throw new FleetAgentExecutionError(
				`Fleet agent execution effort must be one of ${FLEET_AGENT_EXECUTION_EFFORTS.join(', ')}`
			);
		}
		out.effort = input.effort;
	}
	if (input.permissionMode !== undefined && input.permissionMode !== null) {
		if (!isFleetAgentExecutionPermissionMode(input.permissionMode)) {
			throw new FleetAgentExecutionError(
				`Fleet agent execution permissionMode must be one of ${FLEET_AGENT_EXECUTION_PERMISSION_MODES.join(', ')}`
			);
		}
		out.permissionMode = input.permissionMode;
	}
	if (input.skipPermissions !== undefined && input.skipPermissions !== null) {
		if (typeof input.skipPermissions !== 'boolean') {
			throw new FleetAgentExecutionError('Fleet agent execution skipPermissions must be a boolean');
		}
		out.skipPermissions = input.skipPermissions;
	}
	if (input.timeoutSec !== undefined && input.timeoutSec !== null) {
		if (
			typeof input.timeoutSec !== 'number' ||
			!Number.isFinite(input.timeoutSec) ||
			input.timeoutSec < FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC ||
			input.timeoutSec > FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC
		) {
			throw new FleetAgentExecutionError(
				`Fleet agent execution timeoutSec must be between ${FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC} and ${FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC}`
			);
		}
		out.timeoutSec = Math.round(input.timeoutSec);
	}
	if (input.maxBudgetUsd !== undefined && input.maxBudgetUsd !== null) {
		if (
			typeof input.maxBudgetUsd !== 'number' ||
			!Number.isFinite(input.maxBudgetUsd) ||
			input.maxBudgetUsd <= 0 ||
			input.maxBudgetUsd > FLEET_AGENT_EXECUTION_MAX_BUDGET_USD
		) {
			throw new FleetAgentExecutionError(
				`Fleet agent execution maxBudgetUsd must be a positive number up to ${FLEET_AGENT_EXECUTION_MAX_BUDGET_USD}`
			);
		}
		out.maxBudgetUsd = Math.round(input.maxBudgetUsd * 100) / 100;
	}
	if (input.envPassthrough !== undefined && input.envPassthrough !== null) {
		if (!Array.isArray(input.envPassthrough)) {
			throw new FleetAgentExecutionError('Fleet agent execution envPassthrough must be an array of names');
		}
		out.envPassthrough = input.envPassthrough.filter((name): name is string => typeof name === 'string');
	}
	return out;
}

function byteLength(value: string): number {
	// `TextEncoder` is available in every runtime this package targets
	// (Node ≥ 18, browsers); it is the only dependency-free UTF-8 sizer.
	return new TextEncoder().encode(value).length;
}

// ─── Agent-task result (what the node reports back) ──────────────────

/** Outcome of the model-CLI step, as parsed by the node. */
export interface FleetAgentTaskModelResult {
	provider: FleetAgentExecutionProvider;
	/**
	 * `succeeded` — the CLI exited 0 and reported success;
	 * `failed`    — the CLI ran to a nonzero exit or reported an error;
	 * `timeout`   — killed at its wall-clock budget;
	 * `error`     — could not be spawned (no CLI, bad workspace).
	 */
	status: 'succeeded' | 'failed' | 'timeout' | 'error';
	exitCode: number | null;
	durationMs: number;
	/** The CLI's final message (Claude Code `result`), when it produced one. */
	summary: string | null;
	/** Spend the CLI reported for this run, when it did. */
	costUsd?: number | null;
	/** Model round-trips the CLI reported, when it did. */
	turns?: number | null;
	/** CLI session id, for a later resume. */
	sessionId?: string | null;
	/** Last bytes of combined stdout/stderr, for the run report. */
	outputTail?: string;
}

/** What the node did with the working tree after the model ran. */
export interface FleetAgentTaskGitResult {
	/**
	 * Multi-repo Task workspaces (self-build slice C): which repository this
	 * verdict is about. Absent on the primary (`result.git`), set on every
	 * entry of `result.mountGit`.
	 */
	repositoryId?: string;
	/** The mount directory the repository was linked at (`.mounts/<dir>`); mounts only. */
	mountDir?: string;
	branch: string;
	baseSha: string;
	headSha: string | null;
	/** True when there was nothing to commit AND nothing beyond the base. */
	empty: boolean;
	pushed: boolean;
	changedFiles?: number;
	/** Set when commit/push failed; the run is reported as failed. */
	error?: string;
}

// ─── Owner question (self-build slice Q) ─────────────────────────────

/**
 * Directory, relative to a worktree root, the fleet reserves for its own
 * out-of-band files. Kept out of every Task repository's Git view by the
 * node (`info/exclude`, next to `/.mounts/`), so nothing written here can
 * be staged by the finalize's `git add -A`.
 */
export const FLEET_AGENT_TASK_META_DIR = '.ever-works';

/**
 * The file a model writes, in the PRIMARY worktree root, when it needs a
 * decision only the Task owner can make.
 *
 * WHY a file: a fleet run executes a model CLI on the owner's own machine
 * with no platform credentials and no platform tools — the working tree
 * is the only channel it has back to the platform. The node reads the
 * file after the model step, removes it, and reports it as
 * `FleetAgentTaskResult.question`; the reconciler parks the run and files
 * an Inbox question; the owner's answer reaches the NEXT run of the same
 * Task inside its instructions.
 *
 * Case-exact and matched by name: NTFS would find `question.md`, ext4
 * would not, and a node must behave the same on both.
 */
export const FLEET_AGENT_TASK_QUESTION_FILE = '.ever-works/QUESTION.md';

/**
 * Caps. WHY they are mandatory rather than advisory: the platform REJECTS
 * an oversize job result outright (`FLEET_JOB_MAX_RESULT_BYTES`, enforced
 * with a 400 by `FleetJobService.completeJob`), and a rejected report
 * turns a run that merely asked a question into a failed job. So the node
 * never reads more than `MAX_FILE_BYTES` of the file, the question line is
 * capped at the Inbox title width, the context at a budget that keeps
 * title + context inside the Inbox body width — and every cut is
 * deterministic and code-point safe, never a throw.
 */
export const FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES = 64 * 1024;
/** The question line IS the Inbox item's title, so it shares that cap. */
export const FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS = INBOX_MAX_TITLE_CHARS;
/** UTF-8 bytes of context; text + blank line + context stays below `INBOX_MAX_BODY_CHARS`. */
export const FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES = 6 * 1024;

/** A question the model asked the Task owner through `FLEET_AGENT_TASK_QUESTION_FILE`. */
export interface FleetAgentTaskQuestion {
	/** First non-empty line (leading `#{1,6}` stripped), ≤ 300 code points; the Inbox title. */
	text: string;
	/**
	 * Everything after the first line, trimmed. When the first line
	 * exceeded the text cap the FULL first line is prepended here so the
	 * cut never loses words — the title is a headline, the body keeps the
	 * question. `null` when empty.
	 */
	context: string | null;
	/** True only when bytes were actually dropped by a cap. */
	truncated: boolean;
	/**
	 * Where the file was found: `null` = the primary worktree, otherwise
	 * the `.mounts/<dir>` mount directory (the node scans writable mounts
	 * as a safety net for a model that wrote the file where it was working).
	 */
	mountDir: string | null;
}

const QUESTION_MOUNT_DIR_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const QUESTION_HEADING_PREFIX = /^#{1,6}\s*/;
/** ANSI CSI sequences (`ESC [ … m` and friends) — a terminal-coloured line pasted into the file. */
const ANSI_CSI_SEQUENCE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
/** C0 control characters except TAB / LF / CR, plus DEL — the class `sanitizeText` strips. */
const C0_CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Drop control characters a question can only have picked up by accident
 * (a binary head, a symlink target, a terminal escape pasted into the
 * file). WHY here, at the contract: the question line becomes the run
 * summary, the Inbox title and the next run's instructions, and Postgres
 * REJECTS a NUL in `text` / `varchar` — the reconciler's very first write
 * would throw and leave the run `running`, neither parked nor failed.
 * CSI sequences go first so their ESC does not leave `[31m` behind.
 */
function stripControlCharacters(value: string): string {
	return value.replace(ANSI_CSI_SEQUENCE, '').replace(C0_CONTROL_CHARACTERS, '');
}

/**
 * Parse the Markdown the model wrote into a question.
 *
 * Tolerant on the input (a leading UTF-8 BOM, CRLF or bare CR line ends,
 * leading blank lines, a `# ` heading marker, control characters — a
 * line that is nothing but control characters is skipped like a blank
 * one) and strict on the output: the result has been through
 * {@link normalizeFleetAgentTaskQuestion}, so it already satisfies every
 * cap. `null` when the file carries no question line at all — a blank
 * file is not a question.
 */
export function parseFleetAgentTaskQuestionMarkdown(
	markdown: string,
	mountDir?: string | null
): FleetAgentTaskQuestion | null {
	if (typeof markdown !== 'string') return null;
	const lines = markdown
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n')
		.split('\n');
	let index = -1;
	let questionLine = '';
	for (let i = 0; i < lines.length; i += 1) {
		const candidate = stripControlCharacters(lines[i]).trim().replace(QUESTION_HEADING_PREFIX, '').trim();
		if (candidate.length > 0) {
			index = i;
			questionLine = candidate;
			break;
		}
	}
	if (index < 0) return null;
	const points = Array.from(questionLine);
	const overflowed = points.length > FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS;
	const text = overflowed
		? points.slice(0, FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS).join('').trimEnd()
		: questionLine;
	const remainder = lines
		.slice(index + 1)
		.join('\n')
		.trim();
	const context = `${overflowed ? `${questionLine}\n\n` : ''}${remainder}`.trim();
	return normalizeFleetAgentTaskQuestion({
		text,
		context: context.length > 0 ? context : null,
		truncated: false,
		...(mountDir ? { mountDir } : {})
	});
}

/**
 * Coerce an untrusted `question` (off the wire, out of a column) into a
 * `FleetAgentTaskQuestion`, or `null` when nothing usable survives.
 *
 * COERCING, never throwing: the reconciler consumes this from a node's
 * result, and a malformed question must not cost the run its verdict —
 * the model, check and git outcomes in the same result are still true.
 * Only the four declared fields come out; a smuggled `userId` / `taskId`
 * is dropped here so no consumer can be talked into trusting it, and
 * control characters are stripped from both strings (a NUL would make
 * the first Postgres write of the parked-run path throw).
 */
export function normalizeFleetAgentTaskQuestion(raw: unknown): FleetAgentTaskQuestion | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const input = raw as Record<string, unknown>;
	if (typeof input.text !== 'string') return null;
	let truncated = input.truncated === true;

	const firstLine = stripControlCharacters(input.text)
		.trim()
		.split(/\r\n?|\n/, 1)[0]
		.trim();
	if (firstLine.length === 0) return null;
	const points = Array.from(firstLine);
	let text = firstLine;
	if (points.length > FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS) {
		text = points.slice(0, FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS).join('').trimEnd();
		truncated = true;
	}

	let context: string | null = null;
	if (typeof input.context === 'string') {
		const cut = truncateToUtf8Bytes(
			stripControlCharacters(input.context).trim(),
			FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES
		);
		truncated = truncated || cut.truncated;
		context = cut.value.length > 0 ? cut.value : null;
	}

	const mountDir =
		typeof input.mountDir === 'string' && QUESTION_MOUNT_DIR_PATTERN.test(input.mountDir) ? input.mountDir : null;

	return { text, context, truncated, mountDir };
}

/**
 * Cut a string to at most `maxBytes` of UTF-8 without splitting a code
 * point: decode the byte prefix leniently and drop the replacement
 * character a torn trailing sequence leaves behind.
 */
function truncateToUtf8Bytes(value: string, maxBytes: number): { value: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(value);
	if (bytes.length <= maxBytes) return { value, truncated: false };
	const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes));
	return { value: decoded.replace(/\uFFFD+$/, '').trimEnd(), truncated: true };
}

/**
 * The `result` an `agent-task` job carries back to the platform.
 *
 * Shared between the node (which produces it) and the API-side
 * reconciler (which turns it into AgentRun / Task state), so the two
 * cannot drift on what "the run succeeded" means: the model finished,
 * every required check is green, and — when a repository workspace was
 * provisioned — the branch was committed and pushed.
 */
export interface FleetAgentTaskResult extends Record<string, unknown> {
	status: 'succeeded' | 'failed';
	/** Platform Task the run belongs to (echoed for correlation). */
	taskId: string;
	/** Platform `AgentRun` the result correlates to, when the job carried one. */
	runId: string | null;
	/** Validated repository checkout used by this run; null for path-only jobs. */
	workspace: FleetTaskWorkspaceDescriptor | null;
	/** Verdicts of the legacy command steps, in declared order. */
	steps: TaskCheckResult[];
	/** Present when the job carried an `execution` block. */
	model?: FleetAgentTaskModelResult | null;
	/** Verdicts of the acceptance checks, when the job carried any. */
	checks?: TaskCheckResult[] | null;
	/** Gate verdict over `checks` (`none` when the job carried no checks). */
	gateStatus?: 'green' | 'red' | 'none' | null;
	/** Present when the node attempted a commit / push. */
	git?: FleetAgentTaskGitResult | null;
	/**
	 * Multi-repo Task workspaces (self-build slice C): one verdict per
	 * WRITABLE mount the node attempted to commit / push, in spec order.
	 * Read-only mounts never appear here.
	 */
	mountGit?: FleetAgentTaskGitResult[] | null;
	/**
	 * Self-build slice Q: present when the model wrote
	 * `FLEET_AGENT_TASK_QUESTION_FILE`. The run is NOT failed for it — the
	 * reconciler parks it awaiting the owner's answer whatever `status`
	 * says, because partial work almost always reports a red check or a
	 * non-zero model exit and that verdict is still true.
	 */
	question?: FleetAgentTaskQuestion | null;
	/** Why `status` is `failed`, in one sentence, for the run report. */
	failureReason?: string | null;
}

/**
 * Executor input for `browser-check`.
 *
 * The node resolves a browser binary itself (the same probe that decides
 * whether it advertises the `browser` tag at all) and drives it against
 * `url`. `headed` asks for a visible window rather than headless — only
 * honourable on a node that also advertises `display`, and refused
 * rather than silently downgraded so a headed-only check cannot pass on
 * a machine that never opened a window.
 */
export interface FleetBrowserCheckPayload {
	/** Optional platform Task the check belongs to (reporting only). */
	taskId?: string;
	/** Optional platform run the check belongs to (reporting only). */
	runId?: string;
	/** Absolute http(s) URL to load. */
	url: string;
	/** Require a visible (non-headless) browser window. Default false. */
	headed?: boolean;
	/** Fail the check unless the rendered DOM contains this text. */
	expectText?: string;
	/** Wall-clock budget for the navigation. Clamped node-side. */
	timeoutSec?: number;
}

/** Verdict of one `browser-check` job. */
export interface FleetBrowserCheckResult extends Record<string, unknown> {
	/** True when the browser rendered the page and every expectation held. */
	ok: boolean;
	/** Browser executable the node actually used (path, never a credential). */
	browserPath: string;
	/** Whether the run was headless. */
	headless: boolean;
	/** Bytes of DOM the browser produced. */
	domBytes: number;
	/** `<title>` of the loaded document when one was present. */
	title: string | null;
	durationMs: number;
	/** Why the check failed, when it did. */
	error?: string;
}

/** Request body for `POST /api/fleet/jobs/lease`. */
export interface FleetJobLeaseRequest {
	nodeId: string;
	secret: string;
	/** How many jobs to claim in one call (clamped to the batch cap). */
	max?: number;
	/** Requested claim duration; clamped server-side. */
	leaseTtlSec?: number;
	/**
	 * Capability tags the node advertises for THIS poll. Omitted means
	 * "use whatever the node last reported on heartbeat" — supplying it
	 * lets a node narrow its own eligibility without re-enrolling.
	 */
	capabilities?: string[];
}

/** Response body for `POST /api/fleet/jobs/lease`. */
export interface FleetJobLeaseResponse {
	jobs: FleetJobView[];
}

/** Request body for `POST /api/fleet/jobs/:id/heartbeat`. */
export interface FleetJobHeartbeatRequest {
	nodeId: string;
	secret: string;
	/** Requested lease extension; clamped server-side. */
	leaseTtlSec?: number;
}

/** Response body for `POST /api/fleet/jobs/:id/heartbeat`. */
export interface FleetJobHeartbeatResponse {
	ok: true;
	job: FleetJobView;
}

/** Request body for `POST /api/fleet/jobs/:id/complete`. */
export interface FleetJobCompleteRequest {
	nodeId: string;
	secret: string;
	/** `false` records a failure; the sweeper may still retry it. */
	success: boolean;
	/** Executor output; shape is per-kind. Capped server-side. */
	result?: Record<string, unknown> | null;
	/** Failure detail. Capped server-side. */
	error?: string | null;
}

/** Response body for `POST /api/fleet/jobs/:id/complete`. */
export interface FleetJobCompleteResponse {
	ok: true;
	job: FleetJobView;
}

/**
 * Per-node execution summary merged into the Fleet node list so the UI
 * can render busy/idle and "what is this machine doing right now".
 */
export interface FleetNodeLoadView {
	/** Jobs this node currently holds a live claim on. */
	activeJobCount: number;
	/** Kind of the oldest live claim, or null when idle. */
	currentJobKind: FleetJobKind | null;
	/** Id of the oldest live claim, or null when idle. */
	currentJobId: string | null;
}

/** A node with at least one live claim is busy. */
export function isNodeBusy(load: FleetNodeLoadView | null | undefined): boolean {
	return Boolean(load && load.activeJobCount > 0);
}
