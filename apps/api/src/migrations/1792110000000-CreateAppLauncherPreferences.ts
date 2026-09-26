import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
    TableUnique,
} from 'typeorm';

/**
 * APW-11 (App Launcher) — one nullable column on `works` and one new table.
 *
 * Entities:
 *   - `packages/agent/src/entities/work.entity.ts` → `works.appLauncherExposed`
 *   - `packages/agent/src/entities/app-launcher-preference.entity.ts` →
 *     `app_launcher_preferences`
 *
 * Slot **00 of epic 11** in the programme's reserved `1792` block (README §7
 * rule 6; Resolution R-39: `1792` + two-digit epic + two-digit slot + `00000`),
 * stamped above `1791240000000-AddSafetyRailsCore.ts`, the newest migration on
 * `ee45946e5`.
 *
 * ## Why the column is nullable with NO default and NO backfill
 *
 * `appLauncherExposed` has three states (spec FR-19): explicitly on, explicitly
 * off, and *unset* — which means "follow this Work kind's default", on for an
 * App Work and off for every other kind. A `DEFAULT false` (or `true`) would
 * collapse that third state into a choice nobody made, and a backfill would
 * rewrite every existing Work's exposure into an explicit value that **always
 * wins** from then on, including after a kind change. So every existing Work
 * keeps reading exactly the behaviour it showed before this migration ran:
 * `NULL`, and therefore its kind default.
 *
 * ## Why this migration does not touch anything else
 *
 * Nothing is renamed, dropped or narrowed (CONTRACTS R-26, the owner's
 * additive-only rule). `up()` performs exactly two structural operations — one
 * `ADD COLUMN` and one `CREATE TABLE` — plus the new table's index and foreign
 * key, and nothing else in the schema is read or written.
 *
 * ## Shape of `app_launcher_preferences` (plan §3.2:207-222, data-model §2.11)
 *
 * - `uq_app_launcher_prefs_user_scope_item` UNIQUE `(userId, scopeKey, itemKey)`
 *   — one row per person per scope per item. Declared as a named table
 *   constraint rather than a unique index so the same statement and the same
 *   constraint name exist on Postgres and on the better-sqlite3 driver CI and
 *   the e2e lane run.
 * - `idx_app_launcher_prefs_user_scope` on `(userId, scopeKey)` — the read every
 *   panel open performs.
 * - FK `userId` → `users.id` ON DELETE CASCADE: a person's arrangement is
 *   theirs, and deleting the account takes it with them. Deliberately the only
 *   foreign key: `itemKey` is polymorphic (`platform:<id>` · `work:<uuid>`), so
 *   there is no table to point it at and rows for a deleted or inaccessible Work
 *   are ignored on read and pruned first (spec FR-28).
 *
 * Deliberately **absent**: `tenantId` and `organizationId`. The scope stamping
 * subscriber would write the ACTIVE Organization onto a `'global'` Ever-app row
 * that every Organization shares — see the entity's docstring.
 *
 * ## Forward-only, idempotent, portable
 *
 * Every step is guarded (`hasTable` / `hasColumn`), so a re-run is a no-op and
 * `down()` is safe on a database where `up()` never ran. The DDL is TypeORM's
 * `Table` rather than raw SQL, and the timestamp defaults are
 * `CURRENT_TIMESTAMP` rather than `now()`, because production runs Postgres
 * while CI runs better-sqlite3 — `now()` is a Postgres function and every insert
 * under the test driver would fail on it.
 *
 * `down()` reverses exactly what `up()` created: the index and the table (with
 * its constraint and foreign key) and the `works` column. Nothing pre-existing
 * is touched in either direction.
 */
export class CreateAppLauncherPreferences1792110000000 implements MigrationInterface {
    name = 'CreateAppLauncherPreferences1792110000000';

