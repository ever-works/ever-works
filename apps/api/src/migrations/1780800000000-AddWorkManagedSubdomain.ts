import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-734 / EW-736 — adds the durable per-Work `managedSubdomain` claim and
 * its globally-unique partial index.
 *
 * Today, the managed `*.ever.works` host is re-derived from `work.slug` on
 * every deploy (`deploy.service.ts:483-524`,
 * `cloudflare-dns.provider.ts:ingressHostFor`). The result is two real bugs:
 *
 *   1. **No global uniqueness.** `work.slug` is only unique per-`(userId, owner)`
 *      (`work.repository.ts:32-41`). Two users picking slug `ai-coding` both
 *      derive `ai-coding.ever.works` → the second deploy silently overwrites
 *      the first's CNAME.
 *   2. **Slug rename orphans the old record.** Nothing records "this Work
 *      owns `ai-coding.ever.works`", so renaming the slug leaks the old CNAME.
 *
 * This migration is the DB foundation that lets `SubdomainAllocator` (EW-737)
 * detect collisions before persisting and the future
 * `GET/PUT /works/:id/subdomain` (EW-739) edit the claim safely.
 *
 * Forward-only and idempotent (`hasColumn` / catalog guard). No backfill is
 * performed here — the 7 already-migrated Vercel→k8s Works (`dir`,
 * `mcpserver`, `vectordb`, `timetrack`, `chairs`, `startup-books`,
 * `compliance-automation`) keep their derive-from-slug fallback. A separate
 * one-off backfill script (out of scope for this PR — tracked in EW-736
 * follow-up) will read each Work's live `*.ever.works` record from
 * Cloudflare and persist the matching `managedSubdomain` so existing
 * Works also gain orphan-on-rename protection.
 *
 * The unique index is **partial** (`WHERE "managedSubdomain" IS NOT NULL`)
 * so that the NULL-default doesn't collide across rows. This matches the
 * Postgres pattern used by other partial-unique indexes in this codebase.
 */
export class AddWorkManagedSubdomain1780800000000 implements MigrationInterface {
    name = 'AddWorkManagedSubdomain1780800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'managedSubdomain'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'managedSubdomain',
                    type: 'varchar',
                    length: '63',
                    isNullable: true,
                }),
            );
        }

        // Partial unique index — Postgres-style `WHERE` clause. Guarded so
        // re-runs (idempotency / down-then-up) don't double-create.
        const driver = queryRunner.connection.options.type;
        if (driver === 'postgres') {
            await queryRunner.query(
                `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_works_managedSubdomain_notnull" ` +
                    `ON "works" ("managedSubdomain") WHERE "managedSubdomain" IS NOT NULL`,
            );
        } else {
            // SQLite (test/CLI adapter) — partial indexes are supported via
            // the same `WHERE` syntax. Other drivers: skip (the application
            // layer's `SubdomainAllocator` still does a collision probe before
            // insert).
            try {
                await queryRunner.query(
                    `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_works_managedSubdomain_notnull" ` +
                        `ON "works" ("managedSubdomain") WHERE "managedSubdomain" IS NOT NULL`,
                );
            } catch {
                // Best-effort on non-supporting drivers. The allocator still
                // guards against races by re-checking after insert.
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_works_managedSubdomain_notnull"`);
        if (await queryRunner.hasColumn('works', 'managedSubdomain')) {
            await queryRunner.dropColumn('works', 'managedSubdomain');
        }
    }
}
