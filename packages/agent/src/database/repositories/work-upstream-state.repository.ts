import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import type { AppActionsState, AppRepositoryMode, AppUpstreamStatus } from '@ever-works/contracts';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import { serializeOnSingleConnection } from './single-connection-write-queue';

/**
 * APW-02 (Fork lifecycle) — the `work_upstream_states` repository.
 *
 * Plan §3.1 (`plan.md:265-270`) names the methods; T14 fixes their
 * signatures. Feature-owned: it is provided by the App Works module (T15) and
 * exported from `database/index.ts` for it, NOT by `DatabaseModule` — see the
 * docstring of `_repository-inventory.ts` for why a feature-owned repository
 * must not appear in that inventory.
 *
 * ## Every instant here is epoch milliseconds, not a `Date`
 *
 * `claimDue(nowMs, …)`, `findStalePreparing(nowMs, idleMs, …)`,
 * `claimSetupPullRequestChecks(nowMs, minIntervalMs, …)` and the two manual
 * counters all take plain numbers, and every predicate compares the `bigint`
 * columns the entity stores (`plan.md:207-208`). A `Date` bound into a
 * query-builder predicate is passed to the driver verbatim — better-sqlite3
 * refuses to bind one at all, and Postgres would be asked to compare a
 * `bigint` with a `timestamptz`. Dates appear only where TypeORM applies the
 * column transformer: `.set()` on a `TimestampColumn`.
 *
 * ## Claims are conditional UPDATEs, one row at a time
 *
 * `claimDue` and `claimSetupPullRequestChecks` must never hand the same row to
 * two callers: the dispatcher runs every ten minutes on every API replica, and
 * a row claimed twice is a sync dispatched twice or a setup pull request
 * checked twice. Each candidate is therefore stamped with
 * `UPDATE … WHERE id = :id AND <the same predicate that selected it>`, and only
 * a row whose `affected` is 1 is returned — the loser of a race gets 0 and
 * skips the row. Stamping the whole candidate set in one statement and reading
 * the ids back would be ambiguous instead: two callers using the same `nowMs`
 * write the same stamp value, so the read-back could not tell whose claim a row
 * was. The candidate SELECT and its stamps run inside one transaction
 * (`plan.md:266-269`), which {@link serializeOnSingleConnection} keeps from
 * overlapping on the drivers whose TypeORM runner is shared by the whole
 * DataSource — better-sqlite3 is the default `DATABASE_TYPE`, so without it two
 * concurrent claims would collide inside `startTransaction` (see that helper's
 * docstring).
 *
 * ## The claim lease
 *
 * `claimDue` stamps `nextSyncAt` to `now + UPSTREAM_SYNC_CLAIM_LEASE_MS` before
 * it hands the row over: the caller stamps the real next cron slot
 * (`plan.md:809`, §6.4) once it has actually dispatched, so the lease is only
 * the ceiling on how long a crashed dispatch can hide a row — and the reason a
 * Work that fails every run cannot hot-loop.
 */

/**
 * How long a claim holds a row before the sweep may try it again: one full
 * dispatcher tick, the every-ten-minutes cron of `plan.md:803`. The service
 * replaces it with the computed next slot before dispatching; this is the
 * backstop.
 */
export const UPSTREAM_SYNC_CLAIM_LEASE_MS = 600_000;

/** FR-41 — an unreadable upstream is re-checked every 24 hours. */
export const UPSTREAM_RECHECK_INTERVAL_MS = 86_400_000;

/**
 * The hard ceiling on one batch, whatever the caller asks for. The dispatcher
 * asks for 50 (`plan.md:809-814`); this only stops an unbounded value from
 * loading the whole table into memory.
 */
export const UPSTREAM_MAX_BATCH = 500;

/**
 * What {@link WorkUpstreamStateRepository.create} needs to write a row.
 *
 * ## The four relation-dependent columns are inputs, not patches
 *
 * `upstreamStatus`, `actionsState`, `readinessReason` and
 * `dataRepositoryStatus` are the columns whose correct value depends on the
 * `relation` the row is created with: plan §4.2 step 10's per-relation table
 * fixes `upstreamStatus: 'none'` and `actionsState: 'not_applicable'` for a
 * `link` (FR-31 — hygiene never touches a link), while a `fork` or
 * `private-copy` row keeps the declared defaults. They are accepted here so
 * APW-01's create path can write the whole per-relation row in the ONE
 * transaction that also writes the Work row, rather than creating the row on
 * the defaults and patching these four with a second, out-of-transaction
 * UPDATE. Omitting any of them yields exactly the column's declared default,
 * so every existing caller is byte-identical.
 */
