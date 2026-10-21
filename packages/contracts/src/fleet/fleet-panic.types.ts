/**
 * Panic controls (EW-778, closes OPS-16 + security audit 2026-05-17 #25)
 * — the wire shapes for stopping a fleet at 2am.
 *
 * Three controls, deliberately separate, because they are three
 * different decisions:
 *
 *   1. **Drain all** (owner) — every node the caller owns is disabled and
 *      its in-flight claims go back to the queue. Nothing is killed; the
 *      work waits for a node that is allowed to take it.
 *   2. **The global stop flag** (platform admin) — a DB-backed switch
 *      read by the dispatch gate, the run router and every lease
 *      request. When set, no NEW work is dispatched, routed or leased.
 *      Running work keeps running and keeps reporting. Reads FAIL
 *      CLOSED: a flag that cannot be read counts as set.
 *   3. **Cancel in-flight** (owner) — an EXPLICIT second step that
 *      cancels the caller's running fleet jobs and their agent runs.
 *      Never implied by the stop flag.
 *
 * Every set / clear / drain-all / cancel-in-flight writes one `fleet_audit`
 * row carrying the actor and the time.
 */

import type { FleetNodeView } from './fleet-node.types.js';

/** The one row `fleet_kill_switch` ever holds. */
export const FLEET_KILL_SWITCH_ID = 'global';

/** Upper bound on the free-text reason stored with a stop. */
export const FLEET_KILL_SWITCH_REASON_MAX_LENGTH = 500;

/** Paging bounds for the fleet audit read. */
export const FLEET_AUDIT_DEFAULT_LIMIT = 50;
export const FLEET_AUDIT_MAX_LIMIT = 200;

/**
 * Actions recorded in `fleet_audit`. Stored as `varchar(64)` rather than
 * an enum so the log can be extended without a type-altering migration —
 * which is exactly what slice AQ (EW-799) does below.
 *
 * Two conventions, both deliberate and both already present:
 *
 *   - a DOTTED namespace for anything scoped to one subject
 *     (`kill-switch.*`, `node.*`, `affinity.*`, `execution-preference.*`);
 *   - a BARE verb for the whole-fleet, owner-level actions (`drain-all`,
 *     `rotate-all`), which name a decision rather than a subject.
 *
 * DIRECTION is not encoded in the verb. There is no `node.undrain` or
 * `node.resume`: pause/disable/drain each record one action and carry the
 * transition in `details.before` / `details.after`, following
 * `tenant_job_runtime_audit`, whose whole vocabulary is likewise
 * six verbs plus a before/after delta. Paired verbs would double the list
 * and still not answer "what changed".
 *
 * `heartbeat` is deliberately absent: one row per node per 30s is not an
 * audit trail, it is a firehose that buries the rows an operator came to
 * read. So are the two housekeeping CASes (`sweepOffline`,
 * `casTripDailyCeiling`) — a clock and an idempotency key, not decisions.
 */
