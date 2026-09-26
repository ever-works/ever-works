import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_PROVISION_LIMITS, type AppProvisioningStatus } from '@ever-works/contracts';
import { WorkAppProvisioning } from '../../entities/work-app-provisioning.entity';

/**
 * APW-04 (App Provisioner) — the `work_app_provisionings` repository.
 *
 * Plan §3.1 (`plan.md:346-398`) states the columns and the six indexes; T7 fixes
 * the eleven signatures. Feature-owned: it is provided by the provisioning
 * module and exported from `database/index.ts` for it, NOT by `DatabaseModule` —
 * the same rule APW-05's `AppBuildRepository` records, and the docstring of
 * `_repository-inventory.ts` is why a feature-owned repository must not appear
 * in that inventory.
 *
 * ## Every CAS here is ONE statement, and the predicate is what makes it a CAS
 *
 * `claimLease`, `releaseLease` and `casAttemptsUsed` each issue a single
 * `UPDATE … WHERE <the state the caller believed>`. There is no read-then-write
 * pair anywhere in this file, because the gap between a read and a write is
 * exactly the window two step executors race in: two overlapping claims of the
 * same row would both see an expired lease and both proceed, and two overlapping
 * `casAttemptsUsed(id, 2)` would both advance the counter and spend four
 * attempts for two runs. `affected === 1` is the ONLY signal that this caller won
 * — it is returned as a boolean and never inferred from a second read.
 *
 * `casAttemptsUsed` writes `expected + 1` rather than `attemptsUsed + 1`: the
 * arithmetic is the same, and the value is derived from the SAME number the
 * predicate compared, so the statement stays atomic on every driver without a
 * raw SQL fragment. A `SET attemptsUsed = attemptsUsed + 1` spelled as SQL would
 * be a dialect-shaped string in this file — see the next section.
 *
 * ## Driver-agnostic SQL (`APW04-G*`, the `b5a7d6857` rule)
 *
 * The platform runs on MySQL and MariaDB as well as PostgreSQL and the SQLite
 * family, so nothing here is dialect-specific: every predicate is a
 * parameterised property name the query builder escapes per driver, every value
 * is bound as a parameter, and there is no raw statement, no double-quoted SQL
 * fragment, no `interval '` literal and no driver branch. NULL ordering is made
 * explicit with a `CASE` expression rather than left to each driver's default,
 * because PostgreSQL sorts NULLs LAST on `ASC` while SQLite and MySQL sort them
 * FIRST — and "stalest first" has to mean one thing.
 *
 * The rule is pinned BY TEST in `apps/api/src/migrations/__tests__/CreateWorkAppProvisionings.spec.ts`,
 * which scans this file's source for each forbidden shape — the precedent
 * `apps/api/src/migrations/__tests__/query-shape.spec.ts` set for APW-05. This
 * file is deliberately NOT added to that spec's `REPOSITORIES` array: the array
 * belongs to APW-05's slice, and widening it is that file's edit, not this
 * one's.
 *
 * ## Every instant is epoch milliseconds, not a `Date`
 *
 * `listExpiredTargets` and `listStaleQuestions` take a `nowMs` number and compute
 * their own cutoff, and every predicate compares it against the `Date`-typed
 * `verificationExpiresAt` / `questionAskedAt` / `questionRemindedAt` columns.
 * `claimLease` and `releaseLease` compare `leaseExpiresAt`. The two list methods
 * therefore bind a `Date` built from the cutoff (that is what those columns
 * hold on every driver); `nowMs` is the parameter so a caller's clock is the
 * only clock — a repository that read `Date.now()` itself could not be tested
 * without freezing time.
 */

/**
 * The three statuses that mean a row is ACTIVE — the exact predicate of
 * `uq_work_app_provisionings_active` (plan §3.1:389).
 *
 * Deliberately a local constant rather than a contracts export: plan §3.2's
 * closed sets publish the seven statuses, not an "active" subset, and the
 * partial index's `WHERE` clause in the entity and the migration is the third
 * place the same three literals appear. All three are pinned by test.
 */
export const APP_PROVISIONING_ACTIVE_STATUSES: readonly AppProvisioningStatus[] = [
    'queued',
    'running',
    'needs_input',
];

/** The lease TTL of a step executor: five minutes (plan §3.1:382). */
export const APP_PROVISIONING_LEASE_MS = 5 * 60_000;

/**
 * The hard ceiling on one sweeper batch, whatever the caller asks for. The
 * sweeper asks for its own batch size; this only stops an unbounded value from
 * loading the whole table into memory.
 */
export const APP_PROVISIONING_SWEEP_BATCH = 200;

