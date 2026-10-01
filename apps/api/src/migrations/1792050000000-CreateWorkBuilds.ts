import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-05 (Builds) — creates `work_builds` and `work_build_preparations`.
 *
 * Entities: `packages/agent/src/entities/work-build.entity.ts` and
 * `packages/agent/src/entities/work-build-preparation.entity.ts`
 * Plan: `docs/specs/features/app-works/APW-05-builds/plan.md` §3.1 (the
 * `work_builds` column table, `:329-396`), §3.1b (`work_build_preparations`,
 * `:398-425`) and §3.3 (`:559-570`).
 * Repositories: `packages/agent/src/database/repositories/app-build.repository.ts`
 * and `…/app-build-preparation.repository.ts` (T6).
 *
 * Slot **00 of epic 05** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * the stamp the task text and plan §3.3 both fix. 🛑 It is deliberately NOT
 * re-stamped above `1792110000000-CreateAppLauncherPreferences.ts` (APW-11's
 * slot-00 migration, the newest file in this directory): the block reserves the
 * third and fourth digits for the epic, so an epic-05 migration stamped at
 * `179212…` would leave the block and collide with a future epic 12 slot. The
 * two are independent additive migrations over disjoint tables and TypeORM
 * orders ALL migrations by timestamp before filtering out the applied ones, so
 * this one is still executed on a database that has already run APW-11's.
 *
 * ## What `up()` does, and nothing else
 *
 * Two `CREATE TABLE`s, their two foreign keys and the six indexes the plan
 * names (five at `:367-373`, one at `:405`). Nothing is renamed, dropped or
 * narrowed (CONTRACTS R-26, the owner's additive-only rule), and no existing
 * table is read or written.
 *
 * ## No backfill
 *
 * There is none to write: no App Work produced a Build before APW-05, so both
 * tables are empty on arrival.
 *
 * ## Timestamps are `bigint` epoch milliseconds
 *
 * Declared `bigint` here and `TimestampColumn` on the entities. The sweep's
 * predicates are numeric comparisons (`lastObservedAt < :cutoff`, the §7.3
 * lease `watchLeaseUntil < :now`) that have to mean the same thing on the
 * production driver and on better-sqlite3, which CI and the e2e lane run — a raw
 * `timestamp` column would be `timestamptz` on one and `datetime` on the other,
 * and better-sqlite3 rejects the type at BOOT.
 *
 * `createdAt` / `updatedAt` use `CURRENT_TIMESTAMP` rather than `now()` for the
 * same portability reason: `now()` is a function of one dialect and every insert
 * under the test driver would fail on it.
 *
 * ## The two foreign keys
 *
 * `workId → works(id)` ON DELETE CASCADE on both tables: each row describes one
 * Work and has no meaning without it. They are the ONLY foreign keys.
 * `usageEventId`, `triggeredByUserId` and `verifiesBuildId` are deliberately
 * bare uuids (`plan.md:362` and the entity docstring): the receipt and the
 * verified Build are retained on their own schedule, and a delete there must
 * never take a Build's history with it.
 *
 * ## The six indexes — plain, named, and none partial
 *
 * - `uq_work_builds_work_number` UNIQUE `(workId, number)` — the per-Work Build
 *   sequence; Build numbers never repeat.
 * - `uq_work_builds_provider_run` UNIQUE `(buildPluginId, providerRunId,
 *   runAttempt)` — **no partial clause**. `APW05-G10` (`plan.md:375-379`): the
 *   platform also runs on MySQL and MariaDB, where a partial index is not
 *   available at all; NULLs are distinct inside a unique index on every driver,
 *   so an unadopted manual or verification Build never collides, and a plain
 *   unique also lets `upsert(conflictPaths)` work everywhere without the
 *   Postgres-only `indexPredicate`. The webhook and the poll therefore converge
 *   on one row on all four drivers.
 * - `idx_work_builds_work_created` `(workId, createdAt)` — the Builds list.
 * - `idx_work_builds_work_commit` `(workId, commitSha)` — Rebuild dedupe (FR-42)
 *   and APW-06's "green Build for commit".
 * - `idx_work_builds_status_observed` `(status, lastObservedAt)` — the sweep.
 * - `uq_work_build_preparations_work` UNIQUE `(workId)` — one preparation row per
 *   App Work.
 *
 * Every index is created as a unique/named INDEX rather than a table
 * constraint, so the same object and the same name exist on every driver.
 *
 * ## Forward-only, idempotent, portable, no driver branch
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and
 * foreign key), so a re-run is a no-op and `down()` is safe on a database where
 * `up()` never ran. There is no `queryRunner.connection.options.type` read, no
 * raw statement and no dialect-specific expression anywhere in this file, so
 * `up()` and `down()` behave identically on all four drivers — which is what
 * `apps/api/src/migrations/__tests__/CreateWorkBuilds.spec.ts` asserts by
 * reading this source.
 */