export type FleetAuditAction =
	| 'kill-switch.stop'
	| 'kill-switch.clear'
	| 'drain-all'
	| 'cancel-in-flight'
	/** Owner minted a one-time enrollment token (a node row is created). */
	| 'node.create'
	/** A machine consumed a token and became `online` (actor: the node). */
	| 'node.enroll'
	/** Owner revoked an outstanding, never-used enrollment token. */
	| 'node.token-revoke'
	/** Owner re-keyed a node: new one-time token, old secret dead at once. */
	| 'node.rotate'
	/** The node rotated ITSELF with its current credential (dual-accept window). */
	| 'node.rotate-self'
	/** Owner queued a rotation on every node of the fleet. */
	| 'rotate-all'
	| 'node.rename'
	| 'node.capabilities'
	/** Per-node daily model-spend ceiling set or cleared. */
	| 'node.cost-ceiling'
	/** Per-node resource-limit ceiling set or cleared (self-build slice AS). */
	| 'node.limits'
	/** Owner cleared a model usage-limit throttle on a node before its reset. */
	| 'node.model-throttle-clear'
	/** Pause / resume — by the owner, or by the node itself. */
	| 'node.pause'
	/** Disable / re-enable (the owner's harder stop). */
	| 'node.disable'
	/** Drain: disable AND requeue the node's in-flight claims. */
	| 'node.drain'
	/** Owner deleted the registration. */
	| 'node.delete'
	/** The node retired its own registration (actor: the node). */
	| 'node.unenroll'
	| 'affinity.set'
	| 'affinity.clear'
	| 'execution-preference.set'
	| 'execution-preference.clear'
	/** Agent computers — someone opened a live view of a node. */
	| 'computer.session-open'
	/** A live view ended, with its close reason. */
	| 'computer.session-close'
	/** Someone took control of a node. */
	| 'computer.control-grant'
	/** Control was given back or released automatically. */
	| 'computer.control-release'
	/** A take-over was refused (policy or an existing holder). */
	| 'computer.control-refused'
	/** A recorded demonstration started. */
	| 'computer.teach-start'
	/** A recorded demonstration finished. */
	| 'computer.teach-finish'
	/** One Agent's logins and files on one node were reset. */
	| 'computer.profile-reset'
	/**
	 * Fleet node link (FL-02, CONTRACTS §7) — the consents a node reports
	 * changed between two heartbeats (actor: the node). `details.before` /
	 * `details.after` carry the two consent sets.
	 */
	| 'node.consent.change'
	/** A node's link was accepted (actor: the node; informational). */
	| 'node.link.connect'
	/** A node's link closed, with its reason (actor: the node; informational). */
	| 'node.link.disconnect'
	/** A channel in a state-changing family was opened on a node's link (family, target, requestedBy). */
	| 'node.link.channel-open'
	/**
	 * Fleet hub (FL-01) — the owner changed one action family's audience on a
	 * node's control policy (CONTRACTS §2.1, §7). One row per family changed;
	 * details carry `family`, `from`, `to` — never a member's name.
	 */
	| 'node.policy.change'
	/**
	 * Computer health (FL-03, CONTRACTS §7) — someone woke an offline computer
	 * through a sibling on its network. One row per attempt; details carry
	 * `target`, `via` (the sibling's id) and `outcome` (`sent` · `refused`).
	 */
	| 'node.wake'
	/**
	 * Sessions on computers (FL-04, CONTRACTS §7) — every row carries
	 * `family: 'sessions'`, `target` (the session id), `requestedBy`,
	 * `confirmationClass` and `outcome`; never terminal bytes, typed input
	 * or the first message (spec FR-36).
	 */
	| 'node.session.start'
	/** Someone attached as a viewer or a driver (one row per attach, with the role). */
	| 'node.session.attach'
	/** One driver span — written once when it ends, with its start, end and byte count; never per keystroke. */
	| 'node.session.input'
	/** A prompt was answered (FL-05 writes it). */
	| 'node.session.answer'
	| 'node.session.rename'
	/** A new session replaced an ended one (`restartOf`, the new session id). */
	| 'node.session.restart'
	/** A session was ended, with its reason. */
	| 'node.session.end'
	| 'node.session.recording.start'
	| 'node.session.recording.stop'
	/**
	 * Session git & actions (FL-06, CONTRACTS §7): an action prompt was typed
	 * into a session (`action`, a redacted 200-character `promptPreview`, the
	 * delivery) — an owner session's ledger is read back from these rows (R-38).
	 */
	| 'node.session.action'
	/** A pull request was opened or updated for a session's checkout (platform-side, never a merge). */
	| 'node.session.pull-request.open'
	/**
	 * Logs on computers (FL-08, CONTRACTS §7) — someone read a log source
	 * (one row per open or one-shot read) or started following it. Details
	 * carry `source` (the source id), `kind`, `requestedBy`, `lines`,
	 * `redactions`, `confirmationClass: 'plain'` and `outcome`; never a log
	 * line (spec FR-27).
	 */
	| 'node.logs.read'
	| 'node.logs.follow'
	/**
	 * Commands on computers (FL-12, CONTRACTS §7) — one row per computer a
	 * Command ran on (or was refused on), with `family: 'commands'`, `target`
	 * (the Command id), `runId`, `requestedBy`, `confirmationClass: 'confirm'`,
	 * `outcome`, the exit code, the duration and whether output was truncated;
	 * never the command's output and never the command line (spec FR-12, FR-13).
	 */
	| 'node.command.run'
	/** A running Command was stopped on a computer, with its `reason` (user, kill switch, drain). */
	| 'node.command.cancel'
	/**
	 * Services, Docker, Compose and processes (FL-09, CONTRACTS §7) — one row
	 * per act, refused ones included (`outcome: 'refused'`). `details` carry
	 * `family`, `target` (service name, container or image id, project, pid),
	 * `requestedBy`, `confirmationClass`, `outcome`, `blastRadiusKind` when the
	 * node warned and `rootRequired`; never an environment value, a command
	 * line or command output (spec FR-18, FR-29).
	 */
	| 'node.service.start'
	| 'node.service.stop'
	| 'node.service.restart'
	| 'node.service.enable'
	| 'node.service.disable'
	| 'node.docker.container.start'
	| 'node.docker.container.stop'
	| 'node.docker.container.restart'
	| 'node.docker.container.remove'
	| 'node.docker.container.run'
	| 'node.docker.container.exec'
	| 'node.docker.image.pull'
	| 'node.docker.image.remove'
	| 'node.docker.image.prune'
	| 'node.compose.up'
	| 'node.compose.down'
	| 'node.compose.restart'
	| 'node.compose.pull'
	/** A Stop (SIGTERM) or Kill (SIGKILL) sent to one process; `details.signal` names which. */
	| 'node.process.signal'
	/**
	 * Checkouts on computers (FL-14, CONTRACTS §7) — every row carries
	 * `family: 'checkouts'`, `target` (the checkout's path), `requestedBy`,
	 * `confirmationClass` and `outcome`; never a credential or a remote URL
	 * with one (spec FR-28).
	 */
	| 'node.checkout.create'
	/** A checkout was deleted (folder removed) or forgotten (row only). */
	| 'node.checkout.delete'
	/** Fetch, pull, push — and a person's rescan of the code folders. */
	| 'node.checkout.sync'
	/** Moved to the bin (folder untouched). */
	| 'node.checkout.archive'
	/** Brought back from the bin. */
	| 'node.checkout.restore'
	/**
	 * Servers and ports (FL-10, CONTRACTS §7) — one row per **Open** (port,
	 * `target: desktop | preview-profile`, program or container, requester,
	 * class `plain`; never a URL query or page content). An open on the desktop
	 * from the Ports tab writes only this, never FL-07's `node.desktop.openUrl`.
	 */
	| 'node.port.open'
	/** A preview tunnel opened (phase 2) — one row per tunnel, never per request (R-17). */
	| 'node.port.preview.open'
	/** A preview tunnel closed, with the reason, the precise trigger, the request count and the bytes. */
	| 'node.port.preview.close'
	/**
	 * Tasks on computers (FL-15 P2, CONTRACTS §7) — **Use my Ever Works
	 * identity** set a computer's global git `user.name` / `user.email`.
	 * `details.fields` names what was set; never the email value (spec FR-15).
	 */
	| 'node.git.identity.set';

