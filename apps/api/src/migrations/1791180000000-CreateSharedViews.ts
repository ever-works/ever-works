import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableForeignKey,
    TableIndex,
    type TableColumnOptions,
} from 'typeorm';

/**
 * Shared view (AW-18, phase 1) — the `shared_views` table.
 *
 * Entity: `packages/agent/src/entities/shared-view.entity.ts`
 *
 * ONE table, one row per Workspace that has ever turned sharing on. It holds
 * what the share link publishes (sections, knowledge classes, crawler
 * posture), the token as `sha256` hash plus an encrypted re-copyable copy,
 * and the view counters. The published content itself is never stored: it
 * is projected live from the Workspace's Task board on every read.
 *
 * ## Shape
 *
 * - UNIQUE `organizationId` — at most one Shared view per Workspace.
 * - UNIQUE `tokenHash` — the public path's single indexed lookup.
 * - `idx_shared_views_tenant` — the Tier-A scope column.
 * - FK `organizationId` → `organizations.id` ON DELETE CASCADE, so deleting a
 *   Workspace deletes its link in the same transaction.
 * - FKs `ownerUserId` / `createdById` → `users.id` ON DELETE CASCADE: a link
 *   must not outlive the person who published it.
 * - `sections`, `knowledgeClasses` and `tokenEncrypted` are `text` because
 *   the entity maps them as `simple-json` (portable across Postgres and
 *   better-sqlite3); the service always writes them, so they carry no DB
 *   default.
 *
 * Forward-only + idempotent (`hasTable` / index-name / FK-name guards), and
 * portable `Table` DDL because production runs Postgres while CI runs
 * better-sqlite3.
 *
 * ## Ownership — which `shared_views` this migration may touch
 *
 * A `shared_views` table can already exist when `up()` runs: `synchronize()`
 * builds the schema from the entities on the CLI app type, so the idempotent
 * adopt path has to keep working (refusing every pre-existing table would
 * crash-loop that database on boot). What must NOT happen is the mirror image
 * on the way back: `migration:revert` dropping a table this migration never
 * created.
 *
 * Two gates, because a shape check alone cannot prove provenance — a foreign
 * table that happens to carry all the declared column names would pass it:
 *
 *   - SHAPE gates what `up()` will adopt. A pre-existing table is adopted only
 *     when it carries every declared column; anything else is somebody else's
 *     table and the migration refuses it loudly rather than bolting this
 *     feature's indexes and cascading foreign keys onto it.
 *   - PROVENANCE gates what `down()` will drop. `up()` stamps
 *     `idx_shared_views_owned_1791180000000` onto the table on the — and only
 *     the — path where it creates it, so the marker survives in the schema
 *     catalogue between the two processes. `down()` drops the table only when
 *     that stamp is there. A table `up()` merely adopted is instead reverted
 *     precisely: this migration's own indexes and foreign keys come off by
 *     name, and the table and every row in it stay.
 *
 * The stamp is not in the entity's metadata, so a later `synchronize()` may
 * drop it. That failure is the safe one: `down()` then treats a table it did
 * create as adopted and keeps it, which costs a manual `DROP TABLE` on a
 * rollback and never costs anybody's rows.
 */
export class CreateSharedViews1791180000000 implements MigrationInterface {
    name = 'CreateSharedViews1791180000000';

