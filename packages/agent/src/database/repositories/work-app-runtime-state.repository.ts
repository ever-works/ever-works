import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AppDeployTarget } from '@ever-works/contracts';
import type { AppClusterCheck, AppJobResult, AppStatusSnapshot } from '@ever-works/plugin';
import {
    WorkAppRuntimeState,
    type AppRuntimeIngressAddress,
} from '../../entities/work-app-runtime-state.entity';
import { Work } from '../../entities/work.entity';
import type {
    AppDeployQueueWrite,
    AppHealthStatePatch,
    AppRuntimeStatePatch,
    WorkAppRuntimeStatePollRow,
    WorkAppRuntimeStatePort,
} from '../../app-runtime/work-app-runtime-state.port';
import { serializeOnSingleConnection } from './single-connection-write-queue';

/**
 * APW-06 T17 — the `work_app_runtime_states` repository.
 *
 * This is the class the `WORK_APP_RUNTIME_STATES` token
 * (`app-launcher/app-launcher.service.ts:223`) binds to, and it is the single
 * implementation behind **twelve** separate structural views declared by their
 * consumers — `AppDeployRuntimeStateStore`, `AppDeployRuntimeStateReader`,
 * `AppDeployOrchestratorStateStore`, `AppHealthStateStore`,
 * `AppHostsStateStore`, `AppLifecycleOpStateStore`,
 * `WorkAppRuntimeStateDeletionStore`, `AppSmokeStateStore`,
 * `AppDomainsStateStore`, `AppRuntimeStateTargetStore`,
 * `WorkAppRuntimeStateReader` and the `app-deploy` task's dynamic
 * `appContext.get(...)` lookup. Nothing here may be narrowed to one consumer:
 * the method surface below is the UNION of those views, and each method's
 * docstring names the view and the plan section it answers.
 *
 * Feature-owned: provided by {@link AppRuntimeStateModule}, **not** by
 * `DatabaseModule` — the same posture `WorkUpstreamStateRepository` takes, and
 * for the reason `_repository-inventory.ts` gives.
 *
 * ## Every instant is epoch milliseconds, not a `Date`, inside a predicate
 *
 * The entity's time columns are `TimestampColumn` (`bigint`), so a `Date` bound
 * into a query-builder predicate is passed to the driver verbatim:
 * better-sqlite3 refuses to bind one at all, and Postgres would be asked to
 * compare a `bigint` with a `timestamptz`. Dates appear only in `.set()`, where
 * TypeORM applies the column transformer. This is the same rule
 * `work-upstream-state.repository.ts` states, and it is the one that breaks
 * silently on only one of the two drivers if it is forgotten.
 *
 * ## Claims are conditional UPDATEs, and only `affected === 1` wins
 *
 * {@link claimDeployLock}, {@link releaseDeployLock}, {@link claimDeletion},
 * {@link setPaused}, {@link requestCancel}, {@link takeQueued} and
 * {@link clearPendingDomainRebuild} are all compare-and-set: the predicate that
 * makes the claim legal is in the `WHERE`, never in a read the caller did
 * first. Two API replicas run the same dispatcher, and a lock handed to both is
 * two deployments of the same App Work into the same namespace.
 *
 * `serializeOnSingleConnection` wraps the multi-statement ones for the drivers
 * whose TypeORM runner is shared by the whole DataSource — better-sqlite3 is the
 * default `DATABASE_TYPE`, so without it two concurrent claims collide inside
 * `startTransaction` (see that helper's docstring).
 */
@Injectable()
export class WorkAppRuntimeStateRepository implements WorkAppRuntimeStatePort {
    private readonly logger = new Logger(WorkAppRuntimeStateRepository.name);

    constructor(
        @InjectRepository(WorkAppRuntimeState)
        private readonly repository: Repository<WorkAppRuntimeState>,
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
    ) {}

