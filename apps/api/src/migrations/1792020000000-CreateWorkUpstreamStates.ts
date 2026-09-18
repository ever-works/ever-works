import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-02 (Fork lifecycle) — creates `work_upstream_states`, the per-App-Work
 * Upstream state row.
 *
 * Entity: `packages/agent/src/entities/work-upstream-state.entity.ts`
 * Plan: `docs/specs/features/app-works/APW-02-fork-lifecycle/plan.md` §3.1 (the
 * column table, `:205-256`) and §3.2 (this migration, `:272-277`)
 * Repository: `packages/agent/src/database/repositories/work-upstream-state.repository.ts`
 *
 * Slot **00 of epic 02** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * stamped above `1791240000000-AddSafetyRailsCore.ts`, the newest migration on
 * `ee45946e5`. Re-stamp before merge if `develop` has moved.
 *
 * ## What `up()` does, and nothing else
 *
 * One `CREATE TABLE`, one foreign key and the three indexes the plan names at
 * `:258-259`. Nothing is renamed, dropped or narrowed (CONTRACTS R-26, the
 * owner's additive-only rule), and no existing table is read or written.
 *
 * ## No backfill
 *
 * There is none to write: no App Work exists before APW-01, so the table is
 * empty on arrival and the row is created with the Work (`plan.md:277`).
 *
 * ## Timestamps are `bigint` epoch milliseconds
 *
 * Declared `bigint` here and `TimestampColumn` on the entity, exactly as
 * `work_deployments` does. The dispatcher's hot predicate is
 * `nextSyncAt <= :now` — a numeric comparison that has to mean the same thing
 * on Postgres (production) and on the better-sqlite3 driver CI and the e2e lane
 * run — while a raw `timestamp` column would be `timestamptz` on one and
 * `datetime` on the other.
 *
 * `createdAt` / `updatedAt` use `CURRENT_TIMESTAMP` rather than Postgres'
 * `now()` for the same portability reason: `now()` is a Postgres function and
 * every insert under the test driver would fail on it.
 *
 * ## The foreign key
 *
 * `workId → works(id)` ON DELETE CASCADE: the row describes one Work and has
 * no meaning without it, so deleting the Work takes its state with it. It is
 * the ONLY foreign key. `conflictTaskId` is deliberately a bare uuid
 * (`plan.md:244`): a Task deleted after its sync conflict was recorded must not
 * cascade away the state row that merely links to it.
 *
 * ## The three indexes
 *
 * - `uq_work_upstream_states_work` UNIQUE `(workId)` — one state row per App
 *   Work. Created as a unique INDEX rather than a table constraint so the same
 *   object and the same name exist on both drivers.
 * - `idx_work_upstream_states_next_sync` `(nextSyncAt)` — the dispatcher's due
 *   scan, run every ten minutes (`plan.md:809`).
 * - `idx_work_upstream_states_readiness` `(readinessState, readinessHeartbeatAt)`
 *   — the stale-readiness sweep (`plan.md:811`).
 *
 * ## Forward-only, idempotent, portable
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and
 * the foreign key), so a re-run is a no-op and `down()` is safe on a database
 * where `up()` never ran. `down()` drops the three indexes and the table, and
 * touches nothing else.
 */
export class CreateWorkUpstreamStates1792020000000 implements MigrationInterface {
    name = 'CreateWorkUpstreamStates1792020000000';

