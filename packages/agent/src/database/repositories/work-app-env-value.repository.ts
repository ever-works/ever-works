import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AppEnvStoredOrigin } from '@ever-works/contracts';
import { WorkAppEnvValue } from '../../entities/work-app-env-value.entity';
import { isUniqueConstraintError } from '../../utils/db-error.utils';
import { serializeOnSingleConnection } from './single-connection-write-queue';

/**
 * APW-07 (App env & dependencies) — the `work_app_env_values` store.
 *
 * Plan §3.1 (`plan.md:176-200`) is the column contract and T8 names the
 * methods: `findByWork`, `insertIfAbsent`, `upsertValue`, `deleteNames` and
 * `totals`. Feature-owned: it is provided by the App env module (T13) and
 * exported from `database/index.ts` for it, NOT by `DatabaseModule` — see the
 * docstring of `_repository-inventory.ts` for why a feature-owned repository
 * must not appear in that inventory (its drift check fails on an entry that is
 * not a provider there).
 *
 * ## The envelope is never on a read a UI renders (FR-5)
 *
 * `findByWork` passes an EXPLICIT select list — {@link
 * WORK_APP_ENV_VALUE_METADATA_COLUMNS} — which does not name `valueEncrypted`,
 * so a response assembled from it cannot carry a stored value even by
 * accident. The one read that does bring the envelope back is the private
 * {@link WorkAppEnvValueRepository.readStoredEnvelope}, which exists because
 * `insertIfAbsent` must return the stored row (T8) and because §3.1's
 * generation contract says the LOSER of a race reads the WINNER's envelope
 * (ACC-07-02): the app has to be given the value that was actually stored, not
 * the one the losing caller generated.
 *
 * ## Race-safe generation, driver by driver (§3.1:195-200)
 *
 * `insertIfAbsent` writes with the query builder's `orIgnore()`, which is
 * `INSERT … ON CONFLICT ("workId", "name") DO NOTHING` on Postgres and the
 * equivalent `ON CONFLICT DO NOTHING` on the SQLite family, then re-reads the
 * row — the same "first writer wins, losers re-read" contract
 * `WorkRuntimeEnvService.getOrGenerate` has. MySQL/MariaDB get no ignore clause
 * from TypeORM at all, so a lost race arrives there as a unique-constraint
 * error; it is caught and the very same re-read runs, which is the plan's
 * "where a driver offers no such clause, the service does the compare-and-set
 * itself" arm. Every path ends in a read of the stored row, so no driver can
 * hand a caller a value that is not the one in the table.
 *
 * ## Every write is queued on the drivers with one shared connection
 *
 * better-sqlite3 — the default `DATABASE_TYPE`, CI and the e2e stack — funnels
 * a whole DataSource through ONE query runner, so a statement issued while
 * another caller's transaction is open joins it and can be erased by its
 * rollback. {@link serializeOnSingleConnection} keeps this repository's writes
 * from overlapping on those drivers; a pooled driver runs them immediately.
 * The queued work is single statements only — nothing in here calls
 * `serializeOnSingleConnection` again (that would wait on its own tail).
 */

/**
 * Every column of the table EXCEPT `valueEncrypted`: what a UI-facing read may
 * load. Declared as a frozen list rather than leaving the read unqualified, so
 * a column added to the entity is a deliberate addition here too (T5's
 * "no default exposure of `valueEncrypted`").
 */
export const WORK_APP_ENV_VALUE_METADATA_COLUMNS = [
    'id',
    'workId',
    'name',
    'origin',
    'valueBytes',
    'version',
    'generatorFingerprint',
    'derivedFromName',
    'generatedAt',
    'setByUserId',
    'tenantId',
    'organizationId',
    'createdAt',
    'updatedAt',
] as const;

/** A stored row without its envelope — the shape every read path may hold. */
export type WorkAppEnvValueMetadata = Omit<WorkAppEnvValue, 'valueEncrypted' | 'work'>;