    /**
     * T17's own read (`tasks.md:296`), and the one method every consumer calls.
     *
     * Creates the row on first read — a Work has no runtime state until
     * something asks — and applies **FR-63**: `target` is derived from the
     * Work's creation-time choice rather than left at the column default.
     * Without that derivation a Work created for Your cluster stays `none` and
     * refuses to deploy, which is APW-01's recorded cross-epic requirement.
     *
     * The derivation runs **only while the column is still `none`**. A target
     * the owner has since changed through `PUT :id/app-target` is never
     * overwritten, which is why the condition is on the stored value and not on
     * "was this row just created".
     */
    async getOrCreate(workId: string): Promise<WorkAppRuntimeState> {
        const existing = await this.repository.findOne({ where: { workId } });
        if (existing) {
            return this.applyDerivedTarget(existing);
        }

        // The insert races with itself: two requests for the same Work arrive
        // together and both see no row. The UNIQUE index on `workId` is what
        // decides, and the loser re-reads rather than failing — a create race is
        // not an error, it is two readers of the same new Work.
        try {
            const created = await this.repository.save(
                this.repository.create({ workId, target: 'none' }),
            );
            return this.applyDerivedTarget(created);
        } catch (error) {
            const reread = await this.repository.findOne({ where: { workId } });
            if (reread) {
                return this.applyDerivedTarget(reread);
            }
            throw error;
        }
    }

    /**
     * The launcher's batched read (`WorkAppRuntimeStateReader`): the paused /
     * removed flags for many Works at once, keyed by `workId`.
     *
     * Deliberately does NOT create rows. The launcher renders whatever Works a
     * person can see, including ones that have never been deployed, and writing
     * a row per rendered tile would turn a read into a write storm.
     */
    async findStateForWorks(workIds: string[]): Promise<Map<string, WorkAppRuntimeState>> {
        const ids = [...new Set((workIds ?? []).filter(Boolean))];
        if (ids.length === 0) {
            return new Map();
        }
        const rows = await this.repository
            .createQueryBuilder('state')
            .where('state.workId IN (:...ids)', { ids })
            .getMany();
        return new Map(rows.map((row) => [row.workId, row]));
    }

