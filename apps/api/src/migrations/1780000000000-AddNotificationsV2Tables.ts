import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Notifications v2 (EW-650 + sibling Epics EW-663 / EW-664 / EW-665) —
 * creates the 11 new tables that back the multi-channel notifications
 * + per-Agent email inbox feature track. All tables are additive; the
 * existing `notifications` (v1) and `mail-providers` (v1) surfaces are
 * untouched.
 *
 * Forward-only, idempotent (`ifNotExists` on every table).
 *
 * Tables (grouped by epic):
 *
 * **EW-650 — Email Providers**
 * - `tenant_email_addresses`         registry of per-tenant inbound / outbound addresses
 * - `agent_email_assignments`        which Agent uses which address (+ dispatch mode)
 * - `email_conversations`            per-Agent threaded conversation surface (v1.1, §12.3)
 * - `email_messages`                 per-message audit row (out+in)
 *
 * **EW-663 — Notification Channels**
 * - `notification_channels`          per-user Discord/Slack/Telegram/WhatsApp/Novu config
 * - `notification_channel_delivery_log`  per-send attempt log (idempotency + dead-letter)
 *
 * **EW-664 — Event Subscriptions**
 * - `notification_event_types`       event registry (extensible via plugin manifests)
 * - `user_notification_subscriptions`  per-(user,event) channel selection
 * - `user_notification_preferences`  per-user quiet-hours window + timezone
 * - `user_notification_category_mutes`  per-(user,category) temporary or indefinite mute
 * - `organization_notification_defaults`  per-org default subscription map (seeds new users)
 *
 * Specs:
 * - [`docs/specs/features/email-providers/spec.md`](../../../../docs/specs/features/email-providers/spec.md) §4 + §12.3
 * - [`docs/specs/features/notification-channels/spec.md`](../../../../docs/specs/features/notification-channels/spec.md) §4
 * - [`docs/specs/features/event-subscriptions/spec.md`](../../../../docs/specs/features/event-subscriptions/spec.md) §5
 *
 * Tenant/org FK columns on every Tier-C-shaped table mirror the
 * pattern established by [`1779991009000-AddTenantIdAndOrganizationIdToTierC.ts`](./1779991009000-AddTenantIdAndOrganizationIdToTierC.ts):
 * NULLable, no entity-level @ManyToOne (cycle-avoidance per EW-654),
 * FK enforced at DB level only. Backfill is lazy and lives in
 * service-layer wiring (out of scope for this migration).
 */