/** What {@link WorkAppEnvValueRepository.insertIfAbsent} writes. */
export interface InsertWorkAppEnvValueInput {
    readonly workId: string;
    readonly name: string;
    readonly origin: AppEnvStoredOrigin;
    /** The `enc::v1::` envelope `AppEnvCrypto` produced (T9). */
    readonly valueEncrypted: string;
    readonly valueBytes: number;
    readonly generatorFingerprint?: string | null;
    readonly derivedFromName?: string | null;
    readonly generatedAt?: Date | null;
    readonly setByUserId?: string | null;
    readonly tenantId?: string | null;
    readonly organizationId?: string | null;
}

/** What {@link WorkAppEnvValueRepository.upsertValue} writes, and bumps the version by one. */
export interface UpsertWorkAppEnvValueInput {
    readonly origin: AppEnvStoredOrigin;
    readonly valueEncrypted: string;
    readonly valueBytes: number;
    readonly generatorFingerprint?: string | null;
    readonly derivedFromName?: string | null;
    readonly generatedAt?: Date | null;
    readonly setByUserId?: string | null;
}

/** FR-31's two ceilings, as `totals` reports them. */
export interface WorkAppEnvValueTotals {
    readonly count: number;
    readonly bytes: number;
}

@Injectable()
export class WorkAppEnvValueRepository {
    constructor(
        @InjectRepository(WorkAppEnvValue)
        private readonly repository: Repository<WorkAppEnvValue>,
    ) {}

    /**
     * Every stored value of one App Work, WITHOUT the envelope, ordered by name
     * so two identical reads return identical arrays.
     *
     * This is the read the Environment table and the resolver's "which names
     * are set" pass use; `valueEncrypted` is not on the select list, so nothing
     * built from it can leak a value (FR-5).
     */
    findByWork(workId: string): Promise<WorkAppEnvValueMetadata[]> {
        return this.repository
            .find({
                select: [...WORK_APP_ENV_VALUE_METADATA_COLUMNS],
                where: { workId },
                order: { name: 'ASC' },
            })
            .then((rows) => rows as WorkAppEnvValueMetadata[]);
    }

    /**
     * Insert the generated value for `(workId, name)` unless a row is already
     * there, and return the row that is STORED afterwards — envelope included,
     * because the caller is about to hand that value to an app.
     *
     * The first writer wins: a second caller with a different envelope reads
     * the first one back rather than overwriting it (ACC-07-02, plan §3.1).
     */
    async insertIfAbsent(input: InsertWorkAppEnvValueInput): Promise<WorkAppEnvValue> {
        return serializeOnSingleConnection(this.repository.manager, async () => {
            await this.insertIgnoringConflict(input);
            const stored = await this.readStoredEnvelope(input.workId, input.name);
            if (!stored) {
                // The row was deleted between the INSERT and the read-back: the
                // caller must not be told a value exists.
                throw new Error(
                    `work_app_env_values row for ${input.workId}/${input.name} is not there after insert`,
                );
            }
            return stored;
        });
    }

    /**
     * Store a new value for an existing name and bump `version` by one
     * (plan §3.1:185), or create the row at version 1 when the name has none
     * yet — an undeclared name the owner set (FR-1).
     *
     * The bump is `"version" + 1` IN SQL, never `read + 1`: two callers that
     * both read version 3 must produce 4 and 5, not two 4s, because the version
     * is what the change flags and the build fingerprints compare (FR-24).
     */
    async upsertValue(
        workId: string,
        name: string,
        input: UpsertWorkAppEnvValueInput,
    ): Promise<WorkAppEnvValue> {
        return serializeOnSingleConnection(this.repository.manager, async () => {
            if (await this.bumpVersion(workId, name, input)) {
                const updated = await this.readStoredEnvelope(workId, name);
                if (updated) {
                    return updated;
                }
            }

            await this.insertIgnoringConflict({ workId, name, ...input });
            const stored = await this.readStoredEnvelope(workId, name);
            if (!stored) {
                throw new Error(
                    `work_app_env_values row for ${workId}/${name} is not there after upsert`,
                );
            }

            if (stored.valueEncrypted !== input.valueEncrypted) {
                // Another writer's row won the INSERT race between our UPDATE
                // and our INSERT. Apply this caller's value on top of it, so a
                // `set` is never silently dropped.
                await this.bumpVersion(workId, name, input);
                const applied = await this.readStoredEnvelope(workId, name);
                if (applied) {
                    return applied;
                }
            }

            return stored;
        });
    }