    /**
     * §2.2 step 3's atomic claim.
     *
     * `UPDATE … SET deployLockId = :id, deployLockedAt = :now
     *  WHERE workId = :w AND paused = false AND deletionRequestedAt IS NULL
     *    AND (deployLockId IS NULL OR deployLockedAt <= :staleBefore)`
     *
     * The `paused` / `deletionRequestedAt` conditions are APW06-G03's addition
     * and they belong in the WHERE, not in a read: a pause that lands between a
     * caller's read and its claim must lose.
     *
     * The stale branch is what stops a crashed dispatcher wedging a Work
     * forever — after {@link APP_DEPLOY_LOCK_STALE_S} (the maximum deploy
     * duration plus a minute) the lock is reclaimable by whoever asks next.
     *
     * @returns `true` when this call owns the dispatch.
     */
    async claimDeployLock(
        workId: string,
        deploymentId: string,
        staleAfterS: number = APP_DEPLOY_LOCK_STALE_S,
    ): Promise<boolean> {
        const nowMs = Date.now();
        const staleBefore = nowMs - Math.max(0, staleAfterS) * 1000;

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ deployLockId: deploymentId, deployLockedAt: new Date(nowMs) })
            .where('workId = :workId', { workId })
            .andWhere('paused = :notPaused', { notPaused: false })
            .andWhere('deletionRequestedAt IS NULL')
            .andWhere(
                '(deployLockId IS NULL OR deployLockedAt IS NULL OR deployLockedAt <= :staleBefore)',
                { staleBefore },
            )
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * Give the lock back — and clear the cancel flag **in the same UPDATE**
     * (T17's own rule, plan §7.2). A `cancelRequestedAt` left behind by the
     * Deployment that just finished would cancel the next one the moment it
     * claimed the lock.
     *
     * Only the holder may release: `deployLockId = :deploymentId` is in the
     * WHERE, so a late release from a superseded dispatcher is a no-op rather
     * than a lock stolen from the Deployment that is actually running.
     */
    async releaseDeployLock(workId: string, deploymentId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({
                deployLockId: null,
                deployLockedAt: null,
                cancelRequestedAt: null,
                cancelRequestedByUserId: null,
            })
            .where('workId = :workId', { workId })
            .andWhere('deployLockId = :deploymentId', { deploymentId })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * §9.10:1591 — request a cancel of the Deployment that currently holds the
     * lock. Zero rows affected ⇒ `no_deploy_in_progress`, which is the caller's
     * refusal code, not an error here.
     */
    async requestCancel(
        workId: string,
        deploymentId: string,
        userId: string | null,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ cancelRequestedAt: new Date(), cancelRequestedByUserId: userId ?? null })
            .where('workId = :workId', { workId })
            .andWhere('deployLockId = :deploymentId', { deploymentId })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * `tasks.md:1154` — write `queuedDeploymentId` and `queuedBuildId` in ONE
     * transaction and answer the id they displaced.
     *
     * One call for both columns is what makes "at most 1 is queued" hold under
     * two concurrent requests: the caller marks the answered Deployment
     * `SUPERSEDED`, and there is no window in which the row names a queued
     * Deployment with someone else's Build.
     */
    async setQueued(
        workId: string,
        queued: AppDeployQueueWrite,
    ): Promise<{ supersededDeploymentId: string | null }> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(WorkAppRuntimeState);
                const current = await repo.findOne({ where: { workId } });
                const superseded = current?.queuedDeploymentId ?? null;

                await repo
                    .createQueryBuilder()
                    .update(WorkAppRuntimeState)
                    .set({
                        queuedDeploymentId: queued.deploymentId ?? null,
                        queuedBuildId: queued.buildId ?? null,
                    })
                    .where('workId = :workId', { workId })
                    .execute();

                return {
                    supersededDeploymentId:
                        superseded && superseded !== queued.deploymentId ? superseded : null,
                };
            }),
        );
    }

    /**
     * §5.6 step 7's dequeue — "one compare-and-set" (T24's header).
     *
     * Clears both queue columns and answers what it took, so two concurrent
     * finishes cannot dispatch the same queued row twice: the second sees
     * `null` because the first already cleared it.
     */
    async takeQueued(
        workId: string,
    ): Promise<{ queuedDeploymentId: string | null; queuedBuildId: string | null } | null> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(WorkAppRuntimeState);
                const current = await repo.findOne({ where: { workId } });
                if (!current?.queuedDeploymentId) {
                    return null;
                }

                const result = await repo
                    .createQueryBuilder()
                    .update(WorkAppRuntimeState)
                    .set({ queuedDeploymentId: null, queuedBuildId: null })
                    .where('workId = :workId', { workId })
                    .andWhere('queuedDeploymentId = :queued', {
                        queued: current.queuedDeploymentId,
                    })
                    .execute();

                if ((result.affected ?? 0) !== 1) {
                    return null;
                }
                return {
                    queuedDeploymentId: current.queuedDeploymentId,
                    queuedBuildId: current.queuedBuildId ?? null,
                };
            }),
        );
    }

    /**
     * §9.3's health-poll selection (`plan.md:1289-1290`):
     * `target ≠ 'none' AND paused = false AND removedAt IS NULL AND
     *  currentDeploymentId IS NOT NULL`, ordered `lastPolledAt NULLS FIRST`.
     *
     * The `userId` the caller needs for §9.4's per-owner notifications is NOT a
     * column of this table — §7.2 carries no user id — so it is **joined** from
     * `works`. A row whose Work cannot be read arrives without one and is polled
     * but not notified, which is the behaviour `AppHealthStateView.userId`
     * documents.
     *
     * `NULLS FIRST` is expressed as a `CASE` rather than the SQL keyword because
     * better-sqlite3 does not accept `NULLS FIRST` in `ORDER BY`; the `CASE`
     * means the same thing on both drivers. This is the same construction
     * `work-upstream-state.repository.ts` uses.
     */
    async selectForHealthPoll(limit: number): Promise<WorkAppRuntimeStatePollRow[]> {
        const take = Math.max(0, Math.min(Math.trunc(limit) || 0, APP_HEALTH_POLL_MAX_BATCH));
        if (take === 0) {
            return [];
        }

        const rows = await this.repository
            .createQueryBuilder('state')
            .where('state.target != :none', { none: 'none' })
            .andWhere('state.paused = :notPaused', { notPaused: false })
            .andWhere('state.removedAt IS NULL')
            .andWhere('state.currentDeploymentId IS NOT NULL')
            .orderBy('CASE WHEN state.lastPolledAt IS NULL THEN 0 ELSE 1 END', 'ASC')
            .addOrderBy('state.lastPolledAt', 'ASC')
            .addOrderBy('state.id', 'ASC')
            .take(take)
            .getMany();

        if (rows.length === 0) {
            return [];
        }

        // The owner is read in a SECOND, bounded query rather than joined.
        //
        // A `leftJoin` + `getRawAndEntities()` is the obvious shape and it does
        // not work here: TypeORM combines `ORDER BY` with the select expression
        // when a `take()` is present, and it then tries to resolve the
        // `CASE WHEN state.lastPolledAt IS NULL ...` ordering term as a JOIN
        // ALIAS, failing with `"CASE WHEN state" alias was not found`. The
        // `CASE` is not optional either: better-sqlite3 does not accept
        // `NULLS FIRST`, and §9.3's ordering is what decides which App Work is
        // polled next. So the page is selected first, and the at-most-`take`
        // owners are looked up by id.
        const works = await this.works
            .createQueryBuilder('work')
            .select(['work.id', 'work.userId'])
            .where('work.id IN (:...ids)', { ids: rows.map((row) => row.workId) })
            .getMany();
        const owners = new Map(works.map((work) => [work.id, work.userId ?? null]));

        return rows.map((row) => Object.assign(row, { userId: owners.get(row.workId) ?? null }));
    }

    /** T17's `recordHealth(...)`: the three counters, `health`, `lastPolledAt`, the address. */
    async recordHealth(workId: string, patch: AppHealthStatePatch): Promise<void> {
        const update: Record<string, unknown> = {
            health: patch.health,
            consecutiveFailures: patch.consecutiveFailures,
            consecutivePasses: patch.consecutivePasses,
            unreachableStreak: patch.unreachableStreak,
            lastPolledAt: patch.lastPolledAt,
        };
        // Written ONLY when a failure notification was really created — it is
        // §9.4's dedupe handle, and stamping it on every poll would suppress the
        // next real notification for six hours.
        if (patch.lastHealthNotifiedAt !== undefined) {
            update.lastHealthNotifiedAt = patch.lastHealthNotifiedAt;
        }
        // FR-41: present only when the address changed or was withdrawn, so
        // `undefined` must not clear a good address.
        if (patch.ingressAddress !== undefined) {
            update.ingressAddress = patch.ingressAddress;
        }

        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set(update)
            .where('workId = :workId', { workId })
            .execute();
    }

    /** T17's `saveSnapshot(...)`: `statusSnapshot` / `statusObservedAt` (§7.2:1070). */
    async saveSnapshot(
        workId: string,
        snapshot: AppStatusSnapshot,
        observedAt?: string | Date,
    ): Promise<void> {
        const at =
            observedAt instanceof Date
                ? observedAt
                : new Date(observedAt ?? snapshot?.observedAt ?? Date.now());

        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({
                statusSnapshot: snapshot ?? null,
                statusObservedAt: Number.isNaN(at.getTime()) ? new Date() : at,
            })
            .where('workId = :workId', { workId })
            .execute();
    }

    /**
     * §9.10:1592 — one job's result lands inside `statusSnapshot.jobs`.
     *
     * **Takes the `AppJobResult` itself**, not a `{ name, last }` wrapper: that
     * is what `app-lifecycle-ops.service.ts:1670` passes, and `AppJobResult`
     * carries its own `name` (`app-deployment.types.ts:468`). The snapshot's
     * `jobs[]` entries are `{ name, last }`, so the wrapping happens HERE.
     *
     * Read-modify-write inside a transaction: the snapshot is a JSON bag, so
     * there is no column-level UPDATE that can merge one entry. The entry is
     * matched by `name` and replaced, or appended when the snapshot has never
     * seen that job.
     */
    async saveJobResult(workId: string, job: AppJobResult): Promise<void> {
        await serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(WorkAppRuntimeState);
                const row = await repo.findOne({ where: { workId } });
                if (!row) {
                    return;
                }
                const snapshot = (row.statusSnapshot ?? null) as AppStatusSnapshot | null;
                const jobs = [...(snapshot?.jobs ?? [])];
                const at = jobs.findIndex((entry) => entry.name === job.name);
                if (at >= 0) {
                    jobs[at] = { name: job.name, last: job };
                } else {
                    jobs.push({ name: job.name, last: job });
                }

                const next = {
                    observedAt: snapshot?.observedAt ?? new Date().toISOString(),
                    components: snapshot?.components ?? [],
                    cron: snapshot?.cron ?? [],
                    isolationEnforced: snapshot?.isolationEnforced ?? null,
                    ...(snapshot ?? {}),
                    jobs,
                } as AppStatusSnapshot;

                await repo
                    .createQueryBuilder()
                    .update(WorkAppRuntimeState)
                    .set({ statusSnapshot: next })
                    .where('workId = :workId', { workId })
                    .execute();
            }),
        );
    }

    /**
     * §9.10:1592's read half — the status of the named job's last run, or `null`.
     *
     * Reached through an `as unknown as` cast and a `hasMember` probe at
     * `app-lifecycle-ops.service.ts:1734-1745`: it is declared in NO consumer
     * interface, so a missing implementation reads as `null` and the caller
     * concludes the job is not running. That is a safe answer and a wrong one —
     * `isJobRunning` would let a second run start over the top of a live one —
     * which is why it is implemented here rather than left to the probe.
     */
    async findJobState(workId: string, name: string): Promise<string | null> {
        const row = await this.repository.findOne({ where: { workId } });
        const entry = (row?.statusSnapshot?.jobs ?? []).find((job) => job.name === name);
        const status = entry?.last?.status;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    /**
     * §9.7:1490 — the atomic deletion claim.
     *
     * Legal only when no deletion is already recorded **and** no deploy lock is
     * held: deleting a Work mid-deploy would race the dispatcher into a
     * namespace it is still writing. Both conditions are in the WHERE.
     *
     * @returns `true` when this call won the claim and owns the dispatch.
     */
    async claimDeletion(
        workId: string,
        opts: { deleteStoredData: boolean; requestedByUserId: string },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({
                deletionRequestedAt: new Date(),
                deletionDeleteData: opts.deleteStoredData === true,
                deletionRequestedByUserId: opts.requestedByUserId ?? null,
            })
            .where('workId = :workId', { workId })
            .andWhere('deletionRequestedAt IS NULL')
            .andWhere('deployLockId IS NULL')
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /** §9.7:1509 — record an attempt so the row's `deletionAttempts` reflects the retries. */
    async recordDeletionAttempt(workId: string): Promise<number> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(WorkAppRuntimeState);
                const row = await repo.findOne({ where: { workId } });
                if (!row) {
                    return 0;
                }
                const attempts = (row.deletionAttempts ?? 0) + 1;
                await repo
                    .createQueryBuilder()
                    .update(WorkAppRuntimeState)
                    .set({ deletionAttempts: attempts })
                    .where('workId = :workId', { workId })
                    .execute();
                return attempts;
            }),
        );
    }

    /**
     * §9.10:1588-1589 — the paused flag.
     *
     * Pausing is the atomic conditional UPDATE: it must not land while a
     * Deployment holds the lock or a deletion is under way, because both would
     * then be operating on a Work the owner believes is stopped. `false` ⇒ the
     * condition did not hold and the caller reports it. RESUMING carries no such
     * condition — a paused Work holds no lock by construction.
     */
    async setPaused(workId: string, paused: boolean, at: Date): Promise<boolean> {
        const query = this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ paused, pausedAt: paused ? at : null })
            .where('workId = :workId', { workId });

        if (paused) {
            query.andWhere('deployLockId IS NULL').andWhere('deletionRequestedAt IS NULL');
        }

        const result = await query.execute();
        return (result.affected ?? 0) === 1;
    }

    /**
     * §5.6 step 6 — the one write for the fields that step names, plus the
     * §9.10 reconcile fields. Only keys the caller supplies are written:
     * `undefined` must not clear a column a different path owns.
     *
     * `firstDeployJobsCompletedAt` is reset by the caller when
     * `clusterFingerprint` changes (§7.2) — a new cluster has run no
     * first-deploy jobs — and that is a decision, so it stays at the call site.
     */
    async patchRuntimeState(workId: string, patch: AppRuntimeStatePatch): Promise<void> {
        const update: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch ?? {})) {
            if (value !== undefined) {
                update[key] = value;
            }
        }
        if (Object.keys(update).length === 0) {
            return;
        }

        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set(update)
            .where('workId = :workId', { workId })
            .execute();
    }

    /** §5.6:843-844 — set `upstreamSyncJudgedToSha`, whether the Deployment passed or failed. */
    async setUpstreamSyncJudgedToSha(workId: string, sha: string | null): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ upstreamSyncJudgedToSha: sha ?? null })
            .where('workId = :workId', { workId })
            .execute();
    }

    /** §8.2:1112-1114 — the latest-wins `pendingDomainRebuildBuildId` write. */
    async setPendingDomainRebuildBuildId(workId: string, buildId: string | null): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ pendingDomainRebuildBuildId: buildId ?? null })
            .where('workId = :workId', { workId })
            .execute();
    }

    /**
     * T17's atomic clear (APW06-G11): only the Build that is actually pending
     * may clear it. A late `app.build.failed` from a Build that has already been
     * superseded by a newer rebuild must not wipe the newer one's claim.
     */
    async clearPendingDomainRebuild(workId: string, buildId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ pendingDomainRebuildBuildId: null })
            .where('workId = :workId', { workId })
            .andWhere('pendingDomainRebuildBuildId = :buildId', { buildId })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * §9.10:1593 — `clusterCheck`, `clusterCheckedAt` and the observed address.
     *
     * Deliberately does NOT write `clusterFingerprint`: §7.2 reserves that
     * column for `prepare-namespace` and §5.6, and the check's own fingerprint
     * lives inside the `clusterCheck` bag. A check against a cluster the Work is
     * not deployed to must not look like a redeploy.
     */
    async saveClusterCheck(
        workId: string,
        check: AppClusterCheck & { fingerprint?: string | null },
        checkedAt: string | Date,
        ingressAddress: AppRuntimeIngressAddress | null,
    ): Promise<void> {
        const at = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
        const update: Record<string, unknown> = {
            clusterCheck: check ?? null,
            clusterCheckedAt: Number.isNaN(at.getTime()) ? new Date() : at,
        };
        if (ingressAddress !== undefined) {
            update.ingressAddress = ingressAddress;
        }

        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set(update)
            .where('workId = :workId', { workId })
            .execute();
    }

    /** §9.10:1595 — the address a check or a reconcile observed. */
    async saveIngressAddress(
        workId: string,
        address: AppRuntimeIngressAddress | null,
    ): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ ingressAddress: address ?? null })
            .where('workId = :workId', { workId })
            .execute();
    }

    /**
     * §9.10:1590 — the terminal write of `remove`: `removedAt` set,
     * `currentDeploymentId` cleared, so the health poller stops selecting the
     * row on its very next tick.
     */
    async markRemoved(workId: string, removedAt: Date): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ removedAt, currentDeploymentId: null })
            .where('workId = :workId', { workId })
            .execute();
    }

    /**
     * FR-63's derivation, applied in place.
     *
     * Only while the stored target is still `none`: a target the owner has
     * changed is never overwritten. The write is a conditional UPDATE on the
     * same `target = 'none'` predicate, so two concurrent readers cannot
     * disagree about what the derivation produced.
     */
    private async applyDerivedTarget(row: WorkAppRuntimeState): Promise<WorkAppRuntimeState> {
        if (row.target && row.target !== 'none') {
            return row;
        }

        const work = await this.works.findOne({
            where: { id: row.workId },
            select: { id: true, deployProvider: true },
        });
        const derived = deriveAppDeployTarget(work?.deployProvider ?? null);
        if (derived === 'none') {
            return row;
        }

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppRuntimeState)
            .set({ target: derived })
            .where('workId = :workId', { workId: row.workId })
            .andWhere('target = :none', { none: 'none' })
            .execute();

        if ((result.affected ?? 0) === 1) {
            row.target = derived;
            return row;
        }

        // Somebody else derived or set it first; their value is the truth.
        const reread = await this.repository.findOne({ where: { workId: row.workId } });
        return reread ?? row;
    }
}

