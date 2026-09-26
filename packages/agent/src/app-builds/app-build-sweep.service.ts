import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_BUILD_ADOPT_WINDOW_MS,
    APP_BUILD_LOST_GRACE_MINUTES,
    APP_BUILD_POLL_AFTER_SILENCE_MS,
    APP_BUILD_SWEEP_BATCH,
} from '@ever-works/contracts';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import type { WorkBuild } from '../entities/work-build.entity';
import { appBuildBlock } from './app-build-prepare.runner';
import {
    APP_BUILD_SPEC_SOURCE,
    AppBuildsService,
    type AppBuildSpecSource,
} from './app-builds.service';

/**
 * APW-05 T21, first slice — `AppBuildSweepService`, the pass behind the
 * `app-build-sweep` schedule (plan §7.4 — every two minutes).
 *
 * Plan: `docs/specs/features/app-works/APW-05-builds/plan.md` §9.2
 * (`plan.md:1627` — "a requested Build stays queued" and the job is retried 3
 * times) and §7.4 (`plan.md:1401-1403` — Builds past `queuedAt + 5 min +
 * timeoutMinutes + 30` when never adopted are failed as `lost`).
 *
 * ## What this slice runs, and what it leaves to the rest of T21
 *
 * Two passes, each isolated from the other so one failing read cannot stop the
 * second:
 *
 * 1. **The re-drive (§9.2).** A manual or verification Build whose prepare
 *    failed — `prepareRepository` threw, or `startBuild` threw and the runner
 *    released its dispatch claim — stays `queued` with `dispatchedAt` NULL, and
 *    nothing else ever looks at it again: the job returns its failure rather
 *    than rethrowing it (`app-build-prepare.task.ts`, "Budget") and the
 *    in-process fallback runs once. This pass reads those Builds while they are
 *    between {@link APP_BUILD_REDRIVE_MIN_AGE_MS} and
 *    {@link APP_BUILD_REDRIVE_MAX_AGE_MS} old and asks
 *    `AppBuildsService.requestPrepare(workId, 'sweep')` once per Work. The
 *    window is three sweep intervals long and half-open, so ticks that are
 *    exactly two minutes apart land in it three times whatever their phase —
 *    §9.2's "3 times". Real ticks are not exactly periodic (Trigger's schedule
 *    start latency, worker boot, the RPC hop; `runSweep` reads its clock
 *    API-side), and a tick that finds the lock held runs no pass. So in
 *    production a Build whose window edge falls near a tick is re-driven three
 *    times ±1 under schedule jitter; fewer when ticks are skipped because a hung
 *    pass holds the lock (up to {@link APP_BUILD_SWEEP_LOCK_MAX_LIFETIME_MS});
 *    always bounded above by the window, and always idempotent (one
 *    `requestPrepare` per Work, and the runner's dispatch claim starts a Build at
 *    most once). `requestPrepare` bumps
 *    `prepareSeq` before it dispatches, so a prepare that is already running
 *    loops once more and picks the Build up instead of being answered `locked`
 *    and forgotten.
 *
 *    ⚠ A **verification** Build is in this read too (`APP_BUILD_REQUESTED_TRIGGERS`,
 *    as the plan has it), and the runner cannot plan one. Only
 *    `AppBuildsService.startVerification` creates them, and it stamps
 *    `dispatchedAt` after its own `startBuild` even when that throws — so one is
 *    still undispatched at 90 s only when that persist failed or `startBuild` took
 *    longer than 90 s. The re-drive then has the runner claim it and start it in
 *    `verify` mode WITHOUT the verification plan: the plan-less duplicate verify
 *    run the prepare runner's header already routes. The sweep brings that
 *    forward (90–450 s instead of the Work's next prepare); it does not create
 *    it. Routed, not changed here.
 * 2. **Never-adopted `lost` (§7.4).** An open manual or verification Build with
 *    no provider run id that is past `queuedAt + 5 min + timeoutMinutes + 30`
 *    is failed as `lost` with `AppBuildRepository.markNeverAdoptedLost`, whose
 *    UPDATE re-checks what the read saw (still open, still no run id, the same
 *    `dispatchedAt`), so a Build the watch adopted or a prepare claimed in between
 *    is left alone. ONLY a row that call actually moved is finalised — `finalize`
 *    publishes `app.build.failed` and writes the Activity row, and it is not
 *    claim-guarded against a concurrent finalise, so finalising a row this pass
 *    did not move could publish a second terminal event. `timeoutMinutes` is
 *    read from the App spec at the Build's commit (default 60, clamped to the
 *    schema's 5–180), once per Work and commit per tick. A Build dispatched
 *    LATER than it was queued is measured from its dispatch, which is when its
 *    run could first exist.
 *
 * The remaining T21 passes — the silent-Build watch dispatch, the adopted half of
 * the `lost` rule (`startedAt + timeoutMinutes + 30`), the `digestUnconfirmed`
 * recheck, the orphaned verification secrets and T21a's run discovery — belong in
 * THIS file, beside these two, so the one lock covers them all.
 *
 * ## One lock, taken here
 *
 * {@link runSweep} takes `app-builds:sweep` (plan §7.4:1415, 90-second lease)
 * itself, the `WorkspaceBackupService.runSweep` precedent: the Trigger task
 * reaches this service over the internal RPC channel, and `runExclusive` takes
 * a CALLBACK, which cannot cross that hop. The API's own cron fallback calls
 * the same method and takes no second lock (a nested `runExclusive` on the same
 * key would never acquire). The lease is renewed while the pass runs and has a
 * hard lifetime of {@link APP_BUILD_SWEEP_LOCK_MAX_LIFETIME_MS}, so a pass that
 * hangs stops blocking the schedule after a few ticks rather than for the lock
 * service's 24-hour default.
 *
 * ## Counters only
 *
 * The summary and every log line carry counts and ids — never a repository
 * name, a spec body or a provider message beyond the error text.
 */

