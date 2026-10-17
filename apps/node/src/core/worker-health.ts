import {
	describeFleetModelUsageLimitWindow,
	FLEET_MAX_WORKER_STATE_REASON_LENGTH,
	type FleetNodeWorkerState
} from '@ever-works/contracts';
import type { WorkerLoopState } from './worker-loop';

/**
 * What the heartbeat says about the worker (fleet health signals, EW-776,
 * finding OPS-02).
 *
 * The defect this closes, precisely: a node that had self-quarantined —
 * the durable worker safety marker, set when a job's process tree could
 * not be proven dead, surviving restarts and clearable only at that
 * keyboard — kept heartbeating and therefore kept reading `online` in
 * Fleet, while refusing every job it was offered. Under the runbook's
 * recommended `local-wait` there is no cloud fallback either, so there
 * was no notification of any kind. The machine was, from the platform's
 * point of view, perfectly healthy and perfectly idle.
 *
 * This is a pure PROJECTION of {@link WorkerLoopState} onto the five
 * values the wire contract knows, and it lives in its own file for the
 * same reason `describeSelf`'s probes do: it is the one piece of the
 * health signal that has real logic in it, and it should be testable
 * without a loop, a client or a host.
 *
 * The mapping collapses the loop's INTERNAL vocabulary on purpose. The
 * loop distinguishes `polling` from `idle` and `draining` from `paused`
 * because an operator watching the local process needs to; the platform
 * does not — for the fleet the question is only "will this machine take
 * my job, and if not, why not". Adding those names to the contract would
 * be leaking an implementation detail into a wire format that two tiers
 * and every future node build have to agree on.
 */
export interface WorkerHealth {
	workerState: FleetNodeWorkerState;
	/** Present only when there is a reason worth reading. */
	workerStateReason?: string;
}

/**
 * Project the worker loop's state onto the wire contract, or `null` when
 * there is no worker at all.
 *
 * `null` is not the same as `idle`: a visibility-only node (the daemon
 * running without `workerEnabled`) has no worker loop, so it reports NO
 * worker state and the platform shows "unknown". Saying `idle` there
 * would claim capacity that does not exist.
 */
export function describeWorkerHealth(state: WorkerLoopState | null | undefined): WorkerHealth | null {
	if (!state) return null;
	const projected = projectWorkerState(state);
	// Fleet usage limits: a model CLI out of quota is the answer to "why is
	// this machine not taking my agent work", so it is said on the beat. An
	// otherwise-idle worker reads `throttled` (running, not leasing that
	// work); a busy one stays `working` and carries the reason alongside; a
	// quarantine or a drain keeps its own, more important, sentence.
	const usage = describeModelThrottles(state);
	if (!usage) return projected;
	switch (projected.workerState) {
		case 'idle':
			return health('throttled', usage);
		case 'throttled':
		case 'working':
			return health(
				projected.workerState,
				projected.workerStateReason ? `${projected.workerStateReason}; ${usage}` : usage
			);
		default:
			return projected;
	}
}

/** `claude-code: weekly limit until 2026-10-19T01:01:00.000Z`, one clause per CLI. */
function describeModelThrottles(state: WorkerLoopState): string | null {
	const throttles = state.modelThrottles ?? [];
	if (throttles.length === 0) return null;
	return throttles
		.map(
			(throttle) =>
				`${throttle.provider}: ${describeFleetModelUsageLimitWindow(throttle.window)} until ${throttle.until}`
		)
		.join('; ');
}

function projectWorkerState(state: WorkerLoopState): WorkerHealth {
	switch (state.state) {
		// The fail-closed stop. `lastError` carries the quarantine's own
		// message (`markUnsafe` writes it there), which is the single most
		// useful sentence in this whole feature — it is what tells the
		// owner whether to reboot the machine or to look at a runaway
		// process tree by hand.
		case 'unsafe':
			return health('quarantined', state.lastError ?? 'Worker process-tree quarantine is active');
		// Over a resource ceiling: still running, still holding its jobs,
		// just not leasing more. The disk-floor refusal from the node
		// admission gate surfaces here too, through the same field.
		case 'throttled':
			return health('throttled', state.throttleReason ?? null);
		// A drain, in both its forms: `draining` is "paused, still
		// finishing what it holds", which for the fleet is the same
		// answer — no new work.
		case 'paused':
		case 'draining':
			return health('paused', null);
		case 'working':
			return health('working', null);
		// `polling`, `retrying`, `unauthorized` and `stopped` are all
		// "not currently executing a job". They are not throttles and not
		// refusals — a retrying loop is trying to lease — so they read as
		// idle, and liveness itself is already carried by the heartbeat.
		default:
			return health('idle', null);
	}
}

function health(workerState: FleetNodeWorkerState, reason: string | null | undefined): WorkerHealth {
	const trimmed = typeof reason === 'string' ? reason.trim() : '';
	if (!trimmed) {
		return { workerState };
	}
	// Truncated to the SAME bound the server enforces, so what the node
	// shows locally is what Fleet stores. A longer string would not be
	// rejected — the server caps it — but the two would then disagree.
	return { workerState, workerStateReason: trimmed.slice(0, FLEET_MAX_WORKER_STATE_REASON_LENGTH) };
}