export class CreateWorkBuilds1792050000000 implements MigrationInterface {
    name = 'CreateWorkBuilds1792050000000';

    private static readonly BUILDS = 'work_builds';
    private static readonly PREPARATIONS = 'work_build_preparations';

    private static readonly UNIQUE_WORK_NUMBER = 'uq_work_builds_work_number';
    private static readonly UNIQUE_PROVIDER_RUN = 'uq_work_builds_provider_run';
    private static readonly INDEX_WORK_CREATED = 'idx_work_builds_work_created';
    private static readonly INDEX_WORK_COMMIT = 'idx_work_builds_work_commit';
    private static readonly INDEX_STATUS_OBSERVED = 'idx_work_builds_status_observed';
    private static readonly UNIQUE_PREPARATION_WORK = 'uq_work_build_preparations_work';

    private static readonly FK_BUILDS_WORK = 'fk_work_builds_work';
    private static readonly FK_PREPARATIONS_WORK = 'fk_work_build_preparations_work';

    /** Every index this migration creates, per table — used by `down()`. */
    private static readonly BUILD_INDEXES = [
        CreateWorkBuilds1792050000000.UNIQUE_WORK_NUMBER,
        CreateWorkBuilds1792050000000.UNIQUE_PROVIDER_RUN,
        CreateWorkBuilds1792050000000.INDEX_WORK_CREATED,
        CreateWorkBuilds1792050000000.INDEX_WORK_COMMIT,
        CreateWorkBuilds1792050000000.INDEX_STATUS_OBSERVED,
    ];

    private static readonly PREPARATION_INDEXES = [
        CreateWorkBuilds1792050000000.UNIQUE_PREPARATION_WORK,
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.upBuilds(queryRunner);
        await this.upPreparations(queryRunner);
    }

