import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_DIVERGENCE_TTL_MS,
    APP_FORK_READINESS_IDLE_MS,
    APP_FORK_READINESS_MAX_REDISPATCH,
    APP_UPSTREAM_SYNC_DISPATCH_BATCH,
} from '@ever-works/contracts';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import type { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import {
    AppUpstreamStateService,
    APP_FORK_READINESS_DISPATCHER,
    APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS,
    APP_SETUP_PULL_REQUEST_ON_VIEW_MS,
    APP_UPSTREAM_SYNC_DISPATCHER,
    type AppForkReadinessDispatcher,
    type AppForkReadinessJobPayload,
    type AppSetupPullRequestCheck,
    type AppUpstreamSyncDispatcher,
    type AppUpstreamSyncJobPayload,
} from './app-upstream-state.service';
import { computeNextUpstreamSync } from './upstream-schedule';

/**
 * APW-02 T28 — the `app-upstream-sync-dispatcher` tick (plan §6.6, `plan.md:800-816`).
 *
 * Spec: FR-23 (the lost readiness job is restarted), FR-41 (an unreadable upstream is
 * re-checked daily), FR-46 (a stale divergence reading refreshes on view), FR-52 (a
 * rate-limited Work is skipped, not dispatched). ACC-02-07, ACC-02-13, ACC-02-16,
 * ACC-02-17.
 *
 * ## It runs API-side, and every collaborator it cannot reach is `@Optional()`
 *
 * Plan §2.4 (`plan.md:193`) puts this service in the API beside `DataSyncDispatcherService`:
 * it reads and stamps rows of `work_upstream_states`, which only the API process owns a
 * DataSource for. The worker reaches it over the internal RPC channel through the
 * `APP_UPSTREAM_SYNC_DISPATCHER_SERVICE` proxy (T28), exactly as the `data-repo-sync`
 * cron reaches `DataSyncDispatcherService` through `DATA_SYNC_DISPATCHER_SERVICE`.
 *
 * The two **job** dispatchers are ports whose owner tasks have not landed: T31 owns the
 * real `APP_UPSTREAM_SYNC_DISPATCHER` / `APP_FORK_READINESS_DISPATCHER` declarations and
 * the `TriggerService` bindings behind them, and the tokens are imported here from
 * {@link AppUpstreamStateService}, where T23 declares them provisionally — one
 * declaration, so the swap T31 makes is one edit and not two. **Unbound is a counted
 * `failed`, never a silent success**: a tick that cannot queue a job says so in its
 * counters rather than reporting a dispatch that never happened.
 *
 * ## The four legs are independent on purpose
 *
 * A cron tick has four jobs (§6.6): dispatch what is due, restart a lost readiness job,
 * re-check an unreadable upstream, and — T43 — chase a setup pull request. **Each leg is
 * guarded on its own**: a repository read that throws must not stop the other three, and
 * `failed` is the counter that says a leg did not do what it was asked. That is also why
 * every leg reads its own rows instead of sharing one query: the predicates are the
 * repository's (`claimDue`, `findStalePreparing`, `findUnavailableDueForRecheck`), each
 * one a conditional claim or an indexed read, and re-deriving them here would put a
 * second copy of the same SQL in a service.
 *
 * ## Stamping before dispatching is what stops a hot loop
 *
 * `claimDue` already moves `nextSyncAt` to `now + UPSTREAM_SYNC_CLAIM_LEASE_MS` before it
 * hands a row over (`plan.md:809`), and this tick then replaces the lease with the **real
 * next slot** (`computeNextUpstreamSync`, §6.4) *before* it asks the queue to run the job.
 * The order is load-bearing in both directions: a dispatch that fails, a worker that never
 * picks the job up and a Work whose every run dies all leave a row that is due again at
 * the next slot rather than at the next tick. The run itself records the same slot when it
 * settles, so the two writers agree by construction.
 *
 * ## What is deliberately *not* here
 *
 *   - **The setup pull request check** (FR-24a, §6.6's fourth leg, and the on-view half of
 *     §4.1) **landed with T43**: `AppUpstreamStateService.checkSetupPullRequest(workId)` exists
 *     and the leg below (plus the API's on-view dispatch) calls it. What is still *not* here is
 *     re-deriving the claim predicate: `claimSetupPullRequestChecks` is the repository's, and
 *     the batch ceiling is the shared one, exactly as for the other three legs.
 *   - **Reading the App spec.** The row's `syncSchedule` column *is* the effective cron
 *     ("the App spec's value, else the platform default — FR-32", `work-upstream-state.entity.ts:199-201`),
 *     and the sync run re-reads the spec fresh on every run (FR-64). A second spec read here
 *     would be a second answer to the same question.
 */

/**
 * What one tick answers — §6.6's `{ dueCount, dispatched, redispatchedReadiness, timedOut,
 * rechecked, setupChecked, failed }` plus one **additive** counter this file adds.
 *
 * `skipped` is not in §6.6's list and does not replace any of its members: `dueCount: 50,
 * dispatched: 0` cannot distinguish "every claimed Work is inside its rate limit" (the
 * ordinary, healthy ACC-02-16 state) from "nothing was claimed and the loop ran zero
 * times", and that distinction is exactly what an operator reading a cron log needs. Every
 * field §6.6 names is present with the meaning it gives it.
 */
export interface AppUpstreamDispatchCounters {
    /** Rows `claimDue` handed over this tick (≤ {@link APP_UPSTREAM_SYNC_DISPATCH_BATCH}). */
    dueCount: number;
    /** Sync jobs actually queued (`schedule` trigger) and handed a run id by the queue. */
    dispatched: number;
    /** Readiness jobs re-queued for a Work whose heartbeat went silent (FR-23). */
    redispatchedReadiness: number;
    /** Rows whose readiness allowance was used up and that are now `timed_out` (FR-23). */
    timedOut: number;
    /** `unavailable` upstreams whose 24-hour re-check was queued (FR-41). */
    rechecked: number;
    /** Setup pull request checks (T43) — a check whose provider read refused counts in `failed`. */
    setupChecked: number;
    /** Dispatch attempts that produced no run id, plus legs whose own read threw. */
    failed: number;
    /** Claimed rows deliberately not dispatched: `link` (FR-44) or rate-limited (FR-52). */
    skipped: number;
}

/**
 * How long one Work's on-view divergence compare is held back — §4.1's "at most once per
 * 600 000 ms per Work", the same 600 s the reading itself goes stale on (FR-46,
 * `APP_DIVERGENCE_TTL_MS`).
 */
export const APP_UPSTREAM_DIVERGENCE_WINDOW_MS = APP_DIVERGENCE_TTL_MS;

@Injectable()
export class AppUpstreamSyncDispatcherService {
    private readonly logger = new Logger(AppUpstreamSyncDispatcherService.name);

    /**
     * `workId → the epoch ms of the last divergence compare this process queued`.
     *
     * The authoritative condition for a divergence compare is the row's
     * `divergenceComputedAt` (FR-46), which the compare run itself stamps. This map covers
     * the one window that column cannot: the seconds between queueing the job and the run
     * writing the reading, during which a burst of views would otherwise queue a burst of
     * jobs. It is per-process by design — with several API replicas the worst case is one
     * extra job per replica per window, and the run's own `beginSync` claim answers the
     * loser `skipped/sync_in_progress` without settling anything, so a duplicate is
     * wasteful and never wrong. Entries older than the window are pruned on every call, so
     * the map is bounded by the number of Works viewed in the last ten minutes.
     */
    private readonly divergenceDispatches = new Map<string, number>();

    constructor(
        /**
         * The epic's own table (T14). `AppWorksModule` provides it, which is why the API's
         * `TriggerInternalModule` imports that module rather than a database one.
         */
        private readonly rows: WorkUpstreamStateRepository,
        /**
         * The readiness timeout of §6.6's sweep (`plan.md:811-812`) and the one writer of a
         * readiness transition. Same module, so this is a resolved dependency and not a
         * remote proxy — the dispatcher only ever runs API-side (§2.4).
         */
        private readonly states: AppUpstreamStateService,
        @Optional()
        @Inject(APP_UPSTREAM_SYNC_DISPATCHER)
        private readonly syncDispatcher?: AppUpstreamSyncDispatcher,
        @Optional()
        @Inject(APP_FORK_READINESS_DISPATCHER)
        private readonly readinessDispatcher?: AppForkReadinessDispatcher,
    ) {}

    // ── §6.6 — the cron tick ─────────────────────────────────────────────────

    /**
     * One dispatcher tick. **Never throws**: a leg that cannot read its rows is counted in
     * `failed` and the other three still run, because a cron task that throws is a cron
     * task whose outcome nobody recorded (the same posture the sync run takes).
     */
    async dispatchDue(now: number = Date.now()): Promise<AppUpstreamDispatchCounters> {
        const counters: AppUpstreamDispatchCounters = {
            dueCount: 0,
            dispatched: 0,
            redispatchedReadiness: 0,
            timedOut: 0,
            rechecked: 0,
            setupChecked: 0,
            failed: 0,
            skipped: 0,
        };

        await this.guard(counters, 'the due rows', () => this.dispatchDueRows(now, counters));
        await this.guard(counters, 'the stale readiness sweep', () =>
            this.sweepStaleReadiness(now, counters),
        );
        await this.guard(counters, 'the unavailable re-check', () =>
            this.recheckUnavailable(now, counters),
        );
        await this.guard(counters, 'the setup pull request check', () =>
            this.checkSetupPullRequests(now, counters),
        );

        this.pruneDivergenceWindow(now);
        this.logger.debug(
            `App upstream dispatcher: ${counters.dueCount} due, ${counters.dispatched} dispatched, ` +
                `${counters.redispatchedReadiness} readiness re-dispatched, ${counters.timedOut} timed out, ` +
                `${counters.rechecked} re-checked, ${counters.setupChecked} setup pull requests checked, ` +
                `${counters.skipped} skipped, ${counters.failed} failed.`,
        );

        return counters;
    }

    /**
     * §6.6's first leg: claim the rows whose `nextSyncAt` has arrived and queue their sync.
     *
     * The two skips, and why they differ:
     *
     *   - **`link`** (FR-44) — a linked App Work has no upstream and never syncs. Nothing
     *     to stamp: the lease `claimDue` wrote expires with the next tick.
     *   - **rate-limited** (FR-52, ACC-02-16) — the member's window is still in force, so the
     *     run would stop before its first provider call. The row is deliberately left on the
     *     **lease** and not stamped to the next slot: the whole point of the skip is that
     *     the Work resumes as soon as the limit lifts, and a next slot is up to a week away
     *     for the default weekly cron. Re-claiming it next tick costs one indexed read.
     */
    private async dispatchDueRows(
        now: number,
        counters: AppUpstreamDispatchCounters,
    ): Promise<void> {
        const due = await this.rows.claimDue(now, APP_UPSTREAM_SYNC_DISPATCH_BATCH);
        counters.dueCount = due.length;

        for (const row of due) {
            if (row.relation === 'link' || this.rateLimitedUntil(row) > now) {
                counters.skipped++;
                continue;
            }

            await this.stampNextSlot(row, now);
            if (await this.queueSync(row.workId, 'schedule')) {
                counters.dispatched++;
            } else {
                counters.failed++;
            }
        }
    }

    /**
     * §6.6's second leg (FR-23, ACC-02-07): a readiness job that went silent is restarted
     * **within ten minutes**, at most three times, and is `timed_out` after that.
     *
     * The row's `readinessDispatches` is the attempt counter and the allowance at once
     * (`plan.md:811-812`: "`readinessDispatches < 3` ? re-dispatch `attempt + 1` :
     * `timeout()`"), so the sweep reads it, decides, bumps it and dispatches in that order.
     * `readinessHeartbeatAt` is stamped **before** the job is queued, for the same reason
     * the sync leg stamps `nextSyncAt` first: a re-dispatched job that is never picked up
     * must not be re-dispatched again on the very next tick, or three ticks would exhaust
     * an allowance meant to span the job's own 15-minute deadline.
     *
     * `beginAttempt` deliberately does not touch `readinessDispatches` (T23's docstring:
     * that counter is the sweeper's), which is what makes the bump here the only writer.
     */
    private async sweepStaleReadiness(
        now: number,
        counters: AppUpstreamDispatchCounters,
    ): Promise<void> {
        const stale = await this.rows.findStalePreparing(
            now,
            APP_FORK_READINESS_IDLE_MS,
            APP_UPSTREAM_SYNC_DISPATCH_BATCH,
        );

        for (const row of stale) {
            const attempt = Math.max(0, row.readinessDispatches ?? 0);

            if (attempt >= APP_FORK_READINESS_MAX_REDISPATCH) {
                const resolution = await this.states.timeout(row.workId, attempt);
                if (resolution.found) {
                    counters.timedOut++;
                } else {
                    // The row vanished between the read and the write: the Work was
                    // deleted. Not a failure of this tick, and not a timeout either.
                    counters.skipped++;
                }
                continue;
            }

            await this.rows.update(row.workId, {
                readinessDispatches: attempt + 1,
                readinessHeartbeatAt: new Date(now),
            });
            await this.queueReadiness(row.workId, attempt + 1, counters);
        }
    }

    /**
     * §6.6's third leg (FR-41, ACC-02-17): an `unavailable` upstream is re-checked once a
     * day, and the re-check **is a sync run** — the run's own `getRepository` is what can
     * tell that the upstream reads back, and it is the run that writes `available` and the
     * next slot (`app-upstream-sync.service.ts:762-776`).
     *
     * Nothing is stamped before this dispatch, and that is deliberate: the row is paused
     * (`nextSyncAt IS NULL`), so there is no slot to protect. If the upstream is still
     * unreadable the run pauses again and stamps `upstreamCheckedAt`, which is what keeps
     * the next re-check 24 hours away rather than one tick away.
     */
    private async recheckUnavailable(
        now: number,
        counters: AppUpstreamDispatchCounters,
    ): Promise<void> {
        const due = await this.rows.findUnavailableDueForRecheck(
            now,
            APP_UPSTREAM_SYNC_DISPATCH_BATCH,
        );

        for (const row of due) {
            if (row.relation === 'link') {
                counters.skipped++;
                continue;
            }
            // `rechecked`, not `dispatched`: this leg's job is the *re-check* (FR-41), and a
            // tick's counters are what an operator reads to tell the two legs apart.
            if (await this.queueSync(row.workId, 'schedule')) {
                counters.rechecked++;
            } else {
                counters.failed++;
            }
        }
    }

    /**
     * §6.6's **fourth leg** (FR-24a, plan §6.2, APW-02 T43): follow up the setup pull requests
     * the platform opened in the members' repositories.
     *
     * A `waiting_for_setup_pr` row rests on a pull request nobody was watching, because
     * `AppUpstreamStateService.checkSetupPullRequest(workId)` did not exist when the other three
     * legs landed. This leg is the sweeper half of it: `claimSetupPullRequestChecks` hands over
     * the rows whose `setupCheckedAt` is missing or older than
     * {@link APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS} **and stamps them in the same statement**
     * (the same conditional-claim shape `claimDue` uses, so two dispatchers cannot check one row
     * twice), and each claimed row is then read once through the state service.
     *
     * **The counters, and why an unreadable provider is `failed` rather than `setupChecked`:**
     * the class docstring fixes `failed` as "a leg did not do what it was asked". A check whose
     * provider read refused (no credential, scope withdrawn, capability unsupported) did **not**
     * answer the question this leg exists to answer, so counting it as a successful check would
     * hide exactly the condition an operator needs to see. The state service already leaves the
     * row untouched in that case, so the Work is never harmed by the distinction — only the
     * counter is honest about it.
     *
     * A `link` row is never claimed by the query (it has no upstream to have a setup pull request
     * on), so unlike the other legs there is no `link` skip to write here.
     */
    private async checkSetupPullRequests(
        now: number,
        counters: AppUpstreamDispatchCounters,
    ): Promise<void> {
        const due = await this.rows.claimSetupPullRequestChecks(
            now,
            APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS,
            APP_UPSTREAM_SYNC_DISPATCH_BATCH,
        );

        for (const row of due) {
            const check = await this.states.checkSetupPullRequest(row.workId);
            if (check.status === 'unknown') {
                counters.failed++;
                continue;
            }
            counters.setupChecked++;
        }
    }

    // ── §4.1 — the on-view divergence compare ────────────────────────────────
    /**
     * `GET /api/works/:id/upstream`'s background compare (FR-46, ACC-02-13): queue
     * `trigger: 'divergence'` when the stored reading is **older than 600 000 ms**, at most
     * once per 600 000 ms per Work.
     *
     * Two conditions, and the second is not redundant:
     *
     *   1. **the row** — `divergenceComputedAt` older than the TTL, or never set at all (a
     *      Work viewed for the first time has no reading to render, so the first view is
     *      what asks for one). A `link` row is never dispatched: it has no upstream to
     *      compare against (FR-44). This is the condition the plan states, and it is also
     *      what makes the *next* view after a compare a no-op.
     *   2. **the in-process window** ({@link divergenceDispatches}) — the compare job is
     *      queued before it has written the reading, so without this a burst of views in
     *      those seconds would queue a burst of jobs.
     *
     * Returns the run id when a compare was queued, `null` for every other outcome (not
     * due, `link`, no row, no dispatcher bound). The route never waits for the **run**, and
     * never fails on this call — a background refresh that cannot be queued must not turn a
     * readable card into an error.
     */
    async requestDivergenceCompare(
        workId: string,
        now: number = Date.now(),
    ): Promise<string | null> {
        const id = typeof workId === 'string' ? workId.trim() : '';
        if (!id) {
            return null;
        }

        const window = APP_UPSTREAM_DIVERGENCE_WINDOW_MS;
        const last = this.divergenceDispatches.get(id);
        if (last !== undefined && now - last < window) {
            return null;
        }

        const row = await this.readRow(id);
        if (!row || row.relation === 'link') {
            return null;
        }

        const computedAt = row.divergenceComputedAt
            ? new Date(row.divergenceComputedAt).getTime()
            : null;
        if (computedAt !== null && Number.isFinite(computedAt) && now - computedAt <= window) {
            return null;
        }

        const runId = await this.queue(row.workId ?? id, {
            workId: row.workId ?? id,
            trigger: 'divergence',
        });

        // Only a queued compare opens the window: a tick whose dispatcher is unbound has
        // not held anything back, and the next view must be free to try again.
        if (runId) {
            this.divergenceDispatches.set(id, now);
        }

        return runId;
    }

    // ── §4.1 — the on-view setup pull request check (T43) ────────────────────

    /**
     * `GET /api/works/:id/upstream`'s background setup pull request check (FR-24a, plan §4.1):
     * read the pull request when the row is **waiting** on one and the recorded check is older
     * than {@link APP_SETUP_PULL_REQUEST_ON_VIEW_MS} (60 000 ms).
     *
     * This is the second door onto the same service call the sweeper's fourth leg makes, and it
     * exists for the one moment the sweeper is too slow for: the member merges the setup pull
     * request, reloads the card, and expects to see it ready. Ten minutes of "nothing changed"
     * is invisible on a cron log and infuriating in a browser tab.
     *
     * **The row's `setupCheckedAt` is the whole rate limit** — there is no in-process window to
     * add here, unlike {@link requestDivergenceCompare}: the check stamps `setupCheckedAt`
     * itself, in every branch that actually read the provider, so a burst of reloads produces at
     * most one provider read a minute (ACC-02-22) without a second, weaker gate that could drift
     * from the first.
     *
     * Returns the check's outcome, or `null` when there was nothing to do (not waiting, no
     * number, `link`, no row, checked recently). **Never throws** for the caller's sake: this
     * runs behind a read, and a card that rendered must not become an error because a background
     * check could not be made.
     */
    async requestSetupPullRequestCheck(
        workId: string,
        now: number = Date.now(),
    ): Promise<AppSetupPullRequestCheck | null> {
        const id = typeof workId === 'string' ? workId.trim() : '';
        if (!id) {
            return null;
        }

        const row = await this.readRow(id);
        if (!row || row.relation === 'link') {
            return null;
        }

        if (
            row.readinessState !== 'waiting_for_setup_pr' ||
            typeof row.setupPullRequestNumber !== 'number'
        ) {
            return null;
        }

        const checkedAt = row.setupCheckedAt ? new Date(row.setupCheckedAt).getTime() : null;
        if (
            checkedAt !== null &&
            Number.isFinite(checkedAt) &&
            now - checkedAt <= APP_SETUP_PULL_REQUEST_ON_VIEW_MS
        ) {
            return null;
        }

        return this.states.checkSetupPullRequest(id);
    }

    // ── the two ports, with the fail-closed answer ───────────────────────────

    /**
     * Queue one sync run. `true` when the queue handed back a run id, `false` for every
     * other outcome — which the caller counts, because whether that is a `dispatched` or a
     * `rechecked` is the caller's leg and not this method's business.
     */
    private async queueSync(
        workId: string,
        trigger: AppUpstreamSyncJobPayload['trigger'],
    ): Promise<boolean> {
        return (await this.queue(workId, { workId, trigger })) !== null;
    }

    /** Queue one readiness run; same shape, same counted failure. */
    private async queueReadiness(
        workId: string,
        attempt: number,
        counters: AppUpstreamDispatchCounters,
    ): Promise<void> {
        const payload: AppForkReadinessJobPayload = { workId, attempt, reason: 'redispatch' };
        if (!this.readinessDispatcher) {
            this.logger.warn(
                `App upstream dispatcher: no readiness dispatcher is bound, so work ${workId} was not restarted.`,
            );
            counters.failed++;
            return;
        }
        try {
            const runId = (await this.readinessDispatcher.dispatch(payload)) ?? null;
            if (runId) {
                counters.redispatchedReadiness++;
            } else {
                counters.failed++;
            }
        } catch (error) {
            this.logger.warn(
                `App upstream dispatcher: restarting the readiness job of work ${workId} failed (${errorText(error)}).`,
            );
            counters.failed++;
        }
    }

    /** The sync port, with the same never-throws posture as {@link queueReadiness}. */
    private async queue(
        workId: string,
        payload: AppUpstreamSyncJobPayload,
    ): Promise<string | null> {
        if (!this.syncDispatcher) {
            this.logger.warn(
                `App upstream dispatcher: no sync dispatcher is bound, so work ${workId} was not queued.`,
            );
            return null;
        }
        try {
            return (await this.syncDispatcher.dispatch(payload)) ?? null;
        } catch (error) {
            this.logger.warn(
                `App upstream dispatcher: dispatching the sync job for work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    /**
     * Run one leg so that nothing it does can reach the tick. A leg's own repository read
     * is the failure this exists for: a `claimDue` that throws must not take the readiness
     * sweep down with it.
     */
    private async guard(
        counters: AppUpstreamDispatchCounters,
        what: string,
        leg: () => Promise<void>,
    ): Promise<void> {
        try {
            await leg();
        } catch (error) {
            counters.failed++;
            this.logger.warn(`App upstream dispatcher: ${what} failed (${errorText(error)}).`);
        }
    }

    /**
     * Stamp the row's **real** next slot (§6.4) before its job is queued. `computeNextUpstreamSync`
     * applies the documented default cron when the column is empty, the hourly clamp and this
     * Work's stable jitter; it answers `null` only when the cron engine finds no slot at all,
     * and a stored `null` is the documented "nothing scheduled" state (§3.1).
     */
    private async stampNextSlot(row: WorkUpstreamState, now: number): Promise<void> {
        const nextSyncAt = computeNextUpstreamSync(
            row.syncSchedule ?? null,
            new Date(now),
            row.workId,
        );
        try {
            await this.rows.update(row.workId, { nextSyncAt });
        } catch (error) {
            // The job is still worth queueing: the run records the same slot when it settles.
            this.logger.warn(
                `App upstream dispatcher: stamping the next slot of work ${row.workId} failed (${errorText(error)}).`,
            );
        }
    }

    /** The stored rate-limit instant as epoch ms, or `0` when the row has none. */
    private rateLimitedUntil(row: WorkUpstreamState): number {
        const until = row.rateLimitedUntil ? new Date(row.rateLimitedUntil).getTime() : 0;
        return Number.isFinite(until) ? until : 0;
    }

    /** One row, or `null` — a read failure is never a reason to dispatch something. */
    private async readRow(workId: string): Promise<WorkUpstreamState | null> {
        try {
            return await this.rows.findByWorkId(workId);
        } catch (error) {
            this.logger.warn(
                `App upstream dispatcher: reading work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /** Drop the divergence entries that have aged out, so the map cannot grow forever. */
    private pruneDivergenceWindow(now: number): void {
        for (const [workId, at] of this.divergenceDispatches) {
            if (now - at >= APP_UPSTREAM_DIVERGENCE_WINDOW_MS) {
                this.divergenceDispatches.delete(workId);
            }
        }
    }
}

/** An error's text, or the value itself when it is not an `Error`. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