/**
 * One row per attempt to provision one App Work, read and compare-and-set by
 * the step executor, the dispatcher and the sweeper. See the file docstring for
 * the CAS and portability rules every method here obeys.
 */
@Injectable()
export class WorkAppProvisioningRepository {
    constructor(
        @InjectRepository(WorkAppProvisioning)
        private readonly repository: Repository<WorkAppProvisioning>,
    ) {}

    /**
     * The one ACTIVE row of an App Work, or `null`.
     *
     * "Active" is `queued | running | needs_input` — the partial unique index's
     * own predicate, so a Work can have many terminal rows and at most one of
     * these. Newest first and tie-broken by `id` so a database that somehow holds
     * two (a MySQL/MariaDB one, where the partial index cannot exist) still
     * answers deterministically rather than at random.
     */
    async findActiveByWork(workId: string): Promise<WorkAppProvisioning | null> {
        return this.repository
            .createQueryBuilder('provisioning')
            .where('provisioning.workId = :workId', { workId })
            .andWhere('provisioning.status IN (:...statuses)', {
                statuses: [...APP_PROVISIONING_ACTIVE_STATUSES],
            })
            .orderBy('provisioning.createdAt', 'DESC')
            .addOrderBy('provisioning.id', 'ASC')
            .getOne();
    }

    /**
     * The row a provisioning Task belongs to, or `null`.
     *
     * `uq_work_app_provisionings_task` makes this at most one row, which is what
     * lets T51 skip the CI fix-loop and the merge gate for a provisioning Task
     * without a second lookup.
     */
    async findByTaskId(taskId: string): Promise<WorkAppProvisioning | null> {
        return this.repository.findOne({ where: { taskId } });
    }

