/**
 * Execution routing preference — "run this on my machine, or in the
 * cloud?", expressed per Work / per Goal rather than only per tenant.
 *
 * ## What existed before
 *
 * The fleet was selected by ONE instance-global environment variable
 * (`EVER_WORKS_JOB_RUNTIME`) overlaid by ONE per-tenant row
 * (`tenant_job_runtime_config`). That answers "which runtime does this
 * whole tenant use", and nothing finer. There was no way to say "the
 * nightly content refresh can go to the cloud, but the repo-touching
 * Work runs on the laptop that holds the checkout" — and, more sharply,
 * no way to express what should happen when the local runner is BUSY.
 *
 * ## The three modes
 *
 * - `local-wait`     — the fleet, always. If no runner is free the job
 *                      waits in the fleet queue with
 *                      {@link QUEUED_REASON_WAITING_FOR_RUNNER}. Never
 *                      falls back. This is the mode for work that is
 *                      only correct on that machine (it holds the
 *                      checkout, the credentials, the GPU).
 * - `local-fallback` — prefer the fleet, but hand the run to the
 *                      platform runtime when no runner can take it, and
 *                      SAY SO (a fallback notification). The default,
 *                      because it is the only mode whose failure state
 *                      is "slower/elsewhere" rather than "nothing ran".
 * - `cloud`          — the platform runtime, always. An explicit opt-out
 *                      for a tenant that has runners but does not want
 *                      this Work on them.
 *
 * ## Resolution
 *
 * Narrowest wins: Work → Goal → user default → {@link DEFAULT_FLEET_EXECUTION_MODE}.
 * A Work-scoped row beats a Goal-scoped one because a Work is the
 * narrower statement about the same run, and both beat the account-wide
 * default. See {@link resolveFleetExecutionMode} — the rule is a pure
 * function precisely so the router, the API and the settings UI cannot
 * each grow their own version of it.
 *
 * Note the layering: this preference decides FLEET-vs-CLOUD for a run
 * whose tenant already has the fleet available. It never turns the fleet
 * on for a tenant whose resolved runtime is not `node`, and it never
 * overrides the `FLEET_NODE_RUNTIME_ENABLED` kill switch — an operator
 * draining the fleet still wins over every preference row.
 */

/** Where a run should execute. */
export type FleetExecutionMode = 'local-wait' | 'local-fallback' | 'cloud';

/** Canonical mode list — one source of truth for validators and UI. */
export const FLEET_EXECUTION_MODES: readonly FleetExecutionMode[] = ['local-wait', 'local-fallback', 'cloud'];

/**
 * Mode applied when nothing is configured at any scope.
 *
 * `local-fallback` rather than `local-wait`: an unconfigured account
 * that happens to select the fleet runtime must not acquire a new way to
 * have runs sit forever because a laptop is closed.
 */
export const DEFAULT_FLEET_EXECUTION_MODE: FleetExecutionMode = 'local-fallback';

/** Type guard for a mode arriving off the wire. */
export function isFleetExecutionMode(value: unknown): value is FleetExecutionMode {
	return typeof value === 'string' && (FLEET_EXECUTION_MODES as readonly string[]).includes(value);
}

/** True when the mode routes to the fleet at all. */
export function isLocalExecutionMode(mode: FleetExecutionMode): boolean {
	return mode === 'local-wait' || mode === 'local-fallback';
}

/** What a preference row is attached to. */
export type FleetExecutionScopeType = 'user' | 'work' | 'goal';

/** Canonical scope list. Ordered NARROWEST FIRST — resolution reads it. */
export const FLEET_EXECUTION_SCOPE_TYPES: readonly FleetExecutionScopeType[] = ['work', 'goal', 'user'];

/**
 * Stamped on a fleet job (and reported by the router) when the job was
 * enqueued with no runner able to take it right now.
 *
 * A short machine token, never free text — the same discipline
 * `agent_runs.queuedReason` follows, so a UI can switch on it and a log
 * search can find every occurrence.
 */
export const QUEUED_REASON_WAITING_FOR_RUNNER = 'waiting-for-runner';

