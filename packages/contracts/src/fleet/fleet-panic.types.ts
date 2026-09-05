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
 * an enum so slice AQ can extend the log without a type-altering
 * migration.
 */
export type FleetAuditAction = 'kill-switch.stop' | 'kill-switch.clear' | 'drain-all' | 'cancel-in-flight';

export const FLEET_AUDIT_ACTIONS: readonly FleetAuditAction[] = [
	'kill-switch.stop',
	'kill-switch.clear',
	'drain-all',
	'cancel-in-flight'
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
