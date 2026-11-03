import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const TABLE = 'inbox_items';
const UNIQUE_INDEX = 'uq_inbox_items_integration_external';

/**
 * Integration inbox push — the origin of an inbox item.
 *
 * An integration key (Ever Gauzy first) files ITS OWN Inbox items (notices,
 * questions, approvals, mentions, assignments, emails) into a member's Ever
 * Works Inbox through `POST /api/integrations/v1/inbox/items`. Eight nullable /
 * defaulted columns on `inbox_items`:
 *
 * - `origin varchar(16) NOT NULL DEFAULT 'platform'` — every existing row was
 *   written by an Ever Works producer, so the default IS the backfill;
 * - `integrationKeyId uuid` — the key that filed the item (no FK: an item
 *   survives the key's revocation, like every other inbox cross-link);
 * - `externalId varchar(128)` — the integration's own id of the item;
 * - `sourceUrl varchar(2000)` (`https:` only, checked by the API) and
 *   `sourceLabel varchar(80)` — the link and badge back to its app;
 * - `emailMeta text` (`simple-json`) — the header block of a `kind: 'email'` item;
 * - `occurredAt timestamp` — when it happened at the source;
 * - `goalId uuid` — the Goal it is about (`related.goalId`; `taskId` / `workId`
 *   already exist).
 *
 * The unique index `(tenantId, integrationKeyId, externalId) WHERE externalId
 * IS NOT NULL` is the permanent de-duplication of a replayed create: one item
 * per externalId per key, forever, and no constraint at all on platform rows.
 *
 * Entity: `packages/agent/src/entities/inbox-item.entity.ts`.
 *
 * Forward-only + idempotent (`findColumnByName` / index-name guards), portable
 * `TableColumn` / `TableIndex` DDL for Postgres, MySQL and better-sqlite3.
 * `down()` drops exactly what `up()` added, in reverse.
 */
export class AddInboxItemIntegrationOrigin1797200000000 implements MigrationInterface {
    name = 'AddInboxItemIntegrationOrigin1797200000000';

    private static readonly COLUMNS = [
        new TableColumn({
            name: 'origin',
            type: 'varchar',
            length: '16',
            default: "'platform'",
            isNullable: false,
        }),
        new TableColumn({ name: 'integrationKeyId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'externalId', type: 'varchar', length: '128', isNullable: true }),
        new TableColumn({ name: 'sourceUrl', type: 'varchar', length: '2000', isNullable: true }),
        new TableColumn({ name: 'sourceLabel', type: 'varchar', length: '80', isNullable: true }),
        new TableColumn({ name: 'emailMeta', type: 'text', isNullable: true }),
        new TableColumn({ name: 'occurredAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'goalId', type: 'uuid', isNullable: true }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.getTable(TABLE))) return;
        for (const column of AddInboxItemIntegrationOrigin1797200000000.COLUMNS) {
            const table = await queryRunner.getTable(TABLE);
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn(TABLE, new TableColumn({ ...column }));
            }
        }
        const table = await queryRunner.getTable(TABLE);
        if (table && !table.indices.some((index) => index.name === UNIQUE_INDEX)) {
            await queryRunner.createIndex(
                TABLE,
                new TableIndex({
                    name: UNIQUE_INDEX,
                    columnNames: ['tenantId', 'integrationKeyId', 'externalId'],
                    isUnique: true,
                    where: '"externalId" IS NOT NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (table.indices.some((index) => index.name === UNIQUE_INDEX)) {
            await queryRunner.dropIndex(TABLE, UNIQUE_INDEX);
        }
        for (const column of [...AddInboxItemIntegrationOrigin1797200000000.COLUMNS].reverse()) {
            const current = await queryRunner.getTable(TABLE);
            if (current?.findColumnByName(column.name)) {
                await queryRunner.dropColumn(TABLE, column.name);
            }
        }
    }
}
