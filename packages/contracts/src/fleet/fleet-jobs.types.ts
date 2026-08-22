import type { FleetTaskWorkspaceSpec } from './fleet-task-workspace.types.js';

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
