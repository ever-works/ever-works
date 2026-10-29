import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-08 T54 (plan §3.5 slot `03`, APW08-G12, FR-43) — keyed Task-thread posts.
 *
 * ## The stamp
 *
 * Plan §3.5 reserved `1792080300000` for this migration, but stage and production have already
 * applied newer App Works migrations (the newest on `develop` is
 * `1792320000000-AddTaskDeliveryState`). As for slot `00`, it is stamped at the next free slot
 * AFTER the newest, so it runs last and keeps the block's applied order. It depends on nothing
 * stamped between the two.
 *
 * ## What it does (`task_chat_messages` only)
 *
 * | column          | change                                    | why                                         |
 * |-----------------|-------------------------------------------|---------------------------------------------|
 * | `messageKey`    | ADD `varchar(64)` NULL                    | the copy key of a platform post, rendered in |
 * |                 |                                           | the reader's locale (`deliveryPosts.live`)   |
 * | `messageParams` | ADD `text` NULL (`simple-json`)           | that key's values (`{ url }`)                |
 * | `authorId`      | NOT NULL → NULL (widening only)           | a `system` post on a Task with no Agent has  |
 * |                 |                                           | no author id                                 |
 *
 * `authorType` already holds `'system'` (6 characters) on every driver: it is `varchar(16)` since
 * `1795060100000-AddIntegrationApiKeys` and was `varchar(8)` before it, and no CHECK constraint
 * names its values — so the new author type needs no DDL.
 *
 * `body` stays NOT NULL and keeps carrying the pre-rendered English of a keyed post, so every
 * existing reader (exports, the agent's thread context) is unchanged. `system` rows are
 * thread-only: the Integration API's comment reads leave them out, so its DTO keeps a real author.
 * `followUpKey` on `tasks` (plan §3.5 put it in this slot) already shipped with
 * `1792320000000-AddTaskDeliveryState` and is not touched here.
 *
 * ## Portable, forward-only, idempotent
 *
 * Every step re-reads the table first (SQLite recreates the table on an added or changed column,
 * so a descriptor captured earlier is stale): a column already present is not added again, and
 * `authorId` is only changed while it is still NOT NULL — a re-run is a no-op. `changeColumn`
 * keeps the column's type and only clears `isNullable`'s opposite, so Postgres runs `ALTER COLUMN
 * … DROP NOT NULL`, MySQL/MariaDB `CHANGE`/`MODIFY … NULL`, and SQLite recreates the table with
 * every row copied — every existing row keeps its `authorId`.
 *
 * `down()` drops ONLY the two added columns. It does not re-tighten `authorId`: once a `system`
 * post has been written a NOT NULL column could no longer hold it, and narrowing would have to
 * delete or invent authors. A nullable `authorId` is harmless to the previous code.
 */
export class AddTaskChatMessageKey1792330000000 implements MigrationInterface {
    name = 'AddTaskChatMessageKey1792330000000';

    static readonly TABLE = 'task_chat_messages';

    static columns(): TableColumn[] {
        return [
            new TableColumn({
                name: 'messageKey',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
            // `simple-json` is a `text` column holding JSON on every driver.
            new TableColumn({ name: 'messageParams', type: 'text', isNullable: true }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const C = AddTaskChatMessageKey1792330000000;
        if (!(await queryRunner.getTable(C.TABLE))) return;

        for (const column of C.columns()) {
            const table = await queryRunner.getTable(C.TABLE);
            if (table?.findColumnByName(column.name)) continue;
            await queryRunner.addColumn(C.TABLE, column);
        }

        const table = await queryRunner.getTable(C.TABLE);
        const authorId = table?.findColumnByName('authorId');
        if (table && authorId && !authorId.isNullable) {
            const widened = authorId.clone();
            widened.isNullable = true;
            await queryRunner.changeColumn(table, authorId, widened);
        }
    }

    /** Drops the two added columns — nothing else (see the class docstring for `authorId`). */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const C = AddTaskChatMessageKey1792330000000;
        if (!(await queryRunner.getTable(C.TABLE))) return;

        for (const column of [...C.columns()].reverse()) {
            const table = await queryRunner.getTable(C.TABLE);
            const existing = table?.findColumnByName(column.name);
            if (existing) await queryRunner.dropColumn(C.TABLE, existing);
        }
    }
}