export class AddNotificationsV2Tables1780000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // -----------------------------------------------------------------
        // EW-650 — Email Providers
        // -----------------------------------------------------------------

        await queryRunner.createTable(
            new Table({
                name: 'tenant_email_addresses',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid', isNullable: false },
                    { name: 'address', type: 'varchar', length: '254', isNullable: false },
                    { name: 'direction', type: 'varchar', length: '16', isNullable: false },
                    { name: 'pluginId', type: 'varchar', length: '64', isNullable: false },
                    { name: 'providerSettings', type: 'jsonb', isNullable: false },
                    { name: 'verified', type: 'boolean', default: false, isNullable: false },
                    { name: 'verificationToken', type: 'varchar', length: '64', isNullable: true },
                    {
                        name: 'defaultForReplies',
                        type: 'boolean',
                        default: false,
                        isNullable: false,
                    },
                    { name: 'disabledAt', type: 'timestamp', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    {
                        name: 'uq_tenant_email_address_user_direction',
                        columnNames: ['userId', 'address', 'direction'],
                        isUnique: true,
                    },
                    { name: 'idx_tenant_email_address_plugin', columnNames: ['pluginId'] },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'agent_email_assignments',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'agentId', type: 'uuid', isNullable: false },
                    { name: 'emailAddressId', type: 'uuid', isNullable: false },
                    { name: 'direction', type: 'varchar', length: '16', isNullable: false },
                    { name: 'priority', type: 'int', default: 100, isNullable: false },
                    {
                        name: 'dispatchMode',
                        type: 'varchar',
                        length: '16',
                        default: "'task-spawn'",
                        isNullable: false,
                    },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['agentId'],
                        referencedTableName: 'agents',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                    {
                        columnNames: ['emailAddressId'],
                        referencedTableName: 'tenant_email_addresses',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    {
                        name: 'uq_agent_email_assignment',
                        columnNames: ['agentId', 'emailAddressId', 'direction'],
                        isUnique: true,
                    },
                    {
                        name: 'idx_agent_email_assignment_email_direction',
                        columnNames: ['emailAddressId', 'direction'],
                    },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'email_conversations',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'agentId', type: 'uuid', isNullable: false },
                    { name: 'threadKey', type: 'varchar', length: '200', isNullable: false },
                    { name: 'participants', type: 'jsonb', isNullable: false },
                    { name: 'lastMessageAt', type: 'timestamp', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['agentId'],
                        referencedTableName: 'agents',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    {
                        name: 'uq_email_conversation_agent_thread',
                        columnNames: ['agentId', 'threadKey'],
                        isUnique: true,
                    },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'email_messages',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid', isNullable: false },
                    { name: 'agentId', type: 'uuid', isNullable: true },
                    { name: 'taskId', type: 'uuid', isNullable: true },
                    { name: 'conversationId', type: 'uuid', isNullable: true },
                    { name: 'emailAddressId', type: 'uuid', isNullable: false },
                    { name: 'direction', type: 'varchar', length: '16', isNullable: false },
                    { name: 'pluginId', type: 'varchar', length: '64', isNullable: false },
                    { name: 'providerMessageId', type: 'varchar', length: '200', isNullable: true },
                    { name: 'from', type: 'varchar', length: '254', isNullable: false },
                    { name: 'toAddresses', type: 'jsonb', isNullable: false },
                    { name: 'ccAddresses', type: 'jsonb', isNullable: true },
                    { name: 'bccAddresses', type: 'jsonb', isNullable: true },
                    { name: 'subject', type: 'varchar', length: '998', isNullable: false },
                    { name: 'bodyText', type: 'text', isNullable: false },
                    { name: 'bodyHtml', type: 'text', isNullable: true },
                    { name: 'metadata', type: 'jsonb', isNullable: true },
                    { name: 'messageRef', type: 'varchar', length: '120', isNullable: true },
                    { name: 'sentAt', type: 'timestamp', isNullable: true },
                    { name: 'receivedAt', type: 'timestamp', isNullable: true },
                    { name: 'deliveryStatus', type: 'varchar', length: '16', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                    {
                        columnNames: ['emailAddressId'],
                        referencedTableName: 'tenant_email_addresses',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                    {
                        columnNames: ['conversationId'],
                        referencedTableName: 'email_conversations',
                        referencedColumnNames: ['id'],
                        onDelete: 'SET NULL',
                    },
                ],
                indices: [
                    {
                        name: 'idx_email_messages_user_agent_created',
                        columnNames: ['userId', 'agentId', 'createdAt'],
                    },
                    {
                        name: 'idx_email_messages_task_created',
                        columnNames: ['taskId', 'createdAt'],
                    },
                    {
                        name: 'idx_email_messages_conversation_created',
                        columnNames: ['conversationId', 'createdAt'],
                    },
                    {
                        name: 'idx_email_messages_address_created',
                        columnNames: ['emailAddressId', 'createdAt'],
                    },
                    {
                        name: 'uq_email_messages_provider_message',
                        columnNames: ['pluginId', 'providerMessageId'],
                        isUnique: true,
                    },
                ],
            }),
            true,
        );

        // -----------------------------------------------------------------
        // EW-663 — Notification Channels
        // -----------------------------------------------------------------

        await queryRunner.createTable(
            new Table({
                name: 'notification_channels',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid', isNullable: false },
                    { name: 'pluginId', type: 'varchar', length: '64', isNullable: false },
                    { name: 'name', type: 'varchar', length: '120', isNullable: false },
                    { name: 'targetConfig', type: 'jsonb', isNullable: false },
                    { name: 'verified', type: 'boolean', default: false, isNullable: false },
                    { name: 'disabledAt', type: 'timestamp', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    {
                        name: 'uq_notification_channel',
                        columnNames: ['userId', 'pluginId', 'name'],
                        isUnique: true,
                    },
                    { name: 'idx_notification_channel_plugin', columnNames: ['pluginId'] },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'notification_channel_delivery_log',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'channelId', type: 'uuid', isNullable: false },
                    { name: 'messageRef', type: 'varchar', length: '120', isNullable: false },
                    { name: 'eventType', type: 'varchar', length: '120', isNullable: true },
                    { name: 'status', type: 'varchar', length: '16', isNullable: false },
                    { name: 'providerMessageId', type: 'varchar', length: '200', isNullable: true },
                    { name: 'errorMessage', type: 'text', isNullable: true },
                    { name: 'attemptCount', type: 'int', default: 0, isNullable: false },
                    { name: 'deliveredAt', type: 'timestamp', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['channelId'],
                        referencedTableName: 'notification_channels',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    { name: 'idx_ncdl_channel_created', columnNames: ['channelId', 'createdAt'] },
                    { name: 'idx_ncdl_message_ref', columnNames: ['messageRef'] },
                ],
            }),
            true,
        );

        // -----------------------------------------------------------------
        // EW-664 — Event Subscriptions
        // -----------------------------------------------------------------

        await queryRunner.createTable(
            new Table({
                name: 'notification_event_types',
                columns: [
                    {
                        name: 'key',
                        type: 'varchar',
                        length: '120',
                        isPrimary: true,
                        isNullable: false,
                    },
                    { name: 'category', type: 'varchar', length: '64', isNullable: false },
                    { name: 'title', type: 'varchar', length: '200', isNullable: false },
                    { name: 'description', type: 'text', isNullable: false },
                    { name: 'urgent', type: 'boolean', default: false, isNullable: false },
                    {
                        name: 'defaultChannels',
                        type: 'jsonb',
                        default: `'["in-app"]'::jsonb`,
                        isNullable: false,
                    },
                    {
                        name: 'source',
                        type: 'varchar',
                        length: '16',
                        default: "'core'",
                        isNullable: false,
                    },
                    { name: 'pluginId', type: 'varchar', length: '64', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                indices: [
                    { name: 'idx_notification_event_type_category', columnNames: ['category'] },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'user_notification_subscriptions',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid', isNullable: false },
                    { name: 'eventTypeKey', type: 'varchar', length: '120', isNullable: false },
                    { name: 'channelIds', type: 'jsonb', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    {
                        name: 'uq_user_notification_subscription',
                        columnNames: ['userId', 'eventTypeKey'],
                        isUnique: true,
                    },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'user_notification_preferences',
                columns: [
                    { name: 'userId', type: 'uuid', isPrimary: true, isNullable: false },
                    { name: 'quietHoursStart', type: 'varchar', length: '8', isNullable: true },
                    { name: 'quietHoursEnd', type: 'varchar', length: '8', isNullable: true },
                    { name: 'timezone', type: 'varchar', length: '64', isNullable: true },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'user_notification_category_mutes',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid', isNullable: false },
                    { name: 'category', type: 'varchar', length: '64', isNullable: false },
                    { name: 'mutedUntil', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
                indices: [
                    {
                        name: 'uq_user_notification_category_mute',
                        columnNames: ['userId', 'category'],
                        isUnique: true,
                    },
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'organization_notification_defaults',
                columns: [
                    { name: 'organizationId', type: 'uuid', isPrimary: true, isNullable: false },
                    { name: 'defaults', type: 'jsonb', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
                foreignKeys: [
                    {
                        columnNames: ['organizationId'],
                        referencedTableName: 'organizations',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
            }),
            true,
        );

        // -----------------------------------------------------------------
        // Tenant/organization FKs on tier-C-shaped tables.
        // Same pattern as 1779991009000-AddTenantIdAndOrganizationIdToTierC.ts:
        // DB-level FK, no entity-level @ManyToOne, NULLable, SET NULL on delete.
        // -----------------------------------------------------------------

        for (const tableName of [
            'tenant_email_addresses',
            'email_conversations',
            'email_messages',
            'notification_channels',
            'notification_channel_delivery_log',
        ]) {
            await queryRunner.createForeignKey(
                tableName,
                new TableForeignKey({
                    name: `fk_${tableName}_tenant`,
                    columnNames: ['tenantId'],
                    referencedTableName: 'tenants',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createForeignKey(
                tableName,
                new TableForeignKey({
                    name: `fk_${tableName}_organization`,
                    columnNames: ['organizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createIndex(
                tableName,
                new TableIndex({ name: `idx_${tableName}_tenant_id`, columnNames: ['tenantId'] }),
            );
            await queryRunner.createIndex(
                tableName,
                new TableIndex({
                    name: `idx_${tableName}_organization_id`,
                    columnNames: ['organizationId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop in reverse FK order. `dropTable(name, true, true, true)` drops
        // the table along with its foreign keys + indices in one shot.
        for (const tableName of [
            'organization_notification_defaults',
            'user_notification_category_mutes',
            'user_notification_preferences',
            'user_notification_subscriptions',
            'notification_event_types',
            'notification_channel_delivery_log',
            'notification_channels',
            'email_messages',
            'email_conversations',
            'agent_email_assignments',
            'tenant_email_addresses',
        ]) {
            if (await queryRunner.hasTable(tableName)) {
                await queryRunner.dropTable(tableName, true, true, true);
            }
        }
    }
}
