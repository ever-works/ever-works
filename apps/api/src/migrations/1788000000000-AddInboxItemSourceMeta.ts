import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet run asks the owner (self-build slice Q) — `inbox_items.sourceMeta`.
 *
 * A question a FLEET run asked (`sourceType = 'fleet-run'`) carries where
 * it came from: node id and name, the Task branch the partial work was
 * pushed to, the Task title, the pull request when one exists, and the
 * mount directory when the model asked from a mounted repository. The
 * Inbox renders those as "From your fleet · node · Task · branch" chips
 * and the Task page links the parked run to its question. A column rather
 * than prose in `body`: the web needs the node / branch / Task
 * machine-readably, and parsing them back out of the message text would
 * break the moment the wording changed.
 *
 * Additive, nullable JSON (`simple-json` on the entity), no index: read by
 * item primary key and alongside the owner-scoped list. Every existing row
 * and every other producer reads NULL ("no fleet provenance"), which is the
 * correct history. Forward-only with a guard so a partially applied
 * database converges; portable `TableColumn` DDL because the e2e stack and
 * CI run better-sqlite3 while production runs Postgres.
 */
export class AddInboxItemSourceMeta1788000000000 implements MigrationInterface {
    name = 'AddInboxItemSourceMeta1788000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const items = await queryRunner.getTable('inbox_items');
        if (items && !items.findColumnByName('sourceMeta')) {
            await queryRunner.addColumn(
                'inbox_items',
                new TableColumn({ name: 'sourceMeta', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const items = await queryRunner.getTable('inbox_items');
        if (items?.findColumnByName('sourceMeta')) {
            await queryRunner.dropColumn('inbox_items', 'sourceMeta');
        }
    }
}
