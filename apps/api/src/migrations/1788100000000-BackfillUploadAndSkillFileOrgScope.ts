import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill Tier C scope on `user_uploads` and `skill_files` from their parents.
 *
 * DATA migration (no schema change), forward-only, idempotent.
 *
 * Both tables carry `tenantId` / `organizationId` (Tier C, EW-657), but two
 * writers left them NULL for rows that belong to an Organization:
 *
 *   1. `OrganizationService.upgradeFromAccount` moves `works` and `skills`
 *      into the first Organization but never walked these children;
 *   2. since `8f28edca0` (2026-08-23) the web BFF upload proxies forwarded no
 *      `X-Scope-Slug`, so every upload made from an `/org/<slug>/` tab was
 *      stamped personal — including `?workId=` uploads into org Works.
 *
 * The strict org branch of `ownershipWhere` (`organizationId = <org>`) makes
 * such rows invisible from the Organization they belong to, and
 * `UploadsController.serve` turns that miss into an opaque 404.
 *
 * WHAT CHANGES: a personal-stamped row (`organizationId IS NULL`) whose parent
 * (`works.id = user_uploads.workId`, `skills.id = skill_files.skillId`) is
 * org-stamped inherits the parent's `(tenantId, organizationId)`, provided
 * the row has no tenant yet or already agrees with the parent's tenant. Every
 * such parent got its org stamp from an authorised flow, and the child could
 * only have been created by the parent's owner (`assertWorkAccess` /
 * `assertOwnedSkill`), so this NARROWS visibility to the right Organization
 * and never widens it.
 *
 * WHAT DOES NOT CHANGE: rows with no parent — `workId IS NULL`: chat,
 * Mission, Idea and Agent attachments, Memory Files, skill companion bytes —
 * stay personal. One content-addressed row can back several parents in
 * different scopes at once, so there is no deterministic Organization to
 * infer, and the row's own stamp is the only first-hand evidence of the
 * request that created it. Also skipped: anonymous rows (`userId IS NULL`),
 * dangling parent ids, personal parents, and rows whose tenant DISAGREES
 * with the parent's — the last is counted and logged, never rewritten,
 * because changing a row's tenant is a cross-tenant move.
 *
 * IDEMPOTENT because `organizationId IS NULL` is the predicate: a second run
 * affects 0 rows. PORTABLE: correlated subqueries only (no `UPDATE … FROM`,
 * no `LIMIT`, no CTE), double-quoted identifiers like every data migration
 * in this directory (Postgres in prod, better-sqlite3 in CI). Counts are
 * taken with a SELECT before each UPDATE so the operator log does not depend
 * on the driver's affected-row shape. One statement per table, no batching —
 * `migrationsTransactionMode: 'all'` runs every pending migration in one
 * transaction, so chunking could not release locks anyway.
 *
 * DOWN is a deliberate NO-OP: the migration does not record which rows were
 * NULL before, and NULL-ing every org-stamped child would also strip rows
 * that were stamped correctly at insert time.
 */
export class BackfillUploadAndSkillFileOrgScope1788100000000 implements MigrationInterface {
    name = 'BackfillUploadAndSkillFileOrgScope1788100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await this.allExist(queryRunner, ['user_uploads', 'works', 'organizations'])) {
            await this.inheritParentScope(queryRunner, {
                child: 'user_uploads',
                parent: 'works',
                link: 'workId',
            });
        }
        if (await this.allExist(queryRunner, ['skill_files', 'skills', 'organizations'])) {
            await this.inheritParentScope(queryRunner, {
                child: 'skill_files',
                parent: 'skills',
                link: 'skillId',
            });
        }
    }

    public async down(): Promise<void> {
        // Deliberate no-op — see the class comment.
    }

    private async allExist(queryRunner: QueryRunner, tables: string[]): Promise<boolean> {
        for (const table of tables) {
            if (!(await queryRunner.hasTable(table))) return false;
        }
        return true;
    }

    /**
     * `child`.`link` → `parent`.`id`. Identifiers come from the two fixed
     * configs above, never from input.
     */
    private async inheritParentScope(
        queryRunner: QueryRunner,
        cfg: { child: string; parent: string; link: string },
    ): Promise<void> {
        const { child, parent, link } = cfg;

        // The parent is org-stamped and the child either has no tenant yet or
        // agrees with the parent's. Shared by the candidate count and the UPDATE
        // so the two can never disagree about which rows qualify.
        const qualifies = `
            "${child}"."organizationId" IS NULL
            AND "${child}"."${link}" IS NOT NULL
            AND "${child}"."userId" IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM "${parent}" p
                 WHERE p."id" = "${child}"."${link}"
                   AND p."organizationId" IS NOT NULL
                   AND ("${child}"."tenantId" IS NULL OR "${child}"."tenantId" = p."tenantId")
            )`;

        const candidates = await this.count(
            queryRunner,
            `SELECT COUNT(*) AS cnt FROM "${child}" WHERE ${qualifies}`,
        );

        // Rows already stamped with a DIFFERENT tenant than their parent: an
        // anomaly this migration refuses to touch. Logged so a "N candidates,
        // 0 changed" outcome is distinguishable from "nothing to do".
        const mismatched = await this.count(
            queryRunner,
            `SELECT COUNT(*) AS cnt FROM "${child}"
              WHERE "${child}"."organizationId" IS NULL
                AND "${child}"."${link}" IS NOT NULL
                AND "${child}"."tenantId" IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM "${parent}" p
                     WHERE p."id" = "${child}"."${link}"
                       AND p."organizationId" IS NOT NULL
                       AND p."tenantId" IS NOT NULL
                       AND p."tenantId" <> "${child}"."tenantId"
                )`,
        );

        // eslint-disable-next-line no-console
        console.warn(
            `[BackfillUploadAndSkillFileOrgScope] ${child}: ${candidates} row(s) inherit ${parent} scope; ${mismatched} tenant-mismatched row(s) left untouched`,
        );

        if (candidates === 0) return;

        // `organizations.tenantId` is NOT NULL, so a parent with an org but no
        // tenant (should not exist) still yields a tenant; the child never
        // ends up `organizationId NOT NULL, tenantId NULL`, which the strict
        // org branch could not match.
        await queryRunner.query(`
            UPDATE "${child}"
               SET "organizationId" = (
                       SELECT p."organizationId"
                         FROM "${parent}" p
                        WHERE p."id" = "${child}"."${link}"
                   ),
                   "tenantId" = (
                       SELECT COALESCE(p."tenantId", o."tenantId")
                         FROM "${parent}" p
                         LEFT JOIN "organizations" o ON o."id" = p."organizationId"
                        WHERE p."id" = "${child}"."${link}"
                   )
             WHERE ${qualifies}`);
    }

    private async count(queryRunner: QueryRunner, sql: string): Promise<number> {
        const rows = (await queryRunner.query(sql)) as Array<{ cnt?: unknown }>;
        return Number(rows[0]?.cnt ?? 0);
    }
}
