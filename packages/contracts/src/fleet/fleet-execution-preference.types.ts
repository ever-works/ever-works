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

/** Why a run that asked for the fleet ended up somewhere else. */
export type FleetFallbackReason =
	/** No enrolled runner at all. */
	| 'no-runners'
	/** Runners exist, but none is online. */
	| 'runners-offline'
	/** Every online runner is already holding work. */
	| 'runners-busy';

/** The router's verdict for one dispatch. */
export interface FleetRunRoutingDecision {
	target: FleetRunTarget;
	mode: FleetExecutionMode;
	/** Set only when `target === 'cloud'` after a local preference. */
	fallbackReason?: FleetFallbackReason;
	/** Set only when `target === 'fleet-waiting'`. */
	queuedReason?: typeof QUEUED_REASON_WAITING_FOR_RUNNER;
}

/** Snapshot of runner availability the routing rule reads. */
export interface FleetRunnerAvailability {
	/** Enrolled runners this owner has. */
	total: number;
	/** Of those, currently online. */
	online: number;
	/** Online runners with no live job claim. */
	free: number;
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
	const fallbackReason: FleetFallbackReason =
		availability.total <= 0 ? 'no-runners' : availability.online <= 0 ? 'runners-offline' : 'runners-busy';
	if (mode === 'local-wait') {
		// The whole point of the mode: hold the work for the machine that
		// is supposed to run it, and make the waiting visible instead of
		// silently relocating a run whose correctness depends on WHERE it
		// executes.
		return { target: 'fleet-waiting', mode, queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER };
	}
	return { target: 'cloud', mode, fallbackReason };
}