    private async upBuilds(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkBuilds1792050000000.BUILDS;

        if (!(await queryRunner.hasTable(table))) {
            await queryRunner.createTable(
                new Table({
                    name: table,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        // One Build of one App Work; the number is per Work.
                        { name: 'workId', type: 'uuid' },
                        { name: 'number', type: 'int' },
                        { name: 'buildPluginId', type: 'varchar', length: '64' },
                        // 'queued' | 'running' | 'succeeded' | 'failed' | … (plan §3.1:336).
                        { name: 'status', type: 'varchar', length: '16' },
                        // 'push' | 'pull_request' | 'manual' | 'verification'.
                        { name: 'trigger', type: 'varchar', length: '16' },
                        { name: 'blockedReason', type: 'varchar', length: '40', isNullable: true },
                        // Names and numbers only — the three simple-json columns
                        // of the entity are text here.
                        { name: 'blockedDetail', type: 'text', isNullable: true },
                        { name: 'cancelReason', type: 'varchar', length: '16', isNullable: true },
                        { name: 'branch', type: 'varchar', length: '255' },
                        { name: 'commitSha', type: 'varchar', length: '40' },
                        { name: 'pullRequestNumber', type: 'int', isNullable: true },
                        { name: 'providerRunId', type: 'varchar', length: '64', isNullable: true },
                        { name: 'runAttempt', type: 'int', default: 1 },
                        // Equals `id` for a manual or verification Build.
                        { name: 'dispatchCorrelationId', type: 'uuid', isNullable: true },
                        { name: 'dispatchedAt', type: 'bigint', isNullable: true },
                        { name: 'appSpecHash', type: 'varchar', length: '64', isNullable: true },
                        { name: 'specValidAtCommit', type: 'boolean', isNullable: true },
                        {
                            name: 'buildInputsHash',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'buildSecretNames', type: 'text', isNullable: true },
                        { name: 'secretsSyncedAt', type: 'bigint', isNullable: true },
                        { name: 'runnerLabel', type: 'varchar', length: '64', isNullable: true },
                        { name: 'runnerClass', type: 'varchar', length: '24', isNullable: true },
                        {
                            name: 'imageRepository',
                            type: 'varchar',
                            length: '255',
                            isNullable: true,
                        },
                        { name: 'imageDigest', type: 'varchar', length: '71', isNullable: true },
                        { name: 'imageTags', type: 'text', isNullable: true },
                        { name: 'digestConfirmed', type: 'boolean', default: false },
                        { name: 'secretCheck', type: 'varchar', length: '16', isNullable: true },
                        { name: 'deployable', type: 'boolean', default: false },
                        {
                            name: 'notDeployableReason',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        { name: 'failureClass', type: 'varchar', length: '32', isNullable: true },
                        { name: 'failureDetail', type: 'text', isNullable: true },
                        { name: 'failureExcerpt', type: 'text', isNullable: true },
                        { name: 'verificationResult', type: 'text', isNullable: true },
                        // No FK: a verification run that reused an earlier Build's
                        // image must not be erased with it.
                        { name: 'verifiesBuildId', type: 'uuid', isNullable: true },
                        // 'none' | 'upstreamSync' — the APW-04 producer stamps it.
                        {
                            name: 'syncOrigin',
                            type: 'varchar',
                            length: '24',
                            default: "'none'",
                        },
                        { name: 'syncFromSha', type: 'varchar', length: '40', isNullable: true },
                        { name: 'syncToSha', type: 'varchar', length: '40', isNullable: true },
                        { name: 'logsUrl', type: 'varchar', length: '512', isNullable: true },
                        { name: 'queuedAt', type: 'bigint', isNullable: true },
                        { name: 'startedAt', type: 'bigint', isNullable: true },
                        { name: 'completedAt', type: 'bigint', isNullable: true },
                        { name: 'lastObservedAt', type: 'bigint', isNullable: true },
                        // The §7.3 one-shot watch lease; NULL = nobody is watching.
                        { name: 'watchLeaseUntil', type: 'bigint', isNullable: true },
                        { name: 'durationSeconds', type: 'int', isNullable: true },
                        { name: 'billableMinutes', type: 'int', isNullable: true },
                        { name: 'checksBillableMinutes', type: 'int', isNullable: true },
                        { name: 'verifySecretNames', type: 'text', isNullable: true },
                        // The plugin-usage receipt. No FK on purpose (plan :362).
                        { name: 'usageEventId', type: 'uuid', isNullable: true },
                        { name: 'triggeredByUserId', type: 'uuid', isNullable: true },
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

        const builds = await queryRunner.getTable(table);
        if (!builds) {
            return;
        }

        const indexes = [
            new TableIndex({
                name: CreateWorkBuilds1792050000000.UNIQUE_WORK_NUMBER,
                columnNames: ['workId', 'number'],
                isUnique: true,
            }),
            // A PLAIN unique: no partial clause anywhere (APW05-G10).
            new TableIndex({
                name: CreateWorkBuilds1792050000000.UNIQUE_PROVIDER_RUN,
                columnNames: ['buildPluginId', 'providerRunId', 'runAttempt'],
                isUnique: true,
            }),
            new TableIndex({
                name: CreateWorkBuilds1792050000000.INDEX_WORK_CREATED,
                columnNames: ['workId', 'createdAt'],
            }),
            new TableIndex({
                name: CreateWorkBuilds1792050000000.INDEX_WORK_COMMIT,
                columnNames: ['workId', 'commitSha'],
            }),
            new TableIndex({
                name: CreateWorkBuilds1792050000000.INDEX_STATUS_OBSERVED,
                columnNames: ['status', 'lastObservedAt'],
            }),
        ];

        for (const index of indexes) {
            if (!builds.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(table, index);
            }
        }

        if (
            !builds.foreignKeys.some(
                (fk) => fk.name === CreateWorkBuilds1792050000000.FK_BUILDS_WORK,
            )
        ) {
            await queryRunner.createForeignKey(
                table,
                new TableForeignKey({
                    name: CreateWorkBuilds1792050000000.FK_BUILDS_WORK,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    private async upPreparations(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkBuilds1792050000000.PREPARATIONS;

        if (!(await queryRunner.hasTable(table))) {
            await queryRunner.createTable(
                new Table({
                    name: table,
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
                        { name: 'buildPluginId', type: 'varchar', length: '64' },
                        {
                            name: 'buildInputsHash',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        // Written even with 0 values: NULL means "no sync yet".
                        { name: 'secretsSyncedAt', type: 'bigint', isNullable: true },
                        { name: 'buildSecretNames', type: 'text', isNullable: true },
                        { name: 'workflowSha256', type: 'varchar', length: '64', isNullable: true },
                        // 'none' | 'committed' | 'pullRequestOpen' | 'editedByHand'.
                        {
                            name: 'workflowState',
                            type: 'varchar',
                            length: '24',
                            default: "'none'",
                        },
                        { name: 'workflowPullRequestNumber', type: 'int', isNullable: true },
                        {
                            name: 'workflowPullRequestUrl',
                            type: 'varchar',
                            length: '512',
                            isNullable: true,
                        },
                        { name: 'workflowWrittenAt', type: 'bigint', isNullable: true },
                        { name: 'webhookId', type: 'varchar', length: '64', isNullable: true },
                        // 'none' | 'installed' | 'skipped' | 'permissionMissing'.
                        {
                            name: 'webhookState',
                            type: 'varchar',
                            length: '24',
                            default: "'none'",
                        },
                        { name: 'runsEtag', type: 'varchar', length: '128', isNullable: true },
                        { name: 'runsCheckedAt', type: 'bigint', isNullable: true },
                        { name: 'repositoryBlock', type: 'text', isNullable: true },
                        // Bumped by every requestPrepare — the coalescing marker.
                        { name: 'prepareSeq', type: 'int', default: 0 },
                        { name: 'lastPreparedAt', type: 'bigint', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const preparations = await queryRunner.getTable(table);
        if (!preparations) {
            return;
        }

        if (
            !preparations.indices.some(
                (index) => index.name === CreateWorkBuilds1792050000000.UNIQUE_PREPARATION_WORK,
            )
        ) {
            await queryRunner.createIndex(
                table,
                new TableIndex({
                    name: CreateWorkBuilds1792050000000.UNIQUE_PREPARATION_WORK,
                    columnNames: ['workId'],
                    isUnique: true,
                }),
            );
        }

        if (
            !preparations.foreignKeys.some(
                (fk) => fk.name === CreateWorkBuilds1792050000000.FK_PREPARATIONS_WORK,
            )
        ) {
            await queryRunner.createForeignKey(
                table,
                new TableForeignKey({
                    name: CreateWorkBuilds1792050000000.FK_PREPARATIONS_WORK,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /**
     * Drops the six indexes and then both tables — nothing else. The
     * preparations table goes first (it is the one that was created last), and
     * each step is re-checked rather than assumed, so a database where `up()`
     * never ran (or ran only halfway) leaves without an error and a table this
     * migration did not create is never dropped.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        await this.dropPreparations(queryRunner);
        await this.dropBuilds(queryRunner);
    }

    private async dropPreparations(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkBuilds1792050000000.PREPARATIONS;

        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        const preparations = await queryRunner.getTable(table);

        for (const name of CreateWorkBuilds1792050000000.PREPARATION_INDEXES) {
            if (preparations?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(table, name);
            }
        }

        // `dropTable(name, ifExists, dropIndices, cascade)` — the foreign key
        // belongs to the table and goes with it.
        await queryRunner.dropTable(table, true, true, true);
    }

    private async dropBuilds(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkBuilds1792050000000.BUILDS;

        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        const builds = await queryRunner.getTable(table);

        for (const name of CreateWorkBuilds1792050000000.BUILD_INDEXES) {
            if (builds?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(table, name);
            }
        }

        await queryRunner.dropTable(table, true, true, true);
    }
}