export interface CreateWorkUpstreamStateInput {
    readonly workId: string;
    readonly relation: AppRepositoryMode;
    readonly dataOwner: string;
    readonly dataRepo: string;
    readonly dataDefaultBranch: string;
    /** Absent for a `link` relation — it has no upstream (FR-44). */
    readonly upstreamOwner?: string | null;
    readonly upstreamRepo?: string | null;
    readonly upstreamDefaultBranch?: string | null;
    /** The effective cron, once it is known; NULL means "not scheduled". */
    readonly syncSchedule?: string | null;
    readonly nextSyncAt?: Date | null;
    /** Defaults to "now": the readiness clock the stale sweep measures against. */
    readonly readinessStartedAt?: Date | null;
    /** `none` for a `link` (APW-02 §3.1); omitted ⇒ the column default `unknown`. */
    readonly upstreamStatus?: AppUpstreamStatus | null;
    /** `not_applicable` for a `link` (FR-31: hygiene never touches a link); omitted ⇒ the column default `pending`. */
    readonly actionsState?: AppActionsState | null;
    /** A reason code, never a provider message; omitted ⇒ NULL. */
    readonly readinessReason?: string | null;
    /** `available` (the default) or `missing`; omitted ⇒ the column default `available`. */
    readonly dataRepositoryStatus?: 'available' | 'missing' | null;
    readonly tenantId?: string | null;
    readonly organizationId?: string | null;
}

/**
 * The answer to one **Sync now** or **Try again** attempt (FR-33, FR-19).
 *
 * `count` and `windowAtMs` are read back from the row AFTER the update, so
 * under concurrency they may already include another caller's attempt — the
 * authoritative part of the answer is `allowed`, which is the outcome of the
 * conditional update itself.
 */
export interface ManualAttemptResult {
    readonly allowed: boolean;
    readonly count: number;
    readonly windowAtMs: number | null;
}

/** The columns of a patch: never the identity, never the creation stamp. */
export type WorkUpstreamStatePatch = Partial<
    Omit<WorkUpstreamState, 'id' | 'workId' | 'work' | 'createdAt'>
>;

@Injectable()
export class WorkUpstreamStateRepository {
    constructor(
        @InjectRepository(WorkUpstreamState)
        private readonly repository: Repository<WorkUpstreamState>,
    ) {}

    /** The state row of one App Work, or `null` when it has none yet. */
    async findByWorkId(workId: string): Promise<WorkUpstreamState | null> {
        return this.repository.findOne({ where: { workId } });
    }

    /**
     * Insert the row APW-01 creates with the App Work. Everything the plan does
     * not pass here takes its declared default (`preparing`, `unknown`,
     * `available`, `pending`, the counters `0`) — TypeORM omits an undefined
     * property from the INSERT, so the database applies them, not a second copy
     * of the defaults in TypeScript. The four relation-dependent columns
     * ({@link CreateWorkUpstreamStateInput}) are the one exception: each falls
     * back to its column's declared default here, so a caller that omits one
     * still stores exactly what the column default would have written, and a
     * `link` can be written with `none` / `not_applicable` in this same INSERT.
     *
     * `manager` is the transaction-scoped `EntityManager` the caller passes
     * when this row must commit together with the Work row: APW-01's create
     * writes both in ONE transaction, and a save through the injected
     * repository would land on a different pooled connection — outside that
     * transaction on Postgres, so a rollback of the Work would leave this row
     * behind. Callers outside a transaction omit the argument and keep the
     * previous behaviour exactly.
     */
    async create(
        input: CreateWorkUpstreamStateInput,
        manager?: EntityManager,
    ): Promise<WorkUpstreamState> {
        const states = manager ? manager.getRepository(WorkUpstreamState) : this.repository;
        const entity = states.create({
            workId: input.workId,
            relation: input.relation,
            dataOwner: input.dataOwner,
            dataRepo: input.dataRepo,
            dataDefaultBranch: input.dataDefaultBranch,
            upstreamOwner: input.upstreamOwner ?? null,
            upstreamRepo: input.upstreamRepo ?? null,
            upstreamDefaultBranch: input.upstreamDefaultBranch ?? null,
            syncSchedule: input.syncSchedule ?? null,
            nextSyncAt: input.nextSyncAt ?? null,
            readinessStartedAt: input.readinessStartedAt ?? new Date(),
            upstreamStatus: input.upstreamStatus ?? 'unknown',
            actionsState: input.actionsState ?? 'pending',
            readinessReason: input.readinessReason ?? null,
            dataRepositoryStatus: input.dataRepositoryStatus ?? 'available',
            tenantId: input.tenantId ?? null,
            organizationId: input.organizationId ?? null,
        });

        return states.save(entity);
    }

