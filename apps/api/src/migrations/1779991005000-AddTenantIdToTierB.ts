import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-654 (Tenants & Organizations Phase 2) — adds nullable `tenantId`
 * to the 6 Tier B (user-scoped but Org-irrelevant) entities. Tier B
 * gets `tenantId` ONLY — NO `organizationId` — per
 * [spec.md §2.3](../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets).
 *
 * Tables touched (note the actual table names — not all match the
 * entity class name):
 *   - `account` (AuthAccount)
 *   - `session` (AuthSession)
 *   - `verification` (AuthVerification)
 *   - `refresh_tokens` (RefreshToken)
 *   - `user_template_preferences` (UserTemplatePreference)
 *   - `user_task_counter` (UserTaskCounter — singular)
 *
 * Each table gets:
 *   - nullable `tenantId uuid` column,
 *   - FK to `tenants(id)` ON DELETE SET NULL,
 *   - single-column index on `tenantId`.
 *
 * **No backfill.** Existing rows stay `tenantId = NULL` and the
 * application code does NOT start writing values in this phase —
 * `tenantId` is populated only after the user creates their first
 * Organization (Phase 6's lazy backfill).
 *
 * Forward-only, additive, idempotent. The table list is enumerated
 * explicitly so adding a 7th Tier B entity later is a deliberate edit.
 */
const TIER_B_TABLES = [
    'account',
    'session',
    'verification',
    'refresh_tokens',
    'user_template_preferences',
    'user_task_counter',
] as const;

export class AddTenantIdToTierB1779991005000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of TIER_B_TABLES) {
            if (!(await queryRunner.hasColumn(tableName, 'tenantId'))) {
                await queryRunner.addColumn(
                    tableName,
                    new TableColumn({ name: 'tenantId', type: 'uuid', isNullable: true }),
                );
            }

            const table = await queryRunner.getTable(tableName);
            const fkName = `fk_${tableName}_tenant`;
            const hasFk = table?.foreignKeys.some((fk) => fk.name === fkName);
            if (!hasFk) {
                await queryRunner.createForeignKey(
                    tableName,
                    new TableForeignKey({
                        name: fkName,
                        columnNames: ['tenantId'],
                        referencedTableName: 'tenants',
                        referencedColumnNames: ['id'],
                        onDelete: 'SET NULL',
                    }),
                );
            }

            const tableAfterFk = await queryRunner.getTable(tableName);
            const idxName = `idx_${tableName}_tenant_id`;
            const hasIdx = tableAfterFk?.indices.some((i) => i.name === idxName);
            if (!hasIdx) {
                await queryRunner.createIndex(
                    tableName,
                    new TableIndex({ name: idxName, columnNames: ['tenantId'] }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse order so the inverse of up() is exact.
        for (const tableName of [...TIER_B_TABLES].reverse()) {
            const table = await queryRunner.getTable(tableName);
            if (!table) continue;

            const idxName = `idx_${tableName}_tenant_id`;
            if (table.indices.some((i) => i.name === idxName)) {
                await queryRunner.dropIndex(tableName, idxName);
            }

            const fkName = `fk_${tableName}_tenant`;
            const fk = table.foreignKeys.find((f) => f.name === fkName);
            if (fk) {
                await queryRunner.dropForeignKey(tableName, fk);
            }

            if (await queryRunner.hasColumn(tableName, 'tenantId')) {
                await queryRunner.dropColumn(tableName, 'tenantId');
            }
        }
    }
}