/**
 * FR-63 — the Work's creation-time choice, as a deploy target.
 *
 * `tasks.md` T17 states the rule: `your-cluster` when the Work's persisted
 * `deployProvider` names a deployment plugin with `supportsApps === true`, the
 * managed target when it is `ever-works-apps`, else `none`.
 *
 * ## Why the App-capable set is a literal here, and not a plugin query
 *
 * Asking the plugin registry would drag the whole plugin system into a
 * repository that otherwise touches two tables, and the registry answer is
 * async and per-installation while this derivation runs inside a hot read.
 * Measured on this tree (2026-09-21): `grep -rn 'supportsApps' packages/plugins`
 * returns exactly ONE declaration, `packages/plugins/k8s/src/k8s.plugin.ts:388`
 * (`readonly supportsApps = true`). So the set below is not a guess about the
 * plugins — it is the plugins, enumerated.
 *
 * When a second App-capable deployment plugin lands, its id goes here and this
 * function's own spec fails until it does. That is deliberate: a silent
 * `none` would make a correctly-created Work refuse to deploy, which is the
 * exact failure FR-63 exists to prevent, and it would look like an empty
 * database rather than a missing entry.
 *
 * This is NOT a new DI token. The branch already has 55 tokens bound nowhere;
 * adding a 56th to express "which plugins support apps" would trade a literal
 * that is checkable for a port that is dormant.
 */
