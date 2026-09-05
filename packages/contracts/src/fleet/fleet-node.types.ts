/**
 * Fleet node registry — the enroll / heartbeat wire contract shared by
 * the platform API and every node app.
 *
 * Before this file the node apps carried a hand-written MIRROR of these
 * shapes (`apps/node/src/core/types.ts`) with a comment asking future
 * readers not to let it drift. That is not a contract, it is a promise:
 * a field renamed server-side stayed green on both sides and only broke
 * at runtime, against a machine nobody was watching. Putting the shapes
 * here — in the zero-dependency package both tiers already depend on —
 * makes a contract change a COMPILE error on both sides, which is the
 * whole point.
 *
 * What lives here: wire shapes and protocol-level bounds. What does NOT:
 * the server's operator-tunable limits (enrollment-token TTL, offline
 * sweep window, capability-tag caps). Those are read from the platform
 * config module (`config.fleet.*` in `@ever-works/agent/config`); the
 * `FLEET_DEFAULT_*` constants below are the DEFAULTS those getters fall
 * back to, and the values a node assumes when it cannot ask the server.
 *
 * ## Protocol
 *
 * ```
 *   POST /api/fleet/enroll      one-time token  → { nodeId, secret, node }
 *   POST /api/fleet/heartbeat   nodeId + secret → { ok, node }
 * ```
 *
 * Both endpoints are public and self-authenticating: the credential IS
 * the body. Every invalid path answers with one undifferentiated 401.
 */

import type { FleetJobView } from './fleet-jobs.types';

import type { FleetNodeLoadView } from './fleet-jobs.types.js';

/**
 * App shape of a fleet node.
 *
 * `k8s` is list-time only — nodes of a user's OWN configured cluster are
 * merged into list responses live and never persisted as rows, so a
 * machine can never enroll as one (see {@link FleetEnrollableNodeKind}).
 */
export type FleetNodeKind = 'desktop-node' | 'node' | 'k8s';

/** Canonical kind list — one source of truth for validators and UI. */
export const FLEET_NODE_KINDS: readonly FleetNodeKind[] = ['desktop-node', 'node', 'k8s'];

/** The kinds a machine can actually enroll as. */
export type FleetEnrollableNodeKind = Exclude<FleetNodeKind, 'k8s'>;

/** Canonical enrollable-kind list (server: `FLEET_ENROLLABLE_KINDS`). */
export const FLEET_ENROLLABLE_NODE_KINDS: readonly FleetEnrollableNodeKind[] = ['desktop-node', 'node'];

