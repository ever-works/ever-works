import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Adds the nullable `organizationId` column to the `works` table.
 *
 * EW-641 Phase 2/e row 37c — foundation for row 37d's
 * `WorkRepository.findIdsByOrganization(orgId)` lookup, which the KB
 * org-overlay fanout enqueue path uses to resolve target Works for a
 * given organization.
 *
 * Design choice: this column is intentionally **NOT** a foreign key
 * yet. The spec (§7.6) describes an `Organization` entity for KB
 * org-overlay membership, but no such entity has landed on develop
 * (the existing `WorkKnowledgeDocument.organizationId` already stores
 * a free-form UUID for the same reason — see
 * `1779971000000-CreateWorkKnowledgeDocuments.ts`). Treating the
 * column identically here keeps the data model coherent and lets a
 * later migration upgrade it to a `REFERENCES organizations(id)` FK
 * once that table exists.
 *
 * Forward-only, additive, nullable. Existing rows stay NULL on
 * upgrade; org onboarding flows (out of scope here) populate it
 * later. No read paths depend on the column today — until row 37d
 * lands, the only effect of this migration is a harmless extra
 * column.
 *
 * Index: single-column on `(organizationId)` so the row-37d
 * `findIdsByOrganization` lookup doesn't sequential-scan `works`.
 */
export class AddWorkOrganizationId1779977000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'organizationId'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'organizationId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        // Single-column index for the row-37d
        // `findIdsByOrganization(orgId)` lookup. Named explicitly so the
        // down-migration drops the right index even if TypeORM's auto-naming
        // diverges between dialects (SQLite + Postgres) over time.
        const table = await queryRunner.getTable('works');
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_works_organization_id');
        if (!hasIndex) {
            await queryRunner.createIndex(
                'works',
                new TableIndex({
                    name: 'idx_works_organization_id',
                    columnNames: ['organizationId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_works_organization_id');
        if (hasIndex) {
            await queryRunner.dropIndex('works', 'idx_works_organization_id');
        }
        if (await queryRunner.hasColumn('works', 'organizationId')) {
            await queryRunner.dropColumn('works', 'organizationId');
        }
    }
}
