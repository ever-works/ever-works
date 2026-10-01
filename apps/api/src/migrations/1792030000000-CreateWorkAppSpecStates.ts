import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-03 (App spec, Apps catalog and license gate) — creates
 * `work_app_spec_states`, the per-App-Work App spec state row.
 *
 * Entity: `packages/agent/src/entities/work-app-spec-state.entity.ts`
 * Plan: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/plan.md`
 * §3.1 (the column table, `:397-452`) and §3.3 (this migration, `:520-529`)
 * Repository: `packages/agent/src/database/repositories/work-app-spec-state.repository.ts`
 *
 * Slot **00 of epic 03** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`) —
 * T10 re-stamps the generated id to `1792030000000`. The stamp is deliberately
 * **above** every migration on `develop` when this was authored
 * (`1791240000000-AddSafetyRailsCore.ts` was the newest; APW-02's
 * `1792020000000`, APW-07's `1792070000000` and APW-11's `1792110000000` are
 * the sibling slots), and an epic that lands later does not move into it.
 *
 * ## Why this file is hand-written rather than generated
 *
 * T10's instruction is to run
 * `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateWorkAppSpecStates`
 * and re-stamp the result. **That command cannot run in this checkout**: with no
 * `.env` the DataSource falls back to `better-sqlite3`
 * (`database.config.ts:132-170`) with no schema to diff against, and forcing
 * `DATABASE_TYPE=postgres` fails before it connects — `ts-node` cannot require
 * `typeorm.config.ts` at all, because `packages/agent/src/config/index.ts`
 * reaches `@ever-works/contracts`, whose package is `"type": "module"`
 * (`Unable to open file: "apps/api/typeorm.config.ts". Must use import to load
 * ES Module: packages/contracts/dist/index.d.ts`). The three sibling epics'
 * migrations are hand-written in exactly this guarded style for the same
 * reason, and plan §3.3 states the DDL this file has to produce, so the
 * migration below is that DDL, column for column.
 *
 * ## What `up()` does, and nothing else
 *
 * One `CREATE TABLE`, one foreign key and the three indexes the plan names at
 * `:451-452`. Nothing is renamed, dropped or narrowed anywhere (CONTRACTS R-26,
 * the owner's additive-only rule), and **no existing table is read, written or
 * altered** — the whole migration touches `work_app_spec_states` alone.
 *
 * ## No backfill
 *
 * There is none to write: no App Work exists before APW-01, so the table is
 * empty on arrival and the row is created with the Work
 * (`AppSpecService.initialize(workId, branch)`, plan §3.3:529).
 *
 * ## Every date column is a driver-portable `timestamp`
 *
 * The entity declares them with `PortableDateColumn`, which is `type: Date`:
 * Postgres gets `timestamp` and better-sqlite3 gets `datetime`, and TypeORM's
 * SQLite driver accepts the `timestamp` spelling this DDL uses (the same pair
 * `shared-view.entity.ts` and `1791180000000-CreateSharedViews.ts` use). A raw
 * `timestamptz` — the spelling plan §3.1's table uses for these columns — is
 * rejected by better-sqlite3 at BOOT, which is why the entity's own preamble
 * (`plan.md:399-401`) mandates `PortableDateColumn` and
 * `entities/__tests__/portable-date-columns.spec.ts` fails the build on one.
 *
 * `createdAt` / `updatedAt` use `CURRENT_TIMESTAMP` rather than Postgres'
 * `now()` for the same portability reason: `now()` is a Postgres function and
 * every insert under the test driver would fail on it.
 *
 * ## The five sequence columns
 *
 * `requestedSeq` / `startedSeq` / `evaluatedSeq` and their licence pair
 * `licenseRequestedSeq` / `licenseEvaluatedSeq` are `bigint NOT NULL DEFAULT 0`
 * exactly as plan §3.1:409 and `:442` declare them. They are the coalescing
 * arithmetic of §2.3 and mean nothing outside the repository that owns them.
 *
 * ## The foreign key
 *
 * `workId → works(id)` ON DELETE CASCADE: the row describes one Work and has
 * no meaning without it, so deleting the Work takes its spec state with it. It
 * is the ONLY foreign key. `tenantId` / `organizationId` are deliberately bare
 * uuids with no relation (EW-654/EW-655), exactly as
 * `1792020000000-CreateWorkUpstreamStates.ts` does it.
 *
 * ## The three indexes
 *
 * - `uq_work_app_spec_states_work` UNIQUE `(workId)` — one state row per App
 *   Work. Created as a unique INDEX rather than a table constraint so the same
 *   object and the same name exist on both drivers.
 * - `idx_work_app_spec_states_blueprint` `(blueprintId, blueprintVersion)` —
 *   the upgrade scan of the hourly catalog refresh (plan §6.4:681).
 * - `idx_work_app_spec_states_registry` `(licenseRegistryHash)` — the
 *   re-classification fan-out after a registry change (plan §6.4:682).
 *
 * ## Forward-only, idempotent, portable
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and
 * the foreign key), so a re-run is a no-op and `down()` is safe on a database
 * where `up()` never ran. `down()` drops the three indexes and the table, and
 * touches nothing else.
 */