/** The sweep's one lock key (plan §7.4:1415). */
export const APP_BUILD_SWEEP_LOCK_KEY = 'app-builds:sweep' as const;

/** The lock's lease (plan §7.4:1415, `ttlMs: 90_000`); renewed while a pass runs. */
export const APP_BUILD_SWEEP_LOCK_TTL_MS = 90_000;

/**
 * The hard ceiling on one pass's hold of the lock. A pass is bounded (two reads
 * of at most {@link APP_BUILD_SWEEP_BATCH} rows), so only a hung collaborator
 * reaches it; the lease then lapses and a later tick takes over.
 */
export const APP_BUILD_SWEEP_LOCK_MAX_LIFETIME_MS = 5 * 60 * 1000;

/** The period of `APP_BUILD_SWEEP_CRON` — the sweep runs every two minutes. */
export const APP_BUILD_SWEEP_INTERVAL_MS = 120_000;

/**
 * §9.2 — how many times a requested Build nothing dispatched is re-driven, at
 * exactly periodic ticks. In production it is three ±1 under schedule jitter;
 * fewer when ticks are skipped because a hung pass holds the lock (up to
 * {@link APP_BUILD_SWEEP_LOCK_MAX_LIFETIME_MS}); always bounded above by the
 * window, and always idempotent (see the file header).
 */
export const APP_BUILD_REDRIVE_ATTEMPTS = 3;

/**
 * A requested Build is re-driven once it has been undispatched this long — the
 * same 90-second silence after which a Build is polled rather than awaited
 * (plan §3.2:514), so an in-flight prepare is never raced by its own re-drive.
 */
export const APP_BUILD_REDRIVE_MIN_AGE_MS = APP_BUILD_POLL_AFTER_SILENCE_MS;

/**
 * …and is no longer re-driven once it is this old: three sweep intervals past
 * the minimum. The window `[min, max)` holds exactly
 * {@link APP_BUILD_REDRIVE_ATTEMPTS} ticks when they are exactly one interval
 * apart: three ±1 under schedule jitter, and fewer when ticks are skipped because
 * a hung pass holds the lock (up to {@link APP_BUILD_SWEEP_LOCK_MAX_LIFETIME_MS}).
 * The window is always the upper bound, and a re-drive is always idempotent (see
 * the file header). After it the Build waits for the next prepare of its Work, or
 * for the `lost` rule.
 */
