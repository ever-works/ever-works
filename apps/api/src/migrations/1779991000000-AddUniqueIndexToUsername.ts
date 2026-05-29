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
 * Duplicate handling: before the index is created, any case-insensitive
 * duplicate bucket is auto-deduped. The OLDEST row (lowest `createdAt`,
 * tie-broken by `id`) keeps the canonical username; every other row in
 * the bucket is renamed to `<username>-<first-6-id-chars>`. This is
 * deterministic, collision-resistant (UUID prefix), and forward-only.
 *
 * Rationale for auto-rename instead of throwing: a hard throw turns any
 * single duplicate into a full CrashLoopBackOff for the API
 * (`migrationsRun: true` runs migrations at pod boot — see
 * `EVER_WORKS_DB_MIGRATIONS.md`). That happened in prod on 2026-05-28
 * with two real `paradoxe35` users (local + github registrations of the
 * same human). Auto-rename keeps the platform up; an out-of-band human
 * decision can later merge or relabel the renamed accounts.
 *
 * Forward-only, additive. The new index is named explicitly so the down
 * migration can drop the right one even if TypeORM's auto-naming
 * diverges between dialects over time.
 */
export class AddUniqueIndexToUsername1779991000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.dedupeUsernames(queryRunner);

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

    private async dedupeUsernames(queryRunner: QueryRunner): Promise<void> {
        const buckets = (await queryRunner.query(
            `SELECT lower("username") AS lname, COUNT(*) AS cnt FROM "users" WHERE "username" IS NOT NULL GROUP BY lower("username") HAVING COUNT(*) > 1`,
        )) as Array<{ lname: string; cnt: number | string }>;

        if (buckets.length === 0) {
            return;
        }

        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const updateSql = isPostgres
            ? `UPDATE "users" SET "username" = $1 WHERE "id" = $2`
            : `UPDATE "users" SET "username" = ? WHERE "id" = ?`;

        // Build a case-insensitive set of every username currently in use so
        // generated rename targets cannot collide with an existing row that
        // a prior manual cleanup already produced (e.g. prod's
        // `paradoxe35-289966` from the 2026-05-28 incident).
        const taken = new Set<string>(
            (
                (await queryRunner.query(
                    `SELECT lower("username") AS lname FROM "users" WHERE "username" IS NOT NULL`,
                )) as Array<{ lname: string }>
            ).map((r) => r.lname),
        );

        const renames: Array<{ id: string; from: string; to: string }> = [];

        for (const bucket of buckets) {
            const rows = (await queryRunner.query(
                `SELECT "id", "username", "createdAt" FROM "users" WHERE lower("username") = ${
                    isPostgres ? '$1' : '?'
                } ORDER BY "createdAt" ASC, "id" ASC`,
                [bucket.lname],
            )) as Array<{ id: string; username: string; createdAt: Date | string }>;

            // Keep rows[0] (oldest) as canonical; rename the rest. The first
            // bucket-row keeps the lname slot in `taken`; each rename adds the
            // new target to `taken` so subsequent renames in the same pass
            // cannot collide with one we just produced either.
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const renamed = this.allocateRenameTarget(row.username, row.id, taken);
                await queryRunner.query(updateSql, [renamed, row.id]);
                taken.delete(row.username.toLowerCase());
                taken.add(renamed.toLowerCase());
                renames.push({ id: row.id, from: row.username, to: renamed });
            }
        }

        if (renames.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
                `[migration] AddUniqueIndexToUsername renamed ${renames.length} duplicate username(s): ` +
                    JSON.stringify(renames),
            );
        }
    }

    private allocateRenameTarget(username: string, id: string, taken: Set<string>): string {
        const hex = String(id).replace(/-/g, '');
        // Try increasing prefix length 6 → full UUID; any collision falls back
        // to the next longer suffix. Stops at the full hex string, which is
        // guaranteed unique (UUID PKs are unique by the table contract).
        for (let len = 6; len <= hex.length; len++) {
            const candidate = `${username}-${hex.slice(0, len)}`;
            if (!taken.has(candidate.toLowerCase())) {
                return candidate;
            }
        }
        // Defensive: if even the full UUID is taken (impossible unless a row
        // somewhere is already named `<username>-<full-uuid>`), append the
        // numeric suffix `-2`, `-3`, ... like AddSlugToUsers does.
        let n = 2;
        while (taken.has(`${username}-${hex}-${n}`.toLowerCase())) {
            n += 1;
        }
        return `${username}-${hex}-${n}`;
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // IF EXISTS works on both Postgres and SQLite.
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_username_lower_unique"`);
    }
}