    private static readonly TABLE = 'app_launcher_preferences';
    private static readonly INDEX = 'idx_app_launcher_prefs_user_scope';
    private static readonly UNIQUE = 'uq_app_launcher_prefs_user_scope_item';
    private static readonly FOREIGN_KEY = 'fk_app_launcher_preferences_user';
    private static readonly WORK_COLUMN = 'appLauncherExposed';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. `works.appLauncherExposed` — one appended, nullable column. Guarded
        //    on `hasColumn` so a re-run is a no-op, and on `hasTable` so this
        //    migration is safe on a database where the Works table is not there
        //    yet (there is then no Work whose exposure could need a column, and
        //    inventing one on a table this migration does not own would be the
        //    opposite of additive).
        if (await queryRunner.hasTable('works')) {
            if (
                !(await queryRunner.hasColumn(
                    'works',
                    CreateAppLauncherPreferences1792110000000.WORK_COLUMN,
                ))
            ) {
                await queryRunner.addColumn(
                    'works',
                    new TableColumn({
                        name: CreateAppLauncherPreferences1792110000000.WORK_COLUMN,
                        type: 'boolean',
                        isNullable: true,
                        // No `default`: `NULL` is FR-19's "no explicit choice", and
                        // a default would silently turn it into one.
                    }),
                );
            }
        }

        // 2. The preference table.
        if (!(await queryRunner.hasTable(CreateAppLauncherPreferences1792110000000.TABLE))) {
            await queryRunner.createTable(
                new Table({
                    name: CreateAppLauncherPreferences1792110000000.TABLE,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        // 'global' | 'personal' | <organizationId> — plan §3.2:211.
                        { name: 'scopeKey', type: 'varchar', length: '40' },
                        // 'platform:<catalogId>' | 'work:<uuid>' — plan §3.2:212.
                        { name: 'itemKey', type: 'varchar', length: '64' },
                        { name: 'visible', type: 'boolean', default: true },
                        { name: 'pinned', type: 'boolean', default: false },
                        { name: 'pinOrder', type: 'smallint', isNullable: true },
                        { name: 'sortOrder', type: 'integer', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                    uniques: [
                        new TableUnique({
                            name: CreateAppLauncherPreferences1792110000000.UNIQUE,
                            columnNames: ['userId', 'scopeKey', 'itemKey'],
                        }),
                    ],
                }),
                true,
            );
        }

        const table = await queryRunner.getTable(CreateAppLauncherPreferences1792110000000.TABLE);
        if (
            table &&
            !table.indices.some(
                (index) => index.name === CreateAppLauncherPreferences1792110000000.INDEX,
            )
        ) {
            await queryRunner.createIndex(
                CreateAppLauncherPreferences1792110000000.TABLE,
                new TableIndex({
                    name: CreateAppLauncherPreferences1792110000000.INDEX,
                    columnNames: ['userId', 'scopeKey'],
                }),
            );
        }

        const current = await queryRunner.getTable(CreateAppLauncherPreferences1792110000000.TABLE);
        if (
            current &&
            !current.foreignKeys.some(
                (fk) => fk.name === CreateAppLauncherPreferences1792110000000.FOREIGN_KEY,
            )
        ) {
            await queryRunner.createForeignKey(
                CreateAppLauncherPreferences1792110000000.TABLE,
                new TableForeignKey({
                    name: CreateAppLauncherPreferences1792110000000.FOREIGN_KEY,
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /**
     * Drops exactly the column, the table and the index the `up()` path created.
     * A table this migration did not create is never dropped, and neither is a
     * `works` column it did not add — both are re-checked here rather than
     * assumed.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable(CreateAppLauncherPreferences1792110000000.TABLE)) {
            // `dropTable(name, ifExists, dropIndices, cascade)` — the indices and
            // the foreign key belong to the table and go with it.
            await queryRunner.dropTable(
                CreateAppLauncherPreferences1792110000000.TABLE,
                true,
                true,
                true,
            );
        }

        if (
            (await queryRunner.hasTable('works')) &&
            (await queryRunner.hasColumn(
                'works',
                CreateAppLauncherPreferences1792110000000.WORK_COLUMN,
            ))
        ) {
            await queryRunner.dropColumn(
                'works',
                CreateAppLauncherPreferences1792110000000.WORK_COLUMN,
            );
        }
    }
}
