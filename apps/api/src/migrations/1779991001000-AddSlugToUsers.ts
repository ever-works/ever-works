import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Adds a URL-safe `slug` column to `users` with a UNIQUE index.
 *
 * EW-652 (Tenants & Organizations Phase 0) — the slug is the
 * denormalized URL-safe form of `username` used by the slug routing
 * layer (Phase 7 / EW-659). Globally unique across the table; the
 * future `organizations.slug` (Phase 1 / EW-653) is also globally
 * unique and the application-level allocator (`UsernameAllocatorService`)
 * enforces no cross-table collision at write time.
 *
 * Backfill: simple `lower("username")` for any existing rows. The
 * platform is not yet live, so this is expected to be a no-op or
 * touch only test fixtures. New users created post-migration go
 * through the application-layer normalizer (lowercase + replace
 * non-`[a-z0-9-]` with hyphen + collapse + trim — see
 * `UsernameAllocatorService.normalize`), so future writes are
 * always URL-safe.
 *
 * Sequence inside `up`:
 *   1. Add nullable `slug` column.
 *   2. Backfill `slug = lower(username)` for any NULL row.
 *   3. Defensive pre-check: error if backfill produced duplicates
 *      (shouldn't happen given the prior `AddUniqueIndexToUsername`
 *      migration enforces case-insensitive uniqueness on username).
 *   4. Add UNIQUE index on `slug`.
 *   5. Flip column to NOT NULL.
 *
 * Forward-only, additive.
 */
export class AddSlugToUsers1779991001000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Add nullable column.
        if (!(await queryRunner.hasColumn('users', 'slug'))) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'slug',
                    type: 'varchar',
                    isNullable: true,
                }),
            );
        }

        // 2. Backfill from username (lowercase). The Postgres + SQLite UPDATE
        //    shape is identical here; no dialect branching needed.
        await queryRunner.query(
            `UPDATE "users" SET "slug" = lower("username") WHERE "slug" IS NULL`,
        );

        // 3. Defensive duplicate check.
        const dupes = (await queryRunner.query(
            `SELECT "slug", COUNT(*) AS cnt FROM "users" WHERE "slug" IS NOT NULL GROUP BY "slug" HAVING COUNT(*) > 1`,
        )) as Array<{ slug: string; cnt: number | string }>;

        if (dupes.length > 0) {
            throw new Error(
                `AddSlugToUsers aborted: backfill produced ${dupes.length} duplicate slug(s) — implies AddUniqueIndexToUsername was bypassed. ` +
                    `Resolve manually. Sample: ${JSON.stringify(dupes.slice(0, 5))}`,
            );
        }

        // 4. Unique index. TableIndex with isUnique handles both dialects.
        const table = await queryRunner.getTable('users');
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_users_slug_unique');
        if (!hasIndex) {
            await queryRunner.createIndex(
                'users',
                new TableIndex({
                    name: 'idx_users_slug_unique',
                    columnNames: ['slug'],
                    isUnique: true,
                }),
            );
        }

        // 5. Flip NOT NULL. queryRunner.changeColumn handles both Postgres and
        //    SQLite (SQLite emits a recreate-table dance under the hood).
        const slugColumn = (await queryRunner.getTable('users'))?.findColumnByName('slug');
        if (slugColumn && slugColumn.isNullable) {
            const updated = new TableColumn({
                name: 'slug',
                type: 'varchar',
                isNullable: false,
            });
            await queryRunner.changeColumn('users', 'slug', updated);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('users');
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_users_slug_unique');
        if (hasIndex) {
            await queryRunner.dropIndex('users', 'idx_users_slug_unique');
        }
        if (await queryRunner.hasColumn('users', 'slug')) {
            await queryRunner.dropColumn('users', 'slug');
        }
    }
}
