import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import { serializeOnSingleConnection } from './single-connection-write-queue';

/**
 * APW-05 (Builds) — the `work_build_preparations` repository.
 *
 * Plan §3.1b (`plan.md:398-425`) is the normative column list; T6 names the two
 * members. Feature-owned: it is provided by the App Works module and exported
 * from `database/index.ts` for it, NOT by `DatabaseModule` — see the docstring
 * of `_repository-inventory.ts` for why a feature-owned repository must not
 * appear in that inventory.
 *
 * ## Derived state, and no API writer (`APW05-G03`)
 *
 * Constitution III: this table has no hand-written API surface. `upsertAfterPrepare`
 * is called by `app-build-prepare` (§7.2 step 5) and by nothing else; the reads
 * are the Builds-list response (§5), the consumer's push/pull-request insert
 * (§7.5), the sweep's discovery pass (§7.4a) and the watch job's first
 * `startedAt` (§7.3).
 *
 * ## Upsert, not insert-or-fail
 *
 * One row per App Work (`uq_work_build_preparations_work`), so a re-run of a
 * prepare must MERGE into the existing row rather than collide with it. Two
 * prepares can still overlap — the coalescing of §7.2 bounds how often, it does
 * not forbid it — so a unique violation on create is re-read and applied as an
 * update rather than surfaced as a failure. The unique violation is detected
 * across drivers exactly as `CreditLedgerRepository.isUniqueViolation` does.
 *
 * A merge writes only the columns its patch names (see `apply`): the prepare and
 * `requestPrepare`'s bump write the same row without a shared lock. The two
 * patches name disjoint columns — the bump `prepareSeq` alone, the prepare
 * everything BUT `prepareSeq` — so neither can put back a column the other
 * changed after it read the row. A caller that names a column it only read (and
 * does not own) can still revert a racing writer's value; this method cannot
 * tell such an echo from a write.
 *
 * ## `prepareSeq` is deliberately NOT touched here
 *
 * `plan.md:417` gives that column one writer: every `requestPrepare` bumps it,
 * and the coalescing of §7.2 compares it before and after a pass. That is the
 * REQUEST path, not the result path this repository serves — bumping it on a
 * completed prepare would make the marker advance for the job that is supposed
 * to observe it, and the loop would never converge. Whoever lands
 * `requestPrepare` owns it.
 */

/** The columns a prepare may write: never the identity, never the creation stamp. */
export type WorkBuildPreparationPatch = Partial<
    Omit<WorkBuildPreparation, 'id' | 'workId' | 'work' | 'createdAt' | 'updatedAt'>
>;

@Injectable()
export class AppBuildPreparationRepository {
    constructor(
        @InjectRepository(WorkBuildPreparation)
        private readonly repository: Repository<WorkBuildPreparation>,
    ) {}

    /** The preparation row of one App Work, or `null` when no prepare has completed. */
    async findByWork(workId: string): Promise<WorkBuildPreparation | null> {
        return this.repository.findOne({ where: { workId } });
    }

    /**
     * Merge one prepare's result into the App Work's row, creating it on the
     * first call.
     *
     * `buildPluginId` is required on the CREATE path because the column is NOT
     * NULL and a prepare always knows the plugin it resolved; a caller that omits
     * it is refused loudly rather than left to a driver-level constraint error
     * that names the table instead of the call site.
     */
    async upsertAfterPrepare(
        workId: string,
        patch: WorkBuildPreparationPatch,
    ): Promise<WorkBuildPreparation> {
        return serializeOnSingleConnection(this.repository.manager, async () => {
            const existing = await this.findByWork(workId);
            if (existing) {
                return this.apply(existing, patch);
            }

            // The CREATE path: `buildPluginId` is NOT NULL and a prepare always
            // knows the plugin it resolved.
            if (!patch.buildPluginId) {
                throw new Error(
                    'AppBuildPreparationRepository.upsertAfterPrepare: buildPluginId is required to create a preparation row',
                );
            }

            try {
                return await this.repository.save(this.repository.create({ workId, ...patch }));
            } catch (error) {
                if (!this.isUniqueViolation(error)) {
                    throw error;
                }

                // Another prepare created the row between the read and the
                // insert: merge into the row that won instead of failing.
                const raced = await this.findByWork(workId);
                if (!raced) {
                    throw error;
                }

                return this.apply(raced, patch);
            }
        });
    }

    /**
     * Merge a patch onto a loaded row and store ONLY the patch's own columns.
     *
     * The row was read before this write, and the table has two writers that do
     * not share a lock: the prepare (its §3.1b result) and `requestPrepare` (the
     * `prepareSeq` bump). Saving the whole loaded entity would write back every
     * column as it was READ — TypeORM's `save` diffs the entity against a fresh
     * read, so a stale `prepareSeq` differs and is written — and a bump that
     * landed in between would be reverted (and the reverse: a bump's save would
     * put back a stale `workflowState`). So the entity handed to `save` carries
     * the id and the patch's keys only; TypeORM skips an `undefined` property
     * when it computes the changed columns, so nothing the patch did not name is
     * written. `undefined` values are dropped first (a `null` still clears a
     * column), and an empty patch writes nothing.
     */
    private async apply(
        row: WorkBuildPreparation,
        patch: WorkBuildPreparationPatch,
    ): Promise<WorkBuildPreparation> {
        const changes: WorkBuildPreparationPatch = {};
        for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) {
                (changes as Record<string, unknown>)[key] = value;
            }
        }
        this.repository.merge(row, changes);
        if (Object.keys(changes).length === 0) {
            return row;
        }

        await this.repository.save({ id: row.id, ...changes } as WorkBuildPreparation);

        return (await this.findByWork(row.workId)) ?? row;
    }

    /**
     * Driver-agnostic unique-violation detection: PostgreSQL exposes code
     * `23505`, SQLite surfaces `UNIQUE constraint failed` and MySQL/MariaDB
     * `Duplicate entry` in the message — the same detection
     * `CreditLedgerRepository.isUniqueViolation` and
     * `AppBuildRepository.isUniqueViolation` use.
     */
    private isUniqueViolation(error: unknown): boolean {
        const err = error as { code?: string; message?: string; driverError?: { code?: string } };
        if (err?.code === '23505' || err?.driverError?.code === '23505') {
            return true;
        }
        const message = String(err?.message ?? '');
        return (
            message.includes('UNIQUE constraint failed') ||
            message.includes('duplicate key') ||
            message.includes('Duplicate entry')
        );
    }
}
