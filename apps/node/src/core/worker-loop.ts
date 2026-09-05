import { performance } from 'node:perf_hooks';
import type { FleetJobKind, FleetJobView } from '@ever-works/contracts';
import { clampLeaseTtlSec, FLEET_JOB_DEFAULT_LEASE_TTL_SEC, FLEET_JOB_MAX_LEASE_BATCH } from '@ever-works/contracts';
import type { Logger } from './logger';
import type { Scheduler } from './heartbeat';
import { systemScheduler } from './heartbeat';
import {
	admitByResourceLimits,
	hasAdmissionCeilings,
	hasDiskFloor,
	type AdmissionDecision,
	type ResourceProbe,
	type ResourceSample
} from './resource-limits';
import type { DiskProbeIo } from './telemetry-probe';
import { clampResourceLimits, type NodeResourceLimits } from './types';
import { measureWorkspaceFreeBytes } from './workspaces/disk-headroom';
import type { WorkerSafetyGate } from './worker-safety-store';

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
 *   the job to expire and retry forever on the same incapable node. The
 *   one exception is deliberate and narrow: an executor that DECLINED to
 *   finish — it withheld an irreversible write it may no longer be
 *   entitled to make — hands the job back through `JobLeaseHandle.defer`
 *   and nothing is reported, because both terminal states would be a lie
 *   about work nobody ran to a conclusion.
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
 * Stop work before the server may reclaim it. A Windows primary attempt can
 * spend two seconds in taskkill and two more verifying exit; the fail-closed
 * fallback has its own two-second bound. Eight seconds covers that worst-case
 * chain plus scheduling headroom before another node can receive the job.
 */
export const LEASE_TERMINATION_SAFETY_MS = 8_000;

/**
 * DEFAULT lease a job must have left before it may START publishing.
 *
 * Deliberately NOT {@link LEASE_TERMINATION_SAFETY_MS}: that eight seconds
 * budgets a Windows process-tree kill, and killing `git push` does not
 * retract a ref the remote already accepted. This budgets the push itself.
 *
 * Read what it does and does not buy. It bounds the START of a publish,
 * never its completion: a push that begins with the margin in hand and then
 * runs longer than the whole remaining claim still straddles the deadline,
 * and is stopped only by the job signal firing at
 * {@link LEASE_TERMINATION_SAFETY_MS} — which kills the process without
 * retracting whatever the remote already took. Sixty seconds covers an
 * ordinary push of an agent's diff on the uplinks these machines have; a
 * node that habitually pushes a large first diff over a slow link should be
 * given a bigger budget through `publishFenceMarginMs` rather than trusting
 * this number, because the honest answer is repository- and link-specific
 * and no single constant can be right for all six machines.
 *
 * Clamped by {@link WorkerLoop} into `[LEASE_TERMINATION_SAFETY_MS, ttl/3]`
 * so a floor-length lease is still able to publish at all.
 */
export const PUBLISH_FENCE_MARGIN_MS = 60_000;

/** Maximum shutdown wait for a lease transport that ignores cancellation. */
export const DEFAULT_LEASE_POLL_DRAIN_TIMEOUT_MS = 5_000;

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
	lease(
		request: { max?: number; leaseTtlSec?: number; capabilities?: string[] },
		signal?: AbortSignal
	): Promise<FleetJobView[]>;
	heartbeat(jobId: string, leaseTtlSec?: number): Promise<FleetJobView | null>;
	complete(
		jobId: string,
		outcome: { success: boolean; result?: Record<string, unknown> | null; error?: string | null }
	): Promise<boolean>;
}

/**
 * Live view of the claim this node still holds on a running job.
 *
 * Handed to executors that produce SIDE EFFECTS the platform cannot undo —
 * a pushed branch, above all. The abort signal says "stop"; this says "how
 * long you may still be trusted", which is the question a node has to
 * answer for itself when the platform is unreachable.
 */
