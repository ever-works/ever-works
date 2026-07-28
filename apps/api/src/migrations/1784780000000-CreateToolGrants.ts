import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Tool-grant matrix (audit item G4) — `tool_grants`, one row per
 * (owner, scope) carrying that scope's allow/deny contribution.
 *
 * WHY
 *   Before this table there was no tenant → organization → Work → Agent
 *   lattice for TOOL access at all: the only gate was the per-Agent
 *   `permissions` booleans, which an Agent's own row could set. An
 *   operator could not say "nobody under this organization may call
 *   deploy_*" and have it hold for every Agent beneath it.
 *
 * SEMANTICS (resolution lives in `@ever-works/agent/policy`)
 *   - No row  → inherit. With no rows anywhere the chain resolves to the
 *     permissive platform default (`allow: ['*']`), so EVERY existing
 *     install keeps behaving exactly as it did before this migration.
 *   - `allow` present → intersected with the inherited set. A pattern the
 *     ancestors never granted is rejected, not widened in.
 *   - `deny` is additive and permanent down the chain.
 *
 * SCHEMA NOTES
 *   - `scopeId` is NOT NULL for every scope including tenant, so the
 *     unique index `(userId, scopeType, scopeId)` has no nullable member
 *     (SQL treats NULLs as DISTINCT inside a unique index, which would let
 *     a concurrent same-scope create burst all succeed).
 *   - `tenantId` / `organizationId` are the Tier A/C scope columns
 *     auto-stamped by `ScopeStampingSubscriber`. They are raw uuid columns
 *     with no entity relation — the EW-654 cycle-avoidance rule — and are
 *     indexed rather than FK'd so a tenant/org delete can never block a
 *     grant delete.
 *   - `allow` / `deny` are TEXT (`simple-json`), matching the
 *     `agents.permissions` / `works.checkDefaults` storage pattern.
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1784300000000-CreateTerminalTranscriptChunks`.
 */
export class CreateToolGrants1784780000000 implements MigrationInterface {
    name = 'CreateToolGrants1784780000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tool_grants')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'tool_grants',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'scopeType', type: 'varchar', length: '16' },
                    { name: 'scopeId', type: 'uuid' },
                    { name: 'allow', type: 'text', isNullable: true },
                    { name: 'deny', type: 'text', isNullable: true },
                    { name: 'note', type: 'text', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'tool_grants',
            new TableIndex({
                name: 'uq_tool_grants_owner_scope',
                columnNames: ['userId', 'scopeType', 'scopeId'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'tool_grants',
            new TableIndex({ name: 'idx_tool_grants_user', columnNames: ['userId'] }),
        );

        await queryRunner.createIndex(
            'tool_grants',
            new TableIndex({
                name: 'idx_tool_grants_scope',
                columnNames: ['scopeType', 'scopeId'],
            }),
        );

        await queryRunner.createIndex(
            'tool_grants',
            new TableIndex({ name: 'idx_tool_grants_tenant', columnNames: ['tenantId'] }),
        );

        await queryRunner.createIndex(
            'tool_grants',
            new TableIndex({
                name: 'idx_tool_grants_organization',
                columnNames: ['organizationId'],
            }),
        );

        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'tool_grants',
                new TableForeignKey({
                    name: 'fk_tool_grants_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tool_grants')) {
            await queryRunner.dropTable('tool_grants', true);
        }
    }
}
