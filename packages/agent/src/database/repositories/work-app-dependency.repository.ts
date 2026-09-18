import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { APP_DEPENDENCY_INACTIVE_STATUSES, type AppDependencyKind } from '@ever-works/contracts';
import { WorkAppDependency } from '../../entities/work-app-dependency.entity';

/**
 * APW-07 (App env & dependencies) — the `work_app_dependencies` store.
 *
 * Plan §3.2 (`plan.md:202-232`) is the column contract, §4.8:563-566 fixes the
 * lease claim, and T8 names the methods: `findActiveByWork`,
 * `findByWorkAndKind`, `claimLease`, `markKept`, `markDeleted` and
 * `updateOutputs`. Feature-owned: it is provided by the App dependencies module
 * (T16) and exported from `database/index.ts` for it, NOT by `DatabaseModule`
 * — see the docstring of `_repository-inventory.ts` for why a feature-owned
 * repository must not appear in that inventory (its drift check fails on an
 * entry that is not a provider there).
 *
 * ## Which reads carry an envelope, and which never can
 *
 * `configEncrypted` (an external provider's configuration) and
 * `outputsEncrypted` (everything it produced) are the two secret columns. The
 * `find*` helpers both pass an explicit select list —
 * {@link WORK_APP_DEPENDENCY_METADATA_COLUMNS} — which names neither, so the
 * Dependencies card and the deploy preflight cannot leak a value even by
 * accident (FR-5, plan §5:795). The two WORKER-facing methods, `claimLease`
 * and `updateOutputs`, return the whole row because the provisioning job is
 * what decrypts the configuration and writes the outputs (plan §7:873-877);
 * neither is a read a UI renders.
 *
 * ## `findActiveByWork` and `findByWorkAndKind` answer different questions
 *
 * The first is "what does this App Work depend on right now" — the card list
 * and `ensureReadyForDeploy` — so it is the ACTIVE statuses only: `kept` and
 * `deleted` are history (§3.2:225 excludes them from the unique key for the
 * same reason). The second is "the row a caller means when it names one kind":
 * the active row when there is one, otherwise the newest `kept` row — which is
 * what the delete-data dialog lists after a release (FR-45, FR-46) — and never
 * a `deleted` one.
 *
 * ## Row creation is not here on purpose
 *
 * T8's method list has no insert: `reconcile` (T16) creates the `pending` /
 * `awaiting_config` row it is about to dispatch, and the columns it writes are
 * the ones the entity declares. This repository owns the lease, the release
 * and the outputs bookkeeping the job and the card race on.
 */

/**
 * Every column EXCEPT the two envelopes: what a UI-facing read may load.
 * Declared as a frozen list rather than as `select: true` so a column added to
 * the entity is a deliberate addition here too.
 */
export const WORK_APP_DEPENDENCY_METADATA_COLUMNS = [
    'id',
    'workId',
    'kind',
    'deployTarget',
    'providerPluginId',
    'providerId',
    'status',
    'statusReason',
    'statusDetail',
    'attempts',
    'declared',
    'actualVersion',
    'sizeGiB',
    'outputsVersion',
    'resourceRefs',
    'inSpec',
    'backupPolicy',
    'backupState',
    'lastBackupAt',
    'backupCheckedAt',
    'lastProvisionedAt',
    'lastCheckedAt',
    'provisionLeaseUntil',
    'tenantId',
    'organizationId',
    'createdAt',
    'updatedAt',
] as const;

/** A stored dependency row without its two envelopes — the shape every read path may hold. */
export type WorkAppDependencyMetadata = Omit<
    WorkAppDependency,
    'configEncrypted' | 'outputsEncrypted' | 'work'
>;

@Injectable()
export class WorkAppDependencyRepository {
    constructor(
        @InjectRepository(WorkAppDependency)
        private readonly repository: Repository<WorkAppDependency>,
    ) {}

    /**
     * Every ACTIVE dependency of one App Work, without either envelope, ordered
     * by kind so two identical reads return identical arrays.
     *
     * `kept` and `deleted` rows are deliberately absent: a released dependency
     * is no longer something the app depends on, and `ensureReadyForDeploy`
     * must not wait for one.
     */
    findActiveByWork(workId: string): Promise<WorkAppDependencyMetadata[]> {
        return this.repository
            .find({
                select: [...WORK_APP_DEPENDENCY_METADATA_COLUMNS],
                where: { workId, status: Not(In([...APP_DEPENDENCY_INACTIVE_STATUSES])) },
                order: { kind: 'ASC' },
            })
            .then((rows) => rows as WorkAppDependencyMetadata[]);
    }