export class CreateWorkAppSpecStates1792030000000 implements MigrationInterface {
    name = 'CreateWorkAppSpecStates1792030000000';

    private static readonly TABLE = 'work_app_spec_states';
    private static readonly UNIQUE_WORK = 'uq_work_app_spec_states_work';
    private static readonly INDEX_BLUEPRINT = 'idx_work_app_spec_states_blueprint';
    private static readonly INDEX_REGISTRY = 'idx_work_app_spec_states_registry';
    private static readonly FOREIGN_KEY = 'fk_work_app_spec_states_work';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable(CreateWorkAppSpecStates1792030000000.TABLE))) {
            await queryRunner.createTable(
                new Table({
                    name: CreateWorkAppSpecStates1792030000000.TABLE,
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
                        // EW-655 scope stamping — plain columns, no relation.
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        // The branch whose head is evaluated (FR-16).
                        { name: 'trackedBranch', type: 'varchar', length: '255' },
                        // The coalescing arithmetic (plan §2.3, §3.1:409).
                        { name: 'requestedSeq', type: 'bigint', default: 0 },
                        { name: 'startedSeq', type: 'bigint', default: 0 },
                        { name: 'evaluatedSeq', type: 'bigint', default: 0 },
                        { name: 'dispatchedAt', type: 'timestamp', isNullable: true },
                        { name: 'headCommitSha', type: 'varchar', length: '40', isNullable: true },
                        { name: 'headSpecHash', type: 'varchar', length: '64', isNullable: true },
                        // 'valid' | 'valid_with_warnings' | 'invalid' | 'missing' | 'unreadable'.
                        {
                            name: 'validationStatus',
                            type: 'varchar',
                            length: '24',
                            default: "'missing'",
                        },
                        // `AppSpecIssue[]`, capped at 200 by the evaluator.
                        { name: 'issues', type: 'text', isNullable: true },
                        { name: 'errorCount', type: 'int', default: 0 },
                        { name: 'warningCount', type: 'int', default: 0 },
                        { name: 'issuesTruncated', type: 'boolean', default: false },
                        // The effective spec: the commit, its hash and the cached document.
                        {
                            name: 'effectiveCommitSha',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        {
                            name: 'effectiveSpecHash',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'effectiveSpec', type: 'text', isNullable: true },
                        { name: 'effectiveAt', type: 'timestamp', isNullable: true },
                        { name: 'lastEvaluatedAt', type: 'timestamp', isNullable: true },
                        // 'created' | 'push' | 'pr_merged' | 'manual' | 'lazy' | …
                        {
                            name: 'lastEvaluationTrigger',
                            type: 'varchar',
                            length: '24',
                            isNullable: true,
                        },
                        {
                            name: 'lastEvaluationError',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        // Blueprint identity and the apply's own state (plan §2.5).
                        { name: 'blueprintId', type: 'varchar', length: '64', isNullable: true },
                        {
                            name: 'blueprintVersion',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        { name: 'blueprintRepo', type: 'varchar', length: '128', isNullable: true },
                        { name: 'blueprintSha', type: 'varchar', length: '40', isNullable: true },
                        // 'manifest' | 'alias' | 'fork' | 'probe' | 'explicit' | 'file'.
                        {
                            name: 'blueprintMatchSource',
                            type: 'varchar',
                            length: '16',
                            isNullable: true,
                        },
                        // 'applying' | 'applied' | 'failed'.
                        {
                            name: 'blueprintApplyStatus',
                            type: 'varchar',
                            length: '16',
                            isNullable: true,
                        },
                        // The once-only `app.blueprint.matched` guard (FR-82).
                        { name: 'blueprintMatchedAt', type: 'timestamp', isNullable: true },
                        {
                            name: 'blueprintApplyError',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'blueprintApplyRef', type: 'text', isNullable: true },
                        {
                            name: 'blueprintLatestVersion',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        {
                            name: 'blueprintUpgradeDismissedVersion',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        { name: 'blueprintUpgradePr', type: 'text', isNullable: true },
                        // The licence classification (plan §2.6).
                        { name: 'licenseSpdx', type: 'varchar', length: '200', isNullable: true },
                        // 'green' | 'amber' | 'red' | 'unknown' (R-3).
                        { name: 'licenseClass', type: 'varchar', length: '8', isNullable: true },
                        // 'detected' | 'blueprint' | 'user'.
                        { name: 'licenseSource', type: 'varchar', length: '16', isNullable: true },
                        { name: 'licenseMixed', type: 'boolean', default: false },
                        { name: 'licenseScanIncomplete', type: 'boolean', default: false },
                        { name: 'licenseEvidence', type: 'text', isNullable: true },
                        { name: 'licenseObligations', type: 'text', isNullable: true },
                        {
                            name: 'licenseCommitSha',
                            type: 'varchar',
                            length: '40',
                            isNullable: true,
                        },
                        {
                            name: 'licenseRegistryHash',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        // 'live' | 'last_good' | 'snapshot'.
                        {
                            name: 'licenseRegistrySource',
                            type: 'varchar',
                            length: '16',
                            isNullable: true,
                        },
                        // The licence pair of the coalescing arithmetic (plan §3.1:442).
                        { name: 'licenseRequestedSeq', type: 'bigint', default: 0 },
                        { name: 'licenseEvaluatedSeq', type: 'bigint', default: 0 },
                        { name: 'licenseEvaluatedAt', type: 'timestamp', isNullable: true },
                        // The single attestation record (C3, R-3).
                        { name: 'attestation', type: 'text', isNullable: true },
                        { name: 'sourceOfferRequired', type: 'boolean', default: false },
                        { name: 'displayName', type: 'varchar', length: '80', isNullable: true },
                        {
                            name: 'trademarkNotice',
                            type: 'varchar',
                            length: '500',
                            isNullable: true,
                        },
                        { name: 'protectedPaths', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const table = await queryRunner.getTable(CreateWorkAppSpecStates1792030000000.TABLE);
        if (!table) {
            return;
        }

        // One App spec state per App Work.
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppSpecStates1792030000000.UNIQUE_WORK,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppSpecStates1792030000000.TABLE,
                new TableIndex({
                    name: CreateWorkAppSpecStates1792030000000.UNIQUE_WORK,
                    columnNames: ['workId'],
                    isUnique: true,
                }),
            );
        }

        // The upgrade scan of the hourly catalog refresh (§6.4:681).
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppSpecStates1792030000000.INDEX_BLUEPRINT,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppSpecStates1792030000000.TABLE,
                new TableIndex({
                    name: CreateWorkAppSpecStates1792030000000.INDEX_BLUEPRINT,
                    columnNames: ['blueprintId', 'blueprintVersion'],
                }),
            );
        }

        // The re-classification fan-out after a registry change (§6.4:682).
        if (
            !table.indices.some(
                (index) => index.name === CreateWorkAppSpecStates1792030000000.INDEX_REGISTRY,
            )
        ) {
            await queryRunner.createIndex(
                CreateWorkAppSpecStates1792030000000.TABLE,
                new TableIndex({
                    name: CreateWorkAppSpecStates1792030000000.INDEX_REGISTRY,
                    columnNames: ['licenseRegistryHash'],
                }),
            );
        }

        if (
            !table.foreignKeys.some(
                (fk) => fk.name === CreateWorkAppSpecStates1792030000000.FOREIGN_KEY,
            )
        ) {
            await queryRunner.createForeignKey(
                CreateWorkAppSpecStates1792030000000.TABLE,
                new TableForeignKey({
                    name: CreateWorkAppSpecStates1792030000000.FOREIGN_KEY,
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
        if (!(await queryRunner.hasTable(CreateWorkAppSpecStates1792030000000.TABLE))) {
            return;
        }

        const table = await queryRunner.getTable(CreateWorkAppSpecStates1792030000000.TABLE);

        for (const name of [
            CreateWorkAppSpecStates1792030000000.INDEX_REGISTRY,
            CreateWorkAppSpecStates1792030000000.INDEX_BLUEPRINT,
            CreateWorkAppSpecStates1792030000000.UNIQUE_WORK,
        ]) {
            if (table?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(CreateWorkAppSpecStates1792030000000.TABLE, name);
            }
        }

        // `dropTable(name, ifExists, dropIndices, cascade)` — the foreign key
        // belongs to the table and goes with it.
        await queryRunner.dropTable(CreateWorkAppSpecStates1792030000000.TABLE, true, true, true);
    }
}