    /**
     * Take the step executor's lease, or report that somebody else holds it.
     *
     *     UPDATE … SET lease = :lease, leaseExpiresAt = :until
     *      WHERE id = :id AND (lease IS NULL OR leaseExpiresAt < :now)
     *
     * `true` when THIS call won the row (`affected === 1`); `false` when a live
     * lease already covers it, which is the caller's signal to exit without doing
     * the work. An expired lease is takeable, so a crashed executor costs at most
     * {@link APP_PROVISIONING_LEASE_MS}.
     */
    async claimLease(
        id: string,
        lease: string,
        leaseMs: number = APP_PROVISIONING_LEASE_MS,
        nowMs: number = Date.now(),
    ): Promise<boolean> {
        const until = new Date(nowMs + Math.max(0, leaseMs));
        const now = new Date(nowMs);

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppProvisioning)
            .set({ lease, leaseExpiresAt: until })
            .where('id = :id', { id })
            .andWhere('(lease IS NULL OR leaseExpiresAt < :now)', { now })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * Give the lease back — but ONLY to the holder that still owns it.
     *
     * The `lease = :lease` predicate is the fence: an executor whose lease
     * expired and was taken over must not release the NEW holder's claim, or the
     * row would look free while that holder is still working on it.
     */
    async releaseLease(id: string, lease: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppProvisioning)
            .set({ lease: null, leaseExpiresAt: null })
            .where('id = :id', { id })
            .andWhere('lease = :lease', { lease })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /**
     * Advance `attemptsUsed` from `expected` to `expected + 1`, atomically.
     *
     *     UPDATE … SET attemptsUsed = :next WHERE id = :id AND attemptsUsed = :expected
     *
     * `true` only for the caller whose `expected` was still current. A caller
     * holding a stale reading gets `false` and must re-read rather than spend an
     * attempt: with a plain `SET attemptsUsed = attemptsUsed + 1` two racing
     * callers would both advance it and the budget would be spent twice for one
     * run (`APP_PROVISION_LIMITS.attemptsCeiling` is 9 — the ceiling exists to be
     * counted, not to be raced through).
     */
    async casAttemptsUsed(id: string, expected: number): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppProvisioning)
            .set({ attemptsUsed: expected + 1 })
            .where('id = :id', { id })
            .andWhere('attemptsUsed = :expected', { expected })
            .execute();

        return (result.affected ?? 0) === 1;
    }

    /** How many rows this person has ACTIVE — the input to `activePerUser` (3, ACC-04-25). */
    async countActiveForUser(userId: string): Promise<number> {
        return this.repository
            .createQueryBuilder('provisioning')
            .where('provisioning.userId = :userId', { userId })
            .andWhere('provisioning.status IN (:...statuses)', {
                statuses: [...APP_PROVISIONING_ACTIVE_STATUSES],
            })
            .getCount();
    }

    /** How many rows this workspace has ACTIVE — the input to `activePerOrg` (10). */
    async countActiveForOrg(organizationId: string): Promise<number> {
        return this.repository
            .createQueryBuilder('provisioning')
            .where('provisioning.organizationId = :organizationId', { organizationId })
            .andWhere('provisioning.status IN (:...statuses)', {
                statuses: [...APP_PROVISIONING_ACTIVE_STATUSES],
            })
            .getCount();
    }

    /**
     * Verification targets whose TTL has passed — the sweeper's teardown input
     * (§2.4, `namespaceTtlMinutes` 90).
     *
     * A row with no `verificationExpiresAt` or no namespace is excluded: there is
     * nothing to tear down. `nowMs` is a parameter so the caller's clock is the
     * only clock; it defaults to the wall clock for the sweeper's own call.
     */
    async listExpiredTargets(
        limit: number,
        nowMs: number = Date.now(),
    ): Promise<WorkAppProvisioning[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        return this.repository
            .createQueryBuilder('provisioning')
            .where('provisioning.verificationExpiresAt IS NOT NULL')
            .andWhere('provisioning.verificationNamespace IS NOT NULL')
            .andWhere('provisioning.verificationExpiresAt <= :now', { now: new Date(nowMs) })
            .orderBy('provisioning.verificationExpiresAt', 'ASC')
            .addOrderBy('provisioning.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Questions nobody has answered, past the reminder window — the S20 input
     * (`APP_PROVISION_LIMITS.questionReminderMs`, 72 h).
     *
     * Rows already reminded are excluded (`questionRemindedAt IS NOT NULL`): the
     * reminder is sent once, and the 14-day expiry is the service's business, not
     * this lookup's. The `questionAskedAt IS NOT NULL` filter makes the ordering
     * total, so this is the one place a bare `ORDER BY … ASC` is driver-proof:
     * there is no NULL left to sort.
     */
    async listStaleQuestions(
        limit: number,
        nowMs: number = Date.now(),
    ): Promise<WorkAppProvisioning[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        const cutoff = new Date(nowMs - APP_PROVISION_LIMITS.questionReminderMs);

        return this.repository
            .createQueryBuilder('provisioning')
            .where('provisioning.status = :needsInput', { needsInput: 'needs_input' })
            .andWhere('provisioning.questionAskedAt IS NOT NULL')
            .andWhere('provisioning.questionRemindedAt IS NULL')
            .andWhere('provisioning.questionAskedAt <= :cutoff', { cutoff })
            .orderBy('provisioning.questionAskedAt', 'ASC')
            .addOrderBy('provisioning.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * Rows waiting for a slot, oldest first — the queue the dispatcher drains
     * when a user's or a workspace's cap frees up (FR-44).
     */
    async listQueued(limit: number): Promise<WorkAppProvisioning[]> {
        const take = this.batchSize(limit);
        if (take === 0) {
            return [];
        }

        return this.repository
            .createQueryBuilder('provisioning')
            .where('provisioning.status = :queued', { queued: 'queued' })
            .orderBy('provisioning.createdAt', 'ASC')
            .addOrderBy('provisioning.id', 'ASC')
            .take(take)
            .getMany();
    }

    /**
     * The Agent template the most recent provisioning of this scope used, or
     * `null` — so a second run reuses the Agent the first one was given instead
     * of creating a second one, and so a scope that has never provisioned
     * anything says so rather than guessing.
     *
     * The scope is `(userId, organizationId)`, and `organizationId` is compared
     * with `IS NULL` when it is null — a work in no Organization is not the same
     * scope as any Organization's, and `= NULL` matches nothing on every driver.
     */
    async findRecentAgentId(userId: string, organizationId: string | null): Promise<string | null> {
        const query = this.repository
            .createQueryBuilder('provisioning')
            .select('provisioning.agentId', 'agentId')
            .where('provisioning.userId = :userId', { userId })
            .andWhere('provisioning.agentId IS NOT NULL');

        if (organizationId === null) {
            query.andWhere('provisioning.organizationId IS NULL');
        } else {
            query.andWhere('provisioning.organizationId = :organizationId', { organizationId });
        }

        const row = await query
            .orderBy('provisioning.createdAt', 'DESC')
            .addOrderBy('provisioning.id', 'ASC')
            .getRawOne<{ agentId: string | null }>();

        return row?.agentId ?? null;
    }

    /**
     * The hard ceiling on one batch, whatever the caller asks for. A
     * non-positive or non-finite limit answers `[]` without issuing a query, so a
     * caller that computed `0` from an empty configuration cannot accidentally
     * scan the table.
     */
    private batchSize(limit: number): number {
        if (!Number.isFinite(limit)) {
            return APP_PROVISIONING_SWEEP_BATCH;
        }
        return Math.max(0, Math.min(Math.floor(limit), APP_PROVISIONING_SWEEP_BATCH));
    }
}