export const APP_BUILD_REDRIVE_MAX_AGE_MS =
    APP_BUILD_REDRIVE_MIN_AGE_MS + APP_BUILD_REDRIVE_ATTEMPTS * APP_BUILD_SWEEP_INTERVAL_MS;

/** `build.resources.timeoutMinutes` when the App spec does not say (APW-03 `schema.md` §9:179). */
export const APP_BUILD_TIMEOUT_MINUTES_DEFAULT = 60;

/** The schema's lower bound on `build.resources.timeoutMinutes` (APW-03 `schema.md` §9:179). */
export const APP_BUILD_TIMEOUT_MINUTES_MIN = 5;

/** The schema's upper bound on `build.resources.timeoutMinutes` (APW-03 `schema.md` §9:179). */
export const APP_BUILD_TIMEOUT_MINUTES_MAX = 180;

const MINUTE_MS = 60_000;

/** Why a tick ran no pass. */
export type AppBuildSweepSkipReason = 'locked' | 'lockUnavailable';

/** What one tick did — counters only. */
export interface AppBuildSweepSummary {
    /** `null` when the passes ran; otherwise why they did not. */
    readonly skipped: AppBuildSweepSkipReason | null;
    /** Passes whose READ failed (the other pass still ran). */
    readonly passesFailed: number;
    /** Re-drive: stuck requested Builds read. */
    readonly redriveBuilds: number;
    /** Re-drive: distinct App Works among them. */
    readonly redriveWorks: number;
    /** Re-drive: Works whose `requestPrepare` resolved. */
    readonly redriveRequested: number;
    /** Re-drive: Works whose `requestPrepare` threw. */
    readonly redriveFailed: number;
    /** Lost: never-adopted candidates read (before each Build's own deadline). */
    readonly lostCandidates: number;
    /** Lost: Builds this tick's `markNeverAdoptedLost` moved. */
    readonly lostMarked: number;
    /** Lost: of those, Builds `finalize` settled. */
    readonly lostFinalized: number;
    /** Lost: Builds whose `markNeverAdoptedLost` or `finalize` threw (an unreadable spec is the default). */
    readonly lostFailed: number;
}

/** A summary with every counter at zero. */
function emptySummary(skipped: AppBuildSweepSkipReason | null): AppBuildSweepSummary {
    return {
        skipped,
        passesFailed: 0,
        redriveBuilds: 0,
        redriveWorks: 0,
        redriveRequested: 0,
        redriveFailed: 0,
        lostCandidates: 0,
        lostMarked: 0,
        lostFinalized: 0,
        lostFailed: 0,
    };
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A declared `timeoutMinutes` as the sweep uses it: the schema default when it
 * is absent or not a number, else the integer clamped to the schema's 5–180.
 */
export function appBuildTimeoutMinutes(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return APP_BUILD_TIMEOUT_MINUTES_DEFAULT;
    }
    return Math.min(
        APP_BUILD_TIMEOUT_MINUTES_MAX,
        Math.max(APP_BUILD_TIMEOUT_MINUTES_MIN, Math.floor(value)),
    );
}

@Injectable()
export class AppBuildSweepService {
    private readonly logger = new Logger(AppBuildSweepService.name);

    constructor(
        private readonly builds: AppBuildRepository,
        // `requestPrepare` (the re-drive) and `finalize` (the lost Build's
        // verdict, Activity row and terminal event — §7.8's one writer).
        private readonly service: AppBuildsService,
        @Optional() private readonly locks?: DistributedTaskLockService,
        // APW-03's effective spec, for `build.resources.timeoutMinutes`. Unbound,
        // every Build takes the schema default of 60 minutes.
        @Optional()
        @Inject(APP_BUILD_SPEC_SOURCE)
        private readonly specs?: AppBuildSpecSource,
    ) {}