export const FLEET_AUDIT_ACTIONS: readonly FleetAuditAction[] = [
	'kill-switch.stop',
	'kill-switch.clear',
	'drain-all',
	'cancel-in-flight',
	'node.create',
	'node.enroll',
	'node.token-revoke',
	'node.rotate',
	'node.rotate-self',
	'rotate-all',
	'node.rename',
	'node.capabilities',
	'node.cost-ceiling',
	'node.limits',
	'node.model-throttle-clear',
	'node.pause',
	'node.disable',
	'node.drain',
	'node.delete',
	'node.unenroll',
	'affinity.set',
	'affinity.clear',
	'execution-preference.set',
	'execution-preference.clear',
	'computer.session-open',
	'computer.session-close',
	'computer.control-grant',
	'computer.control-release',
	'computer.control-refused',
	'computer.teach-start',
	'computer.teach-finish',
	'computer.profile-reset',
	'node.consent.change',
	'node.link.connect',
	'node.link.disconnect',
	'node.link.channel-open',
	'node.policy.change',
	'node.wake',
	'node.session.start',
	'node.session.attach',
	'node.session.input',
	'node.session.answer',
	'node.session.rename',
	'node.session.restart',
	'node.session.end',
	'node.session.recording.start',
	'node.session.recording.stop',
	'node.session.action',
	'node.session.pull-request.open',
	'node.logs.read',
	'node.logs.follow',
	'node.command.run',
	'node.command.cancel',
	'node.service.start',
	'node.service.stop',
	'node.service.restart',
	'node.service.enable',
	'node.service.disable',
	'node.docker.container.start',
	'node.docker.container.stop',
	'node.docker.container.restart',
	'node.docker.container.remove',
	'node.docker.container.run',
	'node.docker.container.exec',
	'node.docker.image.pull',
	'node.docker.image.remove',
	'node.docker.image.prune',
	'node.compose.up',
	'node.compose.down',
	'node.compose.restart',
	'node.compose.pull',
	'node.process.signal',
	'node.checkout.create',
	'node.checkout.delete',
	'node.checkout.sync',
	'node.checkout.archive',
	'node.checkout.restore',
	'node.port.open',
	'node.port.preview.open',
	'node.port.preview.close',
	'node.git.identity.set'
];

