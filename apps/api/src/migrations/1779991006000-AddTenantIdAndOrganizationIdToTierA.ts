import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-655 (Tenants & Organizations Phase 3) — adds nullable `tenantId`
 * and `organizationId` FK columns to all Tier A (top-level business
 * object) entities. Tier A is the broadest scope tier; every
 * top-level user-visible record carries both columns going forward.
 *
 * See [spec.md §2.3](../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets)
 * for the per-tier rules.
 *
 * Two table groups:
 *
 *   - `TIER_A_BOTH` — 17 tables that get BOTH columns added. Each
 *     gets nullable `tenantId` (FK to `tenants(id)` ON DELETE SET
 *     NULL, indexed) AND nullable `organizationId` (FK to
 *     `organizations(id)` ON DELETE SET NULL, indexed).
 *
 *   - `TIER_A_TENANT_ONLY` — 2 tables (`works`, `work_knowledge_documents`)
 *     that already carry a forward-looking `organizationId` UUID column
 *     from earlier work (see [`1779977000000-AddWorkOrganizationId.ts`](./1779977000000-AddWorkOrganizationId.ts)
 *     and [`work-knowledge-document.entity.ts`](../../../../packages/agent/src/entities/work-knowledge-document.entity.ts)).
 *     They get only `tenantId` here. The free-form `organizationId`
 *     gets upgraded to a real FK in Phase 4 (EW-656).
 *
 * **No backfill.** Existing rows stay `tenantId = NULL` /
 * `organizationId = NULL`. Service-layer code does NOT start writing
 * these in this phase — that's Phase 5 (Tier C denormalization +
 * `ScopeContext`) and Phase 6 (lazy upgrade flow + `OrganizationService`).
 *
 * Forward-only, additive, idempotent (gates on `hasColumn`).
 */
const TIER_A_BOTH = [
    'missions',
    'work_proposals',
    'tasks',
    'agents',
    'skills',
    'conversations',
    'notifications',
    'api_keys',
    'templates',
    'template_customizations',
    'user_subscriptions',
    'work_schedules',
    'work_deployments',
    'onboarding_requests',
    'webhook_subscriptions',
    'github_app_installations',
    'github_app_user_links',
] as const;

const TIER_A_TENANT_ONLY = ['works', 'work_knowledge_documents'] as const;

async function addTenantIdColumn(queryRunner: QueryRunner, tableName: string): Promise<void> {
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
    if (!tableAfterFk?.indices.some((i) => i.name === idxName)) {
        await queryRunner.createIndex(
            tableName,
            new TableIndex({ name: idxName, columnNames: ['tenantId'] }),
        );
    }
}

async function addOrganizationIdColumn(queryRunner: QueryRunner, tableName: string): Promise<void> {
    if (!(await queryRunner.hasColumn(tableName, 'organizationId'))) {
        await queryRunner.addColumn(
            tableName,
            new TableColumn({ name: 'organizationId', type: 'uuid', isNullable: true }),
        );
    }

    const table = await queryRunner.getTable(tableName);
    const fkName = `fk_${tableName}_organization`;
    const hasFk = table?.foreignKeys.some((fk) => fk.name === fkName);
    if (!hasFk) {
        await queryRunner.createForeignKey(
            tableName,
            new TableForeignKey({
                name: fkName,
                columnNames: ['organizationId'],
                referencedTableName: 'organizations',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    const tableAfterFk = await queryRunner.getTable(tableName);
    const idxName = `idx_${tableName}_organization_id`;
    if (!tableAfterFk?.indices.some((i) => i.name === idxName)) {
        await queryRunner.createIndex(
            tableName,
            new TableIndex({ name: idxName, columnNames: ['organizationId'] }),
        );
    }
}

async function dropOrganizationIdColumn(
    queryRunner: QueryRunner,
    tableName: string,
): Promise<void> {
    // Re-read the table between each step — dropping an index in step 1
    // invalidates the indices array on the snapshot, and the FK lookup
    // in step 2 would otherwise be reading a stale view.
    const idxName = `idx_${tableName}_organization_id`;
    let table = await queryRunner.getTable(tableName);
    if (table?.indices.some((i) => i.name === idxName)) {
        await queryRunner.dropIndex(tableName, idxName);
    }
    const fkName = `fk_${tableName}_organization`;
    table = await queryRunner.getTable(tableName);
    const fk = table?.foreignKeys.find((f) => f.name === fkName);
    if (fk) {
        await queryRunner.dropForeignKey(tableName, fk);
    }
    if (await queryRunner.hasColumn(tableName, 'organizationId')) {
        await queryRunner.dropColumn(tableName, 'organizationId');
    }
}

async function dropTenantIdColumn(queryRunner: QueryRunner, tableName: string): Promise<void> {
    const idxName = `idx_${tableName}_tenant_id`;
    let table = await queryRunner.getTable(tableName);
    if (table?.indices.some((i) => i.name === idxName)) {
        await queryRunner.dropIndex(tableName, idxName);
    }
    const fkName = `fk_${tableName}_tenant`;
    table = await queryRunner.getTable(tableName);
    const fk = table?.foreignKeys.find((f) => f.name === fkName);
    if (fk) {
        await queryRunner.dropForeignKey(tableName, fk);
    }
    if (await queryRunner.hasColumn(tableName, 'tenantId')) {
        await queryRunner.dropColumn(tableName, 'tenantId');
    }
}

export class AddTenantIdAndOrganizationIdToTierA1779991006000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of TIER_A_BOTH) {
            // Skip silently if the table doesn't exist in this environment.
            // Migration-only contexts (CLI / test fixtures that load a
            // subset of the schema) may not have every Tier A table yet,
            // and we want the migration to be a no-op in that case rather
            // than throw mid-iteration.
            if (!(await queryRunner.hasTable(tableName))) {
                continue;
            }
            await addTenantIdColumn(queryRunner, tableName);
            await addOrganizationIdColumn(queryRunner, tableName);
        }
        for (const tableName of TIER_A_TENANT_ONLY) {
            if (!(await queryRunner.hasTable(tableName))) {
                continue;
            }
            await addTenantIdColumn(queryRunner, tableName);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse order so the inverse of up() is exact.
        for (const tableName of [...TIER_A_TENANT_ONLY].reverse()) {
            if (!(await queryRunner.hasTable(tableName))) {
                continue;
            }
            await dropTenantIdColumn(queryRunner, tableName);
        }
        for (const tableName of [...TIER_A_BOTH].reverse()) {
            if (!(await queryRunner.hasTable(tableName))) {
                continue;
            }
            await dropOrganizationIdColumn(queryRunner, tableName);
            await dropTenantIdColumn(queryRunner, tableName);
        }
    }
}
