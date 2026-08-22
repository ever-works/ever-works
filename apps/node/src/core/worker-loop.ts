import type { FleetJobKind, FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_DEFAULT_LEASE_TTL_SEC, FLEET_JOB_MAX_LEASE_BATCH } from '@ever-works/contracts';
import type { Logger } from './logger';
import type { Scheduler } from './heartbeat';
import { systemScheduler } from './heartbeat';
import { admitByResourceLimits, hasAdmissionCeilings, type ResourceProbe } from './resource-limits';
import { clampResourceLimits, type NodeResourceLimits } from './types';

/**
 * The node worker host: lease → execute → report, forever, until stopped.
 *
 * This is the loop that finally makes an enrolled machine *capacity*
 * rather than inventory. Before it, `apps/node` could enroll, heartbeat
 * and report its capability tags, and no Task could ever run on it.
 *
 * ## Design rules
 *
 * - **Outbound-only, like every other node channel** (PRD §6.1): the
 *   node polls; nothing ever connects in. No port is opened.
 * - **The lease is a deadline, not a lock.** While a job runs, a
 *   keep-alive extends the claim at a third of the TTL. If this process
 *   dies, nothing has to notice — the claim lapses and the platform
 *   re-offers the work.
 * - **A job always produces a verdict.** An executor that throws is
 *   reported as a job FAILURE, and a kind with no registered executor is
 *   failed immediately naming the kind. Dropping it silently would leave
 *   the job to expire and retry forever on the same incapable node.
 * - **Graceful shutdown drains.** `stop()` stops leasing at once, then
 *   awaits in-flight jobs so their results are REPORTED rather than
 *   abandoned to a lease expiry. A second stop while draining is a no-op.
 * - **So does pausing.** `pause()` is the same drain without the
 *   teardown: leasing halts synchronously, in-flight work runs to a
 *   verdict, and the loop keeps ticking so `resume()` needs no restart.
 *   Pausing is a state a running node is in, not a way to kill it.
 * - **Backoff is exponential with a ceiling**, so an API outage produces
 *   a slow retry rather than a hot loop against a dead endpoint.
 *
 * Timers and the transport are injected so the whole state machine is
 * testable without waiting on wall time or opening a socket.
 */

/** Gap between polls when the fleet has nothing queued for this node. */
export const DEFAULT_IDLE_POLL_MS = 5_000;

/** First retry delay after a failed poll. */
export const WORKER_BACKOFF_BASE_MS = 1_000;

/** Ceiling on the retry delay. */
export const WORKER_BACKOFF_MAX_MS = 60_000;

/** Floor on the keep-alive interval, so a tiny TTL can't spam the API. */
export const MIN_KEEPALIVE_MS = 5_000;

/**
 * Exponential backoff for `n` consecutive failures, capped.
 *
 * `nextBackoffMs(1)` is the base delay and each further failure doubles
 * it up to the ceiling. Nonsense inputs collapse to the base delay
 * rather than throwing — a backoff calculation must never be the thing
 * that kills a worker loop.
 */
export function nextBackoffMs(consecutiveFailures: number): number {
	if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) {
		return WORKER_BACKOFF_BASE_MS;
	}
	const exponent = Math.min(Math.trunc(consecutiveFailures) - 1, 16);
	return Math.min(WORKER_BACKOFF_BASE_MS * 2 ** exponent, WORKER_BACKOFF_MAX_MS);
}

/** Just enough of {@link FleetJobClient} for the loop — keeps tests tiny. */
export interface JobLeaseCapableClient {
	lease(request: { max?: number; leaseTtlSec?: number; capabilities?: string[] }): Promise<FleetJobView[]>;
	heartbeat(jobId: string, leaseTtlSec?: number): Promise<boolean>;
	complete(
		jobId: string,
		outcome: { success: boolean; result?: Record<string, unknown> | null; error?: string | null }
	): Promise<boolean>;
}

/** One registered executor: "this is how a job of kind X gets run here". */
export type JobExecutor = (job: FleetJobView, signal: AbortSignal) => Promise<Record<string, unknown> | void>;