/**
 * The stop flag as any signed-in user may read it (`GET /api/fleet/kill-switch`).
 *
 * `unverified: true` means the flag could NOT be read — the row is
 * missing (migration not applied) or the query failed — and dispatch is
 * refusing on that basis. The banner renders that case distinctly so an
 * operator does not go looking for who threw the switch.
 */
export interface FleetKillSwitchState {
	stopped: boolean;
	reason: string | null;
	/** ISO timestamp of the last set/clear, or null when never set. */
	since: string | null;
	unverified: boolean;
}

/** Admin projection: the public state plus who last changed it. */
export interface FleetKillSwitchAdminState extends FleetKillSwitchState {
	setByUserId: string | null;
}

/** Result of an admin stop / clear. */
export interface FleetKillSwitchChangeResult {
	state: FleetKillSwitchAdminState;
	/** False when the switch was already in the requested position. */
	changed: boolean;
	/** The switch flipped but the audit row could not be written (logged). */
	auditFailed: boolean;
}

/** One `fleet_audit` row on the wire. */
export interface FleetAuditView {
	id: string;
	action: FleetAuditAction | string;
	actorUserId: string | null;
	ownerUserId: string | null;
	nodeId: string | null;
	details: Record<string, unknown> | null;
	occurredAt: string | null;
}

/** `POST /api/fleet/drain-all` result. */
export interface FleetDrainAllResult {
	/** Nodes disabled by this call. */
	drainedNodes: number;
	/** Nodes left alone: still enrolling, already disabled, or a per-node failure. */
	skippedNodes: number;
	/** In-flight claims returned to the queue across every drained node. */
	releasedJobs: number;
	/** The caller's enrolled nodes after the drain. */
	nodes: FleetNodeView[];
	/** The drain happened but the audit row could not be written (logged). */
	auditFailed: boolean;
}

/**
 * `POST /api/fleet/rotate-all` result — credential rotation QUEUED across
 * the owner's fleet.
 *
 * Nothing is rotated here and no credential is minted: the call marks
 * every eligible node, and each machine rotates ITSELF on its next beat
 * through `POST /api/fleet/rotate-credential`. That is the whole point —
 * an operator with six machines on six desks cannot be at six keyboards,
 * and a rotation that requires them to be simply never happens.
 */
export interface FleetRotateAllResult {
	/** Nodes marked for rotation by this call. */
	queuedNodes: number;
	/** Nodes left alone: still `enrolling` (no secret to rotate yet). */
	skippedNodes: number;
	/** The caller's enrolled nodes after the marking. */
	nodes: FleetNodeView[];
	/** The marking happened but the audit row could not be written (logged). */
	auditFailed: boolean;
}

/** The per-job outcome states `FleetJobService.cancel` reports. */
export type FleetJobCancelState = 'queued-dropped' | 'cancel-requested' | 'terminal' | 'not-found';

export const FLEET_JOB_CANCEL_STATES: readonly FleetJobCancelState[] = [
	'queued-dropped',
	'cancel-requested',
	'terminal',
	'not-found'
];

/** `POST /api/fleet/cancel-in-flight` result. */
export interface FleetCancelInFlightResult {
	/** Jobs the call looked at. */
	requested: number;
	/** Jobs whose course was changed (dropped or flagged for the node). */
	cancelled: number;
	/** Agent runs flipped to `cancelled` alongside their job. */
	runsCancelled: number;
	byState: Record<FleetJobCancelState, number>;
	/** Ids of the jobs the call touched (bounded). */
	jobIds: string[];
	/** The cancel happened but the audit row could not be written (logged). */
	auditFailed: boolean;
}

/** Cap on `FleetCancelInFlightResult.jobIds` / audit `jobIds`. */
export const FLEET_CANCEL_IN_FLIGHT_MAX_IDS = 200;
