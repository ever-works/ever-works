import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

/**
 * EW-656 (Tenants & Organizations Phase 4) — upgrades the existing
 * free-form `work_knowledge_documents.organizationId` column to a real
 * FK constraint referencing `organizations(id)`. Mirrors the
 * `works.organizationId` upgrade in
 * [`1779991007000-UpgradeWorkOrganizationIdToFk.ts`](./1779991007000-UpgradeWorkOrganizationIdToFk.ts),
 * but with two extra twists driven by the `work_knowledge_documents_scope_xor`
 * CHECK constraint (exactly one of `workId` / `organizationId` non-NULL).
 *
 * Background: `work_knowledge_documents.organizationId` was added by
 * the original KB org-overlay design (EW-639 / EW-640) as a free-form
 * nullable UUID, with the scope XOR check. Now that Phase 1 (EW-653)
 * has the real `organizations` table, we promote this to a proper FK.
 *
 * Sequence:
 *   1. Cleanup orphans (rows whose `organizationId` doesn't match any
 *      `organizations.id` — today this is *every* org-scoped KB doc in
 *      existence, because the `organizations` table is brand new and
 *      empty). Two paths:
 *        a. `workId IS NOT NULL` — NULL out the orphan `organizationId`
 *           (the CHECK still holds because `workId` is set).
 *        b. `workId IS NULL` — the row has no recoverable scope, and
 *           NULLing `organizationId` would violate the CHECK.
 *           **DELETE these rows** with a logged warning. They reference
 *           non-existent orgs (no real Orgs exist yet) and have no
 *           salvage path. This is consistent with the docblock framing
 *           of these as "forward-looking UUIDs from before the FK
 *           existed" — there is no production user who will lose real
 *           data here. (Codex P1 on the prior revision flagged the
 *           hard-error path as a deploy-blocker.)
 *   2. Add FK constraint `fk_work_knowledge_documents_organization`
 *      → `organizations(id)` **ON DELETE CASCADE**.
 *
 *      Why CASCADE (not SET NULL as on `works`)? Because of the scope
 *      XOR check: if we SET NULL on `organizationId` when an Org is
 *      deleted, any row with `workId IS NULL` + that org's id would
 *      end up with BOTH columns NULL, violating the CHECK and causing
 *      the org-delete itself to fail. CASCADE is the only referential
 *      action compatible with the XOR: when an Org goes away, its
 *      org-scoped KB documents die with it. (Codex P2 on the prior
 *      revision flagged this.) Work-scoped KB docs are untouched —
 *      they reference the Work, not the Org.
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
        // 1a. Delete unrecoverable orphans: rows where workId IS NULL
        // (org-scoped) AND organizationId references a non-existent org.
        // NULLing organizationId here would violate the scope XOR check;
        // there's no workId to fall back to. These rows have no salvage
        // path and are by definition pre-FK dead data.
        const fatalOrphans = (await queryRunner.query(
            `SELECT COUNT(*) AS cnt FROM "work_knowledge_documents" WHERE "workId" IS NULL AND "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
        )) as Array<{ cnt: number | string }>;
        const fatalCount = Number(fatalOrphans[0]?.cnt ?? 0);
        if (fatalCount > 0) {
            // eslint-disable-next-line no-console
            console.warn(
                `[UpgradeWorkKnowledgeDocumentOrganizationIdToFk] Deleting ${fatalCount} unrecoverable orphan work_knowledge_document(s) — workId IS NULL AND organizationId references no real org. These were forward-looking UUIDs from before the FK existed, and the scope XOR check leaves us no NULL-able fallback.`,
            );
            await queryRunner.query(
                `DELETE FROM "work_knowledge_documents" WHERE "workId" IS NULL AND "organizationId" IS NOT NULL AND "organizationId" NOT IN (SELECT "id" FROM "organizations")`,
            );
        }

        // 1b. Null out the recoverable orphans (rows that still have
        // workId set, so the CHECK passes after the NULL).
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

        // 2. Add the FK constraint. ON DELETE CASCADE — see docblock
        // for why this differs from `works.organizationId`'s SET NULL.
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
                    onDelete: 'CASCADE',
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
