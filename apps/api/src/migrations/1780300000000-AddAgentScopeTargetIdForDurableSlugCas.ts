import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the Agent per-scope slug uniqueness DURABLE under concurrency.
 *
 * `uq_agents_user_scope_slug` previously spanned the nullable scope FKs
 * `(userId, scope, missionId, ideaId, workId, slug)`. Because SQL treats NULLs
 * as DISTINCT inside a unique index, that index could NOT dedup same-name
 * agents in any null-containing scope — `tenant` has all three FKs null,
 * `mission` has idea/work null, etc. — so a concurrent same-name create burst
 * could ALL succeed instead of exactly one. (The app-level pre-check in
 * `agents.service.create` races, and the `isUniqueConstraintError` → 409 path
 * never fired because the index never threw.)
 *
 * Fix: a NON-NULL `scopeTargetId` column = COALESCE(missionId, ideaId, workId,
 * '') and move the unique index to `(userId, scope, scopeTargetId, slug)`,
 * which has no nullable members and is therefore enforced on both Postgres and
 * SQLite. The entity keeps the column in lock-step on every persist via
 * `@BeforeInsert/@BeforeUpdate` (`agent.entity.ts` `syncScopeTargetId`).
 *
 * Duplicate handling: `migrationsRun: true` applies migrations at pod boot, so
 * a hard unique-index failure on a pre-existing duplicate would
 * CrashLoopBackOff the API (cf. the AddUniqueIndexToUsername prod incident).
 * Before creating the new index we auto-dedupe each
 * `(userId, scope, scopeTargetId, slug)` bucket: the OLDEST row (createdAt ASC,
 * id ASC) keeps its slug; every other row's slug is suffixed with a UUID prefix
 * (`<slug>-<id6>`) — deterministic and collision-resistant. An out-of-band
 * human decision can later merge/relabel the renamed agents.
 *
 * Forward-only, additive. CI e2e (sqlite + `DATABASE_AUTOMIGRATE`) builds the
 * schema from entity metadata, so this migration is the Postgres-deploy path;
 * it is nonetheless written cross-dialect so the migration test suite passes on
 * better-sqlite3 too.
 */
export class AddAgentScopeTargetIdForDurableSlugCas1780300000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        // 1) Add the non-null normalized column (idempotent).
        const table = await queryRunner.getTable('agents');
        const hasColumn = table?.columns.some((c) => c.name === 'scopeTargetId');
        if (!hasColumn) {
            await queryRunner.query(
                `ALTER TABLE "agents" ADD COLUMN "scopeTargetId" varchar(36) NOT NULL DEFAULT ''`,
            );
        }

        // 2) Backfill from the existing scope FKs. Postgres `uuid` columns need
        //    an explicit ::text cast for COALESCE into a varchar target.
        const coalesce = isPostgres
            ? `COALESCE("missionId"::text, "ideaId"::text, "workId"::text, '')`
            : `COALESCE("missionId", "ideaId", "workId", '')`;
        await queryRunner.query(`UPDATE "agents" SET "scopeTargetId" = ${coalesce}`);

        // 3) Auto-dedupe each (userId, scope, scopeTargetId, slug) bucket BEFORE
        //    the unique index is created, so a pre-existing duplicate cannot
        //    CrashLoopBackOff the API on boot.
        await this.dedupeSlugBuckets(queryRunner, isPostgres);

        // 4) Replace the old NULL-distinct index with the durable one. Same name
        //    so downstream references and the entity decorator stay in sync.
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_agents_user_scope_slug"`);
        const refreshed = await queryRunner.getTable('agents');
        const hasNew = refreshed?.indices.some((idx) => idx.name === 'uq_agents_user_scope_slug');
        if (!hasNew) {
            await queryRunner.query(
                `CREATE UNIQUE INDEX "uq_agents_user_scope_slug" ON "agents" ("userId", "scope", "scopeTargetId", "slug")`,
            );
        }
    }

    private async dedupeSlugBuckets(queryRunner: QueryRunner, isPostgres: boolean): Promise<void> {
        const buckets = (await queryRunner.query(
            `SELECT "userId", "scope", "scopeTargetId", "slug", COUNT(*) AS cnt
             FROM "agents"
             GROUP BY "userId", "scope", "scopeTargetId", "slug"
             HAVING COUNT(*) > 1`,
        )) as Array<{ userId: string; scope: string; scopeTargetId: string; slug: string }>;
        if (buckets.length === 0) {
            return;
        }

        const ph = (n: number) => (isPostgres ? `$${n}` : '?');
        const updateSql = `UPDATE "agents" SET "slug" = ${ph(1)} WHERE "id" = ${ph(2)}`;
        const renamedIds: string[] = [];

        for (const b of buckets) {
            const rows = (await queryRunner.query(
                `SELECT "id", "slug" FROM "agents"
                 WHERE "userId" = ${ph(1)} AND "scope" = ${ph(2)}
                   AND "scopeTargetId" = ${ph(3)} AND "slug" = ${ph(4)}
                 ORDER BY "createdAt" ASC, "id" ASC`,
                [b.userId, b.scope, b.scopeTargetId, b.slug],
            )) as Array<{ id: string; slug: string }>;

            // rows[0] (oldest) keeps the canonical slug; rename the rest.
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const hex = String(row.id).replace(/-/g, '');
                const suffix = `-${hex.slice(0, 6)}`;
                // `slug` is varchar(80); truncate the base so the suffix fits.
                const base =
                    row.slug.length + suffix.length > 80
                        ? row.slug.slice(0, 80 - suffix.length)
                        : row.slug;
                await queryRunner.query(updateSql, [`${base}${suffix}`, row.id]);
                renamedIds.push(row.id);
            }
        }

        if (renamedIds.length > 0) {
            // Log only count + ids (no slugs/PII) for ops traceability.
            // eslint-disable-next-line no-console
            console.warn(
                `[migration] AddAgentScopeTargetIdForDurableSlugCas renamed ${renamedIds.length} duplicate agent slug(s): IDs=${renamedIds.join(',')}`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restore the prior (NULL-distinct) index form, then drop the column.
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_agents_user_scope_slug"`);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "uq_agents_user_scope_slug" ON "agents" ("userId", "scope", "missionId", "ideaId", "workId", "slug")`,
        );
        await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "scopeTargetId"`);
    }
}
