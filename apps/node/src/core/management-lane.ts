import {
	FLEET_MANAGEMENT_LANE_CONSENT,
	FLEET_MANAGEMENT_LANE_KINDS,
	fleetManagementLaneKindsFor,
	type FleetConsents,
	type FleetJobKind,
	type FleetManagementLaneConsent
} from '@ever-works/contracts';
import type { JobExecutor } from './worker-loop';

/**
 * Fleet node link (FL-02, T-27, CONTRACTS R-34) — the node's MANAGEMENT lane:
 * a third lease loop, modelled on the attended live-view lane, for machine
 * jobs (VMs under `--manage`, Actions runners under `--work`, the usage scan
 * under `--usage-scan`). It leases only the kinds later epics register for it
 * and only while the consent each needs is on; it runs one job at a time,
 * OUTSIDE `--concurrency` (an Agent's work never waits behind a VM create, and
 * a VM create never takes an Agent's slot); and the work lane never leases its
 * kinds.
 *
 * FL-02 ships the lane with NO kinds: {@link MANAGEMENT_LANE_EXECUTORS} is
 * empty and so is contracts' `FLEET_MANAGEMENT_LANE_KINDS`, so no node starts
 * it. Each later epic adds ONE entry below (and its kind + consent in
 * contracts) — no edit to the runtime.
 */

/** One management-lane job kind and how this node runs it. */
export interface ManagementLaneExecutor {
	kind: FleetJobKind;
	run: JobExecutor;
}

/**
 * The compile-time list (README D8): FL-16 (`vm-create`, `vm-control`), FL-18
 * (`runner-install`, `runner-control`) and FL-20 (`usage-scan`) append here.
 */
export const MANAGEMENT_LANE_EXECUTORS: readonly ManagementLaneExecutor[] = [];

/** Jobs the lane runs at once — machine jobs are serial on one machine. */
export const MANAGEMENT_LANE_CONCURRENCY = 1;

/** Lease requested for a management job; renewed by the worker loop while it runs. */
export const MANAGEMENT_LANE_LEASE_TTL_SEC = 300;

/** How often an idle management lane polls (machine jobs are rare and never urgent). */
export const MANAGEMENT_LANE_IDLE_POLL_MS = 30_000;

/** What the runtime decides about the lane from the tables and this process's consents. */
export interface ManagementLanePlan {
	/** Kinds the lane leases (consent on AND an executor here). Empty → the lane is not started. */
	kinds: FleetJobKind[];
	/** Every kind the lane OWNS, whatever the consents: the work lane excludes all of them. */
	ownedKinds: FleetJobKind[];
	/** The executor for each leased kind. */
	executors: ManagementLaneExecutor[];
}

export interface ManagementLaneTables {
	/** The lane's kinds; contracts' list by default. */
	kinds?: readonly FleetJobKind[];
	/** The consent each kind needs; contracts' table by default. */
	consents?: Readonly<Partial<Record<FleetJobKind, FleetManagementLaneConsent>>>;
	/** The executors this node has; {@link MANAGEMENT_LANE_EXECUTORS} by default. */
	executors?: readonly ManagementLaneExecutor[];
}

/**
 * Plan the lane for this process. A kind is leased only when it is one of the
 * lane's kinds, its consent is on, and this node has an executor for it — a
 * kind without an executor would be leased and then failed. The work lane
 * excludes every kind the lane owns (listed kinds and executor kinds alike),
 * so a management job can never take an Agent's slot even with its consent off.
 */
export function planManagementLane(consents: FleetConsents, tables: ManagementLaneTables = {}): ManagementLanePlan {
	const listed = tables.kinds ?? FLEET_MANAGEMENT_LANE_KINDS;
	const executors = tables.executors ?? MANAGEMENT_LANE_EXECUTORS;
	const table = tables.consents ?? FLEET_MANAGEMENT_LANE_CONSENT;
	const byKind = new Map<FleetJobKind, ManagementLaneExecutor>();
	for (const executor of executors) {
		if (listed.includes(executor.kind) && !byKind.has(executor.kind)) byKind.set(executor.kind, executor);
	}
	const kinds = fleetManagementLaneKindsFor(consents, listed, table).filter((kind) => byKind.has(kind));
	const ownedKinds: FleetJobKind[] = [];
	for (const kind of [...listed, ...executors.map((executor) => executor.kind)]) {
		if (!ownedKinds.includes(kind)) ownedKinds.push(kind);
	}
	return { kinds, ownedKinds, executors: kinds.map((kind) => byKind.get(kind)!) };
}