    private static readonly INDEXES = [
        new TableIndex({
            name: 'uq_shared_views_organization',
            columnNames: ['organizationId'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'uq_shared_views_token_hash',
            columnNames: ['tokenHash'],
            isUnique: true,
        }),
        new TableIndex({ name: 'idx_shared_views_tenant', columnNames: ['tenantId'] }),
    ];

    /**
     * The provenance stamp. `up()` creates it on the one path where it also
     * creates the table, so its presence in the schema catalogue is proof —
     * persisted, and readable by the later `migration:revert` process — that
     * this migration created this `shared_views`. It is deliberately NOT part
     * of {@link INDEXES}: those are created on the adopt path too, and an
     * index that can appear on an adopted table proves nothing.
     *
     * It indexes the primary key, which is the cheapest column to stamp: the
     * table holds one row per Workspace, so the duplicate index costs
     * essentially nothing, and `down()` takes the whole table with it.
     */
    private static readonly OWNERSHIP_MARKER_INDEX = new TableIndex({
        name: 'idx_shared_views_owned_1791180000000',
        columnNames: ['id'],
    });

    private static readonly FOREIGN_KEYS = [
        new TableForeignKey({
            name: 'fk_shared_views_organization',
            columnNames: ['organizationId'],
            referencedTableName: 'organizations',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_shared_views_owner_user',
            columnNames: ['ownerUserId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_shared_views_created_by',
            columnNames: ['createdById'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    /**
     * The declared columns. `isPostgres` only picks the id default
     * (`uuid_generate_v4()` is a Postgres function); the NAMES are the table's
     * identity for the ownership gate, so they are read from here rather than
     * kept in a second list that could drift.
     */
    private static columns(isPostgres: boolean): TableColumnOptions[] {
        return [
            {
                name: 'id',
                type: 'uuid',
                isPrimary: true,
                generationStrategy: 'uuid',
                default: isPostgres ? 'uuid_generate_v4()' : undefined,
            },
            { name: 'organizationId', type: 'uuid' },
            { name: 'tenantId', type: 'uuid' },
            { name: 'ownerUserId', type: 'uuid' },
            { name: 'tokenHash', type: 'varchar', length: '64' },
            { name: 'tokenEncrypted', type: 'text' },
            { name: 'status', type: 'varchar', length: '16', default: "'active'" },
            { name: 'sections', type: 'text' },
            { name: 'knowledgeClasses', type: 'text' },
            { name: 'searchIndexable', type: 'boolean', default: false },
            { name: 'viewCount', type: 'int', default: 0 },
            { name: 'lastViewedAt', type: 'timestamp', isNullable: true },
            { name: 'firstViewNotifiedAt', type: 'timestamp', isNullable: true },
            { name: 'tokenRotatedAt', type: 'timestamp', isNullable: true },
            { name: 'rotationCount', type: 'int', default: 0 },
            { name: 'createdById', type: 'uuid' },
            { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
            { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ];
    }

    /**
     * Does this table carry the declared shape? True when it has every
     * declared column. Extra columns are tolerated (a later migration may have
     * added one); a missing one means the table is not this feature's, and
     * neither `up()` nor `down()` may touch it.
     *
     * This is a SHAPE test, not an ownership proof — see
     * {@link createdTable} for the latter.
     */
    private static hasDeclaredShape(table: Table | undefined): boolean {
        if (!table) return false;
        const present = new Set(table.columns.map((column) => column.name));
        return CreateSharedViews1791180000000.columns(false).every((column) =>
            present.has(column.name),
        );
    }

    /**
     * Did THIS migration create this table? True only when the table carries
     * the provenance stamp `up()` writes on its create path. A table that
     * `up()` adopted — `synchronize()`-built, or any other pre-existing
     * `shared_views` that happens to match the declared column names — never
     * carries it, so `down()` never drops it.
     */
    private static createdTable(table: Table | undefined): boolean {
        return (
            table?.indices.some(
                (index) =>
                    index.name === CreateSharedViews1791180000000.OWNERSHIP_MARKER_INDEX.name,
            ) ?? false
        );
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        const tableExists = await queryRunner.hasTable('shared_views');

        if (
            tableExists &&
            !CreateSharedViews1791180000000.hasDeclaredShape(
                await queryRunner.getTable('shared_views'),
            )
        ) {
            throw new Error(
                'CreateSharedViews1791180000000: a table named "shared_views" already exists without the ' +
                    'columns this migration declares. Refusing to adopt it — rename or drop that table, then ' +
                    'run the migration again.',
            );
        }

        if (!tableExists) {
            await queryRunner.createTable(
                new Table({
                    name: 'shared_views',
                    columns: CreateSharedViews1791180000000.columns(isPostgres),
                }),
                true,
            );
            // Stamp provenance on the create path only: this is what lets
            // down() tell the table it created from one it merely adopted.
            await queryRunner.createIndex(
                'shared_views',
                CreateSharedViews1791180000000.OWNERSHIP_MARKER_INDEX,
            );
        }

        for (const index of CreateSharedViews1791180000000.INDEXES) {
            const table = await queryRunner.getTable('shared_views');
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('shared_views', index);
            }
        }

        for (const foreignKey of CreateSharedViews1791180000000.FOREIGN_KEYS) {
            const table = await queryRunner.getTable('shared_views');
            if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
                await queryRunner.createForeignKey('shared_views', foreignKey);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('shared_views'))) return;

        const table = await queryRunner.getTable('shared_views');
        // A table that does not carry the declared shape was never this
        // migration's to touch, so it is never this migration's to revert.
        if (!CreateSharedViews1791180000000.hasDeclaredShape(table)) return;

        if (CreateSharedViews1791180000000.createdTable(table)) {
            // Ours: `up()` created it, so the whole table goes.
            await queryRunner.dropTable('shared_views', true, true, true);
            return;
        }

        // Adopted: the table and its rows are somebody else's. Revert exactly
        // what `up()` added to it — its own named foreign keys first (they
        // depend on the indexes), then its own named indexes — and leave the
        // table standing.
        for (const foreignKey of CreateSharedViews1791180000000.FOREIGN_KEYS) {
            const current = await queryRunner.getTable('shared_views');
            const existing = current?.foreignKeys.find((fk) => fk.name === foreignKey.name);
            if (existing) await queryRunner.dropForeignKey('shared_views', existing);
        }

        for (const index of CreateSharedViews1791180000000.INDEXES) {
            const current = await queryRunner.getTable('shared_views');
            const existing = current?.indices.find((idx) => idx.name === index.name);
            if (existing) await queryRunner.dropIndex('shared_views', existing);
        }
    }
}