    /**
     * One tick, under `app-builds:sweep`. What the Trigger task calls over the
     * RPC channel (with no argument) and what the API's cron fallback calls.
     *
     * `nowMs` is a clock seam for the specs only. The RPC entry
     * (`TriggerInternalController`'s `AppBuildSweepService`) is a one-member facade
     * that calls `runSweep()` with NO argument whatever the caller sends — a
     * far-future clock would fail every open never-adopted requested Build as
     * `lost` — and it publishes neither {@link sweep} nor the private passes.
     *
     * A tick that cannot take the lock runs nothing and says why: `locked` when
     * another tick holds it, `lockUnavailable` when no lock service is bound —
     * two overlapping passes would re-drive the same Work twice in one tick.
     */
    async runSweep(nowMs?: number): Promise<AppBuildSweepSummary> {
        const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

        if (!this.locks) {
            this.logger.warn(
                'App builds: the sweep is skipped — DistributedTaskLockService is not bound, so the ' +
                    `${APP_BUILD_SWEEP_LOCK_KEY} lock of plan §7.4 cannot be taken.`,
            );
            return emptySummary('lockUnavailable');
        }

        const lock = await this.locks.runExclusive(
            APP_BUILD_SWEEP_LOCK_KEY,
            () => this.sweep(now),
            {
                ttlMs: APP_BUILD_SWEEP_LOCK_TTL_MS,
                maxLifetimeMs: APP_BUILD_SWEEP_LOCK_MAX_LIFETIME_MS,
                onLocked: () =>
                    this.logger.debug(
                        `App builds: another tick holds ${APP_BUILD_SWEEP_LOCK_KEY}; this tick runs no pass.`,
                    ),
            },
        );

        if (!lock.acquired || !lock.result) {
            return emptySummary('locked');
        }
        return lock.result;
    }

    /**
     * Both passes, WITHOUT the lock — {@link runSweep} is the entry point; this
     * is its body, public for the specs and for a caller that already holds
     * `app-builds:sweep`. It is never reachable over the internal RPC channel
     * (see {@link runSweep}).
     */
    async sweep(nowMs: number = Date.now()): Promise<AppBuildSweepSummary> {
        let passesFailed = 0;

        let redrive: Pick<
            AppBuildSweepSummary,
            'redriveBuilds' | 'redriveWorks' | 'redriveRequested' | 'redriveFailed'
        > = { redriveBuilds: 0, redriveWorks: 0, redriveRequested: 0, redriveFailed: 0 };
        try {
            redrive = await this.redrivePass(nowMs);
        } catch (error) {
            passesFailed += 1;
            this.logger.warn(`App builds: the sweep's re-drive read failed (${errorText(error)}).`);
        }

        let lost: Pick<
            AppBuildSweepSummary,
            'lostCandidates' | 'lostMarked' | 'lostFinalized' | 'lostFailed'
        > = { lostCandidates: 0, lostMarked: 0, lostFinalized: 0, lostFailed: 0 };
        try {
            lost = await this.lostPass(nowMs);
        } catch (error) {
            passesFailed += 1;
            this.logger.warn(`App builds: the sweep's lost read failed (${errorText(error)}).`);
        }

        return { ...emptySummary(null), passesFailed, ...redrive, ...lost };
    }

    /* ---------------------------------------------------------------------- *
     * Pass 1 — the re-drive (§9.2)
     * ---------------------------------------------------------------------- */

    private async redrivePass(nowMs: number) {
        const stuck = await this.builds.findUndispatchedRequested(
            nowMs,
            APP_BUILD_REDRIVE_MIN_AGE_MS,
            APP_BUILD_REDRIVE_MAX_AGE_MS,
            APP_BUILD_SWEEP_BATCH,
        );
        // One request per Work: the runner numbers the Builds it acts on from the
        // database, so one prepare picks up every stuck Build of the Work.
        const workIds = [...new Set(stuck.map((build) => build.workId))];

        let requested = 0;
        let failed = 0;
        for (const workId of workIds) {
            try {
                await this.service.requestPrepare(workId, 'sweep');
                requested += 1;
            } catch (error) {
                failed += 1;
                this.logger.warn(
                    `App builds: the sweep could not re-drive the prepare of work ${workId} (${errorText(error)}).`,
                );
            }
        }

        if (workIds.length > 0) {
            this.logger.debug(
                `App builds: the sweep re-drove ${requested} of ${workIds.length} work(s) with undispatched requested builds.`,
            );
        }

        return {
            redriveBuilds: stuck.length,
            redriveWorks: workIds.length,
            redriveRequested: requested,
            redriveFailed: failed,
        };
    }

    /* ---------------------------------------------------------------------- *
     * Pass 2 — never-adopted Builds failed as `lost` (§7.4)
     * ---------------------------------------------------------------------- */

