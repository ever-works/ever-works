import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * EW-P1-2 — integration API keys (`api_keys.kind = 'integration'`, `ew_int_…`)
 * and the attribution columns integration writes need.
 *
 * Spec: `docs/specs/features/integration-keys/spec.md`.
 *
 * ## `api_keys`
 *
 * Seven nullable columns, all NULL on every existing personal and fleet-run
 * row, so nothing about those keys changes:
 *
 * | column                  | type          | what                                   |
 * |-------------------------|---------------|----------------------------------------|
 * | `scopes`                | text (json)   | granted scopes, vocabulary v1          |
 * | `organizationIds`       | text (json)   | the Organizations the key is pinned to |
 * | `integrationKind`       | varchar(32)   | `ever-gauzy` \| `generic`              |
 * | `description`           | varchar(500)  | free text                              |
 * | `previousHashedKey`     | varchar(64)   | sha256 of the secret before rotation   |
 * | `previousKeyGraceUntil` | bigint (ms)   | when that previous secret stops        |
 * | `rotatedAt`             | bigint (ms)   | last in-place rotation                 |
 *
 * `kind` already exists (1789400000000, `varchar(32) DEFAULT 'personal'`) and
 * simply gains the value `'integration'` — no DDL.
 *
 * Two indexes: `previousHashedKey` (the grace-period lookup on every request
 * that presents a just-rotated secret) and `(tenantId, kind)` (the per-Tenant
 * integration key listing and its cap of 20).
 *
 * ## `task_chat_messages`
 *
 * - `authorType` widens `varchar(8)` → `varchar(16)` so it can hold
 *   `'integration'` (11 characters). Postgres and MySQL alter the type in
 *   place (a widening, no rewrite of existing values); SQLite does not enforce
 *   a varchar length, so nothing runs there.
 * - `externalAuthor` (text, json, nullable): `{ name, avatarUrl?, source }`
 *   for display when an integration writes without acting as a user.
 *
 * `tasks.createdByType` is already `varchar(16)`, so `'integration'` fits
 * without DDL.
 *
 * ## Portability
 *
 * Column adds go through `queryRunner.addColumn` so each driver spells them
 * natively (Postgres, MySQL and better-sqlite3 all supported). Every step is
 * guarded by a re-read of the table, so re-running is a no-op.
 *
 * ## down()
 *
 * Deletes every integration key (the columns that make one safe — its scopes
 * and pins — are about to be dropped, and leaving the rows behind would turn
 * them into indistinguishable keys), resets integration chat authors to
 * `'user'` so the narrowed column can hold every row, and drops what up()
 * added.
 */
export class AddIntegrationApiKeys1795060100000 implements MigrationInterface {
    name = 'AddIntegrationApiKeys1795060100000';

    static readonly API_KEYS = 'api_keys';
    static readonly CHAT = 'task_chat_messages';
    static readonly PREVIOUS_HASH_INDEX = 'idx_api_keys_previous_hashed_key';
    static readonly TENANT_KIND_INDEX = 'idx_api_keys_tenant_kind';

