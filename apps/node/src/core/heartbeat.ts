import { FleetClientError, type FleetErrorKind, type HeartbeatResponse } from './fleet-client';
import type { Logger } from './logger';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_BACKOFF_MS,
	type FleetNodeView,
	type NodeSelfDescription
} from './types';

/**
 * The heartbeat loop.
 *
 * Outbound-only by construction (PRD §6.1): the node polls the API, nothing
 * ever connects in. On success it re-arms at the configured cadence; on
 * failure it backs off exponentially up to the ceiling, and a single success
 * resets it. Timers and the clock are injected so the whole state machine is
 * testable without waiting on wall time.
 */

export type ConnectionState =
	| 'idle'
	| 'connecting'
	| 'connected'
	/** Transient failure (network/5xx/429) — retrying with backoff. */
	| 'retrying'
	/** The platform rejected our credential: revoked, deleted, or node disabled. */
	| 'unauthorized'
	| 'stopped';

export interface HeartbeatState {
	state: ConnectionState;
	/** Epoch ms of the last accepted heartbeat, or null. */
	lastHeartbeatAt: number | null;
	consecutiveFailures: number;
	/** Delay until the next scheduled attempt, or null when not scheduled. */
	nextAttemptInMs: number | null;
	/** Human-readable last failure (already redacted), or null. */
	lastError: string | null;
	lastErrorKind: FleetErrorKind | null;
	/** Latest node view returned by the platform. */
	node: FleetNodeView | null;
}

/** Timer abstraction so tests drive the loop deterministically. */
export interface Scheduler {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemScheduler: Scheduler = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Just enough of {@link FleetClient} for the loop — keeps tests tiny. */
export interface HeartbeatCapableClient {
	heartbeat(request: NodeSelfDescription & { nodeId: string; secret: string }): Promise<HeartbeatResponse>;
}

/**
 * Self-description fields a heartbeat may drop and still be a valid beat.
 *
 * The worker state (EW-776) and the housekeeping report (EW-803). See
 * {@link HeartbeatLoop} for why dropping them is ever the right move.
 *
 * EVERY field added to the self-description after an API release belongs
 * here. The API validates beats with `whitelist + forbidNonWhitelisted`,
 * so a field an older platform does not know 400s the WHOLE request — a
 * new field that is not in this list is a node that goes dark the moment
 * it talks to a platform older than itself.
 */
const OPTIONAL_DESCRIPTION_FIELDS = [
	'workerState',
	'workerStateReason',
	'minFreeDiskBytes',
	'workspaceCount',
	'workspaceBytes',
	'lastReclaimAt',
	'lastReclaimFreedBytes'
] as const;

export interface HeartbeatLoopOptions {
	client: HeartbeatCapableClient;
	nodeId: string;
	secret: string;
	/** Re-evaluated before every beat so capability changes propagate live. */
	describe: () => Promise<NodeSelfDescription> | NodeSelfDescription;
	intervalMs?: number;
	maxBackoffMs?: number;
	scheduler?: Scheduler;
	now?: () => number;
	logger?: Logger;
}

/**
 * Exponential backoff: the nominal interval while healthy, then
 * `interval * 2^failures` capped at `maxMs`. The first retry therefore already
 * waits longer than the normal cadence — a node that just failed is far more
 * likely to fail again immediately than a healthy one is.
 */
export function computeBackoffDelay(intervalMs: number, failures: number, maxMs: number): number {
	if (failures <= 0) {
		return intervalMs;
	}
	const exponent = Math.min(failures, 30);
	const delay = intervalMs * 2 ** exponent;
	return Math.min(delay, maxMs);
}

export class HeartbeatLoop {
	private readonly options: Required<Pick<HeartbeatLoopOptions, 'intervalMs' | 'maxBackoffMs'>> &
		HeartbeatLoopOptions;
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly listeners = new Set<(state: HeartbeatState) => void>();

	private timer: unknown = null;
	private running = false;
	private inFlight: Promise<void> | null = null;
	/**
	 * Latched once this platform has proven it predates the worker-state
	 * fields; from then on the beat carries liveness only. Process-scoped
	 * on purpose — a platform upgrade is a restart-shaped event for the
	 * node, and re-probing on every beat would mean one wasted round trip
	 * per beat, forever, against an API that will never accept them.
	 */
	private legacyDescription = false;
	private state: HeartbeatState = {
		state: 'idle',
		lastHeartbeatAt: null,
		consecutiveFailures: 0,
		nextAttemptInMs: null,
		lastError: null,
		lastErrorKind: null,
		node: null
	};

	constructor(options: HeartbeatLoopOptions) {
		this.options = {
			...options,
			intervalMs: options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
			maxBackoffMs: options.maxBackoffMs ?? MAX_HEARTBEAT_BACKOFF_MS
		};
		this.scheduler = options.scheduler ?? systemScheduler;
		this.now = options.now ?? (() => Date.now());
		this.options.logger?.protect(options.secret);
	}

	getState(): HeartbeatState {
		return { ...this.state };
	}