/** Wire view of one stored preference row. */
export interface FleetExecutionPreferenceView {
	id: string;
	scopeType: FleetExecutionScopeType;
	/** The Work / Goal id. Always null for the account-wide row. */
	scopeId: string | null;
	mode: FleetExecutionMode;
	createdAt: string | null;
	updatedAt: string | null;
}

/** The scope a run is being resolved for. Both ids are optional. */
export interface FleetExecutionScopeQuery {
	workId?: string | null;
	goalId?: string | null;
}

/**
 * Apply the narrowest-wins rule to a set of preference rows.
 *
 * Pure and total: an empty set, unknown scope types and rows for other
 * Works all collapse to {@link DEFAULT_FLEET_EXECUTION_MODE} rather than
 * throwing. Routing a run must never fail because a preference lookup
 * was surprising.
 */
export function resolveFleetExecutionMode(
	preferences: readonly FleetExecutionPreferenceView[] | null | undefined,
	scope: FleetExecutionScopeQuery = {}
): FleetExecutionMode {
	if (!Array.isArray(preferences) || preferences.length === 0) {
		return DEFAULT_FLEET_EXECUTION_MODE;
	}
	const match = (scopeType: FleetExecutionScopeType, scopeId: string | null): FleetExecutionMode | null => {
		const row = preferences.find(
			(entry) =>
				entry &&
				entry.scopeType === scopeType &&
				(entry.scopeId ?? null) === scopeId &&
				isFleetExecutionMode(entry.mode)
		);
		return row ? row.mode : null;
	};
	const workId = scope.workId ?? null;
	const goalId = scope.goalId ?? null;
	return (
		(workId ? match('work', workId) : null) ??
		(goalId ? match('goal', goalId) : null) ??
		match('user', null) ??
		DEFAULT_FLEET_EXECUTION_MODE
	);
}

/**
 * Where a routing decision sent (or would send) a run.
 *
 * `wait` is NOT a third destination: the job goes to the fleet either
 * way. It records that the fleet accepted it with nothing able to run it
 * yet, which is the difference the operator actually needs to see.
 */
export type FleetRunTarget = 'fleet' | 'fleet-waiting' | 'cloud';

/**
 * Why a run that asked for the fleet ended up somewhere else.
 *
 * The first three describe the owner's fleet as a whole. The last two
 * exist because a job is not judged against the whole fleet (self-build
 * slice S / EW-775): an `agent-task` may be PINNED to one node by an
 * Agent affinity, and every job carries capability tags. Availability is
 * computed over the ELIGIBLE set — the nodes that could actually take
 * this job — so five idle siblings can no longer make a job pinned to a
 * closed laptop look placeable.
 */
export type FleetFallbackReason =
	/** No enrolled runner at all. */
	| 'no-runners'
	/** Runners exist, but none is online. */
	| 'runners-offline'
	/** Every online runner is already holding work. */
	| 'runners-busy'
	/**
	 * Runners are enrolled, but none could take THIS job: the Agent is
	 * pinned to a node that is no longer enrolled, or no node advertises
	 * the capability tags the job requires.
	 */
	| 'no-eligible-runners'
	/** The Agent is pinned to one node and that node is not online. */
	| 'pinned-runner-offline';

/** Canonical fallback-reason list — one source of truth for notices, sanitizers and tests. */
export const FLEET_FALLBACK_REASONS: readonly FleetFallbackReason[] = [
	'no-runners',
	'runners-offline',
	'runners-busy',
	'no-eligible-runners',
	'pinned-runner-offline'
];