    /**
     * Remove the named rows of one App Work — `unset` and `reset` (§4.2:375)
     * — and report how many rows went. An unknown name is not an error, an
     * empty list removes nothing, and another App Work's same-named row is
     * never touched.
     */
    async deleteNames(workId: string, names: readonly string[]): Promise<number> {
        const unique = [
            ...new Set((names ?? []).filter((name) => typeof name === 'string' && name.length > 0)),
        ];
        if (!workId || unique.length === 0) {
            return 0;
        }

        const result = await this.repository
            .createQueryBuilder()
            .delete()
            .from(WorkAppEnvValue)
            .where('workId = :workId', { workId })
            .andWhere('name IN (:...names)', { names: unique })
            .execute();

        return result.affected ?? 0;
    }

    /**
     * FR-31's two ceilings for one App Work: how many rows it holds and how
     * many plaintext bytes they add up to. Both numbers come from the table,
     * never from a running total a caller kept.
     */
    async totals(workId: string): Promise<WorkAppEnvValueTotals> {
        const row = await this.repository
            .createQueryBuilder('value')
            .select('COUNT(*)', 'count')
            .addSelect('COALESCE(SUM(value.valueBytes), 0)', 'bytes')
            .where('value.workId = :workId', { workId })
            .getRawOne<{ count: string | number; bytes: string | number }>();

        return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
    }

    /**
     * The value version of one name, envelope included.
     *
     * Deliberately private and deliberately named: this is the ONLY read that
     * loads `valueEncrypted`, it exists so `insertIfAbsent` can hand back the
     * stored row, and no UI-facing path can reach it.
     */
    private readStoredEnvelope(workId: string, name: string): Promise<WorkAppEnvValue | null> {
        return this.repository.findOne({ where: { workId, name } });
    }

    /** `UPDATE` the value and bump the version, reporting whether a row was there to bump. */
    private async bumpVersion(
        workId: string,
        name: string,
        input: UpsertWorkAppEnvValueInput,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkAppEnvValue)
            .set({
                origin: input.origin,
                valueEncrypted: input.valueEncrypted,
                valueBytes: input.valueBytes,
                generatorFingerprint: input.generatorFingerprint ?? null,
                derivedFromName: input.derivedFromName ?? null,
                generatedAt: input.generatedAt ?? null,
                setByUserId: input.setByUserId ?? null,
                version: () => '"version" + 1',
            })
            .where('workId = :workId', { workId })
            .andWhere('name = :name', { name })
            .execute();

        return (result.affected ?? 0) > 0;
    }

    /**
     * `INSERT` the row, ignoring a conflict on the unique `(workId, name)` key
     * on the drivers that have such a clause, and swallowing the unique
     * violation on the drivers that do not (MySQL/MariaDB) — every caller then
     * reads the stored row back, which is what makes the outcome identical
     * everywhere.
     */
    private async insertIgnoringConflict(input: InsertWorkAppEnvValueInput): Promise<void> {
        try {
            await this.repository
                .createQueryBuilder()
                .insert()
                .into(WorkAppEnvValue)
                .values({
                    workId: input.workId,
                    name: input.name,
                    origin: input.origin,
                    valueEncrypted: input.valueEncrypted,
                    valueBytes: input.valueBytes,
                    generatorFingerprint: input.generatorFingerprint ?? null,
                    derivedFromName: input.derivedFromName ?? null,
                    generatedAt: input.generatedAt ?? null,
                    setByUserId: input.setByUserId ?? null,
                    tenantId: input.tenantId ?? null,
                    organizationId: input.organizationId ?? null,
                })
                .orIgnore()
                .execute();
        } catch (error) {
            if (!isUniqueConstraintError(error)) {
                throw error;
            }
            // The row already exists, which is exactly the outcome `orIgnore`
            // produces where the driver has the clause.
        }
    }
}
