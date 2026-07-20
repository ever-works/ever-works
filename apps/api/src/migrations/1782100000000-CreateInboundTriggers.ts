import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Inbound Triggers ("Trigger Schedules") — creates the `inbound_triggers`
 * table backing the signed webhook/API trigger surface: an org member
 * creates a named trigger, receives a signed webhook URL
 * (`POST /api/inbound-triggers/:id/fire`), and every HMAC-verified call
 * spawns a Task (optionally assigned to `targetAgentId`).
 *
 * Entity: `packages/agent/src/entities/inbound-trigger.entity.ts`
 *
 * **Schema notes:**
 *   - `secretEncrypted` / `previousSecretEncrypted` (text) — HMAC-SHA256
 *     signing secrets, AES-256-GCM-encrypted at rest with
 *     PLATFORM_ENCRYPTION_KEY (same envelope as
 *     `webhook_subscriptions.secretEncrypted`). The previous secret stays
 *     valid for the 24h rotation grace window that `rotatedAt` starts.
 *   - `rotatedAt` / `lastFiredAt` as `bigint` epoch-millis (the entity's
 *     portable `TimestampColumn` transformer) — cross-DB parity.
 *   - Tier A scope: nullable `tenantId` / `organizationId` uuid columns,
 *     auto-stamped by `ScopeStampingSubscriber` on insert. Raw uuid
 *     reference columns (`userId`, `targetAgentId`) — no entity-level
 *     @ManyToOne (cycle avoidance per EW-654); FKs live here instead.
 *   - `(organizationId, status)` index — the Schedules aggregation and
 *     the management list both read active triggers per org scope.
 *   - `userId` index — per-user management listing.
 *   - FK `userId` → `users.id` ON DELETE CASCADE (a trigger is
 *     meaningless without its owner); FK `targetAgentId` → `agents.id`
 *     ON DELETE SET NULL (deleting the Agent must not break the trigger —
 *     fires just stop assigning).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1781300000000-AddTenantCredentialSnapshot`.
 */
export class CreateInboundTriggers1782100000000 implements MigrationInterface {
    name = 'CreateInboundTriggers1782100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('inbound_triggers')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'inbound_triggers',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'name', type: 'varchar', length: '120' },
                    { name: 'description', type: 'text', isNullable: true },
                    { name: 'kind', type: 'varchar', length: '16', default: "'webhook'" },
                    { name: 'status', type: 'varchar', length: '16', default: "'active'" },
                    { name: 'secretEncrypted', type: 'text' },
                    { name: 'previousSecretEncrypted', type: 'text', isNullable: true },
                    { name: 'rotatedAt', type: 'bigint', isNullable: true },
                    { name: 'targetAgentId', type: 'uuid', isNullable: true },
                    { name: 'taskTitleTemplate', type: 'varchar', length: '200', isNullable: true },
                    { name: 'lastFiredAt', type: 'bigint', isNullable: true },
                    { name: 'fireCount', type: 'integer', default: 0 },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'inbound_triggers',
            new TableIndex({
                name: 'idx_inbound_triggers_user',
                columnNames: ['userId'],
            }),
        );

        // Backs both the org-scoped management list and the Schedules
        // aggregation's "active triggers for this org" read.
        await queryRunner.createIndex(
            'inbound_triggers',
            new TableIndex({
                name: 'idx_inbound_triggers_org_status',
                columnNames: ['organizationId', 'status'],
            }),
        );

        await queryRunner.createForeignKey(
            'inbound_triggers',
            new TableForeignKey({
                name: 'fk_inbound_triggers_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        // Deleting an Agent must not delete (or orphan-break) triggers
        // that assigned Tasks to it — they keep firing, just unassigned.
        await queryRunner.createForeignKey(
            'inbound_triggers',
            new TableForeignKey({
                name: 'fk_inbound_triggers_target_agent',
                columnNames: ['targetAgentId'],
                referencedTableName: 'agents',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('inbound_triggers')) {
            await queryRunner.dropTable('inbound_triggers', true);
        }
    }
}