export interface JobLeaseHandle {
	/**
	 * Epoch ms, on THIS node's clock, of the last lease expiry the platform
	 * confirmed. Read it LATE: the keep-alive advances it on every
	 * successful renewal, so the value the job was leased with is several
	 * renewals stale by the time a twenty-minute model step finishes.
	 *
	 * The platform mints that expiry on the SERVER's clock, and this node
	 * compares it against its own. Nothing measures the difference, so the
	 * value is additionally capped by an independent monotonic budget: a
	 * node clock that runs slow, or that w32time steps backwards after a
	 * wake-up, cannot hand a caller more claim than the platform granted.
	 * The two clocks catch different faults and neither is trusted alone —
	 * a monotonic clock does not tick through S3/S4, so only the wall clock
	 * sees a suspend, and only the monotonic one survives an NTP step.
	 */
	deadlineAt(): number;
	/** How much of that claim a publish must have left before it may start. */
	readonly publishMarginMs: number;
	/**
	 * Re-confirm the claim with the platform RIGHT NOW, then report the
	 * deadline to fence an irreversible write against.
	 *
	 * Called immediately before a publish, every time — not only when the
	 * local deadline looks thin. A claim can be taken away while its
	 * deadline is still minutes in the future (an operator drains the node;
	 * `releaseClaimsForNode` requeues the job at once), and the local
	 * deadline cannot see that. One extra request per finalize buys the
	 * answer whenever the platform is reachable.
	 *
	 * Never rejects, because the interesting failure is the silent one:
	 *
	 * - renewed → the fresh expiry, and the publish proceeds.
	 * - refused (401 — drained, reassigned, terminal) → the current instant,
	 *   and the job is cancelled. Nothing may be published.
	 * - unreachable → the last confirmed expiry, unchanged. This is the
	 *   partition the local fence exists for: the node cannot ask who owns
	 *   the job, so it falls back to what it last knew.
	 */
	confirmDeadline(): Promise<number>;
	/**
	 * Hand this job back UNSETTLED: the node produced no verdict about the
	 * work, it declined to finish it.
	 *
	 * The loop then reports nothing at all. A settled job is TERMINAL on the
	 * platform, and terminal is exactly wrong for a run whose whole output —
	 * a pushed branch — was withheld: the commit would be stranded on one
	 * machine while the Fleet row read "done". Saying nothing lets the claim
	 * lapse so `reclaimExpired` re-offers the job inside its attempt budget.
	 */
	defer(reason: string): void;
}

/** The keep-alive as the LOOP sees it: the executor's half, plus control. */
interface JobKeepAlive {
	stop(): void;
	/** Why the executor handed the job back unsettled, or null. */
	deferral(): string | null;
	handle: JobLeaseHandle;
}

/**
 * One registered executor: "this is how a job of kind X gets run here".
 *
 * `lease` is optional so a kind with no irreversible side effect (a check,
 * a probe) registers as `(job, signal) => …` exactly as before.
 */
export type JobExecutor = (
	job: FleetJobView,
	signal: AbortSignal,
	lease?: JobLeaseHandle
) => Promise<Record<string, unknown> | void>;

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
	/** Process-tree termination could not be proven; restart/operator review required. */
	| 'unsafe'
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

/** Durable fail-closed marker stored beside the node enrollment config. */
export interface WorkerUnsafeState {
	since: string;
	reason: string;
}