    static apiKeyColumns(): TableColumn[] {
        return [
            new TableColumn({ name: 'scopes', type: 'text', isNullable: true }),
            new TableColumn({ name: 'organizationIds', type: 'text', isNullable: true }),
            new TableColumn({
                name: 'integrationKind',
                type: 'varchar',
                length: '32',
                isNullable: true,
            }),
            new TableColumn({
                name: 'description',
                type: 'varchar',
                length: '500',
                isNullable: true,
            }),
            new TableColumn({
                name: 'previousHashedKey',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
            new TableColumn({ name: 'previousKeyGraceUntil', type: 'bigint', isNullable: true }),
            new TableColumn({ name: 'rotatedAt', type: 'bigint', isNullable: true }),
        ];
    }

    /** The statement that widens `task_chat_messages.authorType`, per driver. */
    static widenAuthorTypeStatement(driver: string, length: 8 | 16): string | null {
        if (driver === 'postgres' || driver === 'cockroachdb') {
            return `ALTER TABLE "task_chat_messages" ALTER COLUMN "authorType" TYPE varchar(${length})`;
        }
        if (driver === 'mysql' || driver === 'mariadb' || driver === 'aurora-mysql') {
            return `ALTER TABLE \`task_chat_messages\` MODIFY \`authorType\` varchar(${length}) NOT NULL`;
        }
        // SQLite (better-sqlite3, sqljs …) does not enforce varchar lengths.
        return null;
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const C = AddIntegrationApiKeys1795060100000;

        if (await queryRunner.getTable(C.API_KEYS)) {
            for (const column of C.apiKeyColumns()) {
                // Re-read every step: on sqlite an added column recreates the
                // table, so a descriptor captured before it is stale.
                const table = await queryRunner.getTable(C.API_KEYS);
                if (table?.findColumnByName(column.name)) continue;
                await queryRunner.addColumn(C.API_KEYS, column);
            }

            const withColumns = await queryRunner.getTable(C.API_KEYS);
            if (withColumns && !withColumns.indices.some((i) => i.name === C.PREVIOUS_HASH_INDEX)) {
                await queryRunner.createIndex(
                    C.API_KEYS,
                    new TableIndex({
                        name: C.PREVIOUS_HASH_INDEX,
                        columnNames: ['previousHashedKey'],
                    }),
                );
            }
            const withHashIndex = await queryRunner.getTable(C.API_KEYS);
            if (
                withHashIndex &&
                withHashIndex.findColumnByName('tenantId') &&
                withHashIndex.findColumnByName('kind') &&
                !withHashIndex.indices.some((i) => i.name === C.TENANT_KIND_INDEX)
            ) {
                await queryRunner.createIndex(
                    C.API_KEYS,
                    new TableIndex({
                        name: C.TENANT_KIND_INDEX,
                        columnNames: ['tenantId', 'kind'],
                    }),
                );
            }
        }

        const chat = await queryRunner.getTable(C.CHAT);
        if (chat) {
            const authorType = chat.findColumnByName('authorType');
            const currentLength = Number(authorType?.length || 0);
            const widen = C.widenAuthorTypeStatement(queryRunner.connection.options.type, 16);
            if (authorType && widen && currentLength > 0 && currentLength < 16) {
                await queryRunner.query(widen);
            }
            const refreshed = await queryRunner.getTable(C.CHAT);
            if (refreshed && !refreshed.findColumnByName('externalAuthor')) {
                await queryRunner.addColumn(
                    C.CHAT,
                    new TableColumn({ name: 'externalAuthor', type: 'text', isNullable: true }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const C = AddIntegrationApiKeys1795060100000;

        // Identifiers below are fixed table/column names quoted by the driver;
        // no value reaches these statements from outside.
        const esc = (name: string) => queryRunner.connection.driver.escape(name);

        // Before integration authorship disappears, hand every row it wrote
        // back to a real person so history stays resolvable: an integration
        // writing WITHOUT act-as always writes as the key's owner, who is the
        // owner (`tasks.userId`) of the Task it created or commented on.
        if (await queryRunner.getTable('tasks')) {
            await queryRunner.query(
                `UPDATE ${esc('tasks')} SET ${esc('createdByType')} = 'user', ${esc('createdById')} = ${esc('userId')} WHERE ${esc('createdByType')} = 'integration'`,
            );
        }

        const chat = await queryRunner.getTable(C.CHAT);
        if (chat) {
            if (chat.findColumnByName('authorType') && (await queryRunner.getTable('tasks'))) {
                await queryRunner.query(
                    `UPDATE ${esc(C.CHAT)} SET ${esc('authorType')} = 'user', ${esc('authorId')} = ` +
                        `(SELECT t.${esc('userId')} FROM ${esc('tasks')} t WHERE t.${esc('id')} = ${esc(C.CHAT)}.${esc('taskId')}) ` +
                        `WHERE ${esc('authorType')} = 'integration'`,
                );
            }
            const column = chat.findColumnByName('externalAuthor');
            if (column) await queryRunner.dropColumn(C.CHAT, column);
            const narrow = C.widenAuthorTypeStatement(queryRunner.connection.options.type, 8);
            if (narrow) await queryRunner.query(narrow);
        }

        const table = await queryRunner.getTable(C.API_KEYS);
        if (!table) return;

        if (table.findColumnByName('kind')) {
            await queryRunner.query(
                `DELETE FROM ${esc(C.API_KEYS)} WHERE ${esc('kind')} = 'integration'`,
            );
        }

        for (const name of [C.TENANT_KIND_INDEX, C.PREVIOUS_HASH_INDEX]) {
            const refreshed = await queryRunner.getTable(C.API_KEYS);
            const index = refreshed?.indices.find((i) => i.name === name);
            if (index) await queryRunner.dropIndex(C.API_KEYS, index);
        }

        for (const column of [...C.apiKeyColumns()].reverse()) {
            const refreshed = await queryRunner.getTable(C.API_KEYS);
            const existing = refreshed?.findColumnByName(column.name);
            if (existing) await queryRunner.dropColumn(C.API_KEYS, existing);
        }
    }
}