	onChange(listener: (state: HeartbeatState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Start beating. Resolves once the FIRST beat has settled. */
	start(): Promise<void> {
		if (this.running) {
			return this.inFlight ?? Promise.resolve();
		}
		this.running = true;
		return this.tick();
	}

	/** Stop beating and cancel any pending timer. */
	stop(): void {
		this.running = false;
		this.cancelTimer();
		this.patch({ state: 'stopped', nextAttemptInMs: null });
	}

	/** Await the in-flight beat, if any (test/shutdown helper). */
	async settled(): Promise<void> {
		await this.inFlight;
	}

	/** Run one beat now. Exposed so the UI can offer "retry" and tests can step. */
	tick(): Promise<void> {
		const run = this.runOnce().finally(() => {
			if (this.inFlight === run) {
				this.inFlight = null;
			}
		});
		this.inFlight = run;
		return run;
	}

	private async runOnce(): Promise<void> {
		if (!this.running) {
			return;
		}
		this.cancelTimer();
		if (this.state.state !== 'connected') {
			this.patch({ state: 'connecting' });
		}

		try {
			const description = await this.options.describe();
			this.onSuccess(await this.beat(description));
		} catch (error) {
			this.onFailure(error);
		}

		this.scheduleNext();
	}

	/**
	 * Send one beat, tolerating a platform that predates the optional
	 * self-description fields (the worker state, EW-776; the housekeeping
	 * report, EW-803).
	 *
	 * The API validates heartbeats with `whitelist + forbidNonWhitelisted`,
	 * so a field an older build does not know is not ignored — it 400s the
	 * whole request. A 400 is a FAILED beat, a failed beat backs off, and
	 * enough of them sweep the node to `offline`. Which would mean shipping
	 * a health-reporting feature whose failure mode is "every node in a
	 * mixed-version fleet goes dark": the exact class of outage this slice
	 * was written to end.
	 *
	 * So a 400 on a beat that CARRIED those fields is retried once,
	 * immediately, without them. If that succeeds the platform is simply
	 * older than this daemon; we latch, say so once, and keep reporting
	 * liveness. The retry costs one request, once per process.
	 *
	 * Inferring "the field was rejected" from a bare 400 is deliberate and
	 * has a cost worth stating: `FleetClient` never surfaces server bodies
	 * (fixed client-authored messages only), so a 400 caused by something
	 * else on such a beat also latches, and this node reports liveness only
	 * until it restarts. That is the safe direction — the node stays
	 * observable either way, and only the extra signal is lost.
	 */
	private async beat(description: NodeSelfDescription): Promise<HeartbeatResponse> {
		const credential = { nodeId: this.options.nodeId, secret: this.options.secret };
		if (this.legacyDescription) {
			return this.options.client.heartbeat({ ...credential, ...stripOptionalFields(description) });
		}

		try {
			return await this.options.client.heartbeat({ ...credential, ...description });
		} catch (error) {
			if (!carriesOptionalFields(description) || !isFieldRejection(error)) {
				throw error;
			}
			const result = await this.options.client.heartbeat({
				...credential,
				...stripOptionalFields(description)
			});
			this.legacyDescription = true;
			this.options.logger?.warn(
				'Platform rejected the optional self-description fields (worker state, housekeeping); it predates them. Reporting liveness only until this node restarts.'
			);
			return result;
		}
	}

	private onSuccess(result: HeartbeatResponse): void {
		this.patch({
			state: 'connected',
			lastHeartbeatAt: this.now(),
			consecutiveFailures: 0,
			lastError: null,
			lastErrorKind: null,
			node: result.node
		});
	}

	private onFailure(error: unknown): void {
		const kind: FleetErrorKind = error instanceof FleetClientError ? error.kind : 'network';
		const raw = error instanceof Error ? error.message : String(error);
		const message = this.options.logger?.redact(raw) ?? raw;
		const failures = this.state.consecutiveFailures + 1;

		this.patch({
			// `unauthorized` is sticky and visible: the operator has to act
			// (re-enable the node in Fleet, or re-enroll). We keep retrying at
			// the backoff ceiling so a re-enabled node recovers on its own.
			state: kind === 'unauthorized' ? 'unauthorized' : 'retrying',
			consecutiveFailures: failures,
			lastError: message,
			lastErrorKind: kind
		});
		this.options.logger?.warn(`Heartbeat failed (attempt ${failures}): ${message}`);
	}

	private scheduleNext(): void {
		if (!this.running) {
			return;
		}
		const delay = computeBackoffDelay(
			this.options.intervalMs,
			this.state.consecutiveFailures,
			this.options.maxBackoffMs
		);
		this.patch({ nextAttemptInMs: delay });
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, delay);
	}

	private cancelTimer(): void {
		if (this.timer !== null) {
			this.scheduler.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private patch(next: Partial<HeartbeatState>): void {
		this.state = { ...this.state, ...next };
		const snapshot = this.getState();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

/** True when this description carries a field an older API would refuse. */
function carriesOptionalFields(description: NodeSelfDescription): boolean {
	return OPTIONAL_DESCRIPTION_FIELDS.some((field) => description[field] !== undefined);
}

/** The same description with the droppable fields removed. */
function stripOptionalFields(description: NodeSelfDescription): NodeSelfDescription {
	const out = { ...description };
	for (const field of OPTIONAL_DESCRIPTION_FIELDS) {
		delete out[field];
	}
	return out;
}

/**
 * Is this the shape of "the API refused a field I sent"?
 *
 * A literal 400 only. A 401 is a credential problem, a 403 is an edge
 * refusal, a 429 backs off, and a 5xx or a network error is transient —
 * retrying any of those without the fields would learn nothing and, for
 * the transient ones, would latch this node into liveness-only reporting
 * over a blip.
 */
function isFieldRejection(error: unknown): boolean {
	return error instanceof FleetClientError && error.kind === 'invalid-request' && error.status === 400;
}