export interface WorkerLoopOptions {
	/** Operator-set CPU/memory ceilings. Wins over `concurrency`. */
	limits?: NodeResourceLimits;
	/** Host sampler backing the admission gate. Absent = no ceilings. */
	resourceProbe?: ResourceProbe;
	/**
	 * Free-space probe backing the disk floor. Both this and `workspacePath`
	 * are needed for the floor to be enforced at the lease: the reading has
	 * to be taken on the volume that actually holds the worktrees, which is
	 * not necessarily the one the service's cwd is on. Absent = the floor is
	 * enforced only at provision time (by the workspace provisioner).
	 */
	diskProbe?: DiskProbeIo;
	/** The workspace ROOT whose volume `diskProbe` measures. */
	workspacePath?: string;
	client: JobLeaseCapableClient;
	/** Max jobs in flight on this node at once. */
	concurrency?: number;
	/** Requested claim duration; the server clamps it. */
	leaseTtlSec?: number;
	idlePollMs?: number;
	scheduler?: Scheduler;
	/** Wall clock paired with the scheduler for lease-expiry enforcement. */
	now?: () => number;
	/**
	 * Monotonic milliseconds, paired with `now`. Used only to bound a lease
	 * against a wall clock that drifts against the platform's or gets
	 * stepped by an NTP resync; injected so that bound is testable without
	 * waiting on real time.
	 */
	monotonicNow?: () => number;
	/**
	 * Lease an executor must have left before it may START publishing.
	 * Defaults to {@link PUBLISH_FENCE_MARGIN_MS}; clamped into
	 * `[LEASE_TERMINATION_SAFETY_MS, ttl/3]` either way. Raise it on a node
	 * whose pushes are slow — the right budget is a property of the repo and
	 * the uplink, not of the fleet.
	 */
	publishFenceMarginMs?: number;
	logger?: Logger;
	/** Capability tags advertised per poll; omitted uses the node's stored tags. */
	capabilities?: string[];
	/** Start drained: heartbeat only, lease nothing until `resume()`. */
	startPaused?: boolean;
	/** Restore a prior unverified process-tree quarantine after restart. */
	startUnsafe?: WorkerUnsafeState | null;
	/** Persist the first unsafe transition before this process may restart. */
	onUnsafe?: (state: WorkerUnsafeState) => Promise<void> | void;
	/** Durable write-ahead marker acquired before this loop may lease. */
	safetyGate?: WorkerSafetyGate;
	/** Bound shutdown if a lease transport does not settle after abort. */
	leasePollDrainTimeoutMs?: number;
}

export class WorkerLoop {
	private readonly executors = new Map<FleetJobKind, JobExecutor>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly jobControllers = new Map<string, AbortController>();
	private readonly activePolls = new Set<Promise<void>>();
	private readonly pollControllers = new Set<AbortController>();
	private readonly listeners = new Set<(state: WorkerLoopState) => void>();
	private readonly scheduler: Scheduler;
	private readonly concurrency: number;
	private readonly leaseTtlSec: number;
	private readonly idlePollMs: number;
	private readonly limits: NodeResourceLimits;
	private readonly resourceProbe: ResourceProbe | undefined;
	private readonly diskProbe: DiskProbeIo | undefined;
	private readonly workspacePath: string | undefined;
	/** Last disk refusal reason logged, so the warning fires once per episode. */
	private lastDiskRefusal: string | null = null;
	private readonly now: () => number;
	private readonly monotonicNow: () => number;
	private readonly leasePollDrainTimeoutMs: number;
	private readonly publishFenceMarginMs: number;

	private running = false;
	private stopping = false;
	private paused = false;
	private unsafe = false;
	private safetySessionId: string | null = null;
	private starting: Promise<void> | null = null;
	private stopTask: Promise<void> | null = null;
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
		this.leaseTtlSec = clampLeaseTtlSec(options.leaseTtlSec ?? FLEET_JOB_DEFAULT_LEASE_TTL_SEC);
		this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
		this.now = options.now ?? (() => Date.now());
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.leasePollDrainTimeoutMs =
			Number.isFinite(options.leasePollDrainTimeoutMs) && (options.leasePollDrainTimeoutMs ?? 0) > 0
				? Math.floor(options.leasePollDrainTimeoutMs!)
				: DEFAULT_LEASE_POLL_DRAIN_TIMEOUT_MS;
		// A publish needs room inside the lease, but never so much room that
		// a short lease can never publish: at the 30s TTL floor a flat 60s
		// margin would refuse every push forever, which trades a rare
		// double-write for a permanent outage. The floor is the termination
		// budget — below that the abort would land after the reclaim anyway.
		const requestedMargin =
			Number.isFinite(options.publishFenceMarginMs) && (options.publishFenceMarginMs ?? 0) > 0
				? Math.floor(options.publishFenceMarginMs!)
				: PUBLISH_FENCE_MARGIN_MS;
		this.publishFenceMarginMs = Math.max(
			LEASE_TERMINATION_SAFETY_MS,
			Math.min(requestedMargin, Math.floor((this.leaseTtlSec * 1000) / 3))
		);
		// `limits` wins over the legacy `concurrency` option so there is
		// exactly one number in play once an operator has set limits.
		this.limits = clampResourceLimits(options.limits ?? { maxConcurrentJobs: this.concurrency });
		this.resourceProbe = options.resourceProbe;
		this.diskProbe = options.diskProbe;
		this.workspacePath = options.workspacePath;
		this.paused = options.startPaused === true;
		this.unsafe = options.startUnsafe != null;
		this.state.paused = this.paused;
		if (this.unsafe) {
			this.state.state = 'unsafe';
			this.state.lastError = options.startUnsafe?.reason ?? 'Worker process-tree quarantine is active';
		} else if (this.paused) {
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

	/** Lease an executor must have left before it may publish (clamped). */
	get publishFenceMargin(): number {
		return this.publishFenceMarginMs;
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
			return this.starting ?? Promise.resolve();
		}
		this.running = true;
		this.stopping = false;
		const starting = this.prepareSafety().then(() => this.tick());
		this.starting = starting;
		const clearStarting = (): void => {
			if (this.starting === starting) this.starting = null;
		};
		void starting.then(clearStarting, clearStarting);
		return starting;
	}