    /**
     * The row a caller means when it names one (Work, kind): the active row if
     * there is one, otherwise the newest `kept` row. `deleted` rows are never
     * returned — they are the record of data that is gone.
     *
     * The inactive statuses are inlined into the ORDER BY expression because
     * they are compile-time constants of `@ever-works/contracts`, not input:
     * a bound parameter inside an ORDER BY is not portable across the three
     * supported drivers.
     */
    async findByWorkAndKind(
        workId: string,
        kind: AppDependencyKind,
    ): Promise<WorkAppDependencyMetadata | null> {
        const inactive = APP_DEPENDENCY_INACTIVE_STATUSES.map((status) => `'${status}'`).join(', ');
        const row = await this.repository
            .createQueryBuilder('dependency')
            .select(WORK_APP_DEPENDENCY_METADATA_COLUMNS.map((column) => `dependency.${column}`))
            .where('dependency.workId = :workId', { workId })
            .andWhere('dependency.kind = :kind', { kind })
            .andWhere('dependency.status <> :deleted', { deleted: 'deleted' })
            .orderBy(`CASE WHEN dependency.status IN (${inactive}) THEN 1 ELSE 0 END`, 'ASC')
            .addOrderBy('dependency.updatedAt', 'DESC')
            .addOrderBy('dependency.id', 'ASC')
            .getOne();

        return (row as WorkAppDependencyMetadata | null) ?? null;
    }

    /**
     * Claim the provisioning lease of one row and return it — envelope
     * included, because the job that claimed it is the one that decrypts the
     * configuration and writes the outputs.
     *
     * The claim is the parameterised compare-and-set of plan §4.8:563-566:
     * `SET "provisionLeaseUntil" = :until WHERE id = :id AND
     * ("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil" < :now)`, with
     * both instants bound as epoch milliseconds. There is no `now()` and no
     * `interval` anywhere in it — those are Postgres-only spellings and
     * `database.config.ts` supports SQLite and MySQL/MariaDB too (APW07-G12).
     *
     * `null` means another worker holds the lease: the loser must not call the
     * provider.
     */
    async claimLease(id: string, leaseMs: number): Promise<WorkAppDependency | null> {
        const nowMs = Date.now();
        const untilMs = nowMs + Math.max(0, Math.floor(leaseMs));

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppDependency)
            .set({ provisionLeaseUntil: new Date(untilMs) })
            .where('id = :id', { id })
            .andWhere('("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil" < :now)', {
                now: nowMs,
            })
            .execute();

        if ((result.affected ?? 0) === 0) {
            return null;
        }

        return this.repository.findOne({ where: { id } });
    }

    /**
     * Record that a released dependency was KEPT: its workloads are gone from
     * the App Work's desired state and its volume, database or bucket remains,
     * which is what makes the row inactive (FR-45/FR-46). `false` means there
     * was no such row.
     */
    markKept(id: string): Promise<boolean> {
        return this.setStatus(id, 'kept');
    }

    /**
     * Record that a released dependency's DATA was deleted after the owner
     * ticked **Also delete stored data** and typed the slug — the row is the
     * record that there is nothing left (FR-46). `false` means there was no
     * such row.
     */
    markDeleted(id: string): Promise<boolean> {
        return this.setStatus(id, 'deleted');
    }

    /**
     * Store the provider's outputs as one envelope and bump `outputsVersion` by
     * one (plan §7:876). `null` is a legitimate envelope: a managed-tier row
     * never carries outputs at all (§3.2:230).
     *
     * The bump is `"outputsVersion" + 1` IN SQL, never `read + 1`, because the
     * version is what a derived env value's `d<outputsVersion>` fingerprint
     * compares against (plan §2.2:139) — two refreshes that both read 3 must
     * produce 4 and 5.
     */
    async updateOutputs(id: string, envelope: string | null): Promise<WorkAppDependency | null> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppDependency)
            .set({ outputsEncrypted: envelope, outputsVersion: () => '"outputsVersion" + 1' })
            .where('id = :id', { id })
            .execute();

        if ((result.affected ?? 0) === 0) {
            return null;
        }

        return this.repository.findOne({ where: { id } });
    }

    /** The shared status write of {@link markKept} / {@link markDeleted}. */
    private async setStatus(id: string, status: 'kept' | 'deleted'): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppDependency)
            .set({ status })
            .where('id = :id', { id })
            .execute();

        return (result.affected ?? 0) > 0;
    }
}