/** Type guard for an enrollable kind arriving off the wire or a config file. */
export function isFleetEnrollableNodeKind(value: unknown): value is FleetEnrollableNodeKind {
	return typeof value === 'string' && (FLEET_ENROLLABLE_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * Heartbeat-derived lifecycle state.
 *
 * - `enrolling` — row exists, its one-time token has not been consumed.
 * - `online`    — a heartbeat was accepted inside the offline window.
 * - `offline`   — no heartbeat for the configured window, or drained.
 * - `disabled`  — operator-drained; heartbeats are refused.
 */
/**
 * Heartbeat-derived lifecycle state.
 *
 * `paused` is a DRAIN, not a cut: the node stops being offered new
 * work but keeps its in-flight claims, keeps reporting their verdicts,
 * and keeps heartbeating so it stays observable in Fleet. `disabled`
 * is the operator's harder stop — also drained rather than severed
 * (in-flight work still reports) but not resumable by the node itself.
 *
 * Stored in a plain `varchar(16)` with no enum/check constraint, so
 * adding a value is a code-level change only — no migration.
 */
export type FleetNodeStatus = 'enrolling' | 'online' | 'offline' | 'paused' | 'disabled';

/**
 * Canonical status list.
 *
 * `paused` was missing here while being a fully-supported
 * {@link FleetNodeStatus} — the union, the entity, the service and the UI
 * all handled it, so anything iterating THIS list (status filters, legend
 * rendering) silently skipped a real state. Added rather than worked
 * around: a canonical list that is not canonical is worse than no list.
 */
export const FLEET_NODE_STATUSES: readonly FleetNodeStatus[] = ['enrolling', 'online', 'offline', 'paused', 'disabled'];

/**
 * Statuses in which the platform will NOT lease new work onto a node.
 *
 * Lives here, next to the status union, rather than only on the server
 * entity: "can this machine take work right now" is now asked by the API
 * edge (runner availability for routing) as well as by the lease
 * protocol, and two hand-written copies of a list like this drift the
 * first time a status is added. The entity re-exports it, so every
 * existing server-side importer is unchanged.
 */
export const FLEET_NODE_NON_LEASABLE_STATUSES: readonly FleetNodeStatus[] = ['enrolling', 'paused', 'disabled'];

/**
 * What the node's WORKER is doing, as opposed to {@link FleetNodeStatus},
 * which is only what the platform can infer from heartbeats.
 *
 * The distinction is the whole point of this field (self-build finding
 * OPS-02). A machine that has self-quarantined — the durable worker
 * safety marker, set when a process tree could not be proven dead and
 * clearable only at that keyboard — keeps beating and therefore keeps
 * reporting `online`, while refusing every job it is offered. Status
 * said "healthy", the queue said "nothing is running", and nothing
 * anywhere said why. These five values are the node's own answer:
 *
 * - `idle`        — polling, ready to take work.
 * - `working`     — at least one job in flight.
 * - `paused`      — drained on purpose (operator pause, or draining
 *                   the last in-flight jobs before a stop).
 * - `quarantined` — fail-closed stop the node imposed on ITSELF; only
 *                   an operator at that machine can clear it.
 * - `throttled`   — over a resource ceiling (CPU/memory, disk floor):
 *                   the loop runs and keeps its jobs, it just does not
 *                   lease more.
 *
 * Stored in a plain `varchar(16)` with no enum/check constraint, like
 * {@link FleetNodeStatus}, so adding a value stays a code change.
 */
export type FleetNodeWorkerState = 'idle' | 'working' | 'paused' | 'quarantined' | 'throttled';

/** Canonical worker-state list — one source of truth for the server and the UI. */
export const FLEET_NODE_WORKER_STATES: readonly FleetNodeWorkerState[] = [
	'idle',
	'working',
	'paused',
	'quarantined',
	'throttled'
];

/**
 * Normalize a worker state arriving off the wire.
 *
 * Returns `null` — meaning "unknown", rendered as such — for ANY value
 * that is not an exact member: a non-string, a node-internal state name
 * that is not part of this contract (`unsafe`, `draining`, `polling`),
 * or a value a NEWER node build invented. Deliberately not a fallback to
 * `idle`: a fabricated "idle" for a machine whose real state we do not
 * understand is precisely the lie this whole field exists to stop.
 *
 * The wire itself stays permissive on purpose (the heartbeat DTO bounds
 * `workerState` as a plain string, not an enum), so a future value can
 * never make a beat fail and turn a live node offline. It is normalized
 * here, once, before it is ever stored or shown.
 */
export function normalizeFleetNodeWorkerState(value: unknown): FleetNodeWorkerState | null {
	if (typeof value !== 'string') return null;
	return (FLEET_NODE_WORKER_STATES as readonly string[]).includes(value) ? (value as FleetNodeWorkerState) : null;
}

/**
 * Self-description a node sends on enroll and refreshes on every
 * heartbeat. Every field is optional: a node that reports nothing is
 * still a valid node, just an undescribed one.
 */
export interface FleetNodeSelfDescription {
	/** `os/arch`, e.g. `linux/x64`. Capped at {@link FLEET_MAX_PLATFORM_LENGTH}. */
	platform?: string;
	/** Node app version. Capped at {@link FLEET_MAX_VERSION_LENGTH}. */
	version?: string;
	/** Scheduling capability tags, e.g. `['terminal', 'workspace', 'docker']`. */
	capabilities?: string[];
	/**
	 * Version of the AGENT CLI installed on the machine (e.g. the
	 * `claude-code` binary the `agent-task` steps shell out to), as
	 * opposed to {@link FleetNodeSelfDescription.version}, which is the
	 * daemon's own version.
	 *
	 * The distinction matters operationally: "the runner is up to date"
	 * and "the tool the runner drives is up to date" are different
	 * questions, and only the second one explains why a job that worked
	 * yesterday now fails on one machine.
	 *
	 * ADDITIVE and OPTIONAL by contract — a daemon built before this
	 * field existed simply omits it, and the server leaves the stored
	 * value untouched rather than nulling it.
	 */
	cliVersion?: string;
	/**
	 * Free bytes on the volume the node's workspace lives on. A number,
	 * not a formatted string, so the UI owns the units.
	 *
	 * Same additive contract as {@link FleetNodeSelfDescription.cliVersion}:
	 * omitted by older daemons, and an omitted value never overwrites a
	 * previously-reported one. Negative / non-finite values are refused
	 * server-side rather than stored.
	 */
	diskFreeBytes?: number;
	/**
	 * Fleet cost accounting (EW-777) — which account / seat the agent CLI
	 * on this machine is logged in as, so the spend a run reports can be
	 * attributed to the subscription that actually paid for it. A display
	 * label only, e.g. `claude-code: user@example.com (Acme, max)` or
	 * `codex: chatgpt`; NEVER a token or a credential.
	 *
	 * The platform records it and shows it. It does NOT decide whether a
	 * PC should run under a dedicated seat or its owner's own login —
	 * that is the founder's call, recorded as such in
	 * `docs/internal/feat-fleet-cost-accounting-notes.md`.
	 *
	 * Same additive contract as {@link FleetNodeSelfDescription.cliVersion}.
	 * Capped at {@link FLEET_MAX_MODEL_IDENTITY_LENGTH}.
	 */
	modelIdentity?: string;
	/**
	 * What the node's WORKER is doing right now — one of
	 * {@link FLEET_NODE_WORKER_STATES}.
	 *
	 * Typed as a plain `string` rather than the union ON PURPOSE: this is
	 * the WIRE, and a node built after this API must be able to report a
	 * value this API has never heard of without its heartbeat being
	 * rejected (a rejected beat is a failed beat, and a node that cannot
	 * beat goes offline). The server runs every incoming value through
	 * {@link normalizeFleetNodeWorkerState}, which maps anything
	 * unrecognised to "unknown" rather than trusting it verbatim.
	 *
	 * Same additive contract as {@link cliVersion}: absent leaves the
	 * stored value alone, so an older daemon never blanks it.
	 */
	workerState?: string;
	/**
	 * Why the worker is in that state, when there is a reason worth
	 * reading: the quarantine's own message, the resource ceiling that
	 * throttled the lease. Free text from the machine, so the server
	 * sanitizes and caps it at {@link FLEET_MAX_WORKER_STATE_REASON_LENGTH}.
	 */
	workerStateReason?: string;
}

/** Wire view of one fleet node — never carries credentials or hashes. */
export interface FleetNodeView {
	id: string;
	name: string;
	kind: FleetNodeKind;
	status: FleetNodeStatus;
	platform: string | null;
	version: string | null;
	capabilities: string[];
	lastHeartbeatAt: string | null;
	createdAt: string | null;
	/**
	 * True for enrolled rows; false for nodes of the user's own
	 * configured clusters, which are surfaced live and never stored.
	 */
	persisted: boolean;
	/**
	 * True once an operator hand-edited the capability tags, which stops
	 * heartbeats from overwriting them. Always false for cluster rows,
	 * which are surfaced live and never stored.
	 */
	capabilitiesPinned?: boolean;
	/**
	 * Live execution load. Populated by the API edge from the job
	 * service; `null`/absent means idle. Cluster-sourced rows never
	 * carry it — the platform does not lease work onto them.
	 */
	load?: FleetNodeLoadView | null;
	/**
	 * Agent-CLI version last reported by the node, or null when the node
	 * has never reported one (an older daemon, or a machine with no CLI
	 * installed). Distinct from {@link FleetNodeView.version}, which is
	 * the daemon's own version.
	 */
	cliVersion?: string | null;
	/** Free bytes last reported for the node's workspace volume, or null. */
	diskFreeBytes?: number | null;
	/**
	 * Which account / seat the node's agent CLI last reported being logged
	 * in as, or null when it never reported one. See
	 * {@link FleetNodeSelfDescription.modelIdentity}.
	 */
	modelIdentity?: string | null;
	/**
	 * Per-node DAILY (UTC day) model-spend ceiling in cents, or null when
	 * the node inherits the deployment default (`FLEET_NODE_DAILY_COST_CEILING_USD`,
	 * itself unset by default = no ceiling). Crossing it drains the node.
	 */
	dailyCostCeilingCents?: number | null;
	/**
	 * The UTC day (`YYYY-MM-DD`) on which this node was last drained by
	 * its daily ceiling, or null. A drained node stays `disabled` until
	 * its owner re-enables it — a ceiling is a stop, not a rate limit.
	 */
	dailyCostTrippedOn?: string | null;
	/**
	 * What the node's worker last reported doing, or null when it has
	 * never reported one (an older daemon, or a visibility-only node with
	 * its worker disabled). Null renders as "unknown", which is the
	 * honest answer — never as `idle`.
	 */
	workerState?: FleetNodeWorkerState | null;
	/** Why the worker is in that state (quarantine / throttle reason), or null. */
	workerStateReason?: string | null;
	/**
	 * ISO timestamp the worker state last CHANGED, or null. Stamped only
	 * on a transition, so "quarantined since 03:14" stays true across the
	 * hundreds of beats that follow rather than resetting every 30s.
	 */
	workerStateChangedAt?: string | null;
}

/**
 * `GET /api/fleet/cost-ceiling` — the owner's FLEET-WIDE daily model-spend
 * ceiling (every enrolled node of the account, summed per UTC day).
 *
 * Sums `fleet_jobs.costCents` only — the spend the owner's own machines
 * reported — never the account's cloud spend or BYOK usage rows. Those
 * have their own budgets; folding them in here would make one ceiling
 * drain a fleet for money spent elsewhere.
 */
export interface FleetCostCeilingView {
	/** Owner-set ceiling in cents; null = inherit the deployment default. */
	dailyCeilingCents: number | null;
	/**
	 * The ceiling actually in force: the owner's, else the deployment
	 * default (`FLEET_DAILY_COST_CEILING_USD`), else null (no ceiling).
	 */
	effectiveDailyCeilingCents: number | null;
	/** Where the effective ceiling came from. */
	source: 'owner' | 'default' | 'none';
	/** The UTC day the fleet was last drained by this ceiling, or null. */
	trippedOn: string | null;
	/** Cents the fleet reported so far today (UTC), across every node. */
	todaySpendCents: number;
	/** The UTC day `todaySpendCents` covers (`YYYY-MM-DD`). */
	day: string;
}

/** Request body for `POST /api/fleet/enroll`. */
export interface FleetEnrollRequest extends FleetNodeSelfDescription {
	/** One-time enrollment token, single-use and short-lived. */
	token: string;
}

/** Response body for `POST /api/fleet/enroll`. */
export interface FleetEnrollResponse {
	nodeId: string;
	/** Heartbeat secret, returned exactly once — only its sha256 is stored. */
	secret: string;
	node: FleetNodeView;
}

/** Request body for `POST /api/fleet/heartbeat`. */
export interface FleetHeartbeatRequest extends FleetNodeSelfDescription {
	nodeId: string;
	secret: string;
}

/** Response body for `POST /api/fleet/heartbeat`. */
export interface FleetHeartbeatResponse {
	ok: true;
	node: FleetNodeView;
}

// ─── Protocol bounds (fixed) ────────────────────────────────────────────────

/** `sanitizeText(platform, 64)` server-side; the node truncates to match. */
export const FLEET_MAX_PLATFORM_LENGTH = 64;

/** `sanitizeText(version, 32)` server-side; the node truncates to match. */
export const FLEET_MAX_VERSION_LENGTH = 32;

/**
 * `sanitizeText(cliVersion, 64)` server-side. Wider than the daemon's own
 * version because an agent CLI commonly reports something like
 * `1.2.3 (Claude Code)` rather than a bare semver.
 */
export const FLEET_MAX_CLI_VERSION_LENGTH = 64;

/**
 * `sanitizeText(modelIdentity, 200)` server-side. Wide enough for
 * `<provider>: <email> (<organization>, <plan>)`; the node builds the
 * label from whitelisted fields, so nothing longer is ever legitimate.
 */
export const FLEET_MAX_MODEL_IDENTITY_LENGTH = 200;

/**
 * `sanitizeText(workerStateReason, 500)` server-side.
 *
 * Wide enough for a real quarantine message ("process tree for job X
 * could not be proven terminated after N attempts: ..."), and hard
 * enough that a machine cannot use a heartbeat field as unbounded
 * storage. The node truncates to the same bound so what it shows locally
 * matches what Fleet stores.
 */
export const FLEET_MAX_WORKER_STATE_REASON_LENGTH = 500;

/**
 * Ceiling on a daily cost ceiling: $100,000 per UTC day, in cents. Not a
 * plausible fleet spend — it is the point past which a figure is a typo
 * (dollars entered as cents, or the reverse) rather than a decision, and
 * the DTO / service refuse it so a mis-typed ceiling cannot silently be
 * "no ceiling at all".
 */
export const FLEET_MAX_DAILY_COST_CEILING_CENTS = 100_000 * 100;

/**
 * Ceiling on a reported `diskFreeBytes`, ~1 EiB. Not a real disk size —
 * it is the point past which the value is certainly nonsense (a
 * misreported unit, a signed-overflow, a hostile node). Values outside
 * `[0, this]` are dropped rather than stored, so a bad reading cannot
 * make the runner widget render a machine with an exabyte free.
 */
export const FLEET_MAX_DISK_FREE_BYTES = 2 ** 60;

/** Node display-name bounds, enforced by the DTO and re-checked in the service. */
export const FLEET_MIN_NODE_NAME_LENGTH = 1;
export const FLEET_MAX_NODE_NAME_LENGTH = 200;

/**
 * Credential length window shared by enrollment tokens and node
 * secrets. Both are 32 random bytes base64url-encoded (43 chars); the
 * window exists so an obviously malformed credential is refused before
 * any database round-trip, and with the same answer as a wrong one.
 */
export const FLEET_CREDENTIAL_MIN_LENGTH = 16;
export const FLEET_CREDENTIAL_MAX_LENGTH = 256;

// ─── Operator-tunable limits: DEFAULTS ──────────────────────────────────────

/** Default one-time enrollment-token lifetime (15 minutes). */
export const FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS = 15 * 60_000;

/** Default silence after which an `online` node sweeps to `offline` (5 minutes). */
export const FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS = 5 * 60_000;

/**
 * Default silence after which an already-`offline` node earns a SECOND,
 * louder Inbox notice — "this machine has now been gone for half an
 * hour" (30 minutes).
 *
 * Separate from {@link FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS} because the
 * two answer different questions. Five minutes of silence is routine (a
 * reboot, a lid closed, a flaky Wi-Fi minute) and the first notice says
 * so. Half an hour is somebody's PC that is not coming back on its own,
 * and under the runbook's recommended `local-wait` there is no cloud
 * fallback to quietly cover for it. Filed exactly once per outage; the
 * marker re-arms when the node beats again.
 */
export const FLEET_DEFAULT_NODE_OFFLINE_NOTICE_AFTER_MS = 30 * 60_000;

/** Default cap on how many capability tags one node may advertise. */
export const FLEET_DEFAULT_MAX_CAPABILITY_TAGS = 16;

/** Default cap on the length of a single capability tag. */
export const FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH = 32;

/**
 * Hard ceilings an operator override may not exceed.
 *
 * The limits above are knobs, not opinions — but an unbounded knob is a
 * denial-of-service surface (`capabilities` is a stored JSON column and
 * a lease-time filter input). These ceilings bound what any env value
 * can widen the edge to; the service clamps into them.
 */
export const FLEET_MAX_CAPABILITY_TAGS_CEILING = 64;
export const FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING = 128;

/** Floor for the enrollment-token TTL — a zero-TTL token cannot be redeemed. */
export const FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS = 30_000;

/**
 * Floor for the offline sweep window. Below the node's own minimum
 * heartbeat cadence every healthy node would flap to `offline` between
 * beats, so the window can be shortened but not to nonsense.
 */
export const FLEET_MIN_NODE_OFFLINE_AFTER_MS = 30_000;

/**
 * The RECONCILED outcome of the platform run a fleet job carried.
 *
 * The job row and the run row settle separately: the node reports a
 * verdict on the job, then the api-side reconciler decides what that
 * meant for the Agent run (completed with a summary, failed with a
 * reason, parked on a question). Showing only the job status is how the
 * drawer ended up saying "done" for a job whose run had failed — the
 * exact question an operator opens the drawer to answer.
 */
export interface FleetJobReconciledOutcome {
	/** The Agent run this job carried. */
	runId: string;
	status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
	/** The run's own summary, or null. */
	summary: string | null;
	/** The run's error message, or null. Length-capped server-side. */
	error: string | null;
}

/**
 * IDs-ONLY summary of what a job was for.
 *
 * Deliberately not the payload: `FleetJobView.payload` is executor input
 * — instructions, mount grants, repo coordinates — and the drawer has no
 * business rendering it (see `FLEET_JOB_MAX_PAYLOAD_BYTES` for how big
 * it can get, and note that it is composed from user content). The
 * identities below are what an operator actually needs to follow the
 * trail from a node row to the Task and the run.
 */
export interface FleetJobHistorySummary {
	kind: string;
	taskId?: string | null;
	runId?: string | null;
	agentId?: string | null;
}

/**
 * One row of the node drawer's job history: a {@link FleetJobView} plus
 * the facts that were on the server and never reached the drawer — the
 * job's own error text, the reconciled run outcome, and a payload-free
 * summary.
 *
 * `payload` is inherited from {@link FleetJobView} and is always sent as
 * `null` on this endpoint. Keeping the field (rather than omitting it)
 * keeps the type a structural superset, so every existing consumer of
 * the detail view still compiles.
 */
export interface FleetNodeJobHistoryEntry extends FleetJobView {
	/** The verdict text the node reported, or null. Capped server-side. */
	error?: string | null;
	/** IDs-only description of the work, never the payload. */
	summary?: FleetJobHistorySummary | null;
	/** The reconciled run outcome, or null for a job that carried no run. */
	reconciled?: FleetJobReconciledOutcome | null;
}

/**
 * `GET /api/fleet/nodes/:id` — one node plus what it has been doing.
 *
 * Lives in contracts (not at the API edge) because the web tier renders
 * it: two hand-copied declarations is exactly how `FleetNodeView` drifted
 * into three copies before it was consolidated here.
 */
export interface FleetNodeDetailView {
	node: FleetNodeView;
	/** Newest-first job history for this node (all outcomes). */
	recentJobs: FleetNodeJobHistoryEntry[];
	/**
	 * The failed subset of {@link recentJobs}, newest first — pulled out
	 * so the drawer can lead with "why is this machine unhappy" instead
	 * of making the operator filter a mixed list by eye.
	 */
	failures: FleetNodeJobHistoryEntry[];
	/**
	 * True when the job history could not be read at all (job tables
	 * unavailable). The node itself still renders — a job-runtime hiccup
	 * must never make a node look like it does not exist.
	 */
	historyUnavailable: boolean;
}

/** `POST /api/fleet/nodes/:id/drain` — drain / undrain result. */
export interface FleetNodeDrainResult {
	node: FleetNodeView;
	/**
	 * How many in-flight claims went back to the queue. Draining without
	 * requeuing would strand the node's work until each lease lapsed — up
	 * to a full lease TTL per job, on a machine that is by then refusing
	 * to report.
	 */
	releasedJobs: number;
}

/**
 * One OUTSTANDING enrollment token — minted but never used.
 *
 * The plaintext token is NOT here and can never be re-read; it was
 * returned exactly once at mint time. This is the metadata the admin
 * list and the revoke control need.
 */
export interface FleetEnrollmentTokenView {
	/** Id of the node the token was minted for (the revoke handle). */
	nodeId: string;
	name: string;
	kind: FleetNodeKind;
	/** When the token was issued (ISO). */
	issuedAt: string | null;
	/** When it stops being consumable (ISO). */
	expiresAt: string | null;
	/** True once `expiresAt` has passed — still revocable, never usable. */
	expired: boolean;
	/**
	 * True when this token REPLACED an existing credential (a rotate)
	 * rather than being a first enrollment. Drives a badge so an
	 * operator can tell a re-key apart from a machine that has never
	 * connected.
	 */
	rotated?: boolean;
}
