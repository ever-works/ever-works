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
 * Backfill: normalize existing `username`, then `email`, then
 * `user-<id>` for legacy/anonymous rows with missing names. Duplicate
 * slugs are resolved with deterministic `-N` suffixes before the
 * UNIQUE index is created.
 *
 * Sequence inside `up`:
 *   1. Add nullable `slug` column.
 *   2. Backfill every missing slug with a URL-safe unique value.
 *   3. Defensive pre-check: error if backfill produced duplicates.
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

        await this.backfillMissingSlugs(queryRunner);

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

        // 5. Flip NOT NULL. On Postgres, avoid queryRunner.changeColumn here:
        //    TypeORM recreates the column by adding the replacement as NOT NULL
        //    before copying the already-backfilled values, which fails on
        //    existing tables. A raw ALTER preserves the populated column.
        const slugColumn = (await queryRunner.getTable('users'))?.findColumnByName('slug');
        if (slugColumn && slugColumn.isNullable) {
            if (queryRunner.connection.options.type === 'postgres') {
                await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "slug" SET NOT NULL`);
                return;
            }

            const updated = new TableColumn({
                name: 'slug',
                type: 'varchar',
                isNullable: false,
            });
            await queryRunner.changeColumn('users', 'slug', updated);
        }
    }

    private async backfillMissingSlugs(queryRunner: QueryRunner): Promise<void> {
        const rows = (await queryRunner.query(
            `SELECT "id", "username", "email", "slug" FROM "users" ORDER BY "createdAt" ASC, "id" ASC`,
        )) as Array<{
            id: string;
            username: string | null;
            email: string | null;
            slug: string | null;
        }>;

        const used = new Set<string>();
        for (const row of rows) {
            if (this.hasValue(row.slug)) {
                used.add(row.slug.trim());
            }
        }

        for (const row of rows) {
            if (this.hasValue(row.slug)) {
                continue;
            }

            const base = this.normalizeSlug(row.username ?? row.email ?? `user-${row.id}`);
            const slug = this.allocateUniqueSlug(base, used);
            used.add(slug);
            await this.updateUserSlug(queryRunner, row.id, slug);
        }
    }

    private async updateUserSlug(
        queryRunner: QueryRunner,
        userId: string,
        slug: string,
    ): Promise<void> {
        if (queryRunner.connection.options.type === 'postgres') {
            await queryRunner.query(`UPDATE "users" SET "slug" = $1 WHERE "id" = $2`, [
                slug,
                userId,
            ]);
            return;
        }

        await queryRunner.query(`UPDATE "users" SET "slug" = ? WHERE "id" = ?`, [slug, userId]);
    }

    private allocateUniqueSlug(base: string, used: Set<string>): string {
        if (!used.has(base)) {
            return base;
        }

        let suffix = 2;
        let candidate = `${base}-${suffix}`;
        while (used.has(candidate)) {
            suffix += 1;
            candidate = `${base}-${suffix}`;
        }
        return candidate;
    }

    private normalizeSlug(input: string): string {
        const normalized = input
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');

        return normalized.length > 0 ? normalized : 'u-anon';
    }

    private hasValue(value: string | null | undefined): value is string {
        return typeof value === 'string' && value.trim().length > 0;
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
