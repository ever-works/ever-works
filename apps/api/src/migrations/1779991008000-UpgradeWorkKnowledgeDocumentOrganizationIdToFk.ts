import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

/**
 * EW-656 (Tenants & Organizations Phase 4) — upgrades the existing
 * free-form `work_knowledge_documents.organizationId` column to a real
 * FK constraint referencing `organizations(id)`. Mirrors the
 * `works.organizationId` upgrade in
 * [`1779991007000-UpgradeWorkOrganizationIdToFk.ts`](./1779991007000-UpgradeWorkOrganizationIdToFk.ts).
 *
 * Background: `work_knowledge_documents.organizationId` was added by
 * the original KB org-overlay design (EW-639 / EW-640) as a free-form
 * nullable UUID, with a CHECK constraint that exactly one of
 * `workId` / `organizationId` is set on each row. Now that Phase 1
 * (EW-653) has the real `organizations` table, we promote this to a
 * proper FK.
 *
 * Sequence:
 *   1. Pre-check for orphan UUIDs and NULL them out with a logged
 *      warning. **Note:** unlike `works.organizationId`, this column
 *      participates in a CHECK constraint that requires one of
 *      `workId` / `organizationId` to be set. NULLing an
 *      `organizationId` here would violate that invariant if
 *      `workId` is also NULL. The query therefore restricts the
 *      NULL-out to rows where `workId IS NOT NULL` (so the CHECK
 *      still holds afterwards). Rows with `workId IS NULL` AND a
 *      stale `organizationId` UUID are rare-to-impossible today
 *      (the column was added forward-looking, no real Orgs exist),
 *      but if any did, we surface them as a hard error so the
 *      operator can resolve manually rather than silently breaking
 *      the CHECK.
 *   2. Add FK constraint `fk_work_knowledge_documents_organization`
 *      → `organizations(id)` ON DELETE SET NULL.
 *
 * **No entity changes.** `WorkKnowledgeDocument.organizationId` is
 * declared as a plain `@Column({ type: 'uuid', nullable: true })` —
 * same rationale as `Work` (see sibling migration's docblock and
 * EW-654 import-cycle comment on `user.entity.ts`).
 *
 * Forward-only, additive, idempotent.
 */
export class UpgradeWorkKnowledgeDocumentOrganizationIdToFk1779991008000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1a. Hard-error on orphans that would violate the workId/orgId
        // CHECK constraint after NULL-out.
        const fatalOrphans = (await queryRunner.query(
            `SELECT COUNT(*) AS cnt FROM "work_knowledge_documents" WHERE "workId" IS NULL AND "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
        )) as Array<{ cnt: number | string }>;
        const fatalCount = Number(fatalOrphans[0]?.cnt ?? 0);
        if (fatalCount > 0) {
            throw new Error(
                `UpgradeWorkKnowledgeDocumentOrganizationIdToFk aborted: ${fatalCount} row(s) have NULL workId AND a stale organizationId UUID with no matching organizations row. NULLing organizationId on these rows would violate the workId/organizationId CHECK constraint. Resolve manually (delete the rows, or backfill organizationId to a real value) before re-running this migration.`,
            );
        }

        // 1b. Null out the safe orphans (rows that still have workId set,
        // so the CHECK passes after the NULL).
        const orphans = (await queryRunner.query(
            `SELECT COUNT(*) AS cnt FROM "work_knowledge_documents" WHERE "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
        )) as Array<{ cnt: number | string }>;
        const orphanCount = Number(orphans[0]?.cnt ?? 0);
        if (orphanCount > 0) {
            // eslint-disable-next-line no-console
            console.warn(
                `[UpgradeWorkKnowledgeDocumentOrganizationIdToFk] Nulling out ${orphanCount} orphan work_knowledge_documents.organizationId value(s) — no matching row in organizations. These were forward-looking UUIDs from before the FK existed.`,
            );
            await queryRunner.query(
                `UPDATE "work_knowledge_documents" SET "organizationId" = NULL WHERE "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
            );
        }

        // 2. Add the FK constraint.
        const wkd = await queryRunner.getTable('work_knowledge_documents');
        const hasFk = wkd?.foreignKeys.some(
            (fk) => fk.name === 'fk_work_knowledge_documents_organization',
        );
        if (!hasFk) {
            await queryRunner.createForeignKey(
                'work_knowledge_documents',
                new TableForeignKey({
                    name: 'fk_work_knowledge_documents_organization',
                    columnNames: ['organizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const wkd = await queryRunner.getTable('work_knowledge_documents');
        const fk = wkd?.foreignKeys.find(
            (f) => f.name === 'fk_work_knowledge_documents_organization',
        );
        if (fk) {
            await queryRunner.dropForeignKey('work_knowledge_documents', fk);
        }
        // As with the works migration: previously-NULLed orphan values
        // are not restored — they were invalid.
    }
}