    /**
     * Patch one App Work's row. `false` means there was no row to patch — which
     * is how a job that lost its App Work notices instead of silently
     * succeeding.
     */
    async update(workId: string, patch: WorkUpstreamStatePatch): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkUpstreamState)
            .set(patch)
            .where('workId = :workId', { workId })
            .execute();

        return (result.affected ?? 0) > 0;
    }

    /**
     * FR-43 (APW-09 T43) — the member a handover recorded as this App Work's
     * **credential of record**, or `null`.
     *
     * `null` carries exactly one meaning for the caller — "no handover has been
     * recorded" — and this method deliberately cannot tell the two ways it
     * arrives there: a Work whose state row does not exist has never had a
     * handover either, and the credential of record is then the Work's creator
     * (`UpstreamCredentialService.readRecordMember`,
     * `upstream-credential.service.ts:518-528`). Throwing for the missing row
     * would turn "the creator's connection" into a job failure, which is the
     * pause the rule exists to avoid.
     *
     * The read is this repository's own door ({@link findByWorkId}), so the row
     * it answers with is the row `update` patches.
     */
    async findCredentialMemberUserId(workId: string): Promise<string | null> {
        const row = await this.findByWorkId(workId);

        return row?.credentialMemberUserId ?? null;
    }

    /**
     * FR-43 — record `memberUserId` as this App Work's credential of record, for
     * background work not yet started.
     *
     * The write is {@link update}'s conditional UPDATE, keyed by `workId` alone:
     * the Work is the scope of this row (`uq_work_upstream_states_work`), and
     * `tenantId` / `organizationId` are carried stamps, never predicates — a
     * credential write moves no row between scopes and rewrites neither column,
     * so an App Work that belongs to another organization is reachable only by
     * its own id and only through whatever door resolved that id for the caller
     * (`WorkRepository.findByIdForAccess` plus membership, the layer the
     * visibility rule lives in — see `AppUpstreamStateService.requireVisibleAppWork`).
     *
     * `false` therefore means what it means there — there was no state row to
     * patch — and the caller must NOT report a handover it did not durably
     * record. Nothing upstream is edited, closed or rewritten by this write: the
     * column names a member and nothing else (FR-43).
     */
    async setCredentialMemberUserId(workId: string, memberUserId: string): Promise<boolean> {
        return this.update(workId, { credentialMemberUserId: memberUserId });
    }

    /**
     * Claim up to `limit` rows whose `nextSyncAt` has arrived, oldest slot
     * first, and stamp each one before returning it (`plan.md:266-267`).
     *
     * A NULL `nextSyncAt` is never claimed: that is the paused state and the
     * `link` relation (§3.1). Rows inside `rateLimitedUntil` ARE claimed — the
     * dispatcher skips them after the claim (`plan.md:810`), which is what
     * keeps them from being re-selected on every tick.
     */
    async claimDue(nowMs: number, limit: number): Promise<WorkUpstreamState[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(WorkUpstreamState);
                const due = await repo
                    .createQueryBuilder('state')
                    .where('state.nextSyncAt IS NOT NULL')
                    .andWhere('state.nextSyncAt <= :nowMs', { nowMs })
                    .orderBy('state.nextSyncAt', 'ASC')
                    .addOrderBy('state.id', 'ASC')
                    .take(take)
                    .getMany();

                return this.stampClaimedRows(
                    repo,
                    due,
                    'nextSyncAt',
                    new Date(nowMs + UPSTREAM_SYNC_CLAIM_LEASE_MS),
                    nowMs,
                );
            }),
        );
    }

    /**
     * Readiness jobs that never started or stopped reporting (FR-23, S27):
     * `preparing` rows whose last heartbeat — or, when there has never been
     * one, whose `readinessStartedAt` — is at least `idleMs` old.
     *
     * A read, not a claim: the sweep re-dispatches the job and bumps
     * `readinessDispatches` (or times the row out) itself, so nothing is
     * stamped here.
     */
    async findStalePreparing(
        nowMs: number,
        idleMs: number,
        limit: number,
    ): Promise<WorkUpstreamState[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const cutoff = nowMs - Math.max(0, idleMs);

        return this.repository
            .createQueryBuilder('state')
            .where('state.readinessState = :preparing', { preparing: 'preparing' })
            .andWhere(
                '(state.readinessHeartbeatAt <= :cutoff OR (state.readinessHeartbeatAt IS NULL AND state.readinessStartedAt <= :cutoff))',
                { cutoff },
            )
            .orderBy('state.readinessStartedAt', 'ASC')
            .addOrderBy('state.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Upstreams to re-check because they read back unreadable (FR-41): rows
     * `unavailable` whose last check is at least 24 hours old.
     *
     * A row never checked (`upstreamCheckedAt IS NULL`) is due immediately
     * rather than never: the pause it carries was set by a path that did not
     * record a check, and "every 24 hours" has no earlier instant to measure
     * from.
     */
    async findUnavailableDueForRecheck(nowMs: number, limit: number): Promise<WorkUpstreamState[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const cutoff = nowMs - UPSTREAM_RECHECK_INTERVAL_MS;

        return this.repository
            .createQueryBuilder('state')
            .where('state.upstreamStatus = :unavailable', { unavailable: 'unavailable' })
            .andWhere('(state.upstreamCheckedAt IS NULL OR state.upstreamCheckedAt <= :cutoff)', {
                cutoff,
            })
            .orderBy('CASE WHEN state.upstreamCheckedAt IS NULL THEN 0 ELSE 1 END', 'ASC')
            .addOrderBy('state.upstreamCheckedAt', 'ASC')
            .addOrderBy('state.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Claim the setup pull request checks that are due (FR-24a): rows waiting
     * for their setup pull request whose `setupCheckedAt` is older than
     * `minIntervalMs`, stamped with `nowMs` in the same transaction so the
     * dispatcher tick and the on-view check cannot both claim one row.
     *
     * A NULL `setupCheckedAt` is due immediately — that row has never been
     * checked, and `minIntervalMs` has nothing to throttle against.
     */
    async claimSetupPullRequestChecks(
        nowMs: number,
        minIntervalMs: number,
        limit: number,
    ): Promise<WorkUpstreamState[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const cutoff = nowMs - Math.max(0, minIntervalMs);

        return serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(WorkUpstreamState);
                const due = await repo
                    .createQueryBuilder('state')
                    .where('state.readinessState = :waiting', { waiting: 'waiting_for_setup_pr' })
                    .andWhere('(state.setupCheckedAt IS NULL OR state.setupCheckedAt <= :cutoff)', {
                        cutoff,
                    })
                    .orderBy('CASE WHEN state.setupCheckedAt IS NULL THEN 0 ELSE 1 END', 'ASC')
                    .addOrderBy('state.setupCheckedAt', 'ASC')
                    .addOrderBy('state.id', 'ASC')
                    .take(take)
                    .getMany();

                return this.stampClaimedRows(repo, due, 'setupCheckedAt', new Date(nowMs), nowMs);
            }),
        );
    }

    /**
     * **Sync now** allowance (FR-33): at most `max` attempts per App Work per
     * rolling `windowMs`.
     *
     * Two conditional UPDATEs, in order. The first opens a new window when the
     * stored one has rolled over (that attempt IS the first of the new window);
     * the second increments inside the current window while it is under the
     * cap. Each statement is atomic and re-evaluates its own predicate under
     * the row lock, so two simultaneous callers can never both take the last
     * slot — whichever loses sees the winner's count and is denied.
     */
    async incrementManualSync(
        workId: string,
        nowMs: number,
        windowMs: number,
        max: number,
    ): Promise<ManualAttemptResult> {
        return this.incrementManualCounter(
            'manualSyncCount',
            'manualSyncWindowAt',
            workId,
            nowMs,
            windowMs,
            max,
        );
    }

    /** **Try again** allowance (FR-19): at most `max` attempts per App Work per rolling `windowMs`. */
    async incrementManualRetry(
        workId: string,
        nowMs: number,
        windowMs: number,
        max: number,
    ): Promise<ManualAttemptResult> {
        return this.incrementManualCounter(
            'readinessManualRetries',
            'readinessManualWindowAt',
            workId,
            nowMs,
            windowMs,
            max,
        );
    }

    /**
     * The shared body of the two manual allowances. `max < 1` denies without
     * touching the row: a zero allowance must not be able to open a window and
     * record a first attempt anyway.
     */
    private async incrementManualCounter(
        countColumn: 'manualSyncCount' | 'readinessManualRetries',
        windowColumn: 'manualSyncWindowAt' | 'readinessManualWindowAt',
        workId: string,
        nowMs: number,
        windowMs: number,
        max: number,
    ): Promise<ManualAttemptResult> {
        if (max < 1) {
            const current = await this.findByWorkId(workId);
            return {
                allowed: false,
                count: current ? current[countColumn] : 0,
                windowAtMs: this.toEpochMs(current?.[windowColumn]),
            };
        }

        const windowStart = nowMs - Math.max(0, windowMs);

        // 1. A window that has rolled over (or was never opened) starts here.
        const restarted =
            countColumn === 'manualSyncCount'
                ? await this.repository
                      .createQueryBuilder()
                      .update(WorkUpstreamState)
                      .set({ manualSyncCount: 1, manualSyncWindowAt: new Date(nowMs) })
                      .where('workId = :workId', { workId })
                      .andWhere(`(${windowColumn} IS NULL OR ${windowColumn} <= :windowStart)`, {
                          windowStart,
                      })
                      .execute()
                : await this.repository
                      .createQueryBuilder()
                      .update(WorkUpstreamState)
                      .set({ readinessManualRetries: 1, readinessManualWindowAt: new Date(nowMs) })
                      .where('workId = :workId', { workId })
                      .andWhere(`(${windowColumn} IS NULL OR ${windowColumn} <= :windowStart)`, {
                          windowStart,
                      })
                      .execute();

        let allowed = (restarted.affected ?? 0) > 0;

        if (!allowed) {
            // 2. The current window is still open: take the next slot if there
            //    is one. The `count < max` predicate is what makes the seventh
            //    **Sync now** and the fourth **Try again** fail.
            const incremented = await (countColumn === 'manualSyncCount'
                ? this.repository
                      .createQueryBuilder()
                      .update(WorkUpstreamState)
                      .set({ manualSyncCount: () => '"manualSyncCount" + 1' })
                      .where('workId = :workId', { workId })
                      .andWhere('manualSyncCount < :max', { max })
                      .execute()
                : this.repository
                      .createQueryBuilder()
                      .update(WorkUpstreamState)
                      .set({ readinessManualRetries: () => '"readinessManualRetries" + 1' })
                      .where('workId = :workId', { workId })
                      .andWhere('readinessManualRetries < :max', { max })
                      .execute());

            allowed = (incremented.affected ?? 0) > 0;
        }

        const row = await this.findByWorkId(workId);

        return {
            allowed,
            count: row ? row[countColumn] : 0,
            windowAtMs: this.toEpochMs(row?.[windowColumn]),
        };
    }

    /**
     * Stamp the rows a claim selected, one conditional UPDATE each, and return
     * only the ones this call actually stamped. See the class docstring.
     */
    private async stampClaimedRows(
        repo: Repository<WorkUpstreamState>,
        candidates: WorkUpstreamState[],
        column: 'nextSyncAt' | 'setupCheckedAt',
        stamp: Date,
        nowMs: number,
    ): Promise<WorkUpstreamState[]> {
        if (candidates.length === 0) {
            return [];
        }

        const patch = column === 'nextSyncAt' ? { nextSyncAt: stamp } : { setupCheckedAt: stamp };
        const claimed: WorkUpstreamState[] = [];

        for (const candidate of candidates) {
            const result = await repo
                .createQueryBuilder()
                .update(WorkUpstreamState)
                .set(patch)
                .where('id = :id', { id: candidate.id })
                .andWhere(`(${column} IS NULL OR ${column} <= :nowMs)`, { nowMs })
                .execute();

            if ((result.affected ?? 0) === 1) {
                // The caller reads the row it was handed: report the stamp that
                // is now stored, not the value the candidate was selected with.
                Object.assign(candidate, patch);
                claimed.push(candidate);
            }
        }

        return claimed;
    }

    /** The stored epoch of a timestamp column, or `null` when it is unset. */
    private toEpochMs(value: Date | null | undefined): number | null {
        return value ? value.getTime() : null;
    }

    private batchSize(limit: number): number {
        if (!Number.isFinite(limit)) {
            return UPSTREAM_MAX_BATCH;
        }
        return Math.max(0, Math.min(Math.floor(limit), UPSTREAM_MAX_BATCH));
    }
}