    private static readonly TABLE = 'work_upstream_states';
    private static readonly UNIQUE_WORK = 'uq_work_upstream_states_work';
    private static readonly INDEX_NEXT_SYNC = 'idx_work_upstream_states_next_sync';
    private static readonly INDEX_READINESS = 'idx_work_upstream_states_readiness';
    private static readonly FOREIGN_KEY = 'fk_work_upstream_states_work';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(CreateWorkUpstreamStates1792020000000.TABLE))) {
            await queryRunner.createTable(
                new Table({
                    name: CreateWorkUpstreamStates1792020000000.TABLE,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        // One row per App Work — the unique index below enforces it.
                        { name: 'workId', type: 'uuid' },
                        // 'link' | 'fork' | 'private-copy' (APP_REPOSITORY_MODES).
                        { name: 'relation', type: 'varchar', length: '16' },
                        // The Work Repository's canonical coordinates.
                        { name: 'dataOwner', type: 'varchar', length: '100' },
                        { name: 'dataRepo', type: 'varchar', length: '100' },
                        { name: 'dataDefaultBranch', type: 'varchar', length: '255' },
                        // NULL for a `link` relation: it has no upstream (FR-44).
                        { name: 'upstreamOwner', type: 'varchar', length: '100', isNullable: true },
                        { name: 'upstreamRepo', type: 'varchar', length: '100', isNullable: true },
                        {
                            name: 'upstreamDefaultBranch',
                            type: 'varchar',
                            length: '255',
                            isNullable: true,
                        },
                        {
                            name: 'upstreamPreviousDefaultBranch',
                            type: 'varchar',
                            length: '255',
                            isNullable: true,
                        },
                        // 'preparing' | 'ready' | 'timed_out' | 'failed' | 'waiting_for_setup_pr'.
                        {
                            name: 'readinessState',
                            type: 'varchar',
                            length: '24',
                            default: "'preparing'",
                        },
                        {
                            name: 'readinessReason',
                            type: 'varchar',
                            length: '48',
                            isNullable: true,
                        },
                        // NOT NULL by the plan (:222): the sweeper always needs a clock.
                        { name: 'readinessStartedAt', type: 'bigint' },
                        { name: 'readinessHeartbeatAt', type: 'bigint', isNullable: true },
                        { name: 'readinessDispatches', type: 'int', default: 0 },
                        { name: 'readinessManualRetries', type: 'int', default: 0 },
                        { name: 'readinessManualWindowAt', type: 'bigint', isNullable: true },
                        { name: 'readyAt', type: 'bigint', isNullable: true },
                        {
                            name: 'setupPullRequestUrl',
                            type: 'varchar',
                            length: '500',
                            isNullable: true,
                        },
                        { name: 'setupPullRequestNumber', type: 'int', isNullable: true },
                        { name: 'setupCheckedAt', type: 'bigint', isNullable: true },
                        { name: 'copyPushedSha', type: 'varchar', length: '40', isNullable: true },
                        { name: 'aheadBy', type: 'int', isNullable: true },
                        { name: 'behindBy', type: 'int', isNullable: true },
                        { name: 'divergenceComputedAt', type: 'bigint', isNullable: true },
                        { name: 'behindEventCount', type: 'int', isNullable: true },
                        {
                            name: 'upstreamHeadSha',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        { name: 'syncSchedule', type: 'varchar', length: '64', isNullable: true },
                        // NULL while paused and for a `link` — the due scan's only predicate.
                        { name: 'nextSyncAt', type: 'bigint', isNullable: true },
                        { name: 'syncStartedAt', type: 'bigint', isNullable: true },
                        { name: 'syncFinishedAt', type: 'bigint', isNullable: true },
                        { name: 'lastSyncResult', type: 'varchar', length: '24', isNullable: true },
                        { name: 'lastSyncReason', type: 'varchar', length: '48', isNullable: true },
                        {
                            name: 'lastSyncedUpstreamSha',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        { name: 'lastSyncCommitCount', type: 'int', isNullable: true },
                        { name: 'syncPullRequestNumber', type: 'int', isNullable: true },
                        {
                            name: 'syncPullRequestUrl',
                            type: 'varchar',
                            length: '500',
                            isNullable: true,
                        },
                        {
                            name: 'syncPullRequestClosedHeadSha',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        // No FK on purpose: a deleted Task must not cascade (plan :244).
                        { name: 'conflictTaskId', type: 'uuid', isNullable: true },
                        { name: 'manualSyncCount', type: 'int', default: 0 },
                        { name: 'manualSyncWindowAt', type: 'bigint', isNullable: true },
                        { name: 'consecutiveRateLimited', type: 'int', default: 0 },
                        { name: 'rateLimitedUntil', type: 'bigint', isNullable: true },
                        // 'available' | 'archived' | 'unavailable' | 'none' | 'unknown'.
                        {
                            name: 'upstreamStatus',
                            type: 'varchar',
                            length: '16',
                            default: "'unknown'",
                        },
                        { name: 'upstreamCheckedAt', type: 'bigint', isNullable: true },
                        // 'available' | 'missing' (FR-42).
                        {
                            name: 'dataRepositoryStatus',
                            type: 'varchar',
                            length: '16',
                            default: "'available'",
                        },
                        // 'pending' | 'clean' | 'needs_admin' | 'permission_missing' | …
                        {
                            name: 'actionsState',
                            type: 'varchar',
                            length: '24',
                            default: "'pending'",
                        },
                        // The three simple-json columns of the entity are text here.
                        { name: 'actionsSeenWorkflowIds', type: 'text', isNullable: true },
                        { name: 'actionsDisabledWorkflows', type: 'text', isNullable: true },
                        { name: 'actionsKeptWorkflows', type: 'text', isNullable: true },
                        { name: 'actionsCheckedAt', type: 'bigint', isNullable: true },
                        // EW-655 scope stamping — plain columns, no relation.
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const table = await queryRunner.getTable(CreateWorkUpstreamStates1792020000000.TABLE);
        if (!table) {
            return;
        }

        // One state row per App Work.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkUpstreamStates1792020000000.UNIQUE_WORK,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkUpstreamStates1792020000000.TABLE,
                new TableIndex({
                    name: CreateWorkUpstreamStates1792020000000.UNIQUE_WORK,
                    columnNames: ['workId'],
                    isUnique: true,
                }),
            );
        }

        // The dispatcher's due scan (every ten minutes).
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkUpstreamStates1792020000000.INDEX_NEXT_SYNC,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkUpstreamStates1792020000000.TABLE,
                new TableIndex({
                    name: CreateWorkUpstreamStates1792020000000.INDEX_NEXT_SYNC,
                    columnNames: ['nextSyncAt'],
                }),
            );
        }

        // The stale-readiness sweep.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkUpstreamStates1792020000000.INDEX_READINESS,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkUpstreamStates1792020000000.TABLE,
                new TableIndex({
                    name: CreateWorkUpstreamStates1792020000000.INDEX_READINESS,
                    columnNames: ['readinessState', 'readinessHeartbeatAt'],
                }),
            );
        }

        if (
            !table.foreignKeys.some(
                (fk) => fk.name === CreateWorkUpstreamStates1792020000000.FOREIGN_KEY,
            )
        ) {
            await queryRunner.createForeignKey(
                CreateWorkUpstreamStates1792020000000.TABLE,
                new TableForeignKey({
                    name: CreateWorkUpstreamStates1792020000000.FOREIGN_KEY,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /**
     * Drops the three indexes and then the table — nothing else. Each step is
     * re-checked rather than assumed, so a database where `up()` never ran (or
     * ran only halfway) leaves without an error, and a table this migration did
     * not create is never dropped.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(CreateWorkUpstreamStates1792020000000.TABLE))) {
            return;
        }

        const table = await queryRunner.getTable(CreateWorkUpstreamStates1792020000000.TABLE);

        for (const name of [
            CreateWorkUpstreamStates1792020000000.INDEX_NEXT_SYNC,
            CreateWorkUpstreamStates1792020000000.INDEX_READINESS,
            CreateWorkUpstreamStates1792020000000.UNIQUE_WORK,
        ]) {
            if (table?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(CreateWorkUpstreamStates1792020000000.TABLE, name);
            }
        }

        // `dropTable(name, ifExists, dropIndices, cascade)` — the foreign key
        // belongs to the table and goes with it.
        await queryRunner.dropTable(CreateWorkUpstreamStates1792020000000.TABLE, true, true, true);
    }
}