/** The router's verdict for one dispatch. */
export interface FleetRunRoutingDecision {
	target: FleetRunTarget;
	mode: FleetExecutionMode;
	/** Set only when `target === 'cloud'` after a local preference. */
	fallbackReason?: FleetFallbackReason;
	/**
	 * Enrolled runners the owner had when this decision was taken. Set
	 * alongside {@link fallbackReason}, because the fallback notice
	 * reports it and the decision is the only place that saw the
	 * availability snapshot — a caller downstream can only guess, and a
	 * guessed count in a stored notification is worse than none.
	 */
	runnerCount?: number;
	/**
	 * Every enrolled runner the owner had, when {@link runnerCount} was
	 * computed over an eligible subset. Set alongside {@link fallbackReason}
	 * only when the availability snapshot carried `fleetTotal`; equal to
	 * `runnerCount` when the counts were already fleet-wide.
	 */
	fleetRunnerCount?: number;
	/** The node the job was pinned to, when the decision was taken against one. Fallback decisions only. */
	pinnedNodeId?: string;
	/** Set only when `target === 'fleet-waiting'`. */
	queuedReason?: typeof QUEUED_REASON_WAITING_FOR_RUNNER;
}

/**
 * Snapshot of runner availability the routing rule reads.
 *
 * The three counts describe the runners that could take THE JOB BEING
 * ROUTED. With no eligibility filter that is the whole fleet, and the
 * shape is exactly the three-field one it always was. When the caller
 * narrowed the set — an Agent affinity pins the job to one node, or the
 * job requires capability tags — the counts are over that subset and
 * `fleetTotal` / `pinnedNodeId` say so, which is what lets the fallback
 * reason and the stored notice be precise instead of "1 of 6 offline".
 */
export interface FleetRunnerAvailability {
	/** Eligible runners this owner has (every enrolled runner when unfiltered). */
	total: number;
	/** Of those, currently online. */
	online: number;
	/** Online runners with no live job claim. */
	free: number;
	/**
	 * Every enrolled runner the owner has, regardless of eligibility.
	 * Absent when the counts above are already fleet-wide.
	 */
	fleetTotal?: number;
	/** The node the job is pinned to, when an affinity narrowed the set to one. */
	pinnedNodeId?: string | null;
}

/**
 * The routing rule, as a pure function of (mode, availability).
 *
 * Extracted from the router service so the whole matrix is unit-testable
 * without a DI graph, a database or a fleet — and so the service cannot
 * accidentally grow a branch the tests never see.
 */
export function decideFleetRouting(
	mode: FleetExecutionMode,
	availability: FleetRunnerAvailability
): FleetRunRoutingDecision {
	if (mode === 'cloud') {
		return { target: 'cloud', mode };
	}
	if (availability.free > 0) {
		return { target: 'fleet', mode };
	}
	const fallbackReason = classifyFallback(availability);
	if (mode === 'local-wait') {
		// The whole point of the mode: hold the work for the machine that
		// is supposed to run it, and make the waiting visible instead of
		// silently relocating a run whose correctness depends on WHERE it
		// executes.
		return { target: 'fleet-waiting', mode, queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER };
	}
	const decision: FleetRunRoutingDecision = {
		target: 'cloud',
		mode,
		fallbackReason,
		runnerCount: availability.total
	};
	// Only echoed when the snapshot carried them, so an unfiltered
	// (fleet-wide) snapshot yields exactly the decision it always did.
	if (typeof availability.fleetTotal === 'number') {
		decision.fleetRunnerCount = availability.fleetTotal;
	}
	if (availability.pinnedNodeId) {
		decision.pinnedNodeId = availability.pinnedNodeId;
	}
	return decision;
}

/**
 * Name the reason nothing could take the job. Precedence is the original
 * one (`total`, then `online`, then busy) with the two eligibility-aware
 * refinements slotted in where they are the more precise statement:
 *
 *   - no eligible runner while the fleet has runners at all is
 *     `no-eligible-runners`, not `no-runners` — "enrol a machine" would be
 *     the wrong advice for an owner with six of them;
 *   - the eligible set being exactly the pinned node, and it being down,
 *     is `pinned-runner-offline` — the actionable fact is WHICH machine.
 */
function classifyFallback(availability: FleetRunnerAvailability): FleetFallbackReason {
	const fleetTotal = typeof availability.fleetTotal === 'number' ? availability.fleetTotal : availability.total;
	if (availability.total <= 0) {
		return fleetTotal > 0 ? 'no-eligible-runners' : 'no-runners';
	}
	if (availability.online <= 0) {
		return availability.pinnedNodeId ? 'pinned-runner-offline' : 'runners-offline';
	}
	return 'runners-busy';
}