export function deriveAppDeployTarget(deployProvider: string | null | undefined): AppDeployTarget {
    const id = (deployProvider ?? '').trim().toLowerCase();
    if (id === '') {
        return 'none';
    }
    if (id === MANAGED_APPS_DEPLOY_PROVIDER_ID) {
        return 'ever-works-apps';
    }
    return APP_CAPABLE_DEPLOY_PROVIDER_IDS.has(id) ? 'your-cluster' : 'none';
}

/** The provider id that means the managed tier (R-12's `ever-works-apps`). */
export const MANAGED_APPS_DEPLOY_PROVIDER_ID = 'ever-works-apps';

/**
 * Every deployment plugin id that declares `supportsApps === true`.
 * See {@link deriveAppDeployTarget} for why this is enumerated and not queried.
 */
export const APP_CAPABLE_DEPLOY_PROVIDER_IDS: ReadonlySet<string> = new Set(['k8s']);

/**
 * When a held deploy lock becomes reclaimable: `APP_DEPLOY_MAX_DURATION_S`
 * (7 200, `plan.md:733`) plus 60 seconds of slack, exactly as §7.2 states. A
 * dispatcher that dies mid-deploy therefore wedges its Work for at most two
 * hours and a minute, not forever.
 */
export const APP_DEPLOY_LOCK_STALE_S = 7_260;

/**
 * The hard ceiling on one health-poll batch, whatever the caller asks for.
 * §9.3's poller asks for a page at a time; this only stops an unbounded value
 * from loading the whole table into memory.
 */
export const APP_HEALTH_POLL_MAX_BATCH = 500;