/**
 * `draining` is the state a paused-but-still-busy node is in: leasing
 * has stopped, the jobs already running have not. It is distinct from
 * `paused` (drained, nothing left in flight) so an operator watching
 * `ever-works-node pause` can tell "still finishing two builds" apart
 * from "safe to reboot".
 */
export type WorkerState =
	| 'idle'
	| 'polling'
	| 'working'
	| 'retrying'
	| 'unauthorized'
	| 'draining'
	// Over an operator-set CPU/memory ceiling: the loop keeps running and
	// keeps its in-flight jobs, it just does not lease MORE. Distinct from
	// `paused`, which is a deliberate operator stop rather than the host
	// protecting itself.
	| 'throttled'
	| 'paused'
	| 'stopped';

export interface WorkerLoopState {
	/**
	 * Why leasing is currently withheld by a resource ceiling, or null.
	 * Surfaced so an idle-looking node can explain itself instead of
	 * appearing broken.
	 */
	throttleReason?: string | null;
	state: WorkerState;
	/** Jobs currently executing on this node. */
	activeJobIds: string[];
	consecutiveFailures: number;
	completed: number;
	failed: number;
	/** Human-readable last failure (already redacted), or null. */
	lastError: string | null;
	/** True once `pause()` has been called and until `resume()` is. */
	paused: boolean;
}

export interface WorkerLoopOptions {
	/** Operator-set CPU/memory ceilings. Wins over `concurrency`. */
	limits?: NodeResourceLimits;
	/** Host sampler backing the admission gate. Absent = no ceilings. */
	resourceProbe?: ResourceProbe;
	client: JobLeaseCapableClient;
	/** Max jobs in flight on this node at once. */
	concurrency?: number;
	/** Requested claim duration; the server clamps it. */
	leaseTtlSec?: number;
	idlePollMs?: number;
	scheduler?: Scheduler;
	logger?: Logger;
	/** Capability tags advertised per poll; omitted uses the node's stored tags. */
	capabilities?: string[];
	/** Start drained: heartbeat only, lease nothing until `resume()`. */
	startPaused?: boolean;
}

export class WorkerLoop {
	private readonly executors = new Map<FleetJobKind, JobExecutor>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly jobControllers = new Map<string, AbortController>();
	private readonly listeners = new Set<(state: WorkerLoopState) => void>();
	private readonly scheduler: Scheduler;
	private readonly concurrency: number;
	private readonly leaseTtlSec: number;
	private readonly idlePollMs: number;
	private readonly limits: NodeResourceLimits;
	private readonly resourceProbe: ResourceProbe | undefined;

	private running = false;
	private stopping = false;
	private paused = false;
	private timer: unknown = null;
	private state: WorkerLoopState = {
		state: 'idle',
		activeJobIds: [],
		consecutiveFailures: 0,
		completed: 0,
		failed: 0,
		lastError: null,
		paused: false,
		throttleReason: null
	};

	constructor(private readonly options: WorkerLoopOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		this.concurrency = Math.min(Math.max(options.concurrency ?? 1, 1), FLEET_JOB_MAX_LEASE_BATCH);
		this.leaseTtlSec = options.leaseTtlSec ?? FLEET_JOB_DEFAULT_LEASE_TTL_SEC;
		this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
		// `limits` wins over the legacy `concurrency` option so there is
		// exactly one number in play once an operator has set limits.
		this.limits = clampResourceLimits(options.limits ?? { maxConcurrentJobs: this.concurrency });
		this.resourceProbe = options.resourceProbe;
		this.paused = options.startPaused === true;
		this.state.paused = this.paused;
		if (this.paused) {
			this.state.state = 'paused';
		}
	}

	/** Register the executor for one job kind. Last registration wins. */
	register(kind: FleetJobKind, executor: JobExecutor): this {
		this.executors.set(kind, executor);
		return this;
	}

	/** The ceilings this loop is enforcing (already clamped). */
	get resourceLimits(): NodeResourceLimits {
		return { ...this.limits };
	}

	/** Max jobs this loop will ever run at once. */
	get maxConcurrency(): number {
		return this.limits.maxConcurrentJobs;
	}

