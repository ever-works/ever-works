import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a case-insensitive UNIQUE index on `users.username`.
 *
 * EW-652 (Tenants & Organizations Phase 0) — the existing
 * `onboarding-account.adapter.ts` already asserts a DB UNIQUE constraint
 * on `users.username` ("The DB UNIQUE constraint on `users.username`
 * catches the race and the create call throws"), but no migration in the
 * `apps/api/src/migrations/` set adds one and the `user.entity.ts`
 * declares `username` as a plain `@Column()` with no `unique: true`. The
 * constraint may have been created in some environments by an early
 * `synchronize: true` boot on Postgres but is not guaranteed across
 * fresh prod databases. This migration makes it a formal contract.
 *
 * Case-insensitive: `lower(username)` is used as the index expression on
 * both Postgres and SQLite (modern SQLite ≥ 3.9 supports expression
 * indexes; the `better-sqlite3` driver used by the internal-cli test
 * suite ships a recent SQLite). This matches GitHub-style "Alice" and
 * "alice" cannot both exist semantics.
 *
 * Pre-check: fails loudly if any case-insensitive duplicates already
 * exist in the table. The platform is not yet live (no live data), so
 * this is expected to be a no-op in practice; the check exists to
 * prevent silent data corruption if someone applies this migration to a
 * snapshot that has been mucked with manually.
 *
 * Forward-only, additive. The new index is named explicitly so the down
 * migration can drop the right one even if TypeORM's auto-naming
 * diverges between dialects over time.
 */
export class AddUniqueIndexToUsername1779991000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const dupes = (await queryRunner.query(
            `SELECT lower("username") AS lname, COUNT(*) AS cnt FROM "users" GROUP BY lower("username") HAVING COUNT(*) > 1`,
        )) as Array<{ lname: string; cnt: number | string }>;

        if (dupes.length > 0) {
            throw new Error(
                `AddUniqueIndexToUsername aborted: found ${dupes.length} case-insensitive duplicate username(s) in users table. ` +
                    `Resolve manually before re-running this migration. Sample: ${JSON.stringify(dupes.slice(0, 5))}`,
            );
        }

        const table = await queryRunner.getTable('users');
        const hasIndex = table?.indices.some(
            (idx) => idx.name === 'idx_users_username_lower_unique',
        );
        if (!hasIndex) {
            // Expression index. Use raw SQL because TypeORM's TableIndex does not
            // model expression columns portably across dialects.
            await queryRunner.query(
                `CREATE UNIQUE INDEX "idx_users_username_lower_unique" ON "users" (lower("username"))`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // IF EXISTS works on both Postgres and SQLite.
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_username_lower_unique"`);
    }
}