	/**
	 * Graceful shutdown: stop leasing immediately, then WAIT for the jobs
	 * already running so their verdicts are reported. Idempotent — a
	 * second Ctrl-C while the first drain is in flight must not start a
	 * concurrent teardown.
	 */
	stop(): Promise<void> {
		if (this.stopTask) return this.stopTask;
		if (!this.running) return Promise.resolve();
		const task = this.performStop();
		this.stopTask = task;
		const clearStopTask = (): void => {
			if (this.stopTask === task) this.stopTask = null;
		};
		void task.then(clearStopTask, clearStopTask);
		return task;
	}

	private async performStop(): Promise<void> {
		this.stopping = true;
		this.running = false;
		this.cancelTimer();
		for (const controller of this.pollControllers) {
			if (!controller.signal.aborted) controller.abort(new Error('Fleet worker is stopping'));
		}
		const polls = new Set(this.activePolls);
		if (this.starting) polls.add(this.starting);
		if (!(await this.waitForPollDrain(polls))) {
			this.markUnsafe(
				`Outstanding lease poll did not settle within ${this.leasePollDrainTimeoutMs}ms after cancellation`
			);
		}
		await Promise.allSettled([...this.inFlight.values()]);
		if (this.safetySessionId && !this.unsafe && this.options.safetyGate) {
			try {
				await this.options.safetyGate.release(this.safetySessionId);
				this.safetySessionId = null;
			} catch (error) {
				this.markUnsafe(`Worker safety marker could not be released after drain: ${errorDetail(error)}`);
			}
		}
		this.patch({ state: this.unsafe ? 'unsafe' : 'stopped', activeJobIds: [] });
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
			state: this.unsafe ? 'unsafe' : this.inFlight.size > 0 ? 'draining' : 'paused'
		});
		await this.drained();
		if (this.paused && !this.unsafe) {
			this.patch({ state: this.running ? 'paused' : this.state.state });
		}
	}

	/** Resume leasing. Polls immediately rather than waiting out the idle gap. */
	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		if (this.unsafe) {
			this.patch({ paused: false, state: 'unsafe' });
			return;
		}
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
	tick(): Promise<void> {
		const poll = this.pollOnce();
		this.activePolls.add(poll);
		const clearPoll = (): void => {
			this.activePolls.delete(poll);
		};
		void poll.then(clearPoll, clearPoll);
		return poll;
	}

	private async pollOnce(): Promise<void> {
		if (!this.running || this.stopping) return;
		this.cancelTimer();
		if (this.unsafe) {
			this.patch({ state: 'unsafe' });
			return;
		}

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
		if (!this.running || this.stopping) return;
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
		const pollController = new AbortController();
		this.pollControllers.add(pollController);
		try {
			const request: { max: number; leaseTtlSec: number; capabilities?: string[] } = {
				max: capacity,
				leaseTtlSec: this.leaseTtlSec
			};
			if (this.options.capabilities) request.capabilities = this.options.capabilities;
			jobs = await this.options.client.lease(request, pollController.signal);
		} catch (error) {
			if (pollController.signal.aborted || this.stopping || !this.running) return;
			this.onPollFailure(error);
			this.scheduleNext(nextBackoffMs(this.state.consecutiveFailures));
			return;
		} finally {
			this.pollControllers.delete(pollController);
		}

		if (!this.running || this.stopping) {
			await Promise.allSettled(
				jobs.map((job) =>
					this.report(job.id, {
						success: false,
						error: 'Fleet worker stopped before execution; no command was started'
					})
				)
			);
			return;
		}

		// Another in-flight job can quarantine the worker while this network
		// request is outstanding. The server has already leased these rows, so
		// fail them terminally without starting any executor; do not let them
		// lapse and get re-offered while an unverified local process may live.
		if (this.unsafe) {
			await Promise.allSettled(
				jobs.map((job) =>
					this.report(job.id, {
						success: false,
						error: 'Fleet worker quarantined before execution; no command was started'
					})
				)
			);
			this.patch({ state: 'unsafe' });
			return;
		}

		this.patch({ consecutiveFailures: 0, lastError: null });

		if (jobs.length === 0) {
			this.patch({ state: this.inFlight.size > 0 ? 'working' : 'idle' });
			this.scheduleNext(this.idlePollMs);
			return;
		}

		for (const job of jobs) {
			if (!this.running || this.stopping || this.unsafe) {
				await this.report(job.id, {
					success: false,
					error: 'Fleet worker stopped or quarantined before execution; no command was started'
				});
				continue;
			}
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
	 *
	 * The disk floor is sampled on the workspace root's volume and folded
	 * into the same decision. It is sampled ONLY when a floor is in force,
	 * so the "skips sampling entirely when no ceiling is set" contract for
	 * CPU/memory keeps holding for its own probe; a null floor takes no
	 * reading at all.
	 */
	private async checkResourceAdmission(): Promise<AdmissionDecision> {
		const wantsHost = this.resourceProbe !== undefined && hasAdmissionCeilings(this.limits);
		const wantsDisk = this.diskProbe !== undefined && this.workspacePath !== undefined && hasDiskFloor(this.limits);
		if (!wantsHost && !wantsDisk) {
			return { admit: true, reason: null };
		}
		// NaN never blocks (see `admitByResourceLimits`), so a dimension that
		// is not sampled cannot refuse.
		let sample: ResourceSample = { cpuPercent: Number.NaN, usedMemoryMb: Number.NaN, totalMemoryMb: Number.NaN };
		if (wantsHost) {
			try {
				sample = { ...(await this.resourceProbe!.sample()) };
			} catch (error) {
				const raw = error instanceof Error ? error.message : String(error);
				this.options.logger?.warn(
					`Resource probe failed, admitting work anyway: ${this.options.logger?.redact(raw) ?? raw}`
				);
			}
		}
		if (wantsDisk) {
			// Measured on the nearest EXISTING ancestor of the root (a fresh
			// node has not created it yet). A throwing / nonsense probe maps
			// to null, and null admits: an unreadable volume is reported (the
			// heartbeat carries no figure) rather than idling the node.
			sample.diskFreeBytes = await measureWorkspaceFreeBytes(this.diskProbe!, this.workspacePath!);
		}
		const decision = admitByResourceLimits(this.limits, sample);
		this.noteDiskDecision(decision);
		return decision;
	}

	/**
	 * One warning when the floor starts refusing, one info line when it
	 * clears — not a line per poll, which at the idle cadence would be a
	 * log entry every five seconds for as long as the disk stays full.
	 */
	private noteDiskDecision(decision: AdmissionDecision): void {
		if (!decision.admit && decision.dimension === 'disk') {
			if (this.lastDiskRefusal !== decision.reason) {
				this.lastDiskRefusal = decision.reason;
				this.options.logger?.warn(
					`Refusing to lease work: ${decision.reason}. Free space on the workspace volume (\`ever-works-node doctor\`, \`ever-works-node gc\`) or lower the floor with --min-free-disk.`
				);
			}
			return;
		}
		if (this.lastDiskRefusal !== null && (decision.admit || decision.dimension !== 'disk')) {
			this.lastDiskRefusal = null;
			this.options.logger?.info('Workspace volume is back above the disk floor — leasing resumes');
		}
	}

	private nextIdleState(): WorkerState {
		if (this.unsafe) return 'unsafe';
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

		const keepAlive = this.startKeepAlive(job);
		let successAccepted = false;
		try {
			this.options.logger?.info(`Executing fleet job ${job.id} (${job.kind})`);
			const result = await executor(job, signal, keepAlive.handle);
			throwIfJobAborted(signal);
			if (this.settleDeferred(job.id, keepAlive.deferral())) return;
			const accepted = await this.report(job.id, {
				success: true,
				result: (result as Record<string, unknown> | undefined) ?? null
			});
			if (!accepted) {
				throw new Error('Fleet job success settlement was rejected; the lease may no longer be owned');
			}
			// The server's accepted terminal transition is authoritative. Stop
			// heartbeat delivery before any late response can abort/count failure.
			successAccepted = true;
			keepAlive.stop();
			this.patch({ completed: this.state.completed + 1 });
			this.options.logger?.info(`Fleet job ${job.id} completed`);
		} catch (error) {
			if (successAccepted) return;
			const raw = error instanceof Error ? error.message : String(error);
			const message = this.options.logger?.redact(raw) ?? raw;
			if (isProcessTreeTerminationError(error)) {
				await this.quarantine(message);
			}
			// Checked before the failure report too: an executor that withheld
			// its publish and THEN hit the lease abort must not have that
			// abort recorded as a terminal `failed`, which would retire a job
			// nobody has run to a result.
			if (this.settleDeferred(job.id, keepAlive.deferral())) return;
			await this.report(job.id, { success: false, error: message });
			this.patch({ failed: this.state.failed + 1, lastError: message });
			this.options.logger?.warn(`Fleet job ${job.id} failed: ${message}`);
		} finally {
			keepAlive.stop();
		}
	}

	/**
	 * Record a job the executor handed back UNSETTLED, and report nothing.
	 *
	 * Every terminal transition the platform accepts is final: `complete`
	 * writes `done` (or `failed`) and clears the lease, and `reclaimExpired`
	 * only ever requeues claims that LAPSED. So a job whose only output — a
	 * pushed branch — was withheld must not be settled at all, in either
	 * direction: `success` would leave the agent's commit stranded on this
	 * machine with the Fleet row reading "done", and `failure` would retire
	 * work that nobody ever ran to a verdict. Silence lets the claim lapse
	 * so the platform re-offers it inside its attempt budget.
	 *
	 * Counted as a local failure because that is what it is from this node's
	 * side: it took work and produced nothing.
	 */
	private settleDeferred(jobId: string, reason: string | null): boolean {
		if (reason === null) return false;
		this.patch({ failed: this.state.failed + 1, lastError: reason });
		this.options.logger?.warn(
			`Fleet job ${jobId} was handed back unsettled (${reason}) — its claim will lapse and the platform will re-offer it`
		);
		return true;
	}

	private async quarantine(reason: string): Promise<void> {
		if (this.unsafe) return;
		const durable: WorkerUnsafeState = {
			since: new Date(this.now()).toISOString(),
			reason
		};
		this.markUnsafe(reason);
		this.options.logger?.warn(`Fleet worker quarantined after unconfirmed process-tree termination: ${reason}`);
		try {
			await this.options.onUnsafe?.(durable);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const safeDetail = this.options.logger?.redact(detail) ?? detail;
			const fatal =
				`Worker quarantine config persistence failed (${safeDetail}); ` +
				'the durable worker-session marker remains active and requires explicit operator clearance';
			this.patch({ state: 'unsafe', lastError: fatal });
			this.options.logger?.warn(fatal);
		}
	}

	private async prepareSafety(): Promise<void> {
		if (this.unsafe || !this.options.safetyGate) return;
		try {
			const acquisition = await this.options.safetyGate.acquire();
			if (acquisition.kind === 'blocked') {
				this.markUnsafe(acquisition.state.reason);
				return;
			}
			this.safetySessionId = acquisition.sessionId;
		} catch (error) {
			this.markUnsafe(errorDetail(error));
			this.options.logger?.warn(`Fleet worker cannot lease: ${errorDetail(error)}`);
		}
	}

	private markUnsafe(reason: string): void {
		this.unsafe = true;
		this.patch({ state: 'unsafe', lastError: reason });
	}

	/**
	 * Keep the claim alive at a third of the lease TTL, re-arming after
	 * each beat. A rejected heartbeat means this node no longer owns the
	 * job, so abort the shared job signal before another node can execute
	 * the same work. Transport errors remain non-fatal because they do not
	 * prove the lease was lost.
	 *
	 * The handle it returns is the same claim seen from the executor's
	 * side: `deadlineAt` publishes the `confirmedUntil` the abort timer is
	 * armed from, so an executor about to do something irreversible has no
	 * second, drifting source of truth; `confirmDeadline` re-asks the
	 * platform at the moment of the write; `defer` hands the job back
	 * unsettled when the executor declined to finish it.
	 */
	private startKeepAlive(job: FleetJobView): JobKeepAlive {
		const jobId = job.id;
		const ttlMs = this.leaseTtlSec * 1000;
		const everyMs = Math.max(Math.floor(ttlMs / 3), MIN_KEEPALIVE_MS);
		const wireExpiry = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : Number.NaN;
		let confirmedUntil = Number.isFinite(wireExpiry) ? wireExpiry : this.now() + ttlMs;
		let monotonicUntil = 0;
		let beatTimer: unknown = null;
		let deadlineTimer: unknown = null;
		let stopped = false;
		let inFlightBeat: Promise<void> | null = null;
		let deferral: string | null = null;

		/**
		 * Record one confirmed expiry against BOTH clocks.
		 *
		 * The monotonic budget is the smaller of the TTL this node asked for
		 * and the grant it actually observed, so a wall clock sitting behind
		 * the platform's — which makes every expiry look further away than it
		 * is — cannot inflate the claim. A clock AHEAD of the platform's only
		 * shortens it, and refusing to publish slightly early is the harmless
		 * direction.
		 */
		const confirm = (expiry: number): void => {
			confirmedUntil = expiry;
			monotonicUntil = this.monotonicNow() + Math.min(ttlMs, Math.max(0, expiry - this.now()));
		};
		confirm(confirmedUntil);

		const deadlineAt = (): number => {
			const now = this.now();
			return now + Math.min(confirmedUntil - now, monotonicUntil - this.monotonicNow());
		};

		/**
		 * `stopped`, not `inFlight`, is what says this keep-alive is finished.
		 *
		 * `startJob` registers the job in `inFlight` only AFTER `executeJob`
		 * has run to its first await — which is inside the executor. An
		 * executor that asks about its claim on its very first tick would
		 * therefore be told it does not exist, and a renewal answering that
		 * question would be discarded. `stop()` runs in `executeJob`'s
		 * `finally`, so this flag is set no later than the map entry is
		 * cleared and is true for exactly the window that matters.
		 */
		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			if (beatTimer !== null) this.scheduler.clearTimeout(beatTimer);
			if (deadlineTimer !== null) this.scheduler.clearTimeout(deadlineTimer);
			beatTimer = null;
			deadlineTimer = null;
		};
		const abortForLapsedLease = (): void => {
			this.options.logger?.warn(
				`Fleet job ${jobId} reached its last confirmed lease deadline — aborting before server reclaim`
			);
			this.cancelJob(jobId, 'Fleet job lease confirmation expired');
		};
		/**
		 * Stop the job when this node's own WALL clock says the claim is
		 * spent, and report whether it did.
		 *
		 * Asked on the wall clock rather than left to `deadlineTimer` because
		 * a timer's base clock does not advance while a machine is suspended:
		 * a lid closed for an hour mid-run wakes with the deadline long gone
		 * and the timer still counting down awake seconds. Six PCs that get
		 * shut mid-run is the ordinary case on this fleet, not the exotic one.
		 */
		const expireIfLapsed = (): boolean => {
			if (stopped) return false;
			if (this.now() < confirmedUntil - LEASE_TERMINATION_SAFETY_MS) return false;
			abortForLapsedLease();
			return true;
		};
		const scheduleDeadline = (): void => {
			if (deadlineTimer !== null) this.scheduler.clearTimeout(deadlineTimer);
			const remaining = Math.max(0, confirmedUntil - LEASE_TERMINATION_SAFETY_MS - this.now());
			deadlineTimer = this.scheduler.setTimeout(() => {
				deadlineTimer = null;
				if (stopped) return;
				// Fires unconditionally, without re-checking the wall clock:
				// a clock stepped BACKWARDS since this timer was armed would
				// make the check say "not yet" with nothing left to re-arm it,
				// and an abort that never happens is the worse failure.
				abortForLapsedLease();
			}, remaining);
		};
		const scheduleBeat = (): void => {
			if (stopped) return;
			if (beatTimer !== null) {
				this.scheduler.clearTimeout(beatTimer);
				beatTimer = null;
			}
			// Re-arming past the deadline is how a partitioned node used to
			// spin: `remaining` collapses to zero, the beat fails against a
			// dead endpoint in milliseconds, and `finally` re-arms at zero
			// delay for the rest of the run. There is nothing left to renew
			// at that point, so stop the job instead — and never re-arm
			// faster than the keep-alive floor, which no lease can undercut.
			if (expireIfLapsed()) return;
			const remaining = Math.max(0, confirmedUntil - LEASE_TERMINATION_SAFETY_MS - this.now());
			beatTimer = this.scheduler.setTimeout(beat, Math.max(MIN_KEEPALIVE_MS, Math.min(everyMs, remaining)));
		};
		const applyRenewal = (renewed: FleetJobView | null): void => {
			if (stopped) return;
			if (!renewed) {
				this.options.logger?.warn(
					`Lost the lease on fleet job ${jobId} — the platform may re-offer it to another node`
				);
				// The claim is gone NOW, not at the deadline it was granted:
				// collapse it so anything asking "may I still publish?" is
				// told the truth even if it never observes the abort.
				confirm(this.now());
				this.cancelJob(jobId, 'Fleet job lease was lost');
				return;
			}
			if (this.jobControllers.get(jobId)?.signal.aborted) return;
			const renewedExpiry = renewed.leaseExpiresAt ? Date.parse(renewed.leaseExpiresAt) : Number.NaN;
			if (
				renewed.id !== jobId ||
				!Number.isFinite(renewedExpiry) ||
				renewedExpiry <= this.now() + LEASE_TERMINATION_SAFETY_MS
			) {
				this.cancelJob(jobId, 'Fleet job heartbeat returned an invalid lease expiry');
				return;
			}
			confirm(renewedExpiry);
			scheduleDeadline();
		};
		/**
		 * One beat, at most one in flight. A publish that asks for a fresh
		 * confirmation while the scheduled beat is already out joins that
		 * request rather than doubling it.
		 */
		const runBeat = (): Promise<void> => {
			if (inFlightBeat) return inFlightBeat;
			const attempt = this.options.client
				.heartbeat(jobId, this.leaseTtlSec)
				.then(applyRenewal)
				.catch((error: unknown) => {
					const raw = error instanceof Error ? error.message : String(error);
					this.options.logger?.warn(
						`Job heartbeat failed for ${jobId}: ${this.options.logger?.redact(raw) ?? raw}`
					);
				})
				.finally(() => {
					inFlightBeat = null;
				});
			inFlightBeat = attempt;
			return attempt;
		};
		const beat = (): void => {
			beatTimer = null;
			if (stopped || this.jobControllers.get(jobId)?.signal.aborted) return;
			if (expireIfLapsed()) return;
			void runBeat().finally(() => {
				if (!this.jobControllers.get(jobId)?.signal.aborted) scheduleBeat();
			});
		};
		const confirmDeadline = async (): Promise<number> => {
			if (!stopped && !this.jobControllers.get(jobId)?.signal.aborted) {
				await runBeat();
			}
			return deadlineAt();
		};
		scheduleBeat();
		scheduleDeadline();
		return {
			stop,
			deferral: () => deferral,
			handle: {
				deadlineAt,
				publishMarginMs: this.publishFenceMarginMs,
				confirmDeadline,
				// First reason wins: it is the one that actually stopped the
				// publish, and a later one would only describe the fallout.
				defer: (reason: string) => {
					if (deferral === null) deferral = reason;
				}
			}
		};
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

	private waitForPollDrain(polls: ReadonlySet<Promise<void>>): Promise<boolean> {
		if (polls.size === 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			let timeout: unknown = null;
			const finish = (drained: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout !== null) this.scheduler.clearTimeout(timeout);
				resolve(drained);
			};
			timeout = this.scheduler.setTimeout(() => finish(false), this.leasePollDrainTimeoutMs);
			void Promise.allSettled([...polls]).then(() => finish(true));
		});
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

function isProcessTreeTerminationError(error: unknown): boolean {
	return error instanceof Error && error.name === 'ProcessTreeTerminationError';
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