	get registeredKinds(): FleetJobKind[] {
		return [...this.executors.keys()];
	}

	getState(): WorkerLoopState {
		return { ...this.state, activeJobIds: [...this.state.activeJobIds] };
	}

	onChange(listener: (state: WorkerLoopState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Start polling. Resolves once the FIRST poll has settled. */
	start(): Promise<void> {
		if (this.running) {
			return Promise.resolve();
		}
		this.running = true;
		this.stopping = false;
		return this.tick();
	}

	/**
	 * Graceful shutdown: stop leasing immediately, then WAIT for the jobs
	 * already running so their verdicts are reported. Idempotent — a
	 * second Ctrl-C while the first drain is in flight must not start a
	 * concurrent teardown.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.stopping = true;
		this.running = false;
		this.cancelTimer();
		await Promise.allSettled([...this.inFlight.values()]);
		this.patch({ state: 'stopped', activeJobIds: [] });
	}

	/** True while the loop is drained (leasing stopped by `pause()`). */
	isPaused(): boolean {
		return this.paused;
	}

	/**
	 * DRAIN, not cut (audit A29).
	 *
	 * Stops leasing at once — the next poll claims nothing — while every
	 * job already in flight keeps running, keeps its lease alive and
	 * still reports its verdict. Killing them instead would throw away
	 * work that is minutes from done, let the claims lapse, and re-run
	 * the same jobs on another node: strictly worse for the operator who
	 * asked for a quiet machine, and strictly worse for the platform.
	 *
	 * The returned promise resolves when the drain is COMPLETE (nothing
	 * left in flight), so `pause()` can be awaited by an operator who
	 * actually wants the machine idle. Callers who just want new work to
	 * stop can ignore it — the leasing halt is synchronous.
	 *
	 * The loop keeps ticking while paused: it is how a `resume()` takes
	 * effect without a restart, and it costs one no-op timer.
	 */
	async pause(): Promise<void> {
		this.paused = true;
		this.patch({
			paused: true,
			state: this.inFlight.size > 0 ? 'draining' : 'paused'
		});
		await this.drained();
		if (this.paused) {
			this.patch({ state: this.running ? 'paused' : this.state.state });
		}
	}

	/** Resume leasing. Polls immediately rather than waiting out the idle gap. */
	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.patch({ paused: false, state: this.inFlight.size > 0 ? 'working' : 'idle' });
		if (this.running && !this.stopping) {
			this.cancelTimer();
			void this.tick();
		}
	}

	/** Await every in-flight job. Resolves immediately when there are none. */
	async drained(): Promise<void> {
		// Re-read `inFlight` each pass: a job settling can be what frees
		// capacity for one that was already leased in the same batch.
		while (this.inFlight.size > 0) {
			await Promise.allSettled([...this.inFlight.values()]);
		}
	}

	/**
	 * Cancel one leased job without affecting the loop or its siblings.
	 * The same signal is shared by workspace provisioning and, later, the
	 * model process. A settled or unknown job has no live controller.
	 */
	cancelJob(jobId: string, reason = 'Fleet job was cancelled'): boolean {
		const controller = this.jobControllers.get(jobId);
		if (!controller || controller.signal.aborted) return false;
		controller.abort(new Error(reason));
		return true;
	}

	/** Run one poll now. Exposed so a UI can offer "check for work" and tests can step. */
	async tick(): Promise<void> {
		if (!this.running || this.stopping) return;
		this.cancelTimer();

		if (this.paused) {
			// Drained: no lease call at all. Still re-arm, so `resume()`
			// takes effect without restarting the process, and so the
			// state keeps reflecting in-flight progress while draining.
			this.patch({ state: this.inFlight.size > 0 ? 'draining' : 'paused' });
			this.scheduleNext(this.idlePollMs);
			return;
		}

		// `limits.maxConcurrentJobs` — not the legacy `concurrency` field.
		// `limits` supersedes it (and is clamped), so reading the raw
		// option here would silently ignore an operator's ceiling.
		const capacity = this.limits.maxConcurrentJobs - this.inFlight.size;
		if (capacity <= 0) {
			this.scheduleNext(this.idlePollMs);
			return;
		}

		// Admission gate: CPU / memory ceilings. Evaluated BEFORE the lease
		// call so an over-loaded machine never claims work it then has to
		// run badly — the platform re-offers it to a node with headroom.
		const admission = await this.checkResourceAdmission();
		if (!admission.admit) {
			this.patch({
				state: this.inFlight.size > 0 ? 'working' : 'throttled',
				throttleReason: admission.reason
			});
			this.scheduleNext(this.idlePollMs);
			return;
		}
		if (this.state.throttleReason != null) {
			this.patch({ throttleReason: null });
		}

		this.patch({ state: this.inFlight.size > 0 ? 'working' : 'polling' });

		let jobs: FleetJobView[];
		try {
			const request: { max: number; leaseTtlSec: number; capabilities?: string[] } = {
				max: capacity,
				leaseTtlSec: this.leaseTtlSec
			};
			if (this.options.capabilities) request.capabilities = this.options.capabilities;
			jobs = await this.options.client.lease(request);
		} catch (error) {
			this.onPollFailure(error);
			this.scheduleNext(nextBackoffMs(this.state.consecutiveFailures));
			return;
		}

		this.patch({ consecutiveFailures: 0, lastError: null });

		if (jobs.length === 0) {
			this.patch({ state: this.inFlight.size > 0 ? 'working' : 'idle' });
			this.scheduleNext(this.idlePollMs);
			return;
		}

		for (const job of jobs) {
			this.startJob(job);
		}
		this.patch({ state: 'working', activeJobIds: [...this.inFlight.keys()] });
		// A full batch means there may be more waiting — poll again as soon
		// as capacity frees up rather than sleeping the idle interval.
		this.scheduleNext(0);
	}

	private startJob(job: FleetJobView): void {
		const controller = new AbortController();
		this.jobControllers.set(job.id, controller);
		const task = this.executeJob(job, controller.signal).finally(() => {
			this.inFlight.delete(job.id);
			if (this.jobControllers.get(job.id) === controller) {
				this.jobControllers.delete(job.id);
			}
			this.patch({
				activeJobIds: [...this.inFlight.keys()],
				state: this.nextIdleState()
			});
		});
		this.inFlight.set(job.id, task);
	}

	/** What the loop settles into once a job finishes. */
	/**
	 * Sample the host and decide whether more work may be admitted.
	 *
	 * A probe that throws or is absent ADMITS: the ceilings are a courtesy to
	 * the machine's owner, and a broken sampler must degrade to "behave like
	 * there were no ceiling", never to "this node is permanently idle".
	 */
	private async checkResourceAdmission(): Promise<{ admit: boolean; reason: string | null }> {
		if (!this.resourceProbe || !hasAdmissionCeilings(this.limits)) {
			return { admit: true, reason: null };
		}
		try {
			const sample = await this.resourceProbe.sample();
			return admitByResourceLimits(this.limits, sample);
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			this.options.logger?.warn(
				`Resource probe failed, admitting work anyway: ${this.options.logger?.redact(raw) ?? raw}`
			);
			return { admit: true, reason: null };
		}
	}

	private nextIdleState(): WorkerState {
		if (this.paused) {
			return this.inFlight.size > 0 ? 'draining' : 'paused';
		}
		if (this.inFlight.size > 0) {
			return 'working';
		}
		return this.running ? 'idle' : 'stopped';
	}

	/**
	 * Run one job to a REPORTED verdict. Never throws: an executor that
	 * blows up is reported as a job failure, because a job whose node
	 * silently swallowed the error is indistinguishable from a hung one.
	 */
	private async executeJob(job: FleetJobView, signal: AbortSignal): Promise<void> {
		const executor = this.executors.get(job.kind);
		if (!executor) {
			this.options.logger?.warn(
				`Leased job ${job.id} of kind '${job.kind}' has no executor on this node — reporting failure`
			);
			await this.report(job.id, {
				success: false,
				error: `No executor registered for fleet job kind '${job.kind}' on this node`
			});
			return;
		}

		const keepAlive = this.startKeepAlive(job.id);
		try {
			this.options.logger?.info(`Executing fleet job ${job.id} (${job.kind})`);
			const result = await executor(job, signal);
			throwIfJobAborted(signal);
			const accepted = await this.report(job.id, {
				success: true,
				result: (result as Record<string, unknown> | undefined) ?? null
			});
			throwIfJobAborted(signal);
			if (!accepted) {
				throw new Error('Fleet job success settlement was rejected; the lease may no longer be owned');
			}
			this.patch({ completed: this.state.completed + 1 });
			this.options.logger?.info(`Fleet job ${job.id} completed`);
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			const message = this.options.logger?.redact(raw) ?? raw;
			await this.report(job.id, { success: false, error: message });
			this.patch({ failed: this.state.failed + 1, lastError: message });
			this.options.logger?.warn(`Fleet job ${job.id} failed: ${message}`);
		} finally {
			this.scheduler.clearTimeout(keepAlive);
		}
	}

	/**
	 * Keep the claim alive at a third of the lease TTL, re-arming after
	 * each beat. A rejected heartbeat means this node no longer owns the
	 * job, so abort the shared job signal before another node can execute
	 * the same work. Transport errors remain non-fatal because they do not
	 * prove the lease was lost.
	 */
	private startKeepAlive(jobId: string): unknown {
		const everyMs = Math.max(Math.floor((this.leaseTtlSec * 1000) / 3), MIN_KEEPALIVE_MS);
		const beat = (): void => {
			if (!this.inFlight.has(jobId)) return;
			void this.options.client
				.heartbeat(jobId, this.leaseTtlSec)
				.then((ok) => {
					if (!ok) {
						this.options.logger?.warn(
							`Lost the lease on fleet job ${jobId} — the platform may re-offer it to another node`
						);
						this.cancelJob(jobId, 'Fleet job lease was lost');
					}
				})
				.catch((error: unknown) => {
					const raw = error instanceof Error ? error.message : String(error);
					this.options.logger?.warn(
						`Job heartbeat failed for ${jobId}: ${this.options.logger?.redact(raw) ?? raw}`
					);
				})
				.finally(() => {
					if (this.inFlight.has(jobId) && !this.jobControllers.get(jobId)?.signal.aborted) {
						this.scheduler.setTimeout(beat, everyMs);
					}
				});
		};
		return this.scheduler.setTimeout(beat, everyMs);
	}

	private async report(
		jobId: string,
		outcome: { success: boolean; result?: Record<string, unknown> | null; error?: string | null }
	): Promise<boolean> {
		try {
			return await this.options.client.complete(jobId, outcome);
		} catch (error) {
			// The lease will expire and the job will be reclaimed — the
			// protocol survives an unreportable result by construction.
			const raw = error instanceof Error ? error.message : String(error);
			this.options.logger?.warn(
				`Could not report the result of fleet job ${jobId}: ${this.options.logger?.redact(raw) ?? raw}`
			);
			return false;
		}
	}

	private onPollFailure(error: unknown): void {
		const raw = error instanceof Error ? error.message : String(error);
		const message = this.options.logger?.redact(raw) ?? raw;
		const failures = this.state.consecutiveFailures + 1;
		const unauthorized =
			typeof (error as { kind?: string })?.kind === 'string' &&
			(error as { kind: string }).kind === 'unauthorized';
		this.patch({
			// `unauthorized` is sticky and visible: the operator has to act
			// (re-enable the node in Fleet, or re-enroll). We keep polling at
			// the backoff ceiling so a re-enabled node recovers on its own.
			state: unauthorized ? 'unauthorized' : 'retrying',
			consecutiveFailures: failures,
			lastError: message
		});
		this.options.logger?.warn(`Lease poll failed (attempt ${failures}): ${message}`);
	}

	private scheduleNext(delayMs: number): void {
		if (!this.running || this.stopping) return;
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, delayMs);
	}

	private cancelTimer(): void {
		if (this.timer !== null) {
			this.scheduler.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private patch(next: Partial<WorkerLoopState>): void {
		this.state = { ...this.state, ...next };
		const snapshot = this.getState();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

function throwIfJobAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = signal.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Fleet job was cancelled');
	error.name = 'AbortError';
	throw error;
}