    private async lostPass(nowMs: number) {
        // The cutoff of the SHORTEST legal timeout: no Build queued after it can
        // be past its own deadline, whatever its spec says.
        const candidates = await this.builds.findNeverAdoptedQueuedBefore(
            nowMs - this.lostAfterMs(APP_BUILD_TIMEOUT_MINUTES_MIN),
            APP_BUILD_SWEEP_BATCH,
        );

        const timeouts = new Map<string, number>();
        let marked = 0;
        let finalized = 0;
        let failed = 0;

        for (const build of candidates) {
            try {
                const since = this.lostClockStart(build);
                // Not past even the shortest deadline (a Build dispatched after
                // it was queued): nothing to read.
                if (nowMs <= since + this.lostAfterMs(APP_BUILD_TIMEOUT_MINUTES_MIN)) {
                    continue;
                }
                const minutes = await this.timeoutMinutes(build, timeouts);
                if (nowMs <= since + this.lostAfterMs(minutes)) {
                    continue;
                }

                // Moves the row only while it is still exactly what this pass read —
                // open, never adopted, the same `dispatchedAt` — so a Build that
                // finished, was adopted by the watch, or was claimed and started by a
                // prepare between the read and here keeps what it has, and a run that
                // just started is never orphaned.
                const moved = await this.builds.markNeverAdoptedLost(
                    build.id,
                    build.dispatchedAt ? new Date(build.dispatchedAt).getTime() : null,
                    new Date(nowMs),
                );
                if (!moved) {
                    continue;
                }
                marked += 1;

                const result = await this.service.finalize(build.id);
                if (result.finalized) {
                    finalized += 1;
                }
                this.logger.debug(
                    `App builds: build ${build.id} of work ${build.workId} was never adopted and is failed as lost.`,
                );
            } catch (error) {
                failed += 1;
                this.logger.warn(
                    `App builds: the sweep could not settle never-adopted build ${build.id} (${errorText(error)}).`,
                );
            }
        }

        return {
            lostCandidates: candidates.length,
            lostMarked: marked,
            lostFinalized: finalized,
            lostFailed: failed,
        };
    }

    /** `5 min + timeoutMinutes + 30` — §7.4's never-adopted allowance, in ms. */
    private lostAfterMs(timeoutMinutes: number): number {
        return (
            APP_BUILD_ADOPT_WINDOW_MS + (timeoutMinutes + APP_BUILD_LOST_GRACE_MINUTES) * MINUTE_MS
        );
    }

    /**
     * Where the never-adopted clock starts: `queuedAt`, or `dispatchedAt` when
     * the Build was handed to the provider later than it was asked for — the run
     * cannot exist before its dispatch, and the adoption window is counted from
     * there.
     */
    private lostClockStart(build: WorkBuild): number {
        const queuedAt = build.queuedAt ? new Date(build.queuedAt).getTime() : 0;
        const dispatchedAt = build.dispatchedAt ? new Date(build.dispatchedAt).getTime() : 0;
        return Math.max(queuedAt, dispatchedAt);
    }

    /**
     * `build.resources.timeoutMinutes` at the Build's commit, once per Work and
     * commit per tick. Anything that is not a readable number — no spec source,
     * a read that throws, no spec, no build block — is the schema default: the
     * sweep never invents a shorter deadline than the owner could have declared.
     */
    private async timeoutMinutes(build: WorkBuild, cache: Map<string, number>): Promise<number> {
        const key = `${build.workId}:${build.commitSha}`;
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        let minutes = APP_BUILD_TIMEOUT_MINUTES_DEFAULT;
        if (this.specs) {
            try {
                const read = await this.specs.read(build.workId, build.commitSha);
                minutes = appBuildTimeoutMinutes(
                    appBuildBlock(read?.spec ?? null)?.resources.timeoutMinutes,
                );
            } catch (error) {
                this.logger.debug(
                    `App builds: the spec of work ${build.workId} at ${build.commitSha} could not be read ` +
                        `(${errorText(error)}); the sweep uses ${APP_BUILD_TIMEOUT_MINUTES_DEFAULT} minutes.`,
                );
            }
        }
        cache.set(key, minutes);
        return minutes;
    }
}
