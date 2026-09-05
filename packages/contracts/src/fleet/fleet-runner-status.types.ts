/**
 * Runner status — the compact "is my local runner up?" projection behind
 * the always-visible sidebar pill.
 *
 * ## Why this is not just `GET /api/fleet/nodes`
 *
 * The node list is a settings-page payload: it carries capability tag
 * sets, cluster-sourced rows, enrollment metadata and a per-node job
 * history hook. The pill polls every 30 seconds from every dashboard
 * page, for every signed-in user, whether or not they own a runner. It
 * needs a handful of scalars and a short per-node row, and it needs the
 * shape to stay stable while the settings view grows.
 *
 * So this is a deliberately NARROW read model over the same data, not a
 * second source of truth: the API edge composes it from the very same
 * `FleetService.listForUser` + `FleetJobService.loadByNodeForUser` pair
 * the settings list uses, which is what keeps "3 of 4 online" in the
 * pill and the table from ever disagreeing.
 *
 * Cluster-sourced (`kind: 'k8s'`) nodes are EXCLUDED: they are not
 * runners the platform leases work onto, and counting them would make
 * the pill claim capacity that cannot execute anything.
 */

import type { FleetJobKind } from './fleet-jobs.types.js';
import type { FleetNodeKind, FleetNodeStatus, FleetNodeWorkerState } from './fleet-node.types.js';

/**
 * How often the pill re-reads runner status. Shipped in the payload
 * rather than hard-coded in the component so the server can slow every
 * client down at once if the read ever becomes expensive, and so the
 * "Refreshes every 30s" caption cannot drift from the actual cadence.
 */
export const FLEET_RUNNER_STATUS_REFRESH_SEC = 30;

/** Floor/ceiling clamps applied to any operator-configured cadence. */
export const FLEET_RUNNER_STATUS_MIN_REFRESH_SEC = 5;
export const FLEET_RUNNER_STATUS_MAX_REFRESH_SEC = 600;

/** One runner row in the pill's popover. */
export interface FleetRunnerNodeView {
	id: string;
	name: string;
	kind: FleetNodeKind;
	/** Registry status. `busy` is derived separately — see {@link busy}. */
	status: FleetNodeStatus;
	/** ISO timestamp of the last accepted heartbeat, or null. */
	lastHeartbeatAt: string | null;
	/** The node daemon's own version (`fleet_nodes.version`). */
	daemonVersion: string | null;
	/** Version of the agent CLI installed on the machine. */
	cliVersion: string | null;
	/** Free bytes on the node's workspace volume. */
	diskFreeBytes: number | null;
	/**
	 * Which account / seat the machine's agent CLI is logged in as (a
	 * display label, never a credential), or null when never reported.
	 */
	modelIdentity: string | null;
	/**
	 * True when the node currently holds at least one live job claim.
	 *
	 * Deliberately NOT a {@link FleetNodeStatus} value: busy is a
	 * property of the JOB table (a live lease), while status is a
	 * property of the REGISTRY (heartbeat + operator intent). Collapsing
	 * them would mean a node that finishes a job has to wait for a
	 * heartbeat to look idle again, and an operator pausing a busy node
	 * would lose one of the two facts.
	 */
	busy: boolean;
	/** Jobs this node currently holds a live claim on. */
	activeJobCount: number;
	/** Kind of the oldest live claim, or null when idle. */
	currentJobKind: FleetJobKind | null;
	/**
	 * What the node's WORKER last reported doing, or null when unknown.
	 *
	 * `status` alone cannot answer "will this machine take my job": a
	 * self-quarantined node keeps beating and reads `online` while
	 * refusing every lease. That is why availability counts a node as
	 * FREE only when its worker state is not one of the refusing ones —
	 * see `FleetRunnerStatusService.availability`.
	 */
	workerState?: FleetNodeWorkerState | null;
	/** Why the worker is in that state (quarantine / throttle reason), or null. */
	workerStateReason?: string | null;
}

/** `GET /api/fleet/runner-status` — the whole pill payload. */
export interface FleetRunnerStatusView {
	/** Enrolled runners this owner has (cluster nodes excluded). */
	total: number;
	/** Of those, how many are `online`. */
	online: number;
	/** Of the online ones, how many hold a live job claim. */
	busy: number;
	/** Runners that are neither online nor mid-enrollment. */
	offline: number;
	/** Runners drained by their owner (`paused` or `disabled`). */
	drained: number;
	/** Poll cadence the client should use, in seconds. */
	refreshIntervalSec: number;
	/**
	 * True when the per-node job load could not be read at all. The rows
	 * still render (with `busy: false`) — a job-runtime hiccup must not
	 * make a live runner look missing, exactly as on the settings page.
	 */
	loadUnavailable: boolean;
	nodes: FleetRunnerNodeView[];
}

/**
 * Summary state the pill renders as one word. Pure so the API, the web
 * tier and any test agree on the wording rule instead of three
 * hand-written ternaries.
 *
 * - `none`    — the owner has no enrolled runner at all (the pill hides).
 * - `offline` — runners exist but none is online.
 * - `busy`    — every online runner is holding work.
 * - `online`  — at least one online runner has a free slot.
 */
export type FleetRunnerSummaryState = 'none' | 'offline' | 'busy' | 'online';

export function summarizeRunnerStatus(status: {
	total: number;
	online: number;
	busy: number;
}): FleetRunnerSummaryState {
	if (status.total <= 0) return 'none';
	if (status.online <= 0) return 'offline';
	if (status.busy >= status.online) return 'busy';
	return 'online';
}
