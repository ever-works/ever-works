import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-657 (Tenants & Organizations Phase 5a) — adds nullable
 * `tenantId` and `organizationId` FK columns to all Tier C child
 * tables. Mirrors the Tier A migration in
 * [`1779991006000-AddTenantIdAndOrganizationIdToTierA.ts`](./1779991006000-AddTenantIdAndOrganizationIdToTierA.ts).
 *
 * See [spec.md §2.3](../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets)
 * for the per-tier rules.
 *
 * Tier C are denormalized child rows of Tier A objects (e.g.,
 * `task_assignees` is a child of `tasks`; `agent_runs` is a child of
 * `agents`). Each Tier C row carries BOTH columns as a denormalized
 * copy of its parent's scope. Per the design call recorded in the
 * spec, the denormalization wins over a join because every read path
 * already filters by scope; carrying the scope alongside avoids a
 * Tier A lookup on every Tier C read.
 *
 * **No backfill.** Existing Tier C rows stay `tenantId = NULL` /
 * `organizationId = NULL`. The service-layer code that starts writing
 * these on insert lands in Phase 5b (EW-657 cont. — ScopeContext
 * provider + service-layer wiring). The lazy backfill that promotes
 * existing rows on the user's first-Org upgrade lands in Phase 6
 * (EW-658).
 *
 * **No entity-level `@ManyToOne` to Tenant / Organization.** Same
 * rationale as Phase 2's `User` entity (see EW-654 import-cycle
 * comment on [`user.entity.ts`](../../../../packages/agent/src/entities/user.entity.ts)):
 * Tier C entities are imported widely; adding `@ManyToOne(() => Tenant)`
 * or `@ManyToOne(() => Organization)` would re-introduce the User →
 * ... → Tier C → Tenant → User cycle that crashed ESM/vitest in
 * Phase 2. The FK is enforced at DB level; service-layer code that
 * needs the parent Tenant / Organization does explicit repository
 * lookups.
 *
 * Forward-only, additive, idempotent (gates on `hasColumn` and
 * `hasTable`).
 */
const TIER_C_TABLES = [
    'conversation_messages',
    'task_assignees',
    'task_approvers',
    'task_reviewers',
    'task_watchers',
    'task_blocks',
    'task_chat_messages',
    'task_kb_mentions',
    'task_attachments',
    'task_relations',
    'agent_runs',
    'agent_run_logs',
    'agent_budgets',
    'agent_memberships',
    'skill_bindings',
    'work_members',
    'work_invitations',
    'work_generation_history',
    'work_knowledge_chunks',
    'work_knowledge_citations',
    'work_knowledge_tags',
    'work_knowledge_uploads',
    'webhook_deliveries',
    'usage_ledger_entries',
    'plugin_usage_events',
    'activity_log',
] as const;

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

export class AddTenantIdAndOrganizationIdToTierC1779991009000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of TIER_C_TABLES) {
            // Skip silently if the table doesn't exist in this environment.
            // Migration-only contexts (CLI / test fixtures that load a
            // subset of the schema) may not have every Tier C table yet,
            // and we want the migration to be a no-op in that case rather
            // than throw mid-iteration.
            if (!(await queryRunner.hasTable(tableName))) {
                continue;
            }
            await addTenantIdColumn(queryRunner, tableName);
            await addOrganizationIdColumn(queryRunner, tableName);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of [...TIER_C_TABLES].reverse()) {
            if (!(await queryRunner.hasTable(tableName))) {
                continue;
            }
            await dropOrganizationIdColumn(queryRunner, tableName);
            await dropTenantIdColumn(queryRunner, tableName);
        }
    }
}
