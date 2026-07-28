import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let `work_knowledge_uploads` hold an ORG-scoped original by making
 * `workId` nullable.
 *
 * WHY
 *   Global Memory (`/memory`) can read every KB document across the org
 *   but cannot accept a file, because uploads were per-Work by schema:
 *   `"workId" uuid NOT NULL REFERENCES works(id)`. There was nowhere to
 *   put an org-scoped original — that, not missing UI, is the real
 *   blocker behind "no upload on the Memory page".
 *
 * WHY NOT THE XOR THAT `work_knowledge_documents` USES
 *   The documents table discriminates scope with
 *   `("workId" IS NOT NULL AND "organizationId" IS NULL) OR (…)`. Copying
 *   that here would BREAK THE DEPLOY, and the reason is worth recording:
 *
 *   `work_knowledge_uploads.organizationId` is not a scope column, it is
 *   a Tier C tenancy denormalization that `ScopeStampingSubscriber`
 *   populates on EVERY insert — Work-scoped rows included. So existing
 *   rows have `workId` AND `organizationId` both set. Postgres validates
 *   `ADD CONSTRAINT … CHECK` against existing data, so an XOR would fail
 *   validation, abort the migration, and crash-loop the API on boot while
 *   ArgoCD held the previous image. The documents table escapes this only
 *   because it predates Tier C stamping.
 *
 *   The discriminator here is therefore simply `workId IS NULL`. The
 *   CHECK we DO add — "at least one scope" — is true for every existing
 *   row by construction, so it validates instantly.
 *
 * SAFETY
 *   - Dropping NOT NULL accepts strictly more than before.
 *   - The CHECK holds for all current rows (they all have `workId`).
 *   - An older pod that has never heard of org-scoped uploads keeps
 *     writing `workId`-bearing rows and keeps satisfying the CHECK, so
 *     this is safe to apply mid-rollout.
 *
 *   No FK is added on `organizationId`: it is a raw uuid column with no
 *   entity relation, per the EW-654 cycle-avoidance rule the other Tier C
 *   columns follow.
 *
 * REVERT
 *   `down()` refuses to run while org-scoped rows exist rather than
 *   deleting them to satisfy the restored NOT NULL. Those rows are files
 *   users uploaded to Memory; losing them should never be a side effect
 *   of a schema rollback.
 */
export class AddOrgScopeToKbUploads1784790000000 implements MigrationInterface {
    name = 'AddOrgScopeToKbUploads1784790000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('work_knowledge_uploads');
        if (!table) return;

        // SQLite (test harness) cannot ALTER a column's nullability in
        // place and ignores ADD CONSTRAINT. The scope rule is enforced in
        // the service too, so that path stays correct without the DDL.
        if (queryRunner.connection.options.type !== 'postgres') return;

        await queryRunner.query(
            `ALTER TABLE "work_knowledge_uploads" ALTER COLUMN "workId" DROP NOT NULL`,
        );

        // Guard against the one genuinely invalid shape: a row owned by
        // nothing. True for every existing row, so validation is a no-op.
        await queryRunner.query(`
            ALTER TABLE "work_knowledge_uploads"
            ADD CONSTRAINT "work_knowledge_uploads_has_scope" CHECK (
                "workId" IS NOT NULL OR "organizationId" IS NOT NULL
            )
        `);

        // Mirror the Work-scoped indexes so an org-scoped list and an
        // org-scoped dedup lookup are as cheap as the per-Work ones.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_wku_org_sha256" ON "work_knowledge_uploads"("organizationId","sha256")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_wku_org_created" ON "work_knowledge_uploads"("organizationId","createdAt")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('work_knowledge_uploads');
        if (!table) return;
        if (queryRunner.connection.options.type !== 'postgres') return;

        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wku_org_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wku_org_sha256"`);
        await queryRunner.query(
            `ALTER TABLE "work_knowledge_uploads" DROP CONSTRAINT IF EXISTS "work_knowledge_uploads_has_scope"`,
        );
        // Restoring NOT NULL is only possible once org-scoped rows are
        // gone — they have a NULL `workId` by definition.
        //
        // REFUSE rather than delete. The obvious implementation here is
        // `DELETE FROM ... WHERE "workId" IS NULL`, and it would quietly
        // destroy every file anyone uploaded to global Memory — real user
        // data, gone as a side effect of a schema rollback. A revert run
        // shortly after deploy (the realistic case) has no such rows and
        // still completes; anything else stops and tells the operator
        // exactly what is in the way, so removing that data stays a
        // deliberate decision rather than a footnote of this migration.
        const [{ count }] = (await queryRunner.query(
            `SELECT COUNT(*)::int AS count FROM "work_knowledge_uploads" WHERE "workId" IS NULL`,
        )) as Array<{ count: number }>;

        if (count > 0) {
            throw new Error(
                `Cannot revert AddOrgScopeToKbUploads: ${count} organization-scoped Memory upload(s) ` +
                    `have a NULL "workId" and would have to be deleted to restore the NOT NULL constraint. ` +
                    `Export or delete them deliberately first ` +
                    `(SELECT * FROM "work_knowledge_uploads" WHERE "workId" IS NULL), then re-run the revert.`,
            );
        }

        await queryRunner.query(
            `ALTER TABLE "work_knowledge_uploads" ALTER COLUMN "workId" SET NOT NULL`,
        );
    }
}
