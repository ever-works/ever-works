import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-07 (App env & dependencies) — creates `work_app_env_values` and
 * `work_app_dependencies`.
 *
 * Entities:
 *   - `packages/agent/src/entities/work-app-env-value.entity.ts` → `work_app_env_values`
 *   - `packages/agent/src/entities/work-app-dependency.entity.ts` → `work_app_dependencies`
 *
 * Plan: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/plan.md`
 * §3.1 (`:176-193`) and §3.2 (`:202-228`) are the normative column lists — this
 * migration creates them column for column, with the index names both sections
 * fix; §3.4 (`:331-340`) is this file.
 *
 * ## The slot
 *
 * Slot **00 of epic 07** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * which is T7's filename verbatim. The per-epic block, not the wall clock, is
 * what orders these: epic 02's is `1792020000000` and epic 11's is
 * `1792110000000`, and an epic that lands later does not move into their slots.
 * TypeORM runs only the migrations a database has not executed, in timestamp
 * order, so a new one inside its own epic's slot applies cleanly even where a
 * higher-numbered epic's migration was applied first.
 *
 * ## What `up()` does, and nothing else
 *
 * Two `CREATE TABLE`s, two foreign keys, four plain indexes and the ONE partial
 * unique index of §3.2:225. Nothing is renamed, dropped or narrowed (CONTRACTS
 * R-26, the owner's additive-only rule), and **no existing table is altered** —
 * `works.deployRuntimeEnvEncrypted` and its neighbours are not touched
 * (`plan.md:339-340`). There is no backfill to write: both tables are empty on
 * arrival, and a value or a dependency row is created by the App Work that
 * needs it.
 *
 * ## The one partial unique index, in three driver spellings (APW07-G12)
 *
 * `uq_work_app_dependencies_active (workId, kind) WHERE status NOT IN ('kept',
 * 'deleted')` is what stops two `ready` rows for one kind. It is emitted as
 * RAW SQL — `WHERE` clauses on indexes are not portable through TypeORM's
 * `TableIndex`, the convention of
 * `1791220000000-CreateWorkspaceBackups.ts:26-34` — with a branch per driver
 * family:
 *
 *   - **Postgres** (production): the plan's guarded raw form, verbatim;
 *   - **SQLite** (the default `DATABASE_TYPE`, CI and the e2e stack): the
 *     equivalent UNIQUE EXPRESSION index, whose third key part is `NULL` for an
 *     inactive row — and NULLs never collide, so any number of `kept` rows
 *     coexist while a second active one is refused;
 *   - **MySQL/MariaDB**: a `STORED` generated column with the same `CASE`, and
 *     the unique key over `(workId, kind, activeKey)`.
 *
 * Correctness never depends on the index form: the service-level compare-and-set
 * of §3.1 covers every driver, and the index is the database's own backstop.
 * `activeUniqueIndexStatements()` is public so the spec can pin all three
 * spellings without a database of each kind.
 *
 * ## Every timestamp is `bigint` epoch milliseconds
 *
 * Declared `bigint` here and `TimestampColumn` on the entities, exactly as
 * `work_upstream_states` and `work_deployments` do. The dependency lease is
 * `WHERE "provisionLeaseUntil" IS NULL OR "provisionLeaseUntil" < :now` — a
 * numeric comparison that has to mean the same thing on Postgres and on
 * better-sqlite3, while a raw `timestamp` column would be `timestamptz` on one
 * and has no equivalent at all on the other. `createdAt` / `updatedAt` use
 * `CURRENT_TIMESTAMP` rather than Postgres' `now()` for the same portability
 * reason: `now()` is a Postgres function and every insert under the test driver
 * would fail on it.
 *
 * ## Forward-only, idempotent, portable
 *
 * Every step is guarded (`hasTable`, and an existence check for each index and
 * foreign key), so a re-run is a no-op and `down()` is safe on a database where
 * `up()` never ran. `down()` drops the two tables — and therefore their
 * indexes and foreign keys, which belong to them — and touches nothing else.
 */
export class CreateAppEnvAndDependencies1792070000000 implements MigrationInterface {
    name = 'CreateAppEnvAndDependencies1792070000000';

    private static readonly ENV_TABLE = 'work_app_env_values';
    private static readonly ENV_UNIQUE = 'uq_work_app_env_values_work_name';
    private static readonly ENV_INDEX_WORK = 'idx_work_app_env_values_work';
    private static readonly ENV_FOREIGN_KEY = 'fk_work_app_env_values_work';

    private static readonly DEP_TABLE = 'work_app_dependencies';
    private static readonly DEP_INDEX_WORK = 'idx_work_app_dependencies_work';
    private static readonly DEP_INDEX_STATUS = 'idx_work_app_dependencies_status';
    private static readonly DEP_ACTIVE_UNIQUE = 'uq_work_app_dependencies_active';
    private static readonly DEP_ACTIVE_COLUMN = 'activeKey';
    private static readonly DEP_FOREIGN_KEY = 'fk_work_app_dependencies_work';

    /**
     * The two statuses the active unique index excludes (`plan.md:225`), spelled
     * out here rather than imported: a migration is frozen history, and
     * `APP_DEPENDENCY_INACTIVE_STATUSES` may legitimately grow later. The spec
     * asserts the two agree TODAY, which is where the drift belongs.
     */
    private static readonly INACTIVE_STATUSES = ['kept', 'deleted'] as const;

    /**
     * The statement(s) that create the active unique index on a driver — the
     * three spellings of APW07-G12, in the order the plan gives them.
     */
    public static activeUniqueIndexStatements(driver: string): string[] {
        const inactive = CreateAppEnvAndDependencies1792070000000.INACTIVE_STATUSES.map(
            (status) => `'${status}'`,
        ).join(', ');
        const table = CreateAppEnvAndDependencies1792070000000.DEP_TABLE;
        const name = CreateAppEnvAndDependencies1792070000000.DEP_ACTIVE_UNIQUE;

        if (driver === 'postgres' || driver === 'cockroachdb') {
            return [
                `CREATE UNIQUE INDEX IF NOT EXISTS "${name}" ` +
                    `ON "${table}" ("workId", "kind") WHERE "status" NOT IN (${inactive})`,
            ];
        }

        if (driver === 'mysql' || driver === 'mariadb' || driver === 'aurora-mysql') {
            const column = CreateAppEnvAndDependencies1792070000000.DEP_ACTIVE_COLUMN;
            return [
                `ALTER TABLE \`${table}\` ` +
                    `ADD COLUMN \`${column}\` TINYINT GENERATED ALWAYS AS ` +
                    `(CASE WHEN \`status\` NOT IN (${inactive}) THEN 1 ELSE NULL END) STORED, ` +
                    `ADD UNIQUE KEY \`${name}\` (\`workId\`, \`kind\`, \`${column}\`)`,
            ];
        }

        // SQLite (and any other driver whose unique indexes take expressions):
        // NULL never collides, so inactive rows are unlimited while a second
        // active row for one kind is refused.
        return [
            `CREATE UNIQUE INDEX IF NOT EXISTS "${name}" ` +
                `ON "${table}" ("workId", "kind", ` +
                `CASE WHEN "status" NOT IN (${inactive}) THEN 1 ELSE NULL END)`,
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.createEnvValuesTable(queryRunner);
        await this.createDependenciesTable(queryRunner);
        await this.createActiveUniqueIndex(queryRunner);
    }

    /**
     * Drops the two tables this migration created — and with them their indexes
     * and foreign keys, which belong to them. A table this migration did not
     * create is never dropped, so `down()` is safe on a database where `up()`
     * never ran, and `works` (the foreign-key target) is untouchable in both
     * directions.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of [
            CreateAppEnvAndDependencies1792070000000.DEP_TABLE,
            CreateAppEnvAndDependencies1792070000000.ENV_TABLE,
        ]) {
            if (await queryRunner.hasTable(table)) {
                // `dropTable(name, ifExists, dropIndices, cascade)`.
                await queryRunner.dropTable(table, true, true, true);
            }
        }
    }

    /** `work_app_env_values` — plan §3.1:180-190. */
    private async createEnvValuesTable(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable(CreateAppEnvAndDependencies1792070000000.ENV_TABLE)) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: CreateAppEnvAndDependencies1792070000000.ENV_TABLE,
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workId', type: 'uuid' },
                    // `^[A-Z_][A-Z0-9_]{0,127}$` (APP_ENV_NAME_PATTERN, FR-18).
                    { name: 'name', type: 'varchar', length: '128' },
                    // 'generated' | 'prompted' | 'user' | 'derived' (plan :182).
                    { name: 'origin', type: 'varchar', length: '16' },
                    // The `enc::v1::` envelope. NOT NULL: there is no plaintext
                    // column to fall back on (FR-5).
                    { name: 'valueEncrypted', type: 'text' },
                    // Byte length, for FR-31's 1 MiB total; never shown.
                    { name: 'valueBytes', type: 'int' },
                    { name: 'version', type: 'int', default: 1 },
                    // 'base64:24' | 'chars:40:alnum' | 'keypair:ed25519:pem' (:186).
                    {
                        name: 'generatorFingerprint',
                        type: 'varchar',
                        length: '160',
                        isNullable: true,
                    },
                    // For a `<NAME>_PUBLIC` row: the keypair entry it belongs to.
                    { name: 'derivedFromName', type: 'varchar', length: '128', isNullable: true },
                    { name: 'generatedAt', type: 'bigint', isNullable: true },
                    { name: 'setByUserId', type: 'uuid', isNullable: true },
                    // EW-655 scope stamping — plain columns, no relation.
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        const table = await queryRunner.getTable(
            CreateAppEnvAndDependencies1792070000000.ENV_TABLE,
        );
        if (!table) {
            return;
        }

        // One row per (Work, name) — the contract `insertIfAbsent` races on.
        if (
            !table.indices.some(
                (index) => index.name === CreateAppEnvAndDependencies1792070000000.ENV_UNIQUE,
            )
        ) {
            await queryRunner.createIndex(
                CreateAppEnvAndDependencies1792070000000.ENV_TABLE,
                new TableIndex({
                    name: CreateAppEnvAndDependencies1792070000000.ENV_UNIQUE,
                    columnNames: ['workId', 'name'],
                    isUnique: true,
                }),
            );
        }

        // The per-App-Work read (`findByWork`, and the resolve that follows it).
        if (
            !table.indices.some(
                (index) => index.name === CreateAppEnvAndDependencies1792070000000.ENV_INDEX_WORK,
            )
        ) {
            await queryRunner.createIndex(
                CreateAppEnvAndDependencies1792070000000.ENV_TABLE,
                new TableIndex({
                    name: CreateAppEnvAndDependencies1792070000000.ENV_INDEX_WORK,
                    columnNames: ['workId'],
                }),
            );
        }

        if (
            !table.foreignKeys.some(
                (fk) => fk.name === CreateAppEnvAndDependencies1792070000000.ENV_FOREIGN_KEY,
            )
        ) {
            await queryRunner.createForeignKey(
                CreateAppEnvAndDependencies1792070000000.ENV_TABLE,
                new TableForeignKey({
                    name: CreateAppEnvAndDependencies1792070000000.ENV_FOREIGN_KEY,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /** `work_app_dependencies` — plan §3.2:206-224. */
    private async createDependenciesTable(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable(CreateAppEnvAndDependencies1792070000000.DEP_TABLE)) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: CreateAppEnvAndDependencies1792070000000.DEP_TABLE,
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workId', type: 'uuid' },
                    // 'postgres' | 'redis' | 'objectStorage' | 'smtp' (FR-35).
                    { name: 'kind', type: 'varchar', length: '16' },
                    // 'your-cluster' | 'ever-works-apps'.
                    { name: 'deployTarget', type: 'varchar', length: '24' },
                    { name: 'providerPluginId', type: 'varchar', length: '64' },
                    { name: 'providerId', type: 'varchar', length: '64' },
                    // 'pending' | 'awaiting_config' | 'provisioning' | 'ready' |
                    // 'degraded' | 'failed' | 'kept' | 'deleting' | 'deleted'.
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'statusReason', type: 'varchar', length: '48', isNullable: true },
                    // simple-json ⇒ text on every supported driver. Names and
                    // numbers only, ≤ 2 KB (plan :211).
                    { name: 'statusDetail', type: 'text', isNullable: true },
                    { name: 'attempts', type: 'int', default: 0 },
                    // The App spec block this kind was reconciled from.
                    { name: 'declared', type: 'text' },
                    { name: 'actualVersion', type: 'varchar', length: '32', isNullable: true },
                    { name: 'sizeGiB', type: 'int', isNullable: true },
                    // An external provider's configuration, as one envelope.
                    { name: 'configEncrypted', type: 'text', isNullable: true },
                    // Every output as one JSON envelope. Always NULL for an
                    // `ever-works-apps` row (plan :230).
                    { name: 'outputsEncrypted', type: 'text', isNullable: true },
                    { name: 'outputsVersion', type: 'int', default: 0 },
                    // simple-json: { namespace?, objects ≤ 20, databases?, buckets? }.
                    { name: 'resourceRefs', type: 'text', isNullable: true },
                    { name: 'inSpec', type: 'boolean', default: true },
                    // 'none' | 'operator' | 'provider' | 'managed' (FR-48).
                    { name: 'backupPolicy', type: 'varchar', length: '16' },
                    // 'none' | 'not_configured' | 'healthy' | 'overdue' |
                    // 'failing' | 'external' | 'unknown'.
                    { name: 'backupState', type: 'varchar', length: '16', isNullable: true },
                    // Every stamp is epoch milliseconds — see the class docstring.
                    { name: 'lastBackupAt', type: 'bigint', isNullable: true },
                    { name: 'backupCheckedAt', type: 'bigint', isNullable: true },
                    { name: 'lastProvisionedAt', type: 'bigint', isNullable: true },
                    { name: 'lastCheckedAt', type: 'bigint', isNullable: true },
                    // The provisioning lease (plan §4.8:563-566).
                    { name: 'provisionLeaseUntil', type: 'bigint', isNullable: true },
                    // EW-655 scope stamping — plain columns, no relation.
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        const table = await queryRunner.getTable(
            CreateAppEnvAndDependencies1792070000000.DEP_TABLE,
        );
        if (!table) {
            return;
        }

        // The per-App-Work read and the deploy preflight.
        if (
            !table.indices.some(
                (index) => index.name === CreateAppEnvAndDependencies1792070000000.DEP_INDEX_WORK,
            )
        ) {
            await queryRunner.createIndex(
                CreateAppEnvAndDependencies1792070000000.DEP_TABLE,
                new TableIndex({
                    name: CreateAppEnvAndDependencies1792070000000.DEP_INDEX_WORK,
                    columnNames: ['workId'],
                }),
            );
        }

        // FR-42's refresh scan: a card whose status is older than 15 minutes.
        if (
            !table.indices.some(
                (index) => index.name === CreateAppEnvAndDependencies1792070000000.DEP_INDEX_STATUS,
            )
        ) {
            await queryRunner.createIndex(
                CreateAppEnvAndDependencies1792070000000.DEP_TABLE,
                new TableIndex({
                    name: CreateAppEnvAndDependencies1792070000000.DEP_INDEX_STATUS,
                    columnNames: ['status', 'lastCheckedAt'],
                }),
            );
        }

        if (
            !table.foreignKeys.some(
                (fk) => fk.name === CreateAppEnvAndDependencies1792070000000.DEP_FOREIGN_KEY,
            )
        ) {
            await queryRunner.createForeignKey(
                CreateAppEnvAndDependencies1792070000000.DEP_TABLE,
                new TableForeignKey({
                    name: CreateAppEnvAndDependencies1792070000000.DEP_FOREIGN_KEY,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /**
     * The active unique index, in the driver's own spelling. The Postgres and
     * SQLite statements are `IF NOT EXISTS` and therefore idempotent; the
     * MySQL/MariaDB `ALTER TABLE ADD COLUMN … ADD UNIQUE KEY` is not, so
     * elsewhere a re-run is best-effort — the service-level compare-and-set of
     * §3.1 is what actually keeps one active row per kind on those drivers.
     */
    private async createActiveUniqueIndex(queryRunner: QueryRunner): Promise<void> {
        const driver = String(queryRunner.connection.options.type);
        const isPostgres = driver === 'postgres' || driver === 'cockroachdb';

        for (const statement of CreateAppEnvAndDependencies1792070000000.activeUniqueIndexStatements(
            driver,
        )) {
            try {
                await queryRunner.query(statement);
            } catch (error) {
                if (isPostgres) {
                    throw error;
                }
            }
        }
    }
}
